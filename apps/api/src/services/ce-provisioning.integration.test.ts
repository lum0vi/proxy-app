import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { decryptSecret } from '../lib/crypto.js';
import { ceLogin, ceProvisioningSettings, provisionCeKeys } from './ce-provisioning.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

interface MockKey {
  id: number;
  name: string;
  key: string;
  group_id: number;
  quota: number;
  quota_used: number;
  status: string;
}

integration('CE PayGo key provisioning', () => {
  const slug = `ce-provisioning-test-${randomUUID()}`;
  const initialToken = `mock-refresh-${randomUUID()}`;
  const access = `mock-access-${randomUUID()}`;
  const remoteKeys: MockKey[] = [];
  const login = { email: `${slug}@example.test`, password: `mock-password-${randomUUID()}` };
  const settings = { login, targets: [{ slug, groupId: 117 }], freeSlots: 2 };
  let http: FastifyInstance;
  let origin: string;
  let poolId: string;
  let requests = 0;
  let logins = 0;
  let refreshes = 0;
  let nextToken = '';
  let balance = 200;
  let subscriptionType = 'standard';
  let catalogReady = false;
  let loseCreateResponse = true;

  const request: typeof fetch = (url, init) => {
    const route = new URL(String(url));
    expect(route.origin).toBe('https://codex-everywhere.com');
    return fetch(`${origin}${route.pathname}${route.search}`, init);
  };

  beforeAll(async () => {
    http = Fastify();
    const envelope = (data: unknown) => ({ code: 0, data });
    http.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/v1/') || req.url.startsWith('/api/v1/auth/') && req.method === 'POST') return;
      if (req.headers.authorization !== `Bearer ${access}` || req.headers['x-user-ui-request'] !== '1') {
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      }
    });
    http.post('/api/v1/auth/login', async (req, reply) => {
      const body = req.body as { email: string; password: string };
      if (body.email !== login.email || body.password !== login.password) return reply.code(401).send({ code: 'INVALID_LOGIN' });
      logins += 1;
      nextToken = initialToken;
      return envelope({ access_token: access, refresh_token: nextToken, expires_in: 3600 });
    });
    http.post('/api/v1/auth/refresh', async (req, reply) => {
      if ((req.body as { refresh_token: string }).refresh_token !== nextToken) return reply.code(401).send({ code: 'EXPIRED' });
      refreshes += 1;
      nextToken = `mock-rotated-${randomUUID()}`;
      return envelope({ access_token: access, refresh_token: nextToken, expires_in: 3600 });
    });
    http.get('/api/v1/auth/me', async () => envelope({ id: 42, balance }));
    http.get('/api/v1/groups/available', async () => envelope([{ id: 117, name: 'Codex Plus Pool (PayGo)', subscription_type: subscriptionType }]));
    http.get('/api/v1/keys', async (req) => {
      const { search } = req.query as { search: string };
      const items = remoteKeys.filter(key => key.name === search);
      return envelope({ total: items.length, items });
    });
    http.get('/api/v1/keys/:id', async (req, reply) => {
      const key = remoteKeys.find(key => key.id === Number((req.params as { id: string }).id));
      return key ? envelope(key) : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    http.post('/api/v1/keys', async (req, reply) => {
      requests += 1;
      expect(req.headers['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
      const body = req.body as { name: string; group_id: number; custom_key: string; quota: number };
      expect(body).toMatchObject({ group_id: 117, quota: 50 });
      expect(body.custom_key).toMatch(/^sk-[a-f0-9]{64}$/);
      const key = { id: requests, name: body.name, group_id: body.group_id, key: body.custom_key, quota: body.quota, quota_used: 0, status: 'active' };
      remoteKeys.push(key);
      if (loseCreateResponse) {
        loseCreateResponse = false;
        return reply.code(503).send({ error: 'Synthetic failure after key creation' });
      }
      return envelope(key);
    });
    http.get('/v1/models', async (req, reply) => {
      if (!remoteKeys.some(key => req.headers.authorization === `Bearer ${key.key}`)) return reply.code(401).send({});
      return catalogReady ? { data: [{ id: 'priced-ce-model' }] } : reply.code(503).send({});
    });
    origin = await http.listen({ host: '127.0.0.1', port: 0 });

    const [pool] = await sql<{ id: string }[]>`
      INSERT INTO upstream_pools (name, slug, base_url, credential_capacity)
      VALUES ('CE test plan', ${slug}, 'https://codex-everywhere.com', 2) RETURNING id
    `;
    poolId = pool!.id;
    await sql`INSERT INTO products (pool_id, name, slug, wholesale_credits, currency, concurrency_limit)
      VALUES (${poolId}, 'Provisioning test', ${slug}, 25, 'USD', 2)`;
    await sql`INSERT INTO model_rates (pool_id, model, input_per_million, output_per_million)
      VALUES (${poolId}, 'priced-ce-model', 1, 1)`;
  });

  afterAll(async () => {
    await http?.close();
    if (poolId) {
      await sql`DELETE FROM ce_key_provisioning_jobs WHERE pool_id = ${poolId}`;
      await sql`DELETE FROM upstream_credentials WHERE pool_id = ${poolId}`;
      await sql`DELETE FROM products WHERE pool_id = ${poolId}`;
      await sql`DELETE FROM upstream_pools WHERE id = ${poolId}`;
    }
    const sessions = await sql<{ bootstrapHash: string; encryptedAccessToken: string }[]>`
      SELECT bootstrap_hash, encrypted_access_token FROM ce_management_session`;
    for (const session of sessions) {
      if (decryptSecret(session.encryptedAccessToken) === access) {
        await sql`DELETE FROM ce_management_session WHERE bootstrap_hash = ${session.bootstrapHash}`;
      }
    }
  });

  it('keeps manual mode as the default', () => {
    expect(ceProvisioningSettings()).toBeUndefined();
    expect(ceLogin({ CE_PROVISION_EMAIL: login.email, CE_PROVISION_PASSWORD: login.password })).toEqual(login);
  });

  it('recovers a created key after a lost response and sells capacity only after the catalog is verified', async () => {
    subscriptionType = 'subscription';
    await provisionCeKeys(settings, request);
    subscriptionType = 'standard';
    balance = 49;
    await provisionCeKeys(settings, request);
    expect(requests).toBe(0);

    balance = 200;
    await Promise.all([provisionCeKeys(settings, request), provisionCeKeys(settings, request)]);
    expect(requests).toBe(1);
    expect(await sql`SELECT id FROM upstream_credentials WHERE pool_id = ${poolId}`).toHaveLength(0);
    const retryNow = () => sql`UPDATE ce_key_provisioning_jobs SET retry_at = now() - interval '1 minute' WHERE pool_id = ${poolId}`;
    await retryNow();
    const sessions = await sql<{ bootstrapHash: string; encryptedAccessToken: string }[]>`
      SELECT bootstrap_hash, encrypted_access_token FROM ce_management_session`;
    const session = sessions.find(session => decryptSecret(session.encryptedAccessToken) === access);
    expect(session).toBeDefined();
    await sql`UPDATE ce_management_session SET expires_at = now() - interval '1 minute' WHERE bootstrap_hash = ${session!.bootstrapHash}`;
    await provisionCeKeys(settings, request);
    expect(requests).toBe(1);
    const [stored] = await sql<{ encryptedKey: string; status: string }[]>`
      SELECT encrypted_key, status FROM upstream_credentials WHERE pool_id = ${poolId}`;
    expect(stored?.status).toBe('DEGRADED');
    expect(decryptSecret(stored!.encryptedKey)).toBe(remoteKeys[0]?.key);
    expect(await sql`SELECT id FROM sellable_upstream_slots WHERE pool_id = ${poolId}`).toHaveLength(0);

    catalogReady = true;
    await retryNow();
    await provisionCeKeys(settings, request);
    await provisionCeKeys(settings, request);
    expect(requests).toBe(1);
    expect(logins).toBe(1);
    expect(refreshes).toBe(1);
    expect(await sql`SELECT credential_capacity FROM sellable_upstream_slots WHERE pool_id = ${poolId}`)
      .toEqual([{ credentialCapacity: 2 }]);
    expect(await sql`SELECT id FROM ce_key_provisioning_jobs WHERE pool_id = ${poolId}`).toHaveLength(0);
  });
});
