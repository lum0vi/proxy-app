import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { requireAdmin } from '../auth/session.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { encryptSecret, keyHint, upstreamKeyFingerprint } from '../lib/crypto.js';
import { AppError, assertFound } from '../lib/errors.js';
import { protocols } from '../proxy/protocols.js';
import { adminVideoRoutes } from '../proxy/videos.js';
import { isDuplicateUpstreamKey, refreshUpstreamCatalog } from '../services/upstream-catalog.js';
import { updateUserAccess } from '../services/user-access.js';
import { providerBalanceStatus } from '../services/provider-balances.js';
import { listProviderKeys, listUserKeys, requestProviderKeyRefresh } from '../services/provider-keys.js';
import type { AuthenticatedRequest } from '../types.js';
import { inspectTonTransaction, reviewTonPayment, tonPaymentOverview } from '../services/ton-payments.js';

const poolSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z.string().regex(/^[a-z0-9-]+$/).max(80),
  baseUrl: z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || (config.NODE_ENV !== 'production' && url.protocol === 'http:'))
        && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }, 'Use a plain HTTPS API base URL (HTTP is allowed in development)')
    .transform((value) => value.replace(/\/+$/, '').replace(/\/v1(?:beta)?$/, '')),
  credentialCapacity: z.number().int().min(1).max(1000).default(config.USERS_PER_UPSTREAM_KEY),
  protocol: z.enum(protocols).default('OPENAI'),
  parentPoolId: z.string().uuid().nullable().default(null),
  routingPriority: z.number().int().min(0).max(10_000).default(0),
  active: z.boolean().default(true),
});

const credentialSchema = z.object({
  label: z.string().trim().min(2).max(100),
  apiKey: z.string().trim().min(8).max(2000),
  priority: z.number().int().min(0).max(10_000).default(100),
  maxConcurrency: z.number().int().min(1).max(1000).default(8),
  spendLimit: z.string().regex(/^\d+(?:\.\d+)?$/).nullable().optional(),
  testOnly: z.boolean().default(false),
});
const keyListQuery = z.object({
  activeOnly: z.enum(['true', 'false']).default('true').transform(value => value === 'true'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const productSchema = z.object({
  poolId: z.string().uuid(),
  name: z.string().trim().min(2).max(100),
  slug: z.string().regex(/^[a-z0-9-]+$/).max(80),
  description: z.string().max(1000).default(''),
  wholesaleCredits: z.string().regex(/^\d+(?:\.\d+)?$/),
  currency: z.string().transform((value) => value.toUpperCase()).pipe(z.literal('USDT')),
  durationDays: z.number().int().positive().nullable().optional(),
  concurrencyLimit: z.number().int().min(1).max(1000),
  active: z.boolean().default(true),
});

const rateSchema = z.object({
  poolId: z.string().uuid(),
  model: z.string().trim().min(1).max(200),
  inputPerMillion: z.string().regex(/^\d+(?:\.\d+)?$/),
  outputPerMillion: z.string().regex(/^\d+(?:\.\d+)?$/),
  cachedInputPerMillion: z.string().regex(/^\d+(?:\.\d+)?$/),
  perRequest: z.string().regex(/^\d+(?:\.\d+)?$/).default('0'),
  perSecond: z.string().regex(/^\d+(?:\.\d+)?$/).default('0'),
  mediaOptions: z.record(z.string().regex(/^(seconds|size|quality|background|input_fidelity|resolution|aspect_ratio|audio|operations)$/),
    z.array(z.union([z.string().min(1).max(100), z.number().finite(), z.boolean()])).min(1).max(30)).default({}),
  longContextThreshold: z.number().int().positive().nullable().default(null),
  longContextMultiplier: z.string().regex(/^\d+(?:\.\d+)?$/).default('1'),
  peakMultiplier: z.number().min(1).max(10).optional(),
  active: z.boolean().default(true),
});

async function audit(request: FastifyRequest, action: string, entityType: string, entityId?: string, metadata = {}) {
  const user = (request as AuthenticatedRequest).authUser;
  const rawIp = request.ip;
  await sql`
    INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata, ip_address)
    VALUES (${user.id}, ${action}, ${entityType}, ${entityId ?? null}, ${sql.json(metadata)}, ${rawIp})
  `;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);
  await adminVideoRoutes(app);

  app.get('/api/admin/payments/ton', tonPaymentOverview);
  app.post('/api/admin/payments/ton/inspect', async request => {
    const body = z.object({ orderId: z.string().uuid(), transactionHash: z.string().trim().min(43).max(64) }).parse(request.body);
    await inspectTonTransaction(body.orderId, body.transactionHash);
    await audit(request, 'INSPECT_PAYMENT', 'ORDER', body.orderId);
    return { verified: true };
  });
  app.post('/api/admin/payments/ton/:id/review', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ decision: z.enum(['approve', 'reject']), orderId: z.string().uuid().optional(),
      note: z.string().trim().min(10).max(1000) }).parse(request.body);
    await reviewTonPayment({ ...body, id, actorId: (request as AuthenticatedRequest).authUser.id });
    return { reviewed: true };
  });

  app.get('/api/admin/provider-keys', request => listProviderKeys(keyListQuery.parse(request.query)));

  app.post('/api/admin/provider-keys/refresh', async (request, reply) => {
    if (!config.ceKeySyncEnabled) throw new AppError(409, 'CE_KEY_SYNC_DISABLED', 'Enable CE_KEY_SYNC_ENABLED in the environment');
    await requestProviderKeyRefresh();
    await audit(request, 'REFRESH', 'PROVIDER_KEYS');
    return reply.code(202).send({ queued: true });
  });

  app.get('/api/admin/users/:id/keys', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return assertFound(await listUserKeys(id, keyListQuery.parse(request.query)), 'USER_NOT_FOUND', 'User not found');
  });

  app.get('/api/admin/provider-balances', async () => ({
    monitoring: { ceEnabled: config.ceBalanceMonitorEnabled, intervalMs: config.PROVIDER_BALANCE_CHECK_INTERVAL_MS,
      smtpConfigured: Boolean(config.SMTP_HOST), lowThresholdUsd: config.PROVIDER_BALANCE_LOW_USD },
    balances: await providerBalanceStatus(),
  }));

  app.get('/api/admin/stats', async () => {
    const [stats] = await sql<Record<string, unknown>[]>`
      SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM api_keys WHERE status = 'ACTIVE') AS active_keys,
        (SELECT count(*)::int FROM upstream_credentials WHERE status IN ('ACTIVE', 'DEGRADED')) AS upstream_keys,
        (SELECT COALESCE(sum(COALESCE(credit_amount, amount)), 0)::text FROM orders WHERE status IN ('PAID', 'FULFILLED')
          AND payment_provider <> 'mock' AND COALESCE(metadata->>'testPayment', 'false') <> 'true') AS gross_revenue,
        (SELECT COALESCE(sum(ur.cost), 0)::text FROM usage_records ur JOIN api_keys ak ON ak.id = ur.api_key_id
          JOIN orders o ON o.id = ak.order_id WHERE o.payment_provider <> 'mock' AND COALESCE(o.metadata->>'testPayment', 'false') <> 'true') AS wholesale_cost,
        (SELECT COALESCE(sum(ur.retail_cost), 0)::text FROM usage_records ur JOIN api_keys ak ON ak.id = ur.api_key_id
          JOIN orders o ON o.id = ak.order_id WHERE o.payment_provider <> 'mock' AND COALESCE(o.metadata->>'testPayment', 'false') <> 'true') AS usage_revenue,
        (SELECT count(*)::int FROM usage_records WHERE error_code LIKE '%UNCONFIRMED%' OR status = 'STARTED') AS unsettled_usage,
        (SELECT count(*)::int FROM orders WHERE status = 'PENDING') AS pending_orders,
        (SELECT count(*)::int FROM orders WHERE status = 'PAID') AS paid_orders
    `;
    const usageRevenue = new Decimal(String(stats?.usageRevenue ?? 0));
    const wholesaleUsdt = new Decimal(String(stats?.wholesaleCost ?? 0)).mul(config.BILLING_USDT_PER_USD);
    const markup = new Decimal(config.PRICE_MARKUP);
    return { stats: { ...stats, usageGrossProfit: usageRevenue.sub(wholesaleUsdt).toFixed(8) },
      economics: { markup: markup.toString(), grossMarginPercent: new Decimal(1).sub(new Decimal(1).div(markup)).mul(100).toFixed(2),
        exampleRevenue: '20', exampleCost: new Decimal(20).div(markup).toFixed(2),
        exampleGrossProfit: new Decimal(20).sub(new Decimal(20).div(markup)).toFixed(2) } };
  });

  app.get('/api/admin/pools', async () => {
    const pools = await sql<Record<string, unknown>[]>`
      SELECT up.id, up.name, up.slug, up.base_url, up.protocol, up.parent_pool_id, up.routing_priority, up.credential_capacity, up.active,
        (SELECT count(*)::int FROM upstream_credentials uc WHERE uc.pool_id = up.id) AS credential_count,
        COALESCE((SELECT sum(s.assigned)::int FROM sellable_upstream_slots s WHERE s.pool_id = up.id), 0) AS assigned_keys,
        up.created_at
      FROM upstream_pools up
      ORDER BY up.created_at ASC
    `;
    return { pools };
  });

  app.post('/api/admin/pools', async (request, reply) => {
    const body = poolSchema.parse(request.body);
    if (body.parentPoolId && !(await sql`SELECT 1 FROM upstream_pools WHERE id = ${body.parentPoolId} AND parent_pool_id IS NULL`).length) {
      throw new AppError(400, 'INVALID_PARENT_POOL', 'Select a standalone provider pool as the parent');
    }
    const rows = await sql<{ id: string }[]>`
      INSERT INTO upstream_pools (name, slug, base_url, credential_capacity, active, protocol, parent_pool_id, routing_priority)
      VALUES (${body.name}, ${body.slug}, ${body.baseUrl}, ${body.credentialCapacity}, ${body.active},
        ${body.protocol}, ${body.parentPoolId}, ${body.routingPriority})
      ON CONFLICT (slug) DO NOTHING RETURNING id
    `;
    const pool = assertFound(rows[0], 'POOL_EXISTS', 'A provider pool with this slug already exists');
    await audit(request, 'CREATE', 'UPSTREAM_POOL', pool.id);
    return reply.code(201).send({ id: pool.id });
  });

  app.patch('/api/admin/pools/:id', async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = poolSchema.omit({ parentPoolId: true, protocol: true }).partial().parse(request.body);
    await sql.begin(async (transaction) => {
      const [current] = await transaction<{ baseUrl: string }[]>`SELECT base_url FROM upstream_pools WHERE id = ${params.id} FOR UPDATE`;
      const pool = assertFound(current, 'POOL_NOT_FOUND', 'Provider pool not found');
      if (body.baseUrl && body.baseUrl !== pool.baseUrl) {
        const [credential] = await transaction`SELECT id FROM upstream_credentials WHERE pool_id = ${params.id} LIMIT 1`;
        if (credential) throw new AppError(409, 'POOL_HAS_CREDENTIALS', 'Create a separate pool for a different API base URL');
      }
      await transaction`
        UPDATE upstream_pools SET
          name = COALESCE(${body.name ?? null}, name), slug = COALESCE(${body.slug ?? null}, slug),
          base_url = COALESCE(${body.baseUrl ?? null}, base_url),
          credential_capacity = COALESCE(${body.credentialCapacity ?? null}, credential_capacity),
          routing_priority = COALESCE(${body.routingPriority ?? null}, routing_priority),
          active = COALESCE(${body.active ?? null}, active), updated_at = now()
        WHERE id = ${params.id}
      `;
    });
    await audit(request, 'UPDATE', 'UPSTREAM_POOL', params.id, body);
    return { ok: true };
  });

  app.get('/api/admin/credentials', async () => {
    const credentials = await sql<Record<string, unknown>[]>`
      SELECT uc.id, uc.pool_id, up.name AS pool_name, uc.label, uc.key_hint, uc.status, uc.priority, uc.test_only,
        uc.max_concurrency, uc.spend_limit::text, uc.spend_used::text, uc.last_health_at,
        uc.available_models, uc.catalog_valid_until,
        uc.last_used_at, uc.last_error, uc.created_at,
        COALESCE(s.assigned, 0) AS assigned_keys
      FROM upstream_credentials uc
      JOIN upstream_pools up ON up.id = uc.pool_id
      LEFT JOIN sellable_upstream_slots s ON s.id = uc.id
      ORDER BY up.name, uc.priority DESC, uc.created_at
    `;
    return { credentials };
  });

  app.post('/api/admin/pools/:poolId/credentials', async (request, reply) => {
    const params = z.object({ poolId: z.string().uuid() }).parse(request.params);
    const body = credentialSchema.parse(request.body);
    const [credential] = await sql<{ id: string }[]>`
      INSERT INTO upstream_credentials (
        pool_id, label, encrypted_key, key_hint, key_fingerprint, priority, max_concurrency, spend_limit, test_only
      ) SELECT id, ${body.label}, ${encryptSecret(body.apiKey)}, ${keyHint(body.apiKey)}, ${upstreamKeyFingerprint(body.apiKey)},
        ${body.priority}, ${body.maxConcurrency}, ${body.spendLimit ?? null}, ${body.testOnly}
      FROM upstream_pools WHERE id = ${params.poolId}
      ON CONFLICT (key_fingerprint) WHERE key_fingerprint IS NOT NULL DO NOTHING
      RETURNING id
    `;
    if (!credential) {
      const [pool] = await sql`SELECT id FROM upstream_pools WHERE id = ${params.poolId}`;
      if (pool) throw new AppError(409, 'UPSTREAM_KEY_DUPLICATE', 'This provider key is already registered');
    }
    const created = assertFound(credential, 'POOL_NOT_FOUND', 'Provider pool not found');
    await audit(request, 'CREATE', 'UPSTREAM_CREDENTIAL', created.id, { poolId: params.poolId, label: body.label, testOnly: body.testOnly });
    await checkCatalogForAdmin(request, created.id);
    return reply.code(201).send({ id: created.id });
  });

  app.patch('/api/admin/credentials/:id', async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      status: z.enum(['ACTIVE', 'DEGRADED', 'DISABLED', 'EXHAUSTED']).optional(),
      priority: z.number().int().min(0).max(10_000).optional(),
      maxConcurrency: z.number().int().min(1).max(1000).optional(),
      spendLimit: z.string().regex(/^\d+(?:\.\d+)?$/).nullable().optional(),
      testOnly: z.boolean().optional(),
      apiKey: z.string().trim().min(8).max(2000).optional(),
    }).parse(request.body);
    const recheck = Boolean(body.apiKey) || body.status === 'ACTIVE' || body.testOnly !== undefined;
    const rows = await sql<{ id: string }[]>`
      UPDATE upstream_credentials SET
        status = CASE WHEN ${body.status === 'DISABLED' || body.status === 'EXHAUSTED'} THEN ${body.status ?? null}::text
                      WHEN ${recheck} AND (status <> 'DISABLED' OR ${body.status === 'ACTIVE'}) THEN 'DEGRADED'
                      ELSE COALESCE(${body.status ?? null}, status) END,
        priority = COALESCE(${body.priority ?? null}, priority),
        max_concurrency = COALESCE(${body.maxConcurrency ?? null}, max_concurrency),
        test_only = COALESCE(${body.testOnly ?? null}, test_only),
        spend_limit = CASE WHEN ${body.spendLimit === null} THEN NULL ELSE COALESCE(${body.spendLimit ?? null}, spend_limit) END,
        encrypted_key = CASE WHEN ${Boolean(body.apiKey)} THEN ${body.apiKey ? encryptSecret(body.apiKey) : ''} ELSE encrypted_key END,
        key_fingerprint = COALESCE(${body.apiKey ? upstreamKeyFingerprint(body.apiKey) : null}, key_fingerprint),
        key_hint = CASE WHEN ${Boolean(body.apiKey)} THEN ${body.apiKey ? keyHint(body.apiKey) : ''} ELSE key_hint END,
        available_models = CASE WHEN ${recheck} THEN ARRAY[]::text[] ELSE available_models END,
        catalog_valid_until = CASE WHEN ${recheck} THEN NULL ELSE catalog_valid_until END,
        updated_at = now()
      WHERE id = ${params.id} RETURNING id
    `.catch((error: unknown) => {
      if (isDuplicateUpstreamKey(error)) throw new AppError(409, 'UPSTREAM_KEY_DUPLICATE', 'This provider key is already registered');
      throw error;
    });
    assertFound(rows[0], 'CREDENTIAL_NOT_FOUND', 'Upstream key not found');
    await audit(request, 'UPDATE', 'UPSTREAM_CREDENTIAL', params.id, { ...body, apiKey: body.apiKey ? '[REDACTED]' : undefined });
    if (recheck) await checkCatalogForAdmin(request, params.id);
    return { ok: true };
  });

  app.get('/api/admin/products', async () => {
    const products = await sql<Record<string, unknown>[]>`
      SELECT p.id, p.pool_id, up.name AS provider_name, p.name, p.slug, p.description,
        p.wholesale_credits::text, p.currency, p.duration_days, p.concurrency_limit, p.active, p.created_at
      FROM products p JOIN upstream_pools up ON up.id = p.pool_id
      ORDER BY p.created_at
    `;
    return { products, priceMarkup: config.PRICE_MARKUP, billingUsdtPerUsd: config.BILLING_USDT_PER_USD };
  });

  app.post('/api/admin/products', async (request, reply) => {
    const body = productSchema.parse(request.body);
    const rows = await sql<{ id: string }[]>`
      INSERT INTO products (
        pool_id, name, slug, description, wholesale_credits, currency, duration_days,
        concurrency_limit, active
      ) VALUES (
        ${body.poolId}, ${body.name}, ${body.slug}, ${body.description}, ${body.wholesaleCredits},
        ${body.currency}, ${body.durationDays ?? null}, ${body.concurrencyLimit}, ${body.active}
      ) ON CONFLICT (slug) DO NOTHING RETURNING id
    `;
    const product = assertFound(rows[0], 'PRODUCT_EXISTS', 'A product with this slug already exists');
    await audit(request, 'CREATE', 'PRODUCT', product.id);
    return reply.code(201).send({ id: product.id });
  });

  app.patch('/api/admin/products/:id', async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = productSchema.partial().parse(request.body);
    const [current] = await sql<Record<string, unknown>[]>`SELECT * FROM products WHERE id = ${params.id}`;
    assertFound(current, 'PRODUCT_NOT_FOUND', 'Product not found');
    const value = { ...current, ...body } as Record<string, unknown>;
    const durationDays = value.durationDays === null ? null : Number(value.durationDays);
    await sql`
      UPDATE products SET pool_id = ${String(value.poolId ?? value.pool_id)}, name = ${String(value.name)},
        slug = ${String(value.slug)}, description = ${String(value.description)},
        wholesale_credits = ${String(value.wholesaleCredits ?? value.wholesale_credits)},
        currency = ${String(value.currency)}, duration_days = ${durationDays},
        concurrency_limit = ${Number(value.concurrencyLimit ?? value.concurrency_limit)},
        active = ${Boolean(value.active)}, updated_at = now()
      WHERE id = ${params.id}
    `;
    await audit(request, 'UPDATE', 'PRODUCT', params.id, body);
    return { ok: true };
  });

  app.get('/api/admin/rates', async () => {
    const rates = await sql<Record<string, unknown>[]>`
      SELECT mr.id, mr.pool_id, up.name AS provider_name, mr.model, mr.input_per_million::text,
        mr.output_per_million::text, mr.cached_input_per_million::text, mr.per_request::text, mr.per_second::text, mr.media_options,
        mr.long_context_threshold::int, mr.long_context_multiplier::text, mr.peak_multiplier::text,
        mr.active, mr.updated_at
      FROM model_rates mr JOIN upstream_pools up ON up.id = mr.pool_id
      ORDER BY up.name, mr.model
    `;
    return { rates };
  });

  app.post('/api/admin/rates', async (request) => {
    const body = rateSchema.parse(request.body);
    const [pool] = await sql<{ protocol: string }[]>`SELECT protocol FROM upstream_pools WHERE id = ${body.poolId}`;
    if (pool?.protocol === 'VIDEOS' && body.active && (Number(body.perSecond) <= 0 || !body.mediaOptions.seconds?.length
      || body.mediaOptions.seconds.some(value => typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 120)
      || [body.inputPerMillion, body.outputPerMillion, body.cachedInputPerMillion, body.perRequest].some(value => Number(value) !== 0))) {
      throw new AppError(400, 'INVALID_VIDEO_RATE', 'Set a positive per-second price, allowed durations (1–120 seconds), and zero token/per-request rates');
    }
    if (pool?.protocol !== 'VIDEOS' && Number(body.perSecond) !== 0) throw new AppError(400, 'INVALID_VIDEO_RATE', 'Per-second pricing requires a VIDEOS provider');
    const [rate] = await sql<{ id: string }[]>`
      INSERT INTO model_rates (
        pool_id, model, input_per_million, output_per_million, cached_input_per_million, per_request,
        long_context_threshold, long_context_multiplier, peak_multiplier, active, per_second, media_options
      ) VALUES (
        ${body.poolId}, ${body.model}, ${body.inputPerMillion}, ${body.outputPerMillion},
        ${body.cachedInputPerMillion}, ${body.perRequest}, ${body.longContextThreshold},
        ${body.longContextMultiplier}, ${body.peakMultiplier ?? 1}, ${body.active}, ${body.perSecond}, ${sql.json(body.mediaOptions)}
      ) ON CONFLICT (pool_id, model) DO UPDATE SET
        input_per_million = EXCLUDED.input_per_million,
        output_per_million = EXCLUDED.output_per_million,
        cached_input_per_million = EXCLUDED.cached_input_per_million,
        per_request = EXCLUDED.per_request,
        per_second = EXCLUDED.per_second,
        media_options = EXCLUDED.media_options,
        long_context_threshold = EXCLUDED.long_context_threshold,
        long_context_multiplier = EXCLUDED.long_context_multiplier,
        peak_multiplier = COALESCE(${body.peakMultiplier ?? null}, model_rates.peak_multiplier),
        active = EXCLUDED.active,
        listed_without_rate = false,
        updated_at = now()
      RETURNING id
    `;
    await audit(request, 'UPSERT', 'MODEL_RATE', rate?.id, { model: body.model, poolId: body.poolId });
    return { id: rate?.id };
  });

  app.get('/api/admin/users', async () => {
    const users = await sql<Record<string, unknown>[]>`
      SELECT u.id, u.email::text, u.name, u.role, u.status, u.wallet_network, u.wallet_address,
        u.created_at,
        (SELECT count(*)::int FROM api_keys ak WHERE ak.user_id = u.id) AS key_count,
        (SELECT COALESCE(sum(o.credit_amount), 0)::text FROM orders o
          WHERE o.user_id = u.id AND o.status = 'FULFILLED') AS spent
      FROM users u
      ORDER BY u.created_at DESC LIMIT 500
    `;
    return { users };
  });

  app.patch('/api/admin/users/:id', async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ role: z.enum(['ADMIN', 'USER']).optional(), status: z.enum(['ACTIVE', 'SUSPENDED']).optional() }).parse(request.body);
    const actorId = (request as AuthenticatedRequest).authUser.id;
    await updateUserAccess(sql, actorId, params.id, body);
    await audit(request, 'UPDATE', 'USER', params.id, body);
    return { ok: true };
  });

  app.get('/api/admin/orders', async () => {
    const orders = await sql<Record<string, unknown>[]>`
      SELECT o.id, u.email::text AS user_email, o.grant_label AS product_name, up.name AS provider_name,
        o.payment_provider, o.status, o.amount::text, o.currency, o.price_markup::text,
        COALESCE(o.credit_amount, o.amount)::text AS credit_amount,
        o.wholesale_credits::text, o.external_id, o.paid_at, o.fulfilled_at, o.created_at, o.top_up_key_id
      FROM orders o
      JOIN users u ON u.id = o.user_id
      JOIN upstream_pools up ON up.id = o.pool_id
      ORDER BY o.created_at DESC LIMIT 500
    `;
    return { orders };
  });
}

async function checkCatalogForAdmin(request: FastifyRequest, id: string): Promise<void> {
  try { await refreshUpstreamCatalog(id); }
  catch { request.log.error({ credentialId: id }, 'Could not record catalog check; worker will retry'); }
}
