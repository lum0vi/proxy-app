import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { sessionCookieName } from '../auth/session.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { encryptSecret, sha256, upstreamKeyFingerprint } from '../lib/crypto.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integration('admin provider credentials', () => {
  const poolId = randomUUID();
  const credentialId = randomUUID();
  const adminId = randomUUID();
  const buyerId = randomUUID();
  const productId = randomUUID();
  const orderId = randomUUID();
  const keyId = randomUUID();
  const leaseId = randomUUID();
  const providerKey = `sk-test-provider-${randomUUID()}`;
  const headers = { cookie: `${sessionCookieName}=${randomUUID()}` };
  const url = `/api/admin/credentials/${credentialId}`;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${adminId}, ${`${adminId}@example.test`}, 'unused', 'ADMIN'),
      (${buyerId}, ${`${buyerId}@example.test`}, 'unused', 'USER')`;
    const token = headers.cookie.slice(sessionCookieName.length + 1);
    await sql`INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${adminId}, ${sha256(`${config.SESSION_SECRET}:${token}`)}, now() + interval '1 hour')`;
    await sql`INSERT INTO upstream_pools (id, name, slug, base_url)
      VALUES (${poolId}, 'Admin test provider', ${`admin-test-${poolId}`}, 'https://provider.invalid')`;
    await sql`INSERT INTO upstream_credentials (id, pool_id, label, encrypted_key, key_hint, key_fingerprint, spend_limit)
      VALUES (${credentialId}, ${poolId}, 'Original key', ${encryptSecret(providerKey)}, 'masked', ${upstreamKeyFingerprint(providerKey)}, 10)`;
    await sql`INSERT INTO products (id, pool_id, name, slug, wholesale_credits, currency)
      VALUES (${productId}, ${poolId}, 'Admin test product', ${`admin-test-${productId}`}, 1, 'USDT')`;
    await sql`INSERT INTO orders (id, user_id, product_id, upstream_credential_id, pool_id, payment_provider, status,
      currency, amount, credit_amount, price_markup, wholesale_credits, reserved_until, grant_label, grant_concurrency_limit)
      VALUES (${orderId}, ${buyerId}, ${productId}, ${credentialId}, ${poolId}, 'mock', 'FULFILLED', 'USDT', 2, 2, 2, 1, now(), 'Test key', 2)`;
    await sql`INSERT INTO api_keys (id, user_id, product_id, order_id, upstream_credential_id, key_hash, encrypted_key, key_hint, label, credits_total)
      VALUES (${keyId}, ${buyerId}, ${productId}, ${orderId}, ${credentialId}, ${sha256(keyId)}, 'unused', 'masked', 'Customer key', 2)`;
    await sql`INSERT INTO request_leases (id, api_key_id, upstream_credential_id, expires_at)
      VALUES (${leaseId}, ${keyId}, ${credentialId}, now() + interval '1 hour')`;
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await sql`DELETE FROM api_keys WHERE id = ${keyId}`;
    await sql`DELETE FROM orders WHERE id = ${orderId}`;
    await sql`DELETE FROM products WHERE id = ${productId}`;
    await sql`DELETE FROM upstream_pools WHERE id = ${poolId}`;
    await sql`DELETE FROM audit_logs WHERE actor_user_id = ${adminId}`;
    await sql`DELETE FROM users WHERE id IN (${adminId}, ${buyerId})`;
  });

  it('updates metadata, blocks removing an in-use key, and preserves customer history on deletion', async () => {
    const original = await sql`SELECT encrypted_key FROM upstream_credentials WHERE id = ${credentialId}`;
    const update = await app.inject({ method: 'PATCH', url, headers, payload: {
      label: 'Updated key', maxConcurrency: 4, priority: 120, spendLimit: null,
    } });
    expect(update.statusCode).toBe(200);

    const list = () => app.inject({ method: 'GET', url: '/api/admin/credentials', headers });
    const updated = (await list()).json().credentials.find((key: { id: string }) => key.id === credentialId);
    expect(updated).toMatchObject({ label: 'Updated key', maxConcurrency: 4, priority: 120, spendLimit: null, keyHint: 'masked' });
    expect(updated).not.toHaveProperty('encryptedKey');
    const current = await sql`SELECT encrypted_key FROM upstream_credentials WHERE id = ${credentialId}`;
    expect(current).toEqual(original);

    const remove = () => app.inject({ method: 'DELETE', url, headers });
    expect((await remove()).statusCode).toBe(409);
    await sql`DELETE FROM request_leases WHERE id = ${leaseId}`;
    expect((await remove()).statusCode).toBe(204);
    expect((await remove()).statusCode).toBe(204);
    expect((await list()).json().credentials).not.toContainEqual(expect.objectContaining({ id: credentialId }));
    expect((await app.inject({ method: 'PATCH', url, headers, payload: { status: 'ACTIVE' } })).statusCode).toBe(404);

    const [retired] = await sql`SELECT uc.encrypted_key, uc.key_fingerprint, uc.status, ak.id AS customer_key_id
      FROM upstream_credentials uc JOIN api_keys ak ON ak.upstream_credential_id = uc.id WHERE uc.id = ${credentialId}`;
    expect(retired).toMatchObject({ encryptedKey: '', keyFingerprint: null, status: 'DISABLED', customerKeyId: keyId });
    const [audit] = await sql`SELECT count(*)::int AS count FROM audit_logs WHERE entity_id = ${credentialId} AND action = 'DELETE'`;
    expect(audit?.count).toBe(1);
  });
});
