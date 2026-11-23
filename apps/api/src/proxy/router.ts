import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { Decimal } from 'decimal.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { decryptSecret, sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import {
  activeProxyRequests, proxyAccountingAnomalies, proxyDuration, proxyRequests, usageCost, upstreamTimeToFirstByte,
} from '../observability/metrics.js';
import { selectCredentialWithCapacity } from '../services/capacity.js';
import { activePeakMultiplier, calculateUsageCost, retailMultiplier, retailUsageCost } from '../services/pricing.js';
import { enabledEndpoint, nativeHeaders, prepareInference, upstreamHeaders } from './request.js';
import { inferenceProtocols, type Protocol } from './protocols.js';
import { PublicEventStream } from './public-stream.js';
import { StreamUsageTracker, extractUsage, type Usage } from './usage.js';

interface KeyContext {
  id: string;
  status: string;
  creditsTotal: string;
  creditsUsed: string;
  concurrencyLimit: number;
  expiresAt: Date | null;
  upstreamCredentialId: string;
  primaryPoolId: string;
  poolId: string;
  amount: string;
  paymentProvider: string;
  testPayment: boolean;
  wholesaleCredits: string;
  userStatus: string;
  poolActive: boolean;
}

interface CredentialContext {
  id: string;
  encryptedKey: string;
  maxConcurrency: number;
  providerSlug: string;
  baseUrl: string;
  spendLimit: string | null;
  spendUsed: string;
  availableModels: string[];
}

interface ModelRate {
  poolId: string;
  protocol: Protocol;
  inputPerMillion: string;
  outputPerMillion: string;
  cachedInputPerMillion: string;
  perRequest: string;
  longContextThreshold: number | null;
  longContextMultiplier: string;
  peakMultiplier: string | number;
}

interface LeaseContext {
  id: string;
  requestId: string;
  key: KeyContext;
  credential: CredentialContext;
  rate: ModelRate;
}

type Inference = ReturnType<typeof prepareInference>;
type Outcome = 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

const emptyUsage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, imageCount: 0, estimated: false };
const bearerBlocked = new Set([401, 402, 403]);
const unavailable = () => new AppError(503, 'UPSTREAM_UNAVAILABLE', 'No verified upstream account is available for this key');

function keyHash(request: FastifyRequest): string {
  const token = request.headers.authorization?.match(/^Bearer\s+(\S{1,300})$/i)?.[1]
    ?? request.headers['x-api-key'] ?? request.headers['x-goog-api-key'];
  if (typeof token !== 'string' || !/^\S{1,300}$/.test(token)) throw new AppError(401, 'INVALID_API_KEY', 'Missing or invalid API key');
  return sha256(token);
}

async function resolveKey(db: postgres.Sql | postgres.TransactionSql, hash: string, lock = false): Promise<KeyContext> {
  const [key] = await db<KeyContext[]>`
    SELECT ak.id, ak.status, ak.credits_total::text, ak.credits_used::text, ak.concurrency_limit, ak.expires_at,
      ak.upstream_credential_id, uc.pool_id AS primary_pool_id, o.pool_id,
      COALESCE(o.credit_amount, o.amount)::text AS amount, o.payment_provider, o.wholesale_credits::text,
      (o.payment_provider = 'mock' OR COALESCE(o.metadata->>'testPayment' = 'true', false)) AS test_payment,
      u.status AS user_status, up.active AS pool_active
    FROM api_keys ak JOIN users u ON u.id = ak.user_id
    JOIN orders o ON o.id = ak.order_id
    JOIN upstream_credentials uc ON uc.id = ak.upstream_credential_id
    JOIN upstream_pools up ON up.id = o.pool_id
    WHERE ak.key_hash = ${hash}
    ${lock ? db`FOR UPDATE OF ak` : db``}
  `;
  if (!key) throw new AppError(401, 'INVALID_API_KEY', 'Invalid API key');
  if (key.testPayment && (config.NODE_ENV === 'production'
    || (key.paymentProvider === 'mock' ? !config.ALLOW_MOCK_PAYMENTS : !config.YOOKASSA_TEST_MODE))) {
    throw new AppError(403, 'TEST_KEY_DISABLED', 'Test payment keys are not enabled in this environment');
  }
  if (key.userStatus !== 'ACTIVE') throw new AppError(403, 'USER_INACTIVE', 'This account is suspended');
  if (key.status === 'EXHAUSTED' || (key.status === 'ACTIVE' && new Decimal(key.creditsUsed).gte(key.creditsTotal))) {
    throw new AppError(402, 'CREDITS_EXHAUSTED', 'API key credits are exhausted');
  }
  if (key.status === 'EXPIRED' || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) {
    throw new AppError(403, 'API_KEY_EXPIRED', 'API key has expired');
  }
  if (key.status !== 'ACTIVE') throw new AppError(403, 'API_KEY_INACTIVE', 'API key is inactive');
  if (!key.poolActive) throw unavailable();
  return key;
}

const busy = () => new AppError(429, 'UPSTREAM_BUSY', 'The model is busy. Retry shortly');

async function activeCredential(transaction: postgres.TransactionSql, key: KeyContext, rate: ModelRate, model: string, minimumBudget: string): Promise<CredentialContext> {
  const [assignment] = await transaction<{ upstreamCredentialId: string }[]>`
    SELECT upstream_credential_id FROM api_key_channel_assignments
    WHERE api_key_id = ${key.id} AND pool_id = ${rate.poolId}
  `;
  const assignedId = rate.poolId === key.primaryPoolId ? key.upstreamCredentialId : assignment?.upstreamCredentialId;

  async function find(id: string) {
    const [credential] = await transaction<CredentialContext[]>`
      SELECT uc.id, uc.encrypted_key, uc.max_concurrency, uc.spend_limit::text, uc.spend_used::text, uc.available_models,
        up.slug AS provider_slug, up.base_url
      FROM upstream_credentials uc JOIN upstream_pools up ON up.id = uc.pool_id
      JOIN sellable_upstream_slots s ON s.id = uc.id
      WHERE uc.id = ${id} AND uc.pool_id = ${rate.poolId} AND ${model} = ANY(uc.available_models)
        AND (NOT s.test_only OR ${key.paymentProvider === 'mock'})
        AND (uc.spend_limit IS NULL OR uc.spend_limit - uc.spend_used - COALESCE((
          SELECT sum(lease.reserved_cost) FROM request_leases lease
          WHERE lease.upstream_credential_id = uc.id AND lease.expires_at > now()
        ), 0) >= ${minimumBudget}::numeric)
      FOR UPDATE OF uc
    `;
    return credential;
  }

  const assigned = assignedId ? await find(assignedId) : undefined;
  if (assigned) return assigned;
  const replacement = await selectCredentialWithCapacity(transaction, rate.poolId, {
    model, minimumBudget, apiKeyId: key.id, allowTest: key.paymentProvider === 'mock',
  }).catch(async error => {
    if (assignedId && error instanceof AppError && error.code === 'NO_UPSTREAM_CAPACITY') {
      const [previousModel] = await transaction`SELECT 1 FROM upstream_credentials
        WHERE id = ${assignedId} AND ${model} = ANY(available_models)`;
      if (previousModel) throw unavailable();
    }
    throw error;
  });
  const credential = await find(replacement.id);
  if (!credential) throw unavailable();
  if (rate.poolId === key.primaryPoolId) {
    await transaction`UPDATE api_keys SET upstream_credential_id = ${credential.id}, updated_at = now() WHERE id = ${key.id}`;
  } else {
    await transaction`
      INSERT INTO api_key_channel_assignments (api_key_id, pool_id, upstream_credential_id)
      VALUES (${key.id}, ${rate.poolId}, ${credential.id})
      ON CONFLICT (api_key_id, pool_id) DO UPDATE SET upstream_credential_id = EXCLUDED.upstream_credential_id
    `;
  }
  return credential;
}

async function listModels(hash: string, gemini: boolean) {
  const key = await resolveKey(sql, hash);
  const rows = await sql<{ model: string; protocol: Protocol }[]>`
    SELECT model, protocol FROM usable_key_models
    WHERE api_key_id = ${key.id} AND (${!gemini} OR protocol = 'GEMINI') ORDER BY model
  `;
  if (gemini) return { models: rows.map(({ model }) => ({
    name: `models/${model}`, displayName: model, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
  })) };
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

async function acquireLease(hash: string, endpoint: string, requestBody: Inference): Promise<LeaseContext> {
  const { model, buffer, outputBudget, images } = requestBody;
  return sql.begin(async (transaction) => {
    const key = await resolveKey(transaction, hash, true);
    const rates = await transaction<ModelRate[]>`
      SELECT pool_id, protocol, input_per_million::text, output_per_million::text, cached_input_per_million::text,
        per_request::text, long_context_threshold, long_context_multiplier::text, peak_multiplier::text
      FROM routable_pool_models WHERE root_pool_id = ${key.poolId} AND model = ${model}
        AND protocol = ANY(${transaction.array(inferenceProtocols[endpoint] ?? [])}::text[])
      ORDER BY routing_priority DESC, pool_id
    `;
    if (rates.length === 0) throw new AppError(404, 'MODEL_NOT_PRICED', 'This model is not enabled for this API endpoint');
    const multiplier = retailMultiplier(key.amount, key.wholesaleCredits);
    let selection: { credential: CredentialContext; rate: ModelRate; estimate: Decimal; customerEstimate: Decimal } | undefined;
    let lastError: AppError | undefined;
    for (const row of rates) {
      if (images && new Decimal(row.perRequest).lte(0)) continue;
      try {
        // A failed candidate rolls back provisional assignment and row locks.
        selection = await transaction.savepoint(async (attempt) => {
          const rate = { ...row, peakMultiplier: activePeakMultiplier(row.peakMultiplier) };
          const estimatedCost = calculateUsageCost({
            ...rate, inputTokens: images ? 0 : Math.ceil(buffer.length / 3), outputTokens: outputBudget,
            cachedInputTokens: 0, imageCount: images, cacheWrite1hTokens: requestBody.cacheWrite ? Math.ceil(buffer.length / 3) : 0,
          });
          const estimate = estimatedCost.toDecimalPlaces(8);
          const customerEstimate = retailUsageCost(estimatedCost, multiplier);
          const credential = await activeCredential(attempt, key, rate, model, estimate.toFixed(8));
          const [leases] = await attempt<{ keyCount: number; credentialCount: number; keyReserved: string; credentialReserved: string }[]>`
            SELECT count(*) FILTER (WHERE api_key_id = ${key.id})::int AS key_count,
              count(*) FILTER (WHERE upstream_credential_id = ${credential.id})::int AS credential_count,
              COALESCE(sum(retail_reserved_cost) FILTER (WHERE api_key_id = ${key.id}), 0)::text AS key_reserved,
              COALESCE(sum(reserved_cost) FILTER (WHERE upstream_credential_id = ${credential.id}), 0)::text AS credential_reserved
            FROM request_leases WHERE expires_at > now() AND (api_key_id = ${key.id} OR upstream_credential_id = ${credential.id})
          `;
          if ((leases?.keyCount ?? 0) >= key.concurrencyLimit) throw new AppError(429, 'KEY_CONCURRENCY_LIMIT', 'API key concurrency limit reached');
          if ((leases?.credentialCount ?? 0) >= credential.maxConcurrency) throw busy();
          if (customerEstimate.gt(new Decimal(key.creditsTotal).sub(key.creditsUsed).sub(leases?.keyReserved ?? '0'))) {
            throw new AppError(402, 'INSUFFICIENT_CREDITS', 'Not enough balance for this request. Reduce the output limit or add balance');
          }
          if (credential.spendLimit !== null
            && estimate.gt(new Decimal(credential.spendLimit).sub(credential.spendUsed).sub(leases?.credentialReserved ?? '0'))) {
            throw new AppError(503, 'UPSTREAM_BUDGET_UNAVAILABLE', 'The model is temporarily unavailable');
          }
          return { credential, rate, estimate, customerEstimate };
        });
        break;
      } catch (error) {
        if (!(error instanceof AppError) || error.code === 'KEY_CONCURRENCY_LIMIT') throw error;
        if (error.code !== 'NO_UPSTREAM_CAPACITY') lastError ??= error;
      }
    }
    if (!selection) {
      if (lastError) throw lastError;
      const [channel] = await transaction`SELECT 1 FROM sellable_upstream_slots s WHERE s.pool_id = ANY(${transaction.array(rates.map(({ poolId }) => poolId))}::uuid[]) LIMIT 1`;
      if (channel) throw new AppError(404, 'MODEL_NOT_AVAILABLE', 'This model is not currently available for your key');
      throw unavailable();
    }
    const { credential, rate, estimate, customerEstimate } = selection;
    const [lease] = await transaction<{ id: string }[]>`
      INSERT INTO request_leases (api_key_id, upstream_credential_id, expires_at, reserved_cost, retail_reserved_cost)
      VALUES (${key.id}, ${credential.id}, ${new Date(Date.now() + config.UPSTREAM_REQUEST_TIMEOUT_MS + 60_000)},
        ${estimate.toFixed(8)}, ${customerEstimate.toFixed(8)}) RETURNING id
    `;
    if (!lease) throw new Error('Request lease was not created');
    const requestId = randomUUID();
    await transaction`
      INSERT INTO usage_records (api_key_id, upstream_credential_id, request_id, endpoint, model, status)
      VALUES (${key.id}, ${credential.id}, ${requestId}, ${endpoint}, ${model}, 'STARTED')
    `;
    return { id: lease.id, requestId, key, credential, rate };
  });
}

async function finalizeUsage(lease: LeaseContext, model: string, result: {
  usage: Usage | null; status: Outcome; httpStatus?: number | undefined; errorCode?: string | undefined;
}): Promise<void> {
  const { usage, status, httpStatus, errorCode } = result;
  const accounting = usage ?? emptyUsage;
  const measuredCost = usage ? calculateUsageCost({ ...usage, ...lease.rate }) : new Decimal(0);
  const cost = measuredCost.toDecimalPlaces(8);
  const posted = await sql.begin(async (transaction) => {
    const [balance] = await transaction<{ remaining: string }[]>`
      SELECT GREATEST(credits_total - credits_used, 0)::text AS remaining
      FROM api_keys WHERE id = ${lease.key.id} FOR UPDATE
    `;
    const charge = Decimal.min(balance?.remaining ?? 0,
      retailUsageCost(measuredCost, retailMultiplier(lease.key.amount, lease.key.wholesaleCredits)));
    const updated = await transaction`
      UPDATE usage_records SET input_tokens = ${accounting.inputTokens}, output_tokens = ${accounting.outputTokens},
        cached_input_tokens = ${accounting.cachedInputTokens}, image_count = ${accounting.imageCount},
        cache_write_5m_tokens = ${accounting.cacheWrite5mTokens ?? 0}, cache_write_1h_tokens = ${accounting.cacheWrite1hTokens ?? 0},
        cost = ${cost.toFixed(8)}, retail_cost = ${charge.toFixed(8)}, status = ${status}, http_status = ${httpStatus ?? null},
        error_code = ${errorCode ?? (accounting.estimated ? 'ESTIMATED_USAGE' : null)}, completed_at = now()
      WHERE request_id = ${lease.requestId} AND status = 'STARTED' RETURNING id
    `;
    if (updated.length && (cost.gt(0) || charge.gt(0))) {
      await transaction`
        UPDATE api_keys SET credits_used = credits_used + ${charge.toFixed(8)}, last_used_at = now(),
          status = CASE WHEN status = 'ACTIVE' AND credits_used + ${charge.toFixed(8)} >= credits_total THEN 'EXHAUSTED' ELSE status END,
          updated_at = now() WHERE id = ${lease.key.id}
      `;
      await transaction`
        UPDATE upstream_credentials SET spend_used = spend_used + ${cost.toFixed(8)},
          status = CASE WHEN status IN ('ACTIVE', 'DEGRADED') AND spend_limit IS NOT NULL
            AND spend_used + ${cost.toFixed(8)} >= spend_limit THEN 'EXHAUSTED' ELSE status END,
          last_used_at = now(), updated_at = now() WHERE id = ${lease.credential.id}
      `;
    }
    if (updated.length && errorCode?.includes('UNCONFIRMED')) {
      // Keep the reservation briefly after an unconfirmed request. A client cannot
      // continuously cancel streams and immediately reuse the same reserved balance.
      await transaction`UPDATE request_leases SET expires_at = ${new Date(Date.now() + config.PROXY_UNCONFIRMED_COOLDOWN_MS)}
        WHERE id = ${lease.id}`;
    } else await transaction`DELETE FROM request_leases WHERE id = ${lease.id}`;
    return updated.length > 0;
  });
  if (posted && cost.gt(0)) usageCost.inc({ provider: lease.credential.providerSlug, model }, cost.toNumber());
  if (posted && (accounting.estimated || errorCode?.includes('UNCONFIRMED'))) {
    proxyAccountingAnomalies.inc({ provider: lease.credential.providerSlug, kind: accounting.estimated ? 'estimated' : 'unconfirmed' });
  }
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
  for (const prefix of ['/v1/*', '/v1beta/*']) app.all(prefix, { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    const endpoint = enabledEndpoint(request);
    const hash = keyHash(request);
    if (endpoint === '/v1/models' || endpoint === '/v1beta/models') {
      reply.header('cache-control', 'no-store');
      return listModels(hash, endpoint === '/v1beta/models');
    }

    const key = await resolveKey(sql, hash);
    const body = prepareInference(request, endpoint, key.id);
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
      if (contentType.includes('text/event-stream') && response.body) {
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
      let parsed: { status?: string; error?: unknown; data?: unknown[] };
      try { parsed = JSON.parse(payload.toString('utf8')); } catch { throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Provider returned invalid JSON'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Provider returned invalid JSON');
      const ok = parsed.status !== 'failed' && !parsed.error;
      if (!ok) statusLabel = '502';
      if (body.images && ok && !Array.isArray(parsed.data)) {
        throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Provider returned no image results');
      }
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
