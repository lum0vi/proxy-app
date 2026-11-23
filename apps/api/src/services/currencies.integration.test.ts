import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { sessionCookieName } from '../auth/session.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { decryptSecret, encryptSecret, sha256, upstreamKeyFingerprint } from '../lib/crypto.js';
import { createOrder } from './orders.js';
import { canonicalWebhookPayload } from './payments.js';
import { requireRubRate } from './price-rates.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integration('RUB checkout and USDT ledger with HTTP payment providers', () => {
  let app: FastifyInstance;
  let provider: FastifyInstance;
  let poolId = '', productId = '', userId = '', keyId = '';
  let sessionHeaders: { cookie: string };
  let rubRate = 100;
  let quoteAvailable = true;
  let paymentApiAvailable = true;
  let loseCheckoutResponse = false;
  let cryptoCheckoutRequests = 0;
  const payments = new Map<string, Record<string, any>>();
  const creations: { payload: Record<string, any>; idempotencyKey: string | undefined }[] = [];
  const originalMethods = [...config.paymentMethods];
  const orderIds: string[] = [];
  const eventIds: string[] = [];

  async function withMockOnly(run: () => Promise<void>) {
    const enabled = [...config.paymentMethods];
    config.paymentMethods.splice(0, config.paymentMethods.length, 'mock');
    try { await run(); }
    finally { config.paymentMethods.splice(0, config.paymentMethods.length, ...enabled); }
  }

  const buy = async (paymentProvider: 'yookassa' | 'nowpayments', topUpKeyId?: string) => {
    const order = await createOrder({ userId, userEmail: 'currencies@example.test', productId, paymentProvider, ...(topUpKeyId && { topUpKeyId }) });
    orderIds.push(String(order.id));
    return order;
  };
  const findPayment = (orderId: unknown) => [...payments.values()].find(payment => payment.metadata.orderId === orderId)!;
  const deliverRub = (payment: Record<string, any>) => {
    eventIds.push(`${payment.id}:succeeded`);
    return app.inject({ method: 'POST', url: '/api/webhooks/yookassa', payload: {
      type: 'notification', event: 'payment.succeeded', object: { id: payment.id, status: 'succeeded', paid: true, amount: { value: '0.01', currency: 'RUB' } },
    } });
  };

  beforeAll(async () => {
    provider = Fastify();
    provider.get('/price', async (_request, reply) => quoteAvailable
      ? { tether: { rub: rubRate, last_updated_at: Math.floor(Date.now() / 1000) } } : reply.code(503).send({}));
    provider.post('/v3/payments', async (request, reply) => {
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from('test-shop:test-yookassa-secret').toString('base64')}`);
      const payload = request.body as Record<string, any>;
      creations.push({ payload, idempotencyKey: request.headers['idempotence-key'] as string });
      const id = randomUUID();
      const payment = { id, amount: payload.amount, status: 'pending', paid: false, test: true,
        recipient: { account_id: 'test-shop' }, metadata: payload.metadata,
        confirmation: { type: 'redirect', confirmation_url: `https://yookassa.invalid/pay/${id}` } };
      payments.set(id, payment);
      if (loseCheckoutResponse) return reply.code(503).send({});
      return payment;
    });
    provider.get('/v3/payments/:id', async (request, reply) => {
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from('test-shop:test-yookassa-secret').toString('base64')}`);
      if (!paymentApiAvailable) return reply.code(503).send({});
      return payments.get((request.params as { id: string }).id) ?? reply.code(404).send({});
    });
    provider.post('/v1/payment', async request => {
      cryptoCheckoutRequests++;
      const payload = request.body as Record<string, any>;
      expect(payload).toMatchObject({ pay_currency: 'usdtton', pay_amount: 20 });
      return { payment_id: '173000000001', pay_address: 'synthetic-ton-address', pay_amount: payload.pay_amount, pay_currency: payload.pay_currency };
    });
    provider.post('/v1/responses', async () => ({
      id: 'resp_currency_test', object: 'response', status: 'completed', output: [],
      usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500, input_tokens_details: { cached_tokens: 200 } },
    }));
    const base = await provider.listen({ host: '127.0.0.1', port: 0 });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (['yookassa.invalid', 'nowpayments.invalid', 'rates.invalid'].includes(url.hostname)) return originalFetch(`${base}${url.pathname}`, init);
      if (url.origin === base) return originalFetch(input, init);
      throw new Error(`Unexpected outbound request to ${url.hostname}`);
    });
    config.paymentMethods.push('yookassa', 'nowpayments');
    const suffix = randomUUID();
    const [pool] = await sql<{ id: string }[]>`INSERT INTO upstream_pools (name, slug, base_url, credential_capacity)
      VALUES ('Currency test', ${`currency-${suffix}`}, ${base}, 5) RETURNING id`;
    poolId = pool!.id;
    await sql`INSERT INTO upstream_credentials (pool_id, label, encrypted_key, key_hint, key_fingerprint, available_models, catalog_valid_until, status)
      VALUES (${poolId}, 'Currency test', ${encryptSecret(suffix)}, 'synthetic', ${upstreamKeyFingerprint(suffix)}, ARRAY['currency-model'], now() + interval '1 day', 'ACTIVE')`;
    const [product] = await sql<{ id: string }[]>`INSERT INTO products (pool_id, name, slug, wholesale_credits, currency, duration_days, concurrency_limit)
      VALUES (${poolId}, 'Currency key', ${`currency-${suffix}`}, 10, 'USDT', NULL, 2) RETURNING id`;
    productId = product!.id;
    await sql`INSERT INTO model_rates (pool_id, model, input_per_million, cached_input_per_million, output_per_million)
      VALUES (${poolId}, 'currency-model', 1, 0.1, 2)`;
    const [user] = await sql<{ id: string }[]>`INSERT INTO users (email, password_hash) VALUES (${`${suffix}@example.test`}, 'unused') RETURNING id`;
    userId = user!.id;
    const session = randomUUID();
    await sql`INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${userId}, ${sha256(`${config.SESSION_SECRET}:${session}`)}, now() + interval '1 day')`;
    sessionHeaders = { cookie: `${sessionCookieName}=${session}` };
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    config.paymentMethods.splice(0, config.paymentMethods.length, ...originalMethods);
    await app?.close();
    await provider?.close();
    if (eventIds.length) await sql`DELETE FROM payment_events WHERE event_id IN ${sql(eventIds)}`;
    if (userId) {
      await sql`DELETE FROM usage_records WHERE api_key_id IN (SELECT id FROM api_keys WHERE user_id = ${userId})`;
      await sql`DELETE FROM request_leases WHERE api_key_id IN (SELECT id FROM api_keys WHERE user_id = ${userId})`;
      await sql`DELETE FROM orders WHERE user_id = ${userId} AND top_up_key_id IS NOT NULL`;
      await sql`DELETE FROM api_keys WHERE user_id = ${userId}`;
      await sql`DELETE FROM orders WHERE user_id = ${userId}`;
      await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
    }
    if (productId) await sql`DELETE FROM products WHERE id = ${productId}`;
    if (poolId) {
      await sql`DELETE FROM upstream_credentials WHERE pool_id = ${poolId}`;
      await sql`DELETE FROM upstream_pools WHERE id = ${poolId}`;
    }
  });

  it('locks 2000 RUB for 20 USDT and credits once using the authenticated payment, even after expiry and a rate change', async () => {
    const order = await buy('yookassa');
    expect(order).toMatchObject({ amount: '2000.00000000', currency: 'RUB', creditAmount: '20.00000000', usdtRubRate: '100.00000000' });
    expect(creations[0]).toMatchObject({ idempotencyKey: order.id, payload: {
      amount: { value: '2000.00', currency: 'RUB' }, capture: true, metadata: { orderId: order.id },
      receipt: { customer: { email: 'currencies@example.test' }, items: [{ amount: { value: '2000.00', currency: 'RUB' }, quantity: '1.00' }] },
    } });
    const payment = findPayment(order.id);
    // An arbitrary caller cannot fabricate success in the unauthenticated callback.
    expect((await deliverRub(payment)).statusCode).toBe(200);
    expect(await sql`SELECT id FROM api_keys WHERE user_id = ${userId}`).toHaveLength(0);
    rubRate = 150;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    expect((await requireRubRate()).usdtToRub).toBe('150.00000000');
    await sql`UPDATE orders SET status = 'EXPIRED' WHERE id = ${String(order.id)}`;
    payment.status = 'succeeded'; payment.paid = true;
    paymentApiAvailable = false;
    expect((await deliverRub(payment)).statusCode).toBe(502);
    paymentApiAvailable = true;
    expect(await sql`SELECT id FROM payment_events WHERE event_id = ${`${payment.id}:succeeded`}`).toHaveLength(0);
    const responses = await Promise.all([deliverRub(payment), deliverRub(payment)]);
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    const keys = await sql<{ id: string; creditsTotal: string; currency: string }[]>`
      SELECT id, credits_total::text, currency FROM api_keys WHERE user_id = ${userId}`;
    expect(keys).toMatchObject([{ creditsTotal: '20.00000000', currency: 'USDT' }]);
    keyId = keys[0]!.id;
  });

  it('charges USDT, not RUB, for usage of a key bought in rubles', async () => {
    const [key] = await sql<{ encryptedKey: string }[]>`SELECT encrypted_key FROM api_keys WHERE id = ${keyId}`;
    const response = await app.inject({ method: 'POST', url: '/v1/responses',
      headers: { authorization: `Bearer ${decryptSecret(key!.encryptedKey)}` }, payload: { model: 'currency-model', input: 'test' } });
    expect(response.statusCode).toBe(200);
    let used = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      const [key] = await sql<{ used: string }[]>`SELECT credits_used::text AS used FROM api_keys WHERE id = ${keyId}`;
      used = key!.used;
      if (Number(used) > 0) break;
      await delay(25);
    }
    expect(used).toBe('0.00364000');
  });

  it('rejects an incorrect amount, shop or payment mode before accepting a RUB top-up', async () => {
    const order = await buy('yookassa', keyId);
    expect(order).toMatchObject({ amount: '3000.00000000', creditAmount: '20.00000000' });
    const payment = findPayment(order.id);
    payment.status = 'succeeded'; payment.paid = true;
    payment.amount.value = '2999.99';
    expect((await deliverRub(payment)).statusCode).toBe(400);
    payment.amount.value = '3000.00'; payment.recipient.account_id = 'another-shop';
    expect((await deliverRub(payment)).statusCode).toBe(502);
    payment.recipient.account_id = 'test-shop'; payment.test = false;
    expect((await deliverRub(payment)).statusCode).toBe(502);
    payment.test = true;
    expect((await deliverRub(payment)).statusCode).toBe(200);
    expect((await deliverRub(payment)).json().duplicate).toBe(true);
    expect(await sql`SELECT id, credits_total::text FROM api_keys WHERE user_id = ${userId}`)
      .toEqual([{ id: keyId, creditsTotal: '40.00000000' }]);
  });

  it('accepts a full signed USDT-on-TON top-up of the same RUB-purchased key', async () => {
    const order = await buy('nowpayments', keyId);
    expect(order).toMatchObject({ currency: 'USDT', amount: '20.00000000', creditAmount: '20.00000000', metadata: { asset: 'USDT', network: 'TON' } });
    const eventId = '173000000001:finished';
    eventIds.push(eventId);
    const deliver = (paid: string, currency = 'usdtton') => {
      const payload = { payment_id: '173000000001', payment_status: 'finished', order_id: order.id,
        price_currency: 'usd', price_amount: 20, pay_currency: currency, actually_paid: paid };
      return app.inject({ method: 'POST', url: '/api/webhooks/nowpayments', payload,
        headers: { 'x-nowpayments-sig': createHmac('sha512', config.NOWPAYMENTS_IPN_SECRET).update(canonicalWebhookPayload(payload)).digest('hex') } });
    };
    expect((await deliver('19.99')).statusCode).toBe(400);
    expect((await deliver('20', 'ton')).statusCode).toBe(400);
    expect((await deliver('20')).statusCode).toBe(200);
    expect((await deliver('20')).json().duplicate).toBe(true);
    expect(await sql`SELECT id, credits_total::text, credits_used::text FROM api_keys WHERE user_id = ${userId}`)
      .toEqual([{ id: keyId, creditsTotal: '60.00000000', creditsUsed: '0.00364000' }]);
  });

  it('recovers a paid RUB invoice whose creation response was lost without accepting an unverified or mismatched payment', async () => {
    loseCheckoutResponse = true;
    try { await expect(buy('yookassa', keyId)).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' }); }
    finally { loseCheckoutResponse = false; }
    const payment = [...payments.values()].at(-1)!;
    const orderId = payment.metadata.orderId;
    orderIds.push(orderId);
    expect(await sql`SELECT status, external_id FROM orders WHERE id = ${orderId}`)
      .toEqual([{ status: 'FAILED', externalId: null }]);
    // Neither a forged success notice nor a successful payment with the wrong
    // amount is allowed to bind the previously unknown provider payment ID.
    expect((await deliverRub(payment)).statusCode).toBe(200);
    payment.status = 'succeeded'; payment.paid = true;
    const originalAmount = payment.amount.value;
    payment.amount.value = '0.01';
    expect((await deliverRub(payment)).statusCode).toBe(400);
    expect(await sql`SELECT status, external_id FROM orders WHERE id = ${orderId}`)
      .toEqual([{ status: 'FAILED', externalId: null }]);
    payment.amount.value = originalAmount;
    const results = await Promise.all([deliverRub(payment), deliverRub(payment)]);
    expect(results.every(response => response.statusCode === 200)).toBe(true);
    expect(results.some(response => response.json().duplicate === true)).toBe(true);
    expect(await sql`SELECT status, external_id, metadata->>'testPayment' AS test FROM orders WHERE id = ${orderId}`)
      .toEqual([{ status: 'FULFILLED', externalId: payment.id, test: 'true' }]);
    expect(await sql`SELECT id, credits_total::text FROM api_keys WHERE user_id = ${userId}`)
      .toEqual([{ id: keyId, creditsTotal: '80.00000000' }]);
  });

  it('locks a RUB mock invoice and tops up its test key in USDT exactly once through the authenticated endpoints', () => withMockOnly(async () => {
    rubRate = 100;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    const created = await app.inject({ method: 'POST', url: '/api/orders', headers: sessionHeaders,
      payload: { productId, paymentProvider: 'mock', paymentCurrency: 'RUB' } });
    expect(created.statusCode).toBe(201);
    const order = created.json().order;
    orderIds.push(order.id);
    expect(order).toMatchObject({ amount: '2000.00000000', currency: 'RUB', creditAmount: '20.00000000',
      usdtRubRate: '100.00000000', metadata: { mode: 'mock' } });
    expect(Number.isFinite(Date.parse(order.exchangeRateAt))).toBe(true);

    rubRate = 160;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    expect((await requireRubRate()).usdtToRub).toBe('160.00000000');
    const complete = (id: string) => app.inject({ method: 'POST', url: `/api/payments/mock/${id}/complete`, headers: sessionHeaders });
    const completions = await Promise.all([complete(order.id), complete(order.id)]);
    expect(completions.map(response => response.statusCode)).toEqual([200, 200]);
    const [mockKey] = await sql<{ id: string; creditsTotal: string; creditsUsed: string; currency: string }[]>`
      SELECT id, credits_total::text, credits_used::text, currency FROM api_keys WHERE order_id = ${order.id}`;
    expect(mockKey).toMatchObject({ creditsTotal: '20.00000000', creditsUsed: '0.00000000', currency: 'USDT' });
    expect(await sql`SELECT amount::text, credit_amount::text, usdt_rub_rate::text, status FROM orders WHERE id = ${order.id}`)
      .toEqual([{ amount: '2000.00000000', creditAmount: '20.00000000', usdtRubRate: '100.00000000', status: 'FULFILLED' }]);

    const topUpResponse = await app.inject({ method: 'POST', url: '/api/orders', headers: sessionHeaders,
      payload: { productId, paymentProvider: 'mock', paymentCurrency: 'RUB', topUpKeyId: mockKey!.id } });
    expect(topUpResponse.statusCode).toBe(201);
    const topUp = topUpResponse.json().order;
    orderIds.push(topUp.id);
    expect(topUp).toMatchObject({ currency: 'RUB', amount: '3200.00000000', creditAmount: '20.00000000',
      usdtRubRate: '160.00000000', topUpKeyId: mockKey!.id });
    const topUpCompletions = await Promise.all([complete(topUp.id), complete(topUp.id)]);
    expect(topUpCompletions.map(response => response.statusCode)).toEqual([200, 200]);
    expect(await sql`SELECT id, credits_total::text, credits_used::text, currency FROM api_keys WHERE order_id IN (${order.id}, ${topUp.id})`)
      .toEqual([{ id: mockKey!.id, creditsTotal: '40.00000000', creditsUsed: '0.00000000', currency: 'USDT' }]);
  }));

  it('preserves default USDT mock checkout when paymentCurrency is omitted', () => withMockOnly(async () => {
    const response = await app.inject({ method: 'POST', url: '/api/orders', headers: sessionHeaders,
      payload: { productId, paymentProvider: 'mock' } });
    expect(response.statusCode).toBe(201);
    const order = response.json().order;
    orderIds.push(order.id);
    expect(order).toMatchObject({ currency: 'USDT', amount: '20.00000000', creditAmount: '20.00000000',
      usdtRubRate: null, exchangeRateAt: null, metadata: { mode: 'mock' } });
  }));

  it('rejects payment currencies incompatible with real providers before creating an order or calling checkout', async () => {
    const before = await sql`SELECT id, status, upstream_credential_id FROM orders WHERE user_id = ${userId} ORDER BY id`;
    const beforeCreations = creations.length;
    const beforeCryptoCreations = cryptoCheckoutRequests;
    for (const [paymentProvider, paymentCurrency] of [['yookassa', 'USDT'], ['nowpayments', 'RUB']]) {
      const response = await app.inject({ method: 'POST', url: '/api/orders', headers: sessionHeaders,
        payload: { productId, paymentProvider, paymentCurrency } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_PAYMENT_CURRENCY');
    }
    expect(await sql`SELECT id, status, upstream_credential_id FROM orders WHERE user_id = ${userId} ORDER BY id`).toEqual(before);
    expect(creations).toHaveLength(beforeCreations);
    expect(cryptoCheckoutRequests).toBe(beforeCryptoCreations);
  });

  it('does not create or reserve a RUB order when a fresh exchange rate is unavailable', async () => {
    quoteAvailable = false;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60_000);
    try {
      await expect(buy('yookassa', keyId)).rejects.toMatchObject({ code: 'EXCHANGE_RATE_UNAVAILABLE' });
      const mock = await app.inject({ method: 'POST', url: '/api/orders', headers: sessionHeaders,
        payload: { productId, paymentProvider: 'mock', paymentCurrency: 'RUB' } });
      expect(mock.statusCode).toBe(503);
      expect(mock.json().error.code).toBe('EXCHANGE_RATE_UNAVAILABLE');
      expect(await sql`SELECT id FROM orders WHERE user_id = ${userId}`).toHaveLength(orderIds.length);
    } finally { clock.mockRestore(); }
  });

  it('advertises only USDT and rejects RUB before reserving stock when rubles are disabled', async () => {
    const original = [...config.paymentCurrencies];
    config.paymentCurrencies.splice(0, config.paymentCurrencies.length, 'USDT');
    const before = await sql`SELECT id FROM orders WHERE user_id = ${userId} ORDER BY id`;
    try {
      expect((await app.inject('/api/config')).json().paymentCurrencies).toEqual(['USDT']);
      expect((await app.inject('/api/products')).json().paymentCurrencies).toEqual(['USDT']);
      expect((await app.inject('/api/price-rates')).json()).toEqual({ rates: null });
      const response = await app.inject({ method: 'POST', url: '/api/orders', headers: sessionHeaders,
        payload: { productId, paymentProvider: 'mock', paymentCurrency: 'RUB' } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('PAYMENT_CURRENCY_DISABLED');
      expect(await sql`SELECT id FROM orders WHERE user_id = ${userId} ORDER BY id`).toEqual(before);
    } finally { config.paymentCurrencies.splice(0, config.paymentCurrencies.length, ...original); }
  });

  it('blocks keys originally paid with the YooKassa test shop in production', async () => {
    const [key] = await sql<{ encryptedKey: string }[]>`SELECT encrypted_key FROM api_keys WHERE id = ${keyId}`;
    const mode = config.NODE_ENV;
    Object.assign(config, { NODE_ENV: 'production' });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/responses',
        headers: { authorization: `Bearer ${decryptSecret(key!.encryptedKey)}` }, payload: { model: 'currency-model', input: 'test' } });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('TEST_KEY_DISABLED');
      await expect(createOrder({ userId, userEmail: 'test@example.test', productId,
        paymentProvider: 'nowpayments', topUpKeyId: keyId })).rejects.toMatchObject({ code: 'KEY_TOP_UP_UNAVAILABLE' });
    } finally { Object.assign(config, { NODE_ENV: mode }); }
  });
});
