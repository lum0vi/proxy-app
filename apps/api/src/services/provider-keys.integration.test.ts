import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { sessionCookieName } from '../auth/session.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { decryptSecret, encryptSecret, sha256, upstreamKeyFingerprint } from '../lib/crypto.js';
import { syncCeKeys } from './ce-provisioning.js';
import { ceKeyProvider, listProviderKeys, listUserKeys } from './provider-keys.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integration('CE key inventory and customer assignments', () => {
  const suffix = randomUUID();
  const secretA = `sk-synthetic-inventory-a-${suffix}`, secretB = `sk-synthetic-inventory-b-${suffix}`;
  const access = `inventory-access-${suffix}`, refresh = `inventory-refresh-${suffix}`;
  const login = { email: `ce-${suffix}@example.test`, password: `synthetic-password-${suffix}` };
  const options = { activeOnly: true, page: 1, pageSize: 25 };
  let remoteKeys = [
    { id: 1, name: 'Funded shared key', key: secretA, group_id: 117, group: { name: 'PayGo' }, status: 'active', quota: 10, quota_used: 2, expires_at: null },
    { id: 2, name: 'Account allowance', key: secretB, group_id: 118, group: { name: 'Shared account' }, status: 'active', quota: 0, quota_used: 30, expires_at: null },
    { id: 3, name: 'Spent key', key: `sk-spent-${suffix}`, group_id: 117, group: { name: 'PayGo' }, status: 'active', quota: 10, quota_used: 10, expires_at: null },
    { id: 4, name: 'Disabled key', key: `sk-disabled-${suffix}`, group_id: 117, group: { name: 'PayGo' }, status: 'inactive', quota: 10, quota_used: 1, expires_at: null },
    { id: 5, name: 'Expired key', key: `sk-expired-${suffix}`, group_id: 117, group: { name: 'PayGo' }, status: 'active', quota: 10, quota_used: 1, expires_at: '2000-01-01T00:00:00Z' },
  ];
  let app: FastifyInstance, http: FastifyInstance, origin: string;
  let poolId = '', channelId = '', credentialId = '', secondCredentialId = '', productId = '', customerKeyId = '';
  let adminHeaders: { cookie: string }, userHeaders: { cookie: string };
  const users: string[] = [], pages: number[] = [];
  let mode: 'ok' | 'partial-error' | 'changed' = 'ok';
  const request: typeof fetch = (url, init) => {
    const path = new URL(String(url));
    expect(path.origin).toBe('https://codex-everywhere.com');
    expect(init?.method).toBe(path.pathname === '/api/v1/auth/login' ? 'POST' : 'GET');
    return fetch(`${origin}${path.pathname}${path.search}`, init);
  };
  async function session(userId: string) {
    const value = randomUUID();
    await sql`INSERT INTO sessions(user_id, token_hash, expires_at)
      VALUES (${userId}, ${sha256(`${config.SESSION_SECRET}:${value}`)}, now() + interval '1 hour')`;
    return { cookie: `${sessionCookieName}=${value}` };
  }
  beforeAll(async () => {
    http = Fastify();
    const envelope = (data: unknown) => ({ code: 0, data });
    http.post('/api/v1/auth/login', async request => {
      expect(request.body).toEqual(login);
      return envelope({ access_token: access, refresh_token: refresh, expires_in: 3600 });
    });
    http.get('/api/v1/auth/me', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${access}`);
      return envelope({ id: 42, balance: 200 });
    });
    http.get('/api/v1/keys', async (request, reply) => {
      expect(request.headers.authorization).toBe(`Bearer ${access}`);
      expect(request.headers['x-user-ui-request']).toBe('1');
      const query = request.query as { page: string; page_size: string };
      expect(query.page_size).toBe('100');
      const page = Number(query.page); pages.push(page);
      if (mode === 'partial-error' && page === 2) return reply.code(503).send({});
      return envelope({ total: remoteKeys.length + (mode === 'changed' && page === 2 ? 1 : 0), items: remoteKeys.slice((page - 1) * 2, page * 2) });
    });
    origin = await http.listen({ host: '127.0.0.1', port: 0 });
    const [pool] = await sql`INSERT INTO upstream_pools(name, slug, base_url)
      VALUES ('Inventory provider', ${`inventory-${suffix}`}, 'https://codex-everywhere.com') RETURNING id`;
    poolId = pool!.id;
    const [channel] = await sql`INSERT INTO upstream_pools(name, slug, base_url, parent_pool_id, protocol)
      VALUES ('Inventory channel', ${`inventory-channel-${suffix}`}, 'https://codex-everywhere.com', ${poolId}, 'ANTHROPIC') RETURNING id`;
    channelId = channel!.id;
    for (const [pool, secret] of [[poolId, secretA], [channelId, secretB]]) {
      const [credential] = await sql`INSERT INTO upstream_credentials(pool_id, label, encrypted_key, key_hint, key_fingerprint, status, spend_limit, spend_used)
        VALUES (${pool!}, 'Connected key', ${encryptSecret(secret!)}, 'synthetic-hint', ${upstreamKeyFingerprint(secret!)}, 'ACTIVE', 20, 4) RETURNING id`;
      if (pool === poolId) credentialId = credential!.id; else secondCredentialId = credential!.id;
    }
    const [product] = await sql`INSERT INTO products(pool_id, name, slug, wholesale_credits, currency)
      VALUES (${poolId}, 'Inventory key', ${`inventory-key-${suffix}`}, 10, 'USDT') RETURNING id`;
    productId = product!.id;
    for (let index = 0; index < 3; index++) {
      const [user] = await sql`INSERT INTO users(email, password_hash, role)
        VALUES (${`inventory-${index}-${suffix}@example.test`}, 'unused', ${index === 2 ? 'ADMIN' : 'USER'}) RETURNING id`;
      users.push(user!.id);
      if (index === 2) continue;
      const [order] = await sql`INSERT INTO orders(user_id, product_id, upstream_credential_id, pool_id, payment_provider, status,
        currency, amount, credit_amount, price_markup, wholesale_credits, reserved_until, grant_label, grant_concurrency_limit)
        VALUES (${user!.id}, ${productId}, ${credentialId}, ${poolId}, 'mock', 'FULFILLED', 'USDT', 20, 20, 2, 10, now(), 'Inventory key', 2) RETURNING id`;
      const [key] = await sql`INSERT INTO api_keys(user_id, product_id, order_id, upstream_credential_id,
        key_hash, encrypted_key, key_hint, label, credits_total, credits_used)
        VALUES (${user!.id}, ${productId}, ${order!.id}, ${credentialId}, ${sha256(`${suffix}-${index}`)},
          ${encryptSecret(`synthetic-customer-key-${suffix}-${index}`)}, 'synthetic-customer-hint', 'Customer key', 20, ${index === 0 ? 5 : 7.5}) RETURNING id`;
      if (index === 0) customerKeyId = key!.id;
    }
    // Primary and channel assignments must be deduplicated for the same credential.
    await sql`INSERT INTO api_key_channel_assignments(api_key_id, pool_id, upstream_credential_id)
      VALUES (${customerKeyId}, ${poolId}, ${credentialId}), (${customerKeyId}, ${channelId}, ${secondCredentialId})`;
    adminHeaders = await session(users[2]!); userHeaders = await session(users[0]!);
    app = await buildApp(); await app.ready();
  });

  afterAll(async () => {
    await app?.close(); await http?.close();
    await sql`DELETE FROM provider_key_sync WHERE provider = ${ceKeyProvider}`;
    await sql`DELETE FROM provider_balances WHERE provider = ${ceKeyProvider}`;
    if (productId) {
      await sql`DELETE FROM api_keys WHERE product_id = ${productId}`;
      await sql`DELETE FROM orders WHERE product_id = ${productId}`;
      await sql`DELETE FROM products WHERE id = ${productId}`;
    }
    if (poolId) {
      await sql`DELETE FROM upstream_credentials WHERE pool_id IN (${poolId}, ${channelId})`;
      await sql`DELETE FROM upstream_pools WHERE id = ${channelId}`;
      await sql`DELETE FROM upstream_pools WHERE id = ${poolId}`;
    }
    if (users.length) {
      await sql`DELETE FROM audit_logs WHERE entity_type = 'PROVIDER_KEYS' AND actor_user_id IN ${sql(users)}`;
      await sql`DELETE FROM users WHERE id IN ${sql(users)}`;
    }
    for (const row of await sql<{ bootstrapHash: string; encryptedAccessToken: string }[]>`SELECT bootstrap_hash, encrypted_access_token FROM ce_management_session`) {
      if (decryptSecret(row.encryptedAccessToken) === access) await sql`DELETE FROM ce_management_session WHERE bootstrap_hash = ${row.bootstrapHash}`;
    }
  });

  it('reads all pages, distinguishes unlimited and exhausted keys, and links shared customer balances without exposing secrets', async () => {
    await syncCeKeys(login, request);
    expect(pages).toEqual([1, 2, 3]);
    const response = await app.inject({ method: 'GET', url: '/api/admin/provider-keys', headers: adminHeaders });
    expect(response.statusCode).toBe(200);
    const data = response.json();
    expect(data.total).toBe(2);
    expect(data.sync).toMatchObject({ stale: false, accountId: '42' });
    expect(data.keys[0]).toMatchObject({ externalId: '1', remainingUsd: '8.00000000', credentialId });
    expect(data.keys[0].customerKeys).toHaveLength(2);
    expect(data.keys[0].customerKeys.map((key: { remainingUsdt: string }) => key.remainingUsdt)).toEqual(['15.00000000', '12.50000000']);
    expect(data.keys[1]).toMatchObject({ externalId: '2', quotaUsd: null, remainingUsd: null, active: true });
    for (const secret of [secretA, secretB, login.password, access, 'keyFingerprint', 'encryptedKey']) expect(response.payload).not.toContain(secret);
    const user = await listUserKeys(users[0]!, options);
    expect(user?.keys).toHaveLength(1);
    expect(user!.keys[0]).toMatchObject({ remainingUsdt: '15.00000000', currency: 'USDT' });
    const upstreams = user!.keys[0]!.upstreams as Record<string, unknown>[];
    expect(upstreams).toHaveLength(2);
    expect(upstreams.find(upstream => upstream.id === credentialId)).toMatchObject({ remoteRemainingUsd: '8.00000000', sharedKeyCount: 2, remoteStale: false });
  });

  it('restricts inventory, refresh and customer assignments to admins', async () => {
    for (const route of [
      { method: 'GET' as const, url: '/api/admin/provider-keys' },
      { method: 'POST' as const, url: '/api/admin/provider-keys/refresh' },
      { method: 'GET' as const, url: `/api/admin/users/${users[1]}/keys` },
    ]) {
      expect((await app.inject(route)).statusCode).toBe(401);
      expect((await app.inject({ ...route, headers: userHeaders })).statusCode).toBe(403);
    }
    const customer = await app.inject({ method: 'GET', url: '/api/keys', headers: userHeaders });
    expect(customer.statusCode).toBe(200);
    expect(customer.payload).not.toContain('Inventory provider');
    expect(customer.payload).not.toContain(secretA);
    const refresh = await app.inject({ method: 'POST', url: '/api/admin/provider-keys/refresh', headers: adminHeaders });
    expect(refresh.statusCode).toBe(202);
    expect((await listProviderKeys(options)).sync.requested).toBe(true);
  });

  it('preserves the previous complete snapshot when pagination fails or changes', async () => {
    const before = await listProviderKeys(options);
    mode = 'partial-error'; remoteKeys[0]!.quota_used = 10;
    await syncCeKeys(login, request);
    const failed = await listProviderKeys(options);
    expect(failed.keys).toEqual(before.keys);
    expect(failed.sync).toMatchObject({ stale: true, lastError: 'CE_HTTP_ERROR_503', requested: false });
    expect(failed.sync.checkedAt).toEqual(before.sync.checkedAt);
    expect((await listUserKeys(users[0]!, options))!.keys[0]!.upstreams).toEqual(expect.arrayContaining([expect.objectContaining({ id: credentialId, remoteStale: true })]));
    mode = 'changed'; await syncCeKeys(login, request);
    expect((await listProviderKeys(options)).sync.lastError).toBe('CE_KEY_LIST_CHANGED');
  });

  it('excludes spent or removed keys after a successful sync while keeping customers and their balances intact', async () => {
    mode = 'ok'; await syncCeKeys(login, request);
    expect((await listProviderKeys(options)).keys.map(key => key.externalId)).toEqual(['2']);
    remoteKeys = []; await syncCeKeys(login, request);
    expect((await listProviderKeys(options)).total).toBe(0);
    const all = await listProviderKeys({ ...options, activeOnly: false });
    expect(all.total).toBe(5);
    expect(all.keys.every(key => key.present === false)).toBe(true);
    expect((await listUserKeys(users[0]!, options))!.keys[0]).toMatchObject({ remainingUsdt: '15.00000000', status: 'ACTIVE' });
  });
});
