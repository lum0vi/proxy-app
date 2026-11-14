import { config } from '../config.js';
import { sql } from '../db/index.js';
import { decryptSecret, upstreamKeyFingerprint } from '../lib/crypto.js';
import { catalogHeaders, type Protocol } from '../proxy/protocols.js';

interface CredentialToCheck {
  id: string;
  encryptedKey: string;
  baseUrl: string;
  protocol: Protocol;
}

function modelIds(payload: unknown, protocol: Protocol): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const catalog = payload as Record<string, unknown>;
  const items = protocol === 'GEMINI' && Array.isArray(catalog.models) ? catalog.models : catalog.data;
  if (!Array.isArray(items)) return [];
  return [...new Set(items.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as Record<string, unknown>;
    const id = protocol === 'GEMINI' && typeof entry.name === 'string' ? entry.name.replace(/^models\//, '') : entry.id;
    return typeof id === 'string' && id.length <= 200 && id.trim() && (protocol !== 'GEMINI' || /^[A-Za-z0-9_.-]+$/.test(id)) ? [id] : [];
  }))];
}

async function catalogPayload(response: Response): Promise<unknown> {
  if (!response.body || !response.headers.get('content-type')?.includes('json')) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) return null;
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function inactiveGroup(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const root = payload as Record<string, unknown>;
  const error = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : root;
  return typeof error.message === 'string' && /no active subscription found for this group/i.test(error.message);
}

export async function refreshUpstreamCatalog(id: string, request: typeof fetch = fetch): Promise<void> {
  const [credential] = await sql<CredentialToCheck[]>`
    SELECT uc.id, uc.encrypted_key, up.base_url, up.protocol
    FROM upstream_credentials uc JOIN upstream_pools up ON up.id = uc.pool_id
    WHERE uc.id = ${id} AND uc.status IN ('ACTIVE', 'DEGRADED') AND up.active
      AND (NOT uc.test_only OR ${config.testUpstreamsEnabled})
  `;
  if (!credential) return;

  let models: string[] = [];
  let failure: string | null = null;
  let fingerprint: string | null = null;
  const signal = AbortSignal.timeout(15_000);
  try {
    if (config.NODE_ENV === 'production' && new URL(credential.baseUrl).protocol !== 'https:') throw new Error('Insecure upstream URL');
    const secret = decryptSecret(credential.encryptedKey);
    fingerprint = upstreamKeyFingerprint(secret);
    const fetchCatalog = (path: string, protocol: Protocol) => request(`${credential.baseUrl.replace(/\/+$/, '')}${path}`, {
      headers: catalogHeaders(protocol, secret), redirect: 'manual', signal,
    });
    let response = credential.protocol === 'GEMINI' ? await fetchCatalog('/v1beta/models', 'GEMINI') : await fetchCatalog('/v1/models', credential.protocol);
    if (credential.protocol === 'GEMINI' && [404, 405, 501].includes(response.status)) {
      await response.body?.cancel();
      response = await fetchCatalog('/v1/models', 'OPENAI');
    }
    const payload = await catalogPayload(response);
    if (!response.ok) {
      failure = response.status === 403 && inactiveGroup(payload)
        ? 'HTTP 403: no active subscription for this provider group'
        : `Model catalog returned HTTP ${response.status}`;
    } else {
      models = modelIds(payload, credential.protocol);
      if (models.length === 0) failure = 'Provider returned no valid model IDs';
    }
  } catch {
    failure = signal.aborted ? 'Model catalog timed out' : 'Could not fetch the model catalog';
  }

  const validUntil = new Date(Date.now() + Math.max(180_000, config.UPSTREAM_HEALTH_INTERVAL_MS * 2));
  try {
    await sql`
      UPDATE upstream_credentials uc SET status = ${failure ? 'DEGRADED' : 'ACTIVE'},
        available_models = ${sql.array(models)}::text[], catalog_valid_until = ${failure ? null : validUntil},
        key_fingerprint = COALESCE(key_fingerprint, ${fingerprint}),
        last_health_at = now(), last_error = ${failure}, updated_at = now()
      FROM upstream_pools up
      WHERE uc.id = ${credential.id} AND uc.encrypted_key = ${credential.encryptedKey}
        AND uc.pool_id = up.id AND up.base_url = ${credential.baseUrl} AND up.protocol = ${credential.protocol} AND up.active
        AND uc.status IN ('ACTIVE', 'DEGRADED')
        AND (uc.spend_limit IS NULL OR uc.spend_used < uc.spend_limit)
    `;
  } catch (error) {
    if (!isDuplicateUpstreamKey(error)) throw error;
    await sql`
      UPDATE upstream_credentials SET status = 'DEGRADED', available_models = '{}', catalog_valid_until = NULL,
        last_health_at = now(), last_error = 'Duplicate upstream key; the existing entry owns the capacity', updated_at = now()
      WHERE id = ${credential.id} AND encrypted_key = ${credential.encryptedKey} AND status IN ('ACTIVE', 'DEGRADED')
    `;
  }
}

export function isDuplicateUpstreamKey(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'constraint_name' in error
    && error.constraint_name === 'upstream_credentials_key_fingerprint_idx';
}
