import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { sessionCookieName } from '../auth/session.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { encryptSecret, sha256, upstreamKeyFingerprint } from '../lib/crypto.js';
import { tonAddress, USDT_TON_MASTER } from '../lib/ton.js';
import { createOrder } from './orders.js';
import { scanTonPayments } from './ton-payments.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;
integration('direct USDT payments with real HTTP indexer and PostgreSQL', () => {
  let app: FastifyInstance, indexer: FastifyInstance;
  let userId = '', adminId = '', poolId = '', productId = '';
  let userHeaders: { cookie: string }, adminHeaders: { cookie: string };
  let actions: Record<string, any>[] = [];
  let available = true, nextPage = false, requestCount = 0;
  const observedQueries: URLSearchParams[] = [];
  const receiver = tonAddress(config.TON_RECEIVER_ADDRESS);
  const methods = [...config.paymentMethods];
  const hash = () => randomBytes(32).toString('base64');
  const state = async (id: string) => (await sql<{ status: string; metadata: Record<string, unknown> }[]>`SELECT status, metadata FROM orders WHERE id = ${id}`)[0]!;
  async function buy(topUpKeyId?: string) {
    const order = await createOrder({ userId, userEmail: 'ton-customer@example.test', productId, paymentProvider: 'ton', ...(topUpKeyId && { topUpKeyId }) });
    // Chain time precedes polling by a minute, but follows invoice creation.
    await sql`UPDATE orders SET created_at = now() - interval '2 minutes' WHERE id = ${String(order.id)}`;
    return { id: String(order.id), metadata: order.metadata as Record<string, unknown> };
  }
  function transfer(order: Awaited<ReturnType<typeof buy>>, changes: Record<string, any> = {}) {
    return { type: 'jetton_transfer', success: true, finality: 'finalized', trace_mc_seqno_end: 100,
      trace_id: hash(), action_id: hash(), transactions: [hash()], end_utime: Math.floor(Date.now() / 1000) - 60,
      details: { asset: USDT_TON_MASTER, receiver, sender: `0:${'22'.repeat(32)}`, amount: '20000000',
        comment: order.metadata.payinExtraId, is_encrypted_comment: false }, ...changes };
  }
  const review = (id: string, decision: 'approve' | 'reject', orderId?: string, headers = adminHeaders) => app.inject({
    method: 'POST', url: `/api/admin/payments/ton/${id}/review`, headers,
    payload: { decision, ...(orderId && { orderId }), note: 'Verified sending wallet ownership and on-chain receipt.' },
  });
  const receipt = async (orderId: string) => (await sql<{ id: string; status: string; reason: string }[]>`SELECT id, status, reason FROM ton_payments WHERE order_id = ${orderId}`)[0]!;

  beforeAll(async () => {
    indexer = Fastify();
    indexer.get('/v3/actions', async (request, reply) => {
      requestCount++;
      expect(request.headers['x-api-key']).toBe('test-toncenter-key');
      if (!available) return reply.code(503).send({ error: 'synthetic outage' });
      const query = new URL(request.url, 'http://localhost').searchParams;
      observedQueries.push(query);
      if (nextPage && !query.has('cursor')) return { actions: [actions[0]], next_cursor: 'page-2' };
      const selected = nextPage ? actions.slice(1) : actions;
      // Deliberately do not filter account or token: the application must validate independently.
      return { actions: selected, next_cursor: null };
    });
    const base = await indexer.listen({ host: '127.0.0.1', port: 0 });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === 'toncenter.invalid') return originalFetch(`${base}${url.pathname}${url.search}`, init);
      throw new Error(`Unexpected external call: ${url.hostname}`);
    });
    config.paymentMethods.push('ton');
    const suffix = randomUUID();
    const [pool] = await sql<{ id: string }[]>`INSERT INTO upstream_pools (name, slug, base_url, credential_capacity)
      VALUES ('TON QA', ${`ton-${suffix}`}, ${base}, 100) RETURNING id`;
    poolId = pool!.id;
    await sql`INSERT INTO upstream_credentials (pool_id, label, encrypted_key, key_hint, key_fingerprint, available_models, catalog_valid_until, status)
      VALUES (${poolId}, 'TON QA', ${encryptSecret(suffix)}, 'synthetic', ${upstreamKeyFingerprint(suffix)}, ARRAY['ton-model'], now() + interval '1 day', 'ACTIVE')`;
    const [product] = await sql<{ id: string }[]>`INSERT INTO products (pool_id, name, slug, wholesale_credits, currency, duration_days, concurrency_limit)
      VALUES (${poolId}, 'TON key', ${`ton-${suffix}`}, 10, 'USDT', NULL, 2) RETURNING id`;
    productId = product!.id;
    await sql`INSERT INTO model_rates (pool_id, model, input_per_million, cached_input_per_million, output_per_million)
      VALUES (${poolId}, 'ton-model', 1, 0.1, 2)`;
    for (const role of ['USER', 'ADMIN']) {
      const [user] = await sql<{ id: string }[]>`INSERT INTO users (email, password_hash, role)
        VALUES (${`${role}-${suffix}@example.test`}, 'unused', ${role}) RETURNING id`;
      const token = randomUUID();
      await sql`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (${user!.id}, ${sha256(`${config.SESSION_SECRET}:${token}`)}, now() + interval '1 day')`;
      if (role === 'USER') { userId = user!.id; userHeaders = { cookie: `${sessionCookieName}=${token}` }; }
      else { adminId = user!.id; adminHeaders = { cookie: `${sessionCookieName}=${token}` }; }
    }
    app = await buildApp(); await app.ready();
  });
  beforeEach(async () => {
    actions = []; available = true; nextPage = false; observedQueries.length = 0;
    Object.assign(config, { TON_AUTO_APPROVE: true });
    await sql`DELETE FROM ton_payment_scans WHERE address = ${receiver}`;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    Object.assign(config, { TON_AUTO_APPROVE: true });
    config.paymentMethods.splice(0, config.paymentMethods.length, ...methods);
    await app?.close(); await indexer?.close();
    await sql`DELETE FROM audit_logs WHERE actor_user_id = ${adminId}`;
    await sql`DELETE FROM ton_payments WHERE receiver = ${receiver}`;
    await sql`DELETE FROM ton_payment_scans WHERE address = ${receiver}`;
    await sql`DELETE FROM orders WHERE user_id = ${userId} AND top_up_key_id IS NOT NULL`;
    await sql`DELETE FROM api_keys WHERE user_id = ${userId}`;
    await sql`DELETE FROM orders WHERE user_id = ${userId}`;
    await sql`DELETE FROM users WHERE id IN (${userId}, ${adminId})`;
    await sql`DELETE FROM products WHERE id = ${productId}`;
    await sql`DELETE FROM upstream_credentials WHERE pool_id = ${poolId}`;
    await sql`DELETE FROM upstream_pools WHERE id = ${poolId}`;
  });

  it('creates an exact USDT invoice and unique comment without calling a payment processor', async () => {
    const count = requestCount;
    const order = await buy();
    expect(order.metadata).toMatchObject({ receiverRaw: receiver, payAmount: '20.00', network: 'TON', asset: 'USDT', autoApprove: true });
    expect(order.metadata.payinExtraId).toMatch(/^ks_[a-f\d]{32}$/);
    expect(requestCount).toBe(count);
  });
  it('reports a missing scanner as stale so a stopped worker cannot look healthy', async () => {
    const response = await app.inject({ url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('proxiapp_ton_monitor_enabled 1\n');
    expect(response.body).toContain('proxiapp_ton_scan_lag_seconds 86400\n');
  });
  it('credits a finalized payment once even on concurrent and repeated scans, then tops up the same key', async () => {
    const order = await buy(); actions = [transfer(order)];
    await Promise.all([scanTonPayments(), scanTonPayments()]); await scanTonPayments();
    expect((await state(order.id)).status).toBe('FULFILLED');
    const keys = await sql<{ id: string; creditsTotal: string }[]>`SELECT id, credits_total::text FROM api_keys WHERE order_id = ${order.id}`;
    expect(keys).toHaveLength(1); expect(Number(keys[0]!.creditsTotal)).toBe(20);
    const topup = await buy(keys[0]!.id); actions = [transfer(topup)];
    await sql`DELETE FROM ton_payment_scans WHERE address = ${receiver}`;
    await scanTonPayments(); await scanTonPayments();
    const [key] = await sql<{ total: string }[]>`SELECT credits_total::text AS total FROM api_keys WHERE id = ${keys[0]!.id}`;
    expect(Number(key!.total)).toBe(40);
  });
  it.each(['fake-token', 'wrong-wallet', 'failed', 'not-final', 'encrypted', 'wrong-comment'])('does not credit %s', async scenario => {
    const order = await buy(), action = transfer(order);
    if (scenario === 'fake-token') action.details.asset = `0:${'33'.repeat(32)}`;
    if (scenario === 'wrong-wallet') action.details.receiver = `0:${'44'.repeat(32)}`;
    if (scenario === 'failed') action.success = false;
    if (scenario === 'not-final') action.finality = 'confirmed';
    if (scenario === 'encrypted') action.details.is_encrypted_comment = true;
    if (scenario === 'wrong-comment') action.details.comment = 'wrong-invoice';
    actions = [action]; await scanTonPayments();
    expect((await state(order.id)).status).toBe('PENDING');
  });
  it('holds underpayment for review and refuses to approve it or permit a user to review payments', async () => {
    const order = await buy(), action = transfer(order); action.details.amount = '19999999'; actions = [action];
    await scanTonPayments(); const row = await receipt(order.id);
    expect(row.reason).toBe('PAYMENT_UNDERPAID');
    expect((await review(row.id, 'approve', undefined, userHeaders)).statusCode).toBe(403);
    expect((await review(row.id, 'approve')).json().error.code).toBe('PAYMENT_UNDERPAID');
    expect((await state(order.id)).status).toBe('PENDING');
  });
  it('holds overpayment, records an administrator decision and prevents reuse', async () => {
    const order = await buy(), action = transfer(order); action.details.amount = '21000000'; actions = [action];
    await scanTonPayments(); const row = await receipt(order.id);
    expect(row.reason).toBe('OVERPAID');
    expect((await review(row.id, 'approve')).statusCode).toBe(200);
    expect((await state(order.id)).status).toBe('FULFILLED');
    expect((await review(row.id, 'approve')).json().error.code).toBe('PAYMENT_ALREADY_USED');
    const [key] = await sql<{ total: string }[]>`SELECT credits_total::text AS total FROM api_keys WHERE order_id = ${order.id}`;
    expect(Number(key!.total)).toBe(20);
    const audit = await sql`SELECT id FROM audit_logs WHERE entity_id = ${row.id} AND action = 'APPROVE_PAYMENT'`;
    expect(audit).toHaveLength(1);
  });
  it('accepts an on-time transfer discovered after expiry but reviews a transfer sent late', async () => {
    const onTime = await buy(); await sql`UPDATE orders SET status = 'EXPIRED' WHERE id = ${onTime.id}`;
    const late = await buy(); await sql`UPDATE orders SET status = 'EXPIRED', reserved_until = now() - interval '90 seconds' WHERE id = ${late.id}`;
    actions = [transfer(onTime), transfer(late)]; await scanTonPayments();
    expect((await state(onTime.id)).status).toBe('FULFILLED');
    expect((await state(late.id)).status).toBe('EXPIRED'); expect((await receipt(late.id)).reason).toBe('LATE_PAYMENT');
    expect((await review((await receipt(late.id)).id, 'approve')).statusCode).toBe(200);
  });
  it('supports manual mode, rejection and a later audited correction', async () => {
    Object.assign(config, { TON_AUTO_APPROVE: false });
    const order = await buy(); actions = [transfer(order)]; await scanTonPayments();
    const row = await receipt(order.id); expect(row.reason).toBe('MANUAL_MODE');
    expect((await review(row.id, 'reject')).statusCode).toBe(200);
    expect((await state(order.id)).status).toBe('PENDING');
    expect((await review(row.id, 'approve')).statusCode).toBe(200);
    expect((await state(order.id)).status).toBe('FULFILLED');
  });
  it('does not treat a customer hash as payment; inspects and links a missing-comment transfer only through admin review', async () => {
    const order = await buy(), action = transfer(order); action.details.comment = null; actions = [action];
    const transactionHash = Buffer.from(action.transactions[0]!, 'base64').toString('hex');
    expect((await app.inject({ method: 'POST', url: `/api/orders/${order.id}/payment-claim`, headers: userHeaders, payload: { transactionHash } })).statusCode).toBe(200);
    expect((await state(order.id)).status).toBe('PENDING');
    expect((await app.inject({ method: 'POST', url: '/api/admin/payments/ton/inspect', headers: adminHeaders,
      payload: { orderId: order.id, transactionHash } })).statusCode).toBe(200);
    const [row] = await sql<{ id: string }[]>`SELECT id FROM ton_payments WHERE transaction_hash = ${transactionHash}`;
    expect((await state(order.id)).status).toBe('PENDING');
    expect((await review(row!.id, 'approve', order.id)).statusCode).toBe(200);
    expect((await state(order.id)).status).toBe('FULFILLED');
  });
  it('does not advance the scan watermark or credit on outage, and recovers with persistent pagination', async () => {
    const first = await buy(), second = await buy(); actions = [transfer(first), transfer(second)];
    available = false; await scanTonPayments();
    const [failed] = await sql<{ errorCode: string; scannedThrough: Date }[]>`SELECT error_code, scanned_through FROM ton_payment_scans WHERE address = ${receiver}`;
    expect(failed!.errorCode).toBe('TON_SCAN_FAILED'); expect((await state(first.id)).status).toBe('PENDING');
    available = true; nextPage = true; await scanTonPayments();
    const [partial] = await sql<{ pageCursor: string; scannedThrough: Date }[]>`SELECT page_cursor, scanned_through FROM ton_payment_scans WHERE address = ${receiver}`;
    expect(partial!.pageCursor).toBe('page-2'); expect(partial!.scannedThrough).toEqual(failed!.scannedThrough);
    await scanTonPayments();
    expect(observedQueries[1]!.get('cursor')).toBe('page-2');
    expect(observedQueries[1]!.get('end_utime')).toBe(observedQueries[0]!.get('end_utime'));
    expect((await state(first.id)).status).toBe('FULFILLED'); expect((await state(second.id)).status).toBe('FULFILLED');
  });
  it('counts only real payments in the admin financial totals', async () => {
    const real = await sql<{ revenue: string }[]>`SELECT COALESCE(sum(COALESCE(credit_amount, amount)), 0)::text AS revenue
      FROM orders WHERE status IN ('PAID', 'FULFILLED') AND payment_provider <> 'mock' AND COALESCE(metadata->>'testPayment', 'false') <> 'true'`;
    const response = await app.inject({ url: '/api/admin/stats', headers: adminHeaders });
    expect(response.statusCode).toBe(200); expect(response.json().stats.grossRevenue).toBe(real[0]!.revenue);
    expect(response.json().economics).toMatchObject({ markup: '2', exampleCost: '10.00', exampleGrossProfit: '10.00', grossMarginPercent: '50.00' });
  });
});
