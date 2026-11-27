import { inspectTonTransaction } from '../services/ton-payments.js';
import type { FastifyInstance } from 'fastify';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { tonHash } from '../lib/ton.js';
import { requireAuth } from '../auth/session.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { decryptSecret, encryptSecret, generateApiKey, keyHint, sha256, verifyPassword } from '../lib/crypto.js';
import { AppError, assertFound } from '../lib/errors.js';
import { createOrder, markOrderPaid, tryFulfillPaidOrder } from '../services/orders.js';
import { activePeakMultiplier, calculateUsageCost, moneyString, retailMultiplier, retailPrice, retailUsageCost } from '../services/pricing.js';
import type { Protocol } from '../proxy/protocols.js';
import { getPriceRates } from '../services/price-rates.js';
import type { AuthenticatedRequest } from '../types.js';

const createOrderSchema = z.object({
  productId: z.string().uuid(),
  paymentProvider: z.enum(['yookassa', 'nowpayments', 'ton', 'mock']),
  paymentCurrency: z.enum(['RUB', 'USDT']).optional(),
  topUpKeyId: z.string().uuid().optional(),
});

const passwordSchema = z.object({ password: z.string().min(1).max(200) });

const estimateSchema = z.object({
  model: z.string().min(1).max(200),
  inputTokens: z.coerce.number().int().min(0).max(1_100_000).default(0),
  imageCount: z.coerce.number().int().min(1).max(10).optional(),
  videoSeconds: z.coerce.number().int().min(1).max(120).optional(),
  cachedInputTokens: z.coerce.number().int().min(0).max(1_000_000).default(0),
  cacheWrite5mTokens: z.coerce.number().int().min(0).max(1_000_000).default(0),
  cacheWrite1hTokens: z.coerce.number().int().min(0).max(1_000_000).default(0),
  outputTokens: z.coerce.number().int().min(0).max(128_000).default(0),
}).refine(({ cachedInputTokens, cacheWrite5mTokens, cacheWrite1hTokens, inputTokens }) => cachedInputTokens + cacheWrite5mTokens + cacheWrite1hTokens <= inputTokens, {
  path: ['cachedInputTokens'], message: 'Cache reads and writes cannot exceed total input',
});

const usageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().uuid().optional(),
});

interface EstimateRate {
  wholesaleCredits: string;
  protocol: Protocol;
  peakMultiplier: string;
  inputPerMillion: string;
  cachedInputPerMillion: string;
  outputPerMillion: string;
  perRequest: string;
  perSecond: string;
  mediaOptions: Record<string, (string | number | boolean)[]>;
  longContextThreshold: number | null;
  longContextMultiplier: string;
}

export async function storeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/products', async () => {
    const rows = await sql<({
      wholesaleCredits: string;
      inventory: number;
      models: (Omit<EstimateRate, 'wholesaleCredits'> & { model: string; available: boolean })[];
      unpricedModels: { model: string; protocol: Protocol }[];
    } & Record<string, unknown>)[]>`
      SELECT p.id, p.name, p.slug, p.description, p.wholesale_credits::text, p.currency,
        p.duration_days, p.concurrency_limit,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'model', r.model, 'available', r.available, 'protocol', r.protocol,
            'inputPerMillion', r.input_per_million::text, 'cachedInputPerMillion', r.cached_input_per_million::text,
            'outputPerMillion', r.output_per_million::text, 'perRequest', r.per_request::text,
            'perSecond', r.per_second::text, 'mediaOptions', r.media_options,
            'longContextThreshold', r.long_context_threshold, 'longContextMultiplier', r.long_context_multiplier::text,
            'peakMultiplier', r.peak_multiplier::text
          ) ORDER BY r.model)
          FROM public_pool_models r WHERE r.root_pool_id = p.pool_id
        ), '[]'::jsonb) AS models,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('model', r.model, 'protocol', r.protocol) ORDER BY r.model)
          FROM unpriced_pool_models r WHERE r.root_pool_id = p.pool_id), '[]'::jsonb) AS unpriced_models,
        COALESCE((SELECT sum(COALESCE(s.free_slots, 1))::int
          FROM sellable_upstream_slots s JOIN pool_channels c USING (pool_id) WHERE c.root_pool_id = up.id), 0) AS inventory
      FROM products p JOIN upstream_pools up ON up.id = p.pool_id
      WHERE p.active AND up.active
      ORDER BY p.wholesale_credits ASC, p.slug ASC
    `;
    return {
      products: rows.map(({ wholesaleCredits, models, ...product }) => {
        const price = retailPrice(wholesaleCredits);
        const factor = retailMultiplier(price, wholesaleCredits);
        return {
          ...product,
          usageAllowance: price.toFixed(8),
          retailPrice: price.toFixed(2),
          inventory: config.salesEnabled && price.gt(0) ? product.inventory : 0,
          models: models.map((rate) => ({
            ...rate, inputPerMillion: moneyString(new Decimal(rate.inputPerMillion).mul(factor), 12),
            cachedInputPerMillion: moneyString(new Decimal(rate.cachedInputPerMillion).mul(factor), 12),
            outputPerMillion: moneyString(new Decimal(rate.outputPerMillion).mul(factor), 12),
            perRequest: moneyString(new Decimal(rate.perRequest).mul(factor), 12),
            perSecond: moneyString(new Decimal(rate.perSecond).mul(factor), 12),
          })),
        };
      }),
      paymentMethods: config.salesEnabled ? config.paymentMethods : [],
      paymentCurrencies: config.salesEnabled ? config.paymentCurrencies : [],
      cryptoCurrency: config.paymentMethods.some(method => ['nowpayments', 'ton'].includes(method)) && config.salesEnabled ? 'USDT' : null,
      cryptoNetwork: config.paymentMethods.some(method => ['nowpayments', 'ton'].includes(method)) && config.salesEnabled ? 'TON' : null,
      currency: 'USDT',
    };
  });

  app.get('/api/price-rates', async () => ({ rates: await getPriceRates() }));

  app.get('/api/products/:id/estimate', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const usage = estimateSchema.parse(request.query);
    const [rate] = await sql<EstimateRate[]>`
      SELECT p.wholesale_credits::text, r.protocol, r.input_per_million::text, r.cached_input_per_million::text,
        r.output_per_million::text, r.per_request::text, r.per_second::text, r.media_options, r.long_context_threshold, r.long_context_multiplier::text, r.peak_multiplier::text
      FROM products p JOIN public_pool_models r ON r.root_pool_id = p.pool_id
      WHERE p.id = ${id} AND p.active AND r.model = ${usage.model}
    `;
    const terms = assertFound(rate, 'PRODUCT_RATE_NOT_FOUND', 'This model has no public rate for the package');
    const imageCount = usage.imageCount ?? (terms.protocol === 'IMAGES' ? 1 : 0);
    const videoSeconds = usage.videoSeconds ?? 0;
    if ((terms.protocol === 'VIDEOS' ? new Decimal(terms.perSecond).lte(0) || !terms.mediaOptions.seconds?.includes(videoSeconds)
        || imageCount !== 0 || usage.inputTokens + usage.outputTokens > 0
      : terms.protocol === 'IMAGES' ? new Decimal(terms.perRequest).lte(0) || usage.inputTokens + usage.outputTokens > 0 || videoSeconds > 0
      : imageCount !== 0 || videoSeconds > 0 || usage.inputTokens + usage.outputTokens === 0)
      || (terms.protocol !== 'ANTHROPIC' && usage.cacheWrite5mTokens + usage.cacheWrite1hTokens > 0)) {
      throw new AppError(400, 'INVALID_ESTIMATE', 'Enter usage for the selected model');
    }
    const price = retailPrice(terms.wholesaleCredits);
    const peak = activePeakMultiplier(terms.peakMultiplier);
    const cost = retailUsageCost(calculateUsageCost({
      ...usage, ...terms, peakMultiplier: peak, imageCount, videoSeconds,
      inputTokens: imageCount ? 0 : usage.inputTokens, outputTokens: imageCount ? 0 : usage.outputTokens,
    }), retailMultiplier(price, terms.wholesaleCredits));
    return {
      cost: cost.toFixed(8),
      currency: 'USDT',
      requestsPerKey: cost.gt(0) ? price.dividedToIntegerBy(cost).toFixed(0) : null,
      longContextApplied: !imageCount && terms.longContextThreshold !== null && usage.inputTokens > terms.longContextThreshold,
      peakApplied: Number(peak) > 1,
    };
  });

  app.post('/api/orders', { preHandler: requireAuth }, async (request, reply) => {
    const body = createOrderSchema.parse(request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const order = await createOrder({ ...body, userId: user.id, userEmail: user.email });
    return reply.code(201).send({ order });
  });

  app.get('/api/orders', { preHandler: requireAuth }, async (request) => {
    const userId = (request as AuthenticatedRequest).authUser.id;
    const orders = await sql<Record<string, unknown>[]>`
      SELECT o.id, o.status, o.payment_provider, o.amount::text, o.currency,
        COALESCE(o.credit_amount, o.amount)::text AS credit_amount, o.usdt_rub_rate::text, o.exchange_rate_at, o.checkout_url,
        o.metadata, o.reserved_until, o.paid_at, o.fulfilled_at, o.created_at,
        o.grant_label AS product_name, o.top_up_key_id, ak.id AS api_key_id, ak.key_hint
      FROM orders o
      LEFT JOIN api_keys ak ON (o.top_up_key_id IS NULL AND ak.order_id = o.id)
        OR (o.status = 'FULFILLED' AND ak.id = o.top_up_key_id)
      WHERE o.user_id = ${userId}
      ORDER BY o.created_at DESC
    `;
    return { orders };
  });

  app.get('/api/orders/:id', { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const userId = (request as AuthenticatedRequest).authUser.id;
    const [order] = await sql<Record<string, unknown>[]>`
      SELECT o.id, o.status, o.payment_provider, o.amount::text, o.currency,
        COALESCE(o.credit_amount, o.amount)::text AS credit_amount, o.usdt_rub_rate::text, o.exchange_rate_at, o.checkout_url,
        o.metadata, o.reserved_until, o.paid_at, o.fulfilled_at, o.created_at,
        o.grant_label AS product_name, o.top_up_key_id, ak.id AS api_key_id, ak.key_hint
      FROM orders o
      LEFT JOIN api_keys ak ON (o.top_up_key_id IS NULL AND ak.order_id = o.id)
        OR (o.status = 'FULFILLED' AND ak.id = o.top_up_key_id)
      WHERE o.id = ${params.id} AND o.user_id = ${userId}
    `;
    return { order: assertFound(order, 'ORDER_NOT_FOUND', 'Order not found') };
  });

  app.post('/api/orders/:id/payment-claim', { preHandler: requireAuth }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { transactionHash } = z.object({ transactionHash: z.string().trim().min(43).max(64) }).parse(request.body);
    let hash: string;
    try { hash = tonHash(transactionHash); } catch { throw new AppError(400, 'INVALID_TRANSACTION_HASH', 'Enter a TON transaction hash'); }
    const userId = (request as AuthenticatedRequest).authUser.id;
    const [invoice] = await sql`SELECT metadata FROM orders WHERE id = ${id} AND user_id = ${userId} AND payment_provider = 'ton'`;
    if (assertFound(invoice, 'ORDER_NOT_FOUND', 'TON invoice not found').metadata.verification === 'txid') {
      await inspectTonTransaction(id, hash, true);
      return { verified: true };
    }
    // A public hash is not proof that the submitter owns a payment. This only opens a review request.
    const [order] = await sql`UPDATE orders SET metadata = metadata || ${sql.json({
      paymentClaim: { transactionHash: hash, submittedAt: new Date().toISOString() },
    })}, updated_at = now() WHERE id = ${id} AND user_id = ${userId} AND payment_provider = 'ton'
      AND status NOT IN ('PAID', 'FULFILLED', 'REFUNDED') RETURNING id`;
    assertFound(order, 'ORDER_NOT_FOUND', 'Unpaid TON order not found');
    return { submitted: true };
  });

  app.post('/api/payments/mock/:orderId/complete', { preHandler: requireAuth }, async (request) => {
    if (!config.ALLOW_MOCK_PAYMENTS || config.NODE_ENV === 'production') {
      throw new AppError(404, 'NOT_FOUND', 'Not found');
    }
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const userId = (request as AuthenticatedRequest).authUser.id;
    await sql.begin(async (transaction) => {
      const [order] = await transaction<{ id: string }[]>`
        SELECT id FROM orders
        WHERE id = ${params.orderId} AND user_id = ${userId} AND payment_provider = 'mock'
          AND (status IN ('PAID', 'FULFILLED') OR (status = 'PENDING' AND reserved_until > now()))
        FOR UPDATE
      `;
      assertFound(order, 'ORDER_NOT_FOUND', 'Pending mock order not found');
      await markOrderPaid(params.orderId, transaction);
    });
    await tryFulfillPaidOrder(params.orderId);
    return { ok: true };
  });

  app.get('/api/keys', { preHandler: requireAuth }, async (request, reply) => {
    const userId = (request as AuthenticatedRequest).authUser.id;
    const keys = await sql<Record<string, unknown>[]>`
      SELECT ak.id, ak.label, ak.key_hint, ak.status, ak.credits_total::text, ak.credits_used::text, ak.currency,
        COALESCE((SELECT sum(l.retail_reserved_cost) FROM request_leases l WHERE l.api_key_id = ak.id AND l.expires_at > now()), 0)::text AS reserved_credits,
        ak.concurrency_limit, ak.expires_at, ak.last_used_at, ak.created_at, o.payment_provider = 'mock' AS test_key,
        ARRAY(
          SELECT p.id FROM products p JOIN upstream_pools up ON up.id = p.pool_id
          WHERE p.pool_id = o.pool_id AND p.active AND up.active AND p.duration_days IS NULL
            AND ak.status IN ('ACTIVE', 'EXHAUSTED') AND ak.expires_at IS NULL
        ) AS top_up_product_ids,
        ARRAY(SELECT DISTINCT m.model FROM usable_key_models m WHERE m.api_key_id = ak.id ORDER BY m.model) AS models,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('model', m.model, 'protocol', m.protocol, 'mediaOptions', r.media_options) ORDER BY m.model, m.protocol)
          FROM usable_key_models m JOIN public_pool_models r ON r.root_pool_id = o.pool_id AND r.model = m.model AND r.protocol = m.protocol
          WHERE m.api_key_id = ak.id), '[]'::jsonb) AS model_options
      FROM api_keys ak JOIN orders o ON o.id = ak.order_id
      WHERE ak.user_id = ${userId}
      ORDER BY ak.created_at DESC
    `;
    return reply.header('cache-control', 'private, no-store').send({ keys });
  });

  app.get('/api/keys/:id/usage', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { limit, before } = usageQuerySchema.parse(request.query);
    const userId = (request as AuthenticatedRequest).authUser.id;
    const [key] = await sql<{ id: string }[]>`SELECT id FROM api_keys WHERE id = ${id} AND user_id = ${userId}`;
    assertFound(key, 'KEY_NOT_FOUND', 'API key not found');

    const rows = await sql<({ id: string } & Record<string, unknown>)[]>`
      SELECT id, request_id, endpoint, model, input_tokens::text, output_tokens::text, cached_input_tokens::text,
        cache_write_5m_tokens::text, cache_write_1h_tokens::text,
        image_count, video_seconds, retail_cost::text AS cost, status, http_status, error_code, started_at, completed_at
      FROM usage_records WHERE api_key_id = ${id}
      ${before ? sql`AND (started_at, id) < (SELECT started_at, id FROM usage_records WHERE id = ${before} AND api_key_id = ${id})` : sql``}
      ORDER BY started_at DESC, id DESC LIMIT ${limit + 1}
    `;
    const usage = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? usage.at(-1)?.id ?? null : null;
    return reply.header('cache-control', 'private, no-store').send({ usage, nextCursor, currency: 'USDT' });
  });

  app.post('/api/keys/:id/reveal', { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = passwordSchema.parse(request.body);
    const userId = (request as AuthenticatedRequest).authUser.id;
    const [row] = await sql<{ encryptedKey: string; passwordHash: string }[]>`
      SELECT ak.encrypted_key, u.password_hash
      FROM api_keys ak JOIN users u ON u.id = ak.user_id
      WHERE ak.id = ${params.id} AND ak.user_id = ${userId}
    `;
    const key = assertFound(row, 'KEY_NOT_FOUND', 'API key not found');
    if (!(await verifyPassword(body.password, key.passwordHash))) {
      throw new AppError(401, 'INVALID_PASSWORD', 'Invalid password');
    }
    return reply.header('cache-control', 'no-store').send({ apiKey: decryptSecret(key.encryptedKey) });
  });

  app.post('/api/keys/:id/rotate', { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = passwordSchema.parse(request.body);
    const userId = (request as AuthenticatedRequest).authUser.id;
    const [user] = await sql<{ passwordHash: string }[]>`SELECT password_hash FROM users WHERE id = ${userId}`;
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new AppError(401, 'INVALID_PASSWORD', 'Invalid password');
    }
    const secret = generateApiKey();
    const rows = await sql<{ id: string }[]>`
      UPDATE api_keys SET key_hash = ${sha256(secret)}, encrypted_key = ${encryptSecret(secret)},
        key_hint = ${keyHint(secret)}, updated_at = now()
      WHERE id = ${params.id} AND user_id = ${userId} AND status IN ('ACTIVE', 'PAUSED', 'EXHAUSTED')
      RETURNING id
    `;
    assertFound(rows[0], 'KEY_NOT_FOUND', 'Active API key not found');
    return reply.header('cache-control', 'no-store').send({ apiKey: secret });
  });

  app.post('/api/keys/:id/revoke', { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const userId = (request as AuthenticatedRequest).authUser.id;
    await sql.begin(async (transaction) => {
      const [key] = await transaction<{ id: string }[]>`
        SELECT id FROM api_keys WHERE id = ${params.id} AND user_id = ${userId} AND status <> 'REVOKED' FOR UPDATE
      `;
      assertFound(key, 'KEY_NOT_FOUND', 'API key not found');
      const [pending] = await transaction`
        SELECT id FROM orders WHERE top_up_key_id = ${params.id}
          AND (status = 'PAID' OR (status = 'PENDING' AND reserved_until > now())) LIMIT 1
      `;
      if (pending) throw new AppError(409, 'KEY_TOP_UP_PENDING', 'A top-up is pending for this key');
      await transaction`UPDATE api_keys SET status = 'REVOKED', updated_at = now() WHERE id = ${params.id}`;
    });
    return reply.code(204).send();
  });
}
