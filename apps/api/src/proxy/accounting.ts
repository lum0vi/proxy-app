import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { Decimal } from 'decimal.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { proxyAccountingAnomalies, usageCost } from '../observability/metrics.js';
import { selectCredentialWithCapacity } from '../services/capacity.js';
import { activePeakMultiplier, calculateUsageCost, retailMultiplier, retailUsageCost } from '../services/pricing.js';
import { prepareInference } from './request.js';
import { inferenceProtocols, type Protocol } from './protocols.js';
import type { Usage } from './usage.js';
import { validateMediaRate, type MediaOptions } from './media.js';

export interface KeyContext {
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

export interface CredentialContext {
  id: string;
  encryptedKey: string;
  maxConcurrency: number;
  providerSlug: string;
  baseUrl: string;
  spendLimit: string | null;
  spendUsed: string;
  availableModels: string[];
}

export interface ModelRate {
  poolId: string;
  protocol: Protocol;
  inputPerMillion: string;
  outputPerMillion: string;
  cachedInputPerMillion: string;
  perRequest: string;
  perSecond: string;
  mediaOptions: MediaOptions;
  longContextThreshold: number | null;
  longContextMultiplier: string;
  peakMultiplier: string | number;
}

export interface LeaseContext {
  id: string;
  requestId: string;
  key: KeyContext;
  credential: CredentialContext;
  rate: ModelRate;
}

type Inference = ReturnType<typeof prepareInference>;
type Outcome = 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export const emptyUsage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, imageCount: 0, estimated: false };
export const unavailable = () => new AppError(503, 'UPSTREAM_UNAVAILABLE', 'No verified upstream account is available for this key');

export function keyHash(request: FastifyRequest): string {
  const token = request.headers.authorization?.match(/^Bearer\s+(\S{1,300})$/i)?.[1]
    ?? request.headers['x-api-key'] ?? request.headers['x-goog-api-key'];
  if (typeof token !== 'string' || !/^\S{1,300}$/.test(token)) throw new AppError(401, 'INVALID_API_KEY', 'Missing or invalid API key');
  return sha256(token);
}

export async function resolveKey(db: postgres.Sql | postgres.TransactionSql, hash: string, lock = false, allowSpent = false): Promise<KeyContext> {
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
  if (!allowSpent && (key.status === 'EXHAUSTED' || (key.status === 'ACTIVE' && new Decimal(key.creditsUsed).gte(key.creditsTotal)))) {
    throw new AppError(402, 'CREDITS_EXHAUSTED', 'API key credits are exhausted');
  }
  if (key.status === 'EXPIRED' || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) {
    throw new AppError(403, 'API_KEY_EXPIRED', 'API key has expired');
  }
  if (key.status !== 'ACTIVE' && !(allowSpent && key.status === 'EXHAUSTED')) throw new AppError(403, 'API_KEY_INACTIVE', 'API key is inactive');
  if (!allowSpent && !key.poolActive) throw unavailable();
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

export async function acquireLease(hash: string, endpoint: string, requestBody: Inference, db?: postgres.TransactionSql): Promise<LeaseContext> {
  const { model, buffer, outputBudget, images } = requestBody;
  const acquire = async (transaction: postgres.TransactionSql) => {
    const key = await resolveKey(transaction, hash, true);
    const rates = await transaction<ModelRate[]>`
      SELECT pool_id, protocol, input_per_million::text, output_per_million::text, cached_input_per_million::text,
        per_request::text, per_second::text, media_options, long_context_threshold, long_context_multiplier::text, peak_multiplier::text
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
      if (requestBody.videoSeconds && new Decimal(row.perSecond).lte(0)) continue;
      try {
        // A failed candidate rolls back provisional assignment and row locks.
        selection = await transaction.savepoint(async (attempt) => {
          const rate = { ...row, peakMultiplier: activePeakMultiplier(row.peakMultiplier) };
          validateMediaRate(requestBody, rate.mediaOptions);
          const estimatedCost = requestBody.countOnly ? new Decimal(0) : calculateUsageCost({
            ...rate, inputTokens: images || requestBody.videoSeconds ? 0 : Math.ceil(buffer.length / 3), outputTokens: outputBudget,
            videoSeconds: requestBody.videoSeconds ?? 0,
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
  };
  return db ? acquire(db) : sql.begin(acquire);
}

export async function finalizeUsage(lease: LeaseContext, model: string, result: {
  usage: Usage | null; status: Outcome; httpStatus?: number | undefined; errorCode?: string | undefined;
}, db?: postgres.TransactionSql): Promise<void> {
  const { usage, status, httpStatus, errorCode } = result;
  const accounting = usage ?? emptyUsage;
  const measuredCost = usage ? calculateUsageCost({ ...usage, ...lease.rate }) : new Decimal(0);
  const cost = measuredCost.toDecimalPlaces(8);
  const settle = async (transaction: postgres.TransactionSql) => {
    const [balance] = await transaction<{ remaining: string }[]>`
      SELECT GREATEST(credits_total - credits_used, 0)::text AS remaining
      FROM api_keys WHERE id = ${lease.key.id} FOR UPDATE
    `;
    const charge = Decimal.min(balance?.remaining ?? 0,
      retailUsageCost(measuredCost, retailMultiplier(lease.key.amount, lease.key.wholesaleCredits)));
    const updated = await transaction`
      UPDATE usage_records SET input_tokens = ${accounting.inputTokens}, output_tokens = ${accounting.outputTokens},
        cached_input_tokens = ${accounting.cachedInputTokens}, image_count = ${accounting.imageCount}, video_seconds = ${accounting.videoSeconds ?? 0},
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
  };
  const posted = db ? await settle(db) : await sql.begin(settle);
  if (posted && cost.gt(0)) usageCost.inc({ provider: lease.credential.providerSlug, model }, cost.toNumber());
  if (posted && (accounting.estimated || errorCode?.includes('UNCONFIRMED'))) {
    proxyAccountingAnomalies.inc({ provider: lease.credential.providerSlug, kind: accounting.estimated ? 'estimated' : 'unconfirmed' });
  }
}

