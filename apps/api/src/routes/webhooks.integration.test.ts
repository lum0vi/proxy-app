import { createHmac, randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { encryptSecret, upstreamKeyFingerprint } from '../lib/crypto.js';
import { fulfillPaidOrder, retryPaidOrders } from '../services/orders.js';
import { canonicalWebhookPayload } from '../services/payments.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integration('signed payment confirmation and recoverable fulfillment', () => {
  let app: FastifyInstance;
  let poolId: string;
  let originalCredentialId: string;
  let productId: string;
  let userId: string;
  const orderIds: string[] = [];
  const eventIds: string[] = [];

  async function makeCredential(label: string, verified = true, testOnly = false) {
    const key = `synthetic-upstream-${randomUUID()}`;
    const [credential] = await sql<{ id: string }[]>`
      INSERT INTO upstream_credentials (pool_id, label, encrypted_key, key_hint, status, key_fingerprint, available_models, catalog_valid_until, test_only)
      VALUES (${poolId}, ${label}, ${encryptSecret(key)}, 'synthetic', ${verified ? 'ACTIVE' : 'DEGRADED'}, ${upstreamKeyFingerprint(key)},
        ARRAY['payment-test-model'], ${verified ? new Date(Date.now() + 600_000) : null}, ${testOnly}) RETURNING id
    `;
    return credential!.id;
  }

  async function makeOrder(options: {
    provider: 'stripe' | 'nowpayments'; externalId: string | null; expired?: boolean; assigned?: boolean;
    durationDays?: number | null; topUpKeyId?: string;
  }) {
    const [order] = await sql<{ id: string }[]>`
      INSERT INTO orders (
        user_id, product_id, upstream_credential_id, payment_provider, status, currency, amount,
        price_markup, wholesale_credits, reserved_until, external_id, pool_id, grant_label, grant_duration_days,
        grant_concurrency_limit, metadata, top_up_key_id, credit_amount
      ) VALUES (
        ${userId}, ${productId}, ${options.assigned ? originalCredentialId : null}, ${options.provider},
        ${options.expired ? 'EXPIRED' : 'PENDING'}, 'USD', 20, 2, 10,
        ${new Date(Date.now() + (options.expired ? -60_000 : 3_600_000))}, ${options.externalId}, ${poolId},
        'Purchased terms', ${options.durationDays === undefined ? 7 : options.durationDays}, 1,
        ${sql.json({ payAmount: 10, payCurrency: 'ton' })}, ${options.topUpKeyId ?? null}, 20
      ) RETURNING id
    `;
    orderIds.push(order!.id);
    return order!.id;
  }

  function deliverTon(externalId: string, orderId: string, actuallyPaid: number, currency: string) {
    const payload = { payment_id: externalId, payment_status: 'finished', order_id: orderId,
      price_amount: 20, price_currency: 'usd', actually_paid: actuallyPaid, pay_currency: currency };
    const signature = createHmac('sha512', config.NOWPAYMENTS_IPN_SECRET).update(canonicalWebhookPayload(payload)).digest('hex');
    return app.inject({ method: 'POST', url: '/api/webhooks/nowpayments', payload, headers: { 'x-nowpayments-sig': signature } });
  }

  beforeAll(async () => {
    const suffix = randomUUID();
    const [pool] = await sql<{ id: string }[]>`
      INSERT INTO upstream_pools (name, slug, base_url, credential_capacity)
      VALUES ('Test provider', ${`payment-test-${suffix}`}, 'https://example.invalid', 1) RETURNING id
    `;
    poolId = pool!.id;
    originalCredentialId = await makeCredential('Original provider key', false);
    const [product] = await sql<{ id: string }[]>`
      INSERT INTO products (pool_id, name, slug, wholesale_credits, currency, duration_days, concurrency_limit)
      VALUES (${poolId}, 'Edited product name', ${`payment-test-${suffix}`}, 100, 'USD', 60, 10) RETURNING id
    `;
    productId = product!.id;
    await sql`INSERT INTO model_rates (pool_id, model, input_per_million, output_per_million) VALUES (${poolId}, 'payment-test-model', 1, 2)`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, name) VALUES (${`${suffix}@example.test`}, 'unused', 'Synthetic customer') RETURNING id
    `;
    userId = user!.id;
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (eventIds.length) await sql`DELETE FROM payment_events WHERE event_id IN ${sql(eventIds)}`;
    if (orderIds.length) {
      await sql`DELETE FROM orders WHERE id IN ${sql(orderIds)} AND top_up_key_id IS NOT NULL`;
      await sql`DELETE FROM api_keys WHERE order_id IN ${sql(orderIds)}`;
      await sql`DELETE FROM orders WHERE id IN ${sql(orderIds)}`;
    }
    if (productId) await sql`DELETE FROM products WHERE id = ${productId}`;
    if (poolId) {
      await sql`DELETE FROM upstream_credentials WHERE pool_id = ${poolId}`;
      await sql`DELETE FROM upstream_pools WHERE id = ${poolId}`;
    }
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
  });

  it('accepts a retry after a checkout race, records a late payment, and fulfills once when capacity returns', async () => {
    const orderId = await makeOrder({ provider: 'stripe', externalId: null, expired: true, assigned: true });
    const eventId = `evt_${randomUUID()}`;
    eventIds.push(eventId);
    const externalId = `cs_test_${randomUUID()}`;
    const deliver = (amount = 2000) => {
      const payload = JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: {
        id: externalId, mode: 'payment', payment_status: 'paid', metadata: { orderId }, currency: 'usd', amount_total: amount,
      } } });
      return app.inject({ method: 'POST', url: '/api/webhooks/stripe', payload, headers: {
        'content-type': 'application/json', 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: config.STRIPE_WEBHOOK_SECRET }),
      } });
    };
    const early = await deliver();
    expect(early.statusCode).toBe(503);
    expect(early.json().error.code).toBe('CHECKOUT_NOT_RECORDED');
    await sql`UPDATE orders SET external_id = ${externalId} WHERE id = ${orderId}`;
    const wrong = await deliver(1999);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('PAYMENT_MISMATCH');
    const paid = await deliver();
    expect(paid.statusCode).toBe(200);
    const [waiting] = await sql<{ status: string; upstreamCredentialId: string | null }[]>`
      SELECT status, upstream_credential_id FROM orders WHERE id = ${orderId}
    `;
    expect(waiting).toMatchObject({ status: 'PAID', upstreamCredentialId: null });
    expect((await deliver()).json().duplicate).toBe(true);

    const trial = await makeCredential('Verified test-only key', true, true);
    expect(await sql`SELECT 1 FROM sellable_upstream_slots WHERE id = ${trial}`).toHaveLength(1);
    await expect(fulfillPaidOrder(orderId)).rejects.toMatchObject({ code: 'NO_UPSTREAM_CAPACITY' });
    const replacement = await makeCredential('Verified replacement');
    await Promise.all([retryPaidOrders(), retryPaidOrders()]);
    const keys = await sql<{ label: string; creditsTotal: string; concurrencyLimit: number; upstreamCredentialId: string; duration: number }[]>`
      SELECT label, credits_total::text, concurrency_limit, upstream_credential_id,
        round(extract(epoch FROM (expires_at - created_at)) / 86400)::int AS duration
      FROM api_keys WHERE order_id = ${orderId}
    `;
    expect(keys).toMatchObject([{ label: 'Purchased terms', creditsTotal: '20.00000000', concurrencyLimit: 1, upstreamCredentialId: replacement, duration: 7 }]);
    const [finished] = await sql<{ status: string }[]>`SELECT status FROM orders WHERE id = ${orderId}`;
    expect(finished?.status).toBe('FULFILLED');
  });

  it('still reconciles full signed payments for legacy USD/Toncoin orders and top-ups', async () => {
    const externalId = Date.now().toString();
    const orderId = await makeOrder({ provider: 'nowpayments', externalId, durationDays: null });
    eventIds.push(`${externalId}:finished`);
    const deliver = (actuallyPaid: number, currency: string) => deliverTon(externalId, orderId, actuallyPaid, currency);
    expect((await deliver(9, 'ton')).statusCode).toBe(400);
    expect((await deliver(10, 'usdtton')).statusCode).toBe(400);
    const [before] = await sql<{ status: string }[]>`SELECT status FROM orders WHERE id = ${orderId}`;
    expect(before?.status).toBe('PENDING');
    await makeCredential('Crypto order capacity');
    expect((await deliver(10, 'ton')).statusCode).toBe(200);
    expect((await deliver(10, 'ton')).json().duplicate).toBe(true);
    const [after] = await sql<{ status: string; keyCount: number }[]>`
      SELECT status, (SELECT count(*)::int FROM api_keys WHERE order_id = ${orderId}) AS key_count FROM orders WHERE id = ${orderId}
    `;
    expect(after).toEqual({ status: 'FULFILLED', keyCount: 1 });

    const [key] = await sql<{ id: string }[]>`SELECT id FROM api_keys WHERE order_id = ${orderId}`;
    const depositId = (BigInt(externalId) + 1n).toString();
    const deposit = await makeOrder({ provider: 'nowpayments', externalId: depositId, topUpKeyId: key!.id, durationDays: null });
    eventIds.push(`${depositId}:finished`);
    expect((await deliverTon(depositId, deposit, 9, 'ton')).statusCode).toBe(400);
    expect((await deliverTon(depositId, deposit, 10, 'ton')).statusCode).toBe(200);
    expect((await deliverTon(depositId, deposit, 10, 'ton')).json().duplicate).toBe(true);
    expect(await sql`SELECT id, credits_total::text FROM api_keys WHERE order_id IN (${orderId}, ${deposit})`)
      .toEqual([{ id: key!.id, creditsTotal: '40.00000000' }]);
  });
});
