import { once } from 'node:events';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { decryptSecret } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { activeProxyRequests, proxyAccountingAnomalies, proxyDuration, proxyRequests, upstreamTimeToFirstByte } from '../observability/metrics.js';
import { enabledEndpoint, nativeHeaders, prepareInference, upstreamHeaders } from './request.js';
import type { Protocol } from './protocols.js';
import { PublicEventStream } from './public-stream.js';
import { StreamUsageTracker, extractUsage } from './usage.js';
import { acquireLease, emptyUsage, finalizeUsage, keyHash, resolveKey, unavailable, type CredentialContext } from './accounting.js';
import { prepareMedia } from './media.js';
import { videoRoutes } from './videos.js';

const bearerBlocked = new Set([401, 402, 403]);

async function listModels(hash: string, gemini: boolean, anthropic = false) {
  const key = await resolveKey(sql, hash);
  const rows = await sql<{ model: string; protocol: Protocol }[]>`
    SELECT model, protocol FROM usable_key_models
    WHERE api_key_id = ${key.id} AND (${!gemini} OR protocol = 'GEMINI') AND (${!anthropic} OR protocol = 'ANTHROPIC') ORDER BY model
  `;
  if (gemini) return { models: rows.map(({ model }) => ({
    name: `models/${model}`, displayName: model, supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
  })) };
  if (anthropic) return { data: rows.map(({ model }) => ({ id: model, type: 'model', display_name: model, created_at: '1970-01-01T00:00:00Z' })),
    has_more: false, first_id: rows[0]?.model ?? null, last_id: rows.at(-1)?.model ?? null };
  if (!rows.length && !(await sql`SELECT 1 FROM pool_channels JOIN sellable_upstream_slots USING (pool_id)
    WHERE root_pool_id = ${key.poolId} LIMIT 1`).length) throw unavailable();
  const models = new Map<string, Protocol[]>();
  for (const row of rows) {
    const protocols = models.get(row.model) ?? [];
    protocols.push(row.protocol);
    models.set(row.model, protocols);
  }
  return { object: 'list', data: [...models].map(([id, protocols]) => ({ id, object: 'model', created: 0, owned_by: 'unknown', protocols })) };
}

async function markDegraded(credential: CredentialContext, reason: string): Promise<void> {
  await sql`
    UPDATE upstream_credentials SET status = 'DEGRADED', catalog_valid_until = NULL,
      last_error = ${reason}, updated_at = now()
    WHERE id = ${credential.id} AND status = 'ACTIVE' AND encrypted_key = ${credential.encryptedKey}
  `;
}

function updateClientHeaders(response: Response, reply: FastifyReply, requestId: string) {
  for (const name of ['content-type', 'retry-after']) {
    const value = response.headers.get(name);
    if (value) reply.header(name, value);
  }
  reply.header('cache-control', 'no-store');
  reply.header('x-proxy-request-id', requestId);
}

async function readBody(response: Response, limit: number, onFirstByte?: () => void): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      if (size === 0 && value.byteLength > 0) onFirstByte?.();
      size += value.byteLength;
      if (size > limit) throw new Error('Upstream response exceeds the gateway body limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
}

export async function proxyRoutes(app: FastifyInstance): Promise<void> {
  await videoRoutes(app);
  for (const prefix of ['/v1/*', '/v1beta/*']) app.all(prefix, { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    const endpoint = enabledEndpoint(request);
    const hash = keyHash(request);
    if (endpoint === '/v1/models' || endpoint === '/v1beta/models' || endpoint.endsWith('/models/:model')) {
      reply.header('cache-control', 'no-store');
      const gemini = endpoint.startsWith('/v1beta/');
      const catalog = await listModels(hash, gemini, !gemini && !!(request.headers['anthropic-version'] || request.headers['x-api-key']));
      const items = 'models' in catalog ? catalog.models! : catalog.data!;
      if (endpoint.endsWith('/:model')) {
        const id = request.url.split('?', 1)[0]!.split('/').at(-1);
        const item = items.find(value => ('name' in value ? value.name === `models/${id}` : value.id === id));
        if (!item) throw new AppError(404, 'MODEL_NOT_AVAILABLE', 'This model is not available for your key');
        return item;
      }
      const query = new URL(request.url, 'http://proxy.invalid').searchParams;
      const limit = Number(query.get(gemini ? 'pageSize' : 'limit') ?? 1000);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new AppError(400, 'INVALID_PAGE_SIZE', 'Page size must be from 1 to 1000');
      const cursor = query.get(gemini ? 'pageToken' : 'after_id');
      const index = cursor ? items.findIndex(value => ('name' in value ? value.name === `models/${cursor}` : value.id === cursor)) : -1;
      if (cursor && index < 0) throw new AppError(400, 'INVALID_PAGE_TOKEN', 'Invalid page cursor');
      const page = items.slice(index + 1, index + 1 + limit);
      const more = items.length > index + 1 + limit;
      if (gemini) return { models: page, ...(more && { nextPageToken: (page.at(-1) as { name: string }).name.replace(/^models\//, '') }) };
      return { ...catalog, data: page, ...('has_more' in catalog && { has_more: more, first_id: (page[0] as { id: string } | undefined)?.id ?? null,
        last_id: (page.at(-1) as { id: string } | undefined)?.id ?? null }) };
    }

    const key = await resolveKey(sql, hash);
    const body = endpoint.startsWith('/v1/images/') ? await prepareMedia(request) : prepareInference(request, endpoint, key.id);
    const lease = await acquireLease(hash, endpoint, body);
    const { credential } = lease;
    const provider = credential.providerSlug;
    const started = performance.now();
    let statusLabel = '502';
    let upstreamStatus: number | undefined;
    let bytesSeen = false;
    let tracker: StreamUsageTracker | undefined;
    let finalized = false;
    let clientClosed = false;
    let streamOpened = false;
    let shouldDegrade: string | undefined;
    let upstreamAttempted = false;
    const timeout = AbortSignal.timeout(config.UPSTREAM_REQUEST_TIMEOUT_MS);
    const disconnect = new AbortController();
    const signal = AbortSignal.any([timeout, disconnect.signal]);
    const close = () => { clientClosed = true; disconnect.abort(); };
    reply.raw.once('close', close);
    if (reply.raw.destroyed) close();
    activeProxyRequests.inc({ provider });

    const finalize = async (result: Parameters<typeof finalizeUsage>[2]) => {
      await finalizeUsage(lease, body.model, result);
      finalized = true;
    };
    try {
      const upstreamSecret = decryptSecret(credential.encryptedKey);
      upstreamAttempted = true;
      const headers = nativeHeaders(upstreamHeaders(request, lease.key.id, upstreamSecret, lease.requestId), request, endpoint, upstreamSecret);
      headers.set('content-type', body.contentType);
      const response = await fetch(`${credential.baseUrl.replace(/\/+$/, '')}${body.upstreamPath}`, {
        method: 'POST', headers,
        body: new Uint8Array(body.buffer), redirect: 'manual', signal,
      });
      upstreamStatus = response.status;
      statusLabel = String(upstreamStatus);
      const observeFirstByte = () => {
        if (bytesSeen) return;
        bytesSeen = true;
        upstreamTimeToFirstByte.observe({ provider, endpoint }, (performance.now() - started) / 1000);
      };
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok) {
        if (bearerBlocked.has(response.status)) shouldDegrade = `Inference returned HTTP ${response.status}`;
        await response.body?.cancel().catch(() => undefined);
        await finalize({ usage: null, status: 'FAILED', httpStatus: response.status, errorCode: 'UPSTREAM_HTTP_ERROR' });
        updateClientHeaders(response, reply, lease.requestId);
        reply.type('application/json');
        if (shouldDegrade) {
          statusLabel = '503';
          throw unavailable();
        }
        const status = response.status >= 400 ? response.status : 502;
        statusLabel = String(status);
        if (status === 429) throw new AppError(429, 'MODEL_BUSY', 'The model is busy. Retry shortly');
        if (status < 500) throw new AppError(status, 'MODEL_REQUEST_REJECTED', 'The model rejected the request. Check the request fields and model');
        throw new AppError(status, 'MODEL_UNAVAILABLE', 'The model is temporarily unavailable');
      }

      updateClientHeaders(response, reply, lease.requestId);
      reply.code(response.status);
      if (!body.countOnly && contentType.includes('text/event-stream') && response.body) {
        tracker = new StreamUsageTracker(lease.rate.protocol);
        reply.hijack();
        streamOpened = true;
        reply.raw.statusCode = response.status;
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) reply.raw.setHeader(name, value);
        }
        const reader = response.body.getReader();
        const events = new PublicEventStream(lease.rate.protocol);
        reply.raw.flushHeaders();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            observeFirstByte();
            tracker.push(value);
            for (const event of events.push(value)) {
              if (!reply.raw.write(event)) await once(reply.raw, 'drain', { signal });
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        const tail = events.finish();
        if (tail && !reply.raw.write(tail)) await once(reply.raw, 'drain', { signal });
        if (!tracker.terminal || tracker.terminal === 'failed') statusLabel = '502';
        const ok = statusLabel !== '502';
        const hasUsage = tracker.observedUsage();
        await finalize({
          usage: hasUsage ?? (ok && body.images ? { ...emptyUsage, imageCount: body.images } : null),
          status: ok ? 'SUCCEEDED' : 'FAILED', httpStatus: response.status,
          // message_start can contain partial Anthropic usage. Without a terminal
          // event it is not a final bill, even when those counters are non-zero.
          errorCode: (!hasUsage && !body.images) || !tracker.terminal ? 'USAGE_UNCONFIRMED' : ok ? undefined : 'UPSTREAM_STREAM_FAILED',
        });
        if (!tracker.terminal) reply.raw.destroy();
        else reply.raw.end();
        return;
      }

      if (!contentType.includes('json')) {
        await response.body?.cancel();
        throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Expected a JSON or event-stream response');
      }
      const payload = await readBody(response, 32 * 1024 * 1024, observeFirstByte);
      let parsed: { status?: string; error?: unknown; data?: unknown[]; input_tokens?: unknown; totalTokens?: unknown };
      try { parsed = JSON.parse(payload.toString('utf8')); } catch { throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Provider returned invalid JSON'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Provider returned invalid JSON');
      if (body.countOnly) {
        const count = endpoint.endsWith('/countTokens') ? parsed.totalTokens : parsed.input_tokens;
        if (parsed.error || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Provider returned no valid token count');
        await finalize({ usage: null, status: 'SUCCEEDED', httpStatus: response.status });
        return reply.send(payload);
      }
      const ok = parsed.status !== 'failed' && !parsed.error;
      if (!ok) statusLabel = '502';
      if (body.images && ok && !Array.isArray(parsed.data)) {
        throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Provider returned no image results');
      }
      if (body.images && ok && parsed.data && (parsed.data.length > body.images || parsed.data.some(image => {
        if (!image || typeof image !== 'object') return true;
        const item = image as { b64_json?: unknown; url?: unknown };
        return !(typeof item.b64_json === 'string' && item.b64_json.length > 0)
          && !(typeof item.url === 'string' && /^https:\/\//.test(item.url));
      }))) throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Provider returned invalid image results');
      const imageCount = body.images && Array.isArray(parsed.data) ? parsed.data.length : 0;
      const measured = body.images ? (ok && imageCount > 0 ? { ...emptyUsage, imageCount } : null) : extractUsage(parsed, lease.rate.protocol);
      await finalize({ usage: measured,
        status: ok ? 'SUCCEEDED' : 'FAILED', httpStatus: response.status,
        errorCode: !measured && !body.images ? 'USAGE_UNCONFIRMED' : ok ? undefined : 'UPSTREAM_RESPONSE_FAILED' });
      if (!ok) throw new AppError(502, 'MODEL_RESPONSE_FAILED', 'The model could not complete the request');
      return reply.send(payload);
    } catch (error) {
      if (finalized) throw error;
      const code = clientClosed ? 'CLIENT_DISCONNECTED' : timeout.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE';
      statusLabel = clientClosed ? '499' : timeout.aborted ? '504' : '502';
      try {
        const known = tracker?.observedUsage() ?? null;
        const partialStream = streamOpened && tracker?.terminal !== 'completed' && tracker?.terminal !== 'incomplete';
        const unconfirmed = upstreamAttempted && (!known || partialStream)
          && (upstreamStatus === undefined || (upstreamStatus >= 200 && upstreamStatus < 300));
        await finalize({ usage: known, status: clientClosed ? 'CANCELLED' : 'FAILED', httpStatus: upstreamStatus,
          errorCode: unconfirmed ? `${code}_USAGE_UNCONFIRMED` : code });
      } catch {
        request.log.error({ requestId: lease.requestId }, 'Could not settle usage; lease left for expiry and reconciliation');
        proxyAccountingAnomalies.inc({ provider, kind: 'settlement_failed' });
      }
      if (streamOpened) reply.raw.destroy();
      else if (!clientClosed) {
        reply.removeHeader('content-type');
        if (error instanceof AppError) throw error;
        throw new AppError(timeout.aborted ? 504 : 502, code, 'Upstream request did not complete');
      }
    } finally {
      reply.raw.off('close', close);
      if (shouldDegrade) await markDegraded(credential, shouldDegrade).catch(() => {
        request.log.error({ requestId: lease.requestId }, 'Could not update upstream credential health');
      });
      activeProxyRequests.dec({ provider });
      proxyRequests.inc({ provider, endpoint, status: statusLabel });
      proxyDuration.observe({ provider, endpoint, status: statusLabel }, (performance.now() - started) / 1000);
    }
  });
}
