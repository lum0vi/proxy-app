import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { sessionCookieName } from '../auth/session.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { decryptSecret, encryptSecret, sha256 } from '../lib/crypto.js';
import { createOrder } from '../services/orders.js';
import { refreshUpstreamCatalog } from '../services/upstream-catalog.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integration('purchase allocation and OpenAI-compatible proxy', () => {
  let app: FastifyInstance;
  let upstream: FastifyInstance;
  let poolId = '';
  let credentialId = '';
  let productId = '';
  let key = '';
  let secondKey = '';
  let slug = '';
  const userIds: string[] = [];
  const channelCredentials: string[] = [];
  const channels: string[] = [];
  const seenAuthorization: string[] = [];
  const modelIds = ['integration-model', 'other-model', 'unpriced-model', 'cheap-model', 'image-model'];
  const seenInference: { endpoint: string; body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];
  let catalogMode: 'ok' | 'trial' | 'html' = 'ok';
  let holdNextResponse: { started(): void; release: Promise<void> } | undefined;
  const auth = () => ({ authorization: `Bearer ${key}` });

  async function session(userId: string) {
    const token = randomUUID();
    await sql`INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${userId}, ${sha256(`${config.SESSION_SECRET}:${token}`)}, now() + interval '1 hour')`;
    return { cookie: `${sessionCookieName}=${token}` };
  }

  async function updateCatalog(mode: typeof catalogMode) {
    catalogMode = mode;
    await refreshUpstreamCatalog(credentialId);
  }

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    slug = `integration-${suffix}`;
    upstream = Fastify({ logger: false });
    upstream.get('/v1/models', async (_request, reply) => {
      if (_request.headers['x-api-key'] === 'upstream-claude-key') return { data: [{ id: 'claude-integration' }] };
      if (catalogMode === 'trial') return reply.code(403).send({ error: { message: 'No active subscription found for this group' } });
      if (catalogMode === 'html') return reply.type('text/html').send('<h1>Gateway</h1>');
      return { object: 'list', data: modelIds.map((id) => ({ id })) };
    });
    upstream.get('/v1beta/models', async (request, reply) => request.headers['x-goog-api-key'] === 'upstream-gemini-key'
      ? { models: [{ name: 'models/gemini-integration' }, { name: 'models/gemini-unpriced' }] }
      : reply.code(401).send({}));
    upstream.post('/v1/messages', async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      seenInference.push({ endpoint: request.url, body, headers: request.headers });
      if (request.headers['x-api-key'] !== 'upstream-claude-key') return reply.code(401).send({});
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":800,"cache_read_input_tokens":200,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_5m_input_tokens":200,"ephemeral_1h_input_tokens":100},"output_tokens":1}}}\n\n');
      reply.raw.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":50},"delta":{"stop_reason":"end_turn"}}\n\n');
      reply.raw.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    upstream.post('/v1beta/models/*', async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      seenInference.push({ endpoint: request.url, body, headers: request.headers });
      if (request.headers['x-goog-api-key'] !== 'upstream-gemini-key' || request.headers.authorization) return reply.code(401).send({});
      const response = { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 500,
        cachedContentTokenCount: 100, toolUsePromptTokenCount: 10, candidatesTokenCount: 35, thoughtsTokenCount: 15 } };
      if (request.url.endsWith(':streamGenerateContent?alt=sse')) {
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
        reply.raw.end(`data: ${JSON.stringify(response)}\n\n`);
        return;
      }
      return response;
    });
    upstream.post('/v1/responses', async (request, reply) => {
      seenAuthorization.push(request.headers.authorization ?? '');
      const body = request.body as Record<string, unknown>;
      seenInference.push({ endpoint: request.url, body, headers: request.headers });
      if (body.input === 'private-http-error') return reply.code(400).send({ error: { message: 'Integration provider private diagnostic' } });
      if (body.input === 'private-stream-error') {
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
        reply.raw.write('event: response.failed\r\ndata: {"type":"response.failed",');
        reply.raw.end('"response":{"id":"resp_failed","error":{"message":"Integration provider private diagnostic"}}}\r\n\r\n');
        return;
      }
      if (body.input === 'interrupted-stream') {
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        reply.raw.end('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
        return;
      }
      if (holdNextResponse) {
        const pending = holdNextResponse;
        holdNextResponse = undefined;
        pending.started();
        await pending.release;
      }
      return {
        id: 'resp_integration',
        object: 'response',
        model: body.model,
        output: [],
        usage: body.input === 'tiny-cached-usage'
          ? { input_tokens: 1, output_tokens: 0, input_tokens_details: { cached_tokens: 1 } }
          : { input_tokens: 1000, output_tokens: 500, input_tokens_details: { cached_tokens: 200 } },
      };
    });
    upstream.post('/v1/responses/compact', async (request) => {
      seenInference.push({ endpoint: request.url, body: request.body as Record<string, unknown>, headers: request.headers });
      return { object: 'response.compaction', output: [{ type: 'compaction', encrypted_content: 'opaque' }],
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 20 } } };
    });
    upstream.post('/v1/images/generations', async () => ({ data: [{ b64_json: 'aW1hZ2U=' }] }));
    upstream.post('/v1/chat/completions', async (request, reply) => {
      seenAuthorization.push(request.headers.authorization ?? '');
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      reply.raw.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      reply.raw.write('data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":50}}}\n\n');
      reply.raw.end('data: [DONE]\n\n');
    });
    await upstream.listen({ host: '127.0.0.1', port: 0 });
    const address = upstream.server.address();
    if (!address || typeof address === 'string') throw new Error('Mock upstream did not bind a TCP port');

    const [pool] = await sql<{ id: string }[]>`
      INSERT INTO upstream_pools (name, slug, base_url, credential_capacity)
      VALUES ('Integration provider', ${slug}, ${`http://127.0.0.1:${address.port}`}, 2)
      RETURNING id
    `;
    poolId = pool!.id;
    const [credential] = await sql<{ id: string }[]>`
      INSERT INTO upstream_credentials (pool_id, label, encrypted_key, key_hint, max_concurrency)
      VALUES (${poolId}, 'Integration key', ${encryptSecret('upstream-test-key')}, 'upstream…-key', 8)
      RETURNING id
    `;
    credentialId = credential!.id;
    const [product] = await sql<{ id: string }[]>`
      INSERT INTO products (pool_id, name, slug, wholesale_credits, currency, duration_days, concurrency_limit)
      VALUES (${poolId}, 'Integration key', ${`${slug}-product`}, 10, 'USD', 30, 2)
      RETURNING id
    `;
    productId = product!.id;
    await sql`
      INSERT INTO model_rates (
        pool_id, model, input_per_million, output_per_million, cached_input_per_million
      ) VALUES (${poolId}, 'integration-model', 1, 2, 0.1),
        (${poolId}, 'other-model', 2, 4, 0.2), (${poolId}, 'configured-but-absent', 1, 1, 0),
        (${poolId}, 'cheap-model', 1, 2, 0.003), (${poolId}, 'image-model', 0, 0, 0)
    `;
    await sql`UPDATE model_rates SET per_request = 0.015 WHERE pool_id = ${poolId} AND model = 'image-model'`;
    await sql`UPDATE model_rates SET long_context_threshold = 272000, long_context_multiplier = 2
      WHERE pool_id = ${poolId} AND model = 'other-model'`;
    await updateCatalog('ok');

    for (let index = 0; index < 3; index += 1) {
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO users (email, password_hash, name)
        VALUES (${`${slug}-${index}@example.test`}, 'not-used-by-this-test', ${`Buyer ${index + 1}`})
        RETURNING id
      `;
      userIds.push(user!.id);
    }

    app = await buildApp();
    await app.ready();
    for (const userId of userIds.slice(0, 2)) {
      const headers = await session(userId);
      const created = await app.inject({ method: 'POST', url: '/api/orders', headers, payload: { productId, paymentProvider: 'mock' } });
      expect(created.statusCode).toBe(201);
      const { order } = created.json();
      const paid = await app.inject({ method: 'POST', url: `/api/payments/mock/${order.id}/complete`, headers });
      expect(paid.statusCode).toBe(200);
    }

    const [storedKey] = await sql<{ encryptedKey: string }[]>`
      SELECT encrypted_key FROM api_keys WHERE user_id = ${userIds[0]!}
    `;
    key = decryptSecret(storedKey!.encryptedKey);
    const [other] = await sql<{ encryptedKey: string }[]>`
      SELECT encrypted_key FROM api_keys WHERE user_id = ${userIds[1]!}
    `;
    secondKey = decryptSecret(other!.encryptedKey);
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (upstream) await upstream.close();
    if (credentialId) {
      const used = [credentialId, ...channelCredentials];
      await sql`DELETE FROM usage_records WHERE upstream_credential_id IN ${sql(used)}`;
      await sql`DELETE FROM request_leases WHERE upstream_credential_id IN ${sql(used)}`;
    }
    if (productId) {
      await sql`DELETE FROM api_keys WHERE product_id = ${productId}`;
      await sql`DELETE FROM orders WHERE product_id = ${productId}`;
      await sql`DELETE FROM products WHERE id = ${productId}`;
    }
    if (credentialId) await sql`DELETE FROM upstream_credentials WHERE id IN ${sql([credentialId, ...channelCredentials])}`;
    if (channels.length) await sql`DELETE FROM upstream_pools WHERE id IN ${sql(channels)}`;
    if (poolId) await sql`DELETE FROM upstream_pools WHERE id = ${poolId}`;
    if (userIds.length > 0) await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
  });

  it('assigns exactly two sold keys to one upstream credential and rejects a third sale', async () => {
    const assigned = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM api_keys WHERE upstream_credential_id = ${credentialId}
    `;
    expect(assigned[0]?.count).toBe(2);

    await expect(createOrder({
      userId: userIds[2]!,
      userEmail: `${slug}-2@example.test`,
      productId,
      paymentProvider: 'mock',
    })).rejects.toMatchObject({ code: 'NO_UPSTREAM_CAPACITY', statusCode: 409 });

    const inventoryResponse = await app.inject({ method: 'GET', url: '/api/products' });
    expect(inventoryResponse.statusCode).toBe(200);
    const product = inventoryResponse.json().products.find((item: { id: string }) => item.id === productId);
    expect(product.inventory).toBe(0);
  });

  it('forwards Responses and streaming Chat Completions while recording exact usage', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: { model: 'integration-model', input: 'hello' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe('resp_integration');

    const stream = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: { model: 'integration-model', messages: [{ role: 'user', content: 'hello' }], stream: true },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.payload).toContain('data: [DONE]');
    expect(seenAuthorization).toEqual(['Bearer upstream-test-key', 'Bearer upstream-test-key']);

    let accounting: { creditsUsed: string; requestCount: number } | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      [accounting] = await sql<{ creditsUsed: string; requestCount: number }[]>`
        SELECT ak.credits_used::text,
          (SELECT count(*)::int FROM usage_records ur
            WHERE ur.api_key_id = ak.id AND ur.status = 'SUCCEEDED') AS request_count
        FROM api_keys ak WHERE ak.user_id = ${userIds[0]!}
      `;
      if (accounting?.requestCount === 2) break;
      await delay(25);
    }
    expect(accounting?.creditsUsed).toBe('0.00435000');
    expect(accounting?.requestCount).toBe(2);
  });

  it('hides unpriced or unavailable models, and blocks stored state and path escapes before upstream', async () => {
    const catalog = await app.inject({ method: 'GET', url: '/v1/models?client_version=0.159.2', headers: auth() });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().data.map((entry: { id: string }) => entry.id)).toEqual(['cheap-model', 'image-model', 'integration-model', 'other-model']);
    expect(catalog.json().data.every((entry: { owned_by: string }) => entry.owned_by === 'unknown')).toBe(true);
    const before = seenInference.length;
    for (const url of ['/v1/responses/resp_foreign', '/v1/responses/%2e%2e/secret', '/v1/images/edits']) {
      const res = await app.inject({ method: 'POST', url, headers: auth(), payload: { model: 'integration-model' } });
      expect(res.statusCode).toBe(404);
    }
    for (const payload of [{ previous_response_id: 'resp_foreign' }, { input: [{ type: 'item_reference', id: 'msg_foreign' }] },
      { tools: [{ type: 'web_search' }] }]) {
      const res = await app.inject({ method: 'POST', url: '/v1/responses', headers: auth(), payload: { model: 'integration-model', ...payload } });
      expect(res.statusCode).toBe(400);
    }
    const unpriced = await app.inject({ method: 'POST', url: '/v1/responses/compact', headers: auth(), payload: { model: 'unpriced-model' } });
    const unavailable = await app.inject({ method: 'POST', url: '/v1/responses', headers: auth(), payload: { model: 'configured-but-absent' } });
    expect(unpriced.json().error.code).toBe('MODEL_NOT_PRICED');
    expect(unavailable.json().error.code).toBe('MODEL_NOT_AVAILABLE');
    expect(seenInference.length).toBe(before);
  });

  it('quotes published model rates and withholds the provider identity from shoppers', async () => {
    const listing = await app.inject({ method: 'GET', url: '/api/products' });
    const product = listing.json().products.find((item: { id: string }) => item.id === productId);
    expect(product).toMatchObject({ retailPrice: '20.00', usageAllowance: '20.00000000', inventory: 0 });
    expect(product).not.toHaveProperty('wholesaleCredits');
    expect(product).not.toHaveProperty('providerName');
    expect(product).not.toHaveProperty('providerSlug');
    expect(product.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'integration-model', available: true }),
      expect.objectContaining({ model: 'configured-but-absent', available: false }),
    ]));
    const url = `/api/products/${productId}/estimate?model=integration-model&inputTokens=1000&outputTokens=500`;
    const estimate = await app.inject({ method: 'GET', url: `${url}&cachedInputTokens=200` });
    expect(estimate.json()).toEqual({ cost: '0.00364000', requestsPerKey: '5494', longContextApplied: false, peakApplied: false });
    expect((await app.inject({ method: 'GET', url: `${url}&cachedInputTokens=1001` })).statusCode).toBe(400);
    const long = await app.inject({ method: 'GET', url: `/api/products/${productId}/estimate?model=other-model&inputTokens=300000&cachedInputTokens=100000&outputTokens=2000` });
    expect(long.json()).toEqual({ cost: '1.71200000', requestsPerKey: '11', longContextApplied: true, peakApplied: false });
  });

  it('paginates charges for the owner and rejects another account', async () => {
    const [first] = await sql<{ id: string }[]>`SELECT id FROM api_keys WHERE user_id = ${userIds[0]!}`;
    const id = first!.id;
    const url = `/api/keys/${id}/usage?limit=1`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url, headers: await session(userIds[1]!) })).statusCode).toBe(404);
    const owner = await session(userIds[0]!);
    const keys = await app.inject({ method: 'GET', url: '/api/keys', headers: owner });
    expect(keys.json().keys[0].models).toContain('integration-model');
    expect(keys.json().keys[0]).not.toHaveProperty('providerName');
    const page = await app.inject({ method: 'GET', url, headers: owner });
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect(page.json().usage[0]).toMatchObject({ endpoint: '/v1/chat/completions', inputTokens: '200', cachedInputTokens: '50', cost: '0.00071000' });
    const next = await app.inject({ method: 'GET', url: `${url}&before=${page.json().nextCursor}`, headers: owner });
    expect(next.json()).toMatchObject({ usage: [{ endpoint: '/v1/responses', cost: '0.00364000' }], nextCursor: null });
  });

  it('rounds the quote and the balance debit after applying the markup', async () => {
    const estimate = await app.inject({ method: 'GET',
      url: `/api/products/${productId}/estimate?model=cheap-model&inputTokens=1&cachedInputTokens=1` });
    expect(estimate.statusCode).toBe(200);
    expect(estimate.json()).toMatchObject({ cost: '0.00000001', requestsPerKey: '2000000000' });

    const headers = { authorization: `Bearer ${secondKey}` };
    const response = await app.inject({ method: 'POST', url: '/v1/responses', headers,
      payload: { model: 'cheap-model', input: 'tiny-cached-usage' } });
    expect(response.statusCode).toBe(200);
    const [balances] = await sql<{ debit: string; providerCost: string; retailCost: string }[]>`
      SELECT ak.credits_used::text AS debit, ur.cost::text AS provider_cost, ur.retail_cost::text
      FROM usage_records ur JOIN api_keys ak ON ak.id = ur.api_key_id
      WHERE ur.request_id = ${String(response.headers['x-proxy-request-id'])}
    `;
    expect(balances).toEqual({ debit: '0.00000001', providerCost: '0.00000000', retailCost: '0.00000001' });
  });

  it('keeps provider diagnostics out of HTTP and streamed model errors', async () => {
    const call = (input: string, stream: boolean) => app.inject({ method: 'POST', url: '/v1/responses',
      headers: { authorization: `Bearer ${secondKey}` }, payload: { model: 'integration-model', input, stream } });
    const rejected = await call('private-http-error', false);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('MODEL_REQUEST_REJECTED');
    expect(rejected.payload).not.toContain('private diagnostic');
    const streamed = await call('private-stream-error', true);
    expect(streamed.statusCode).toBe(200);
    expect(streamed.payload).toContain('MODEL_RESPONSE_FAILED');
    expect(streamed.payload).not.toContain('private diagnostic');
  });

  it('meters stateless compaction and single-image billing, and isolates shared cache IDs by customer key', async () => {
    const since = seenInference.length;
    for (const token of [key, key, secondKey]) {
      const compact = await app.inject({ method: 'POST', url: '/v1/responses/compact',
        headers: { authorization: `Bearer ${token}`, session_id: 'same-client-id', 'openai-organization': 'must-not-forward' },
        payload: { model: 'integration-model', input: [{ type: 'message', role: 'user', content: 'hello' }], prompt_cache_key: 'shared-value' },
      });
      expect(compact.statusCode).toBe(200);
      expect(compact.json().output[0].encrypted_content).toBe('opaque');
    }
    const requests = seenInference.slice(since);
    expect(requests[0]?.headers.session_id).not.toBe('same-client-id');
    expect(requests[0]?.headers.session_id).toBe(requests[1]?.headers.session_id);
    expect(requests[0]?.headers.session_id).not.toBe(requests[2]?.headers.session_id);
    expect(requests[0]?.body.prompt_cache_key).toBe(requests[1]?.body.prompt_cache_key);
    expect(requests[0]?.body.prompt_cache_key).not.toBe(requests[2]?.body.prompt_cache_key);
    expect(requests[0]?.headers['openai-organization']).toBeUndefined();
    const image = await app.inject({ method: 'POST', url: '/v1/images/generations', headers: auth(),
      payload: { model: 'image-model', prompt: 'image example' },
    });
    expect(image.statusCode).toBe(200);
    const ledger = await sql<{ endpoint: string; cost: string }[]>`
      SELECT endpoint, cost::text FROM usage_records WHERE upstream_credential_id = ${credentialId}
        AND endpoint IN ('/v1/responses/compact', '/v1/images/generations') ORDER BY started_at
    `;
    expect(ledger.map((entry) => entry.cost)).toEqual(['0.00012200', '0.00012200', '0.00012200', '0.01500000']);
  });

  it('blocks inference and sales when the CE-style catalog refuses a key shown as active', async () => {
    try {
      for (const mode of ['trial', 'html'] as const) {
        await updateCatalog(mode);
        const [catalog] = await sql<{ status: string; lastError: string; availableModels: string[] }[]>`
          SELECT status, last_error, available_models FROM upstream_credentials WHERE id = ${credentialId}
        `;
        expect(catalog?.status).toBe('DEGRADED');
        expect(catalog?.availableModels).toEqual([]);
        expect(catalog?.lastError).toMatch(mode === 'trial' ? /no active subscription/ : /no valid model IDs/);
        const models = await app.inject({ method: 'GET', url: '/v1/models', headers: auth() });
        expect(models.statusCode).toBe(503);
        await expect(createOrder({ userId: userIds[2]!, userEmail: `${slug}-2@example.test`, productId, paymentProvider: 'mock' }))
          .rejects.toMatchObject({ code: 'NO_UPSTREAM_CAPACITY' });
      }
    } finally { await updateCatalog('ok'); }
  });

  it('does not turn an older copy of an upstream key into extra capacity', async () => {
    const [duplicate] = await sql<{ id: string }[]>`
      INSERT INTO upstream_credentials (pool_id, label, encrypted_key, key_hint)
      VALUES (${poolId}, 'Legacy duplicate', ${encryptSecret('upstream-test-key')}, 'masked') RETURNING id
    `;
    try {
      await refreshUpstreamCatalog(duplicate!.id);
      const [verified] = await sql<{ status: string; lastError: string }[]>`
        SELECT status, last_error FROM upstream_credentials WHERE id = ${duplicate!.id}
      `;
      expect(verified?.status).toBe('DEGRADED');
      expect(verified?.lastError).toMatch(/Duplicate upstream key/);
      const products = (await app.inject({ method: 'GET', url: '/api/products' })).json().products;
      expect(products.find((product: { id: string }) => product.id === productId).inventory).toBe(0);
    } finally {
      await sql`DELETE FROM upstream_credentials WHERE id = ${duplicate!.id}`;
    }
  });

  it('prevents two parallel calls from reserving the same final balance', async () => {
    const [original] = await sql<{ id: string; creditsUsed: string }[]>`
      SELECT id, credits_used::text FROM api_keys WHERE user_id = ${userIds[0]!}
    `;
    await sql`UPDATE api_keys SET credits_used = 19.994 WHERE id = ${original!.id}`;
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    holdNextResponse = { started, release: new Promise<void>((resolve) => { release = resolve; }) };
    const call = () => app.inject({ method: 'POST', url: '/v1/responses', headers: auth(),
      payload: { model: 'cheap-model', input: 'hello', max_output_tokens: 1000 },
    });
    const first = call();
    try {
      await Promise.race([ready, first.then((response) => { throw new Error(`First request did not reach mock: ${response.statusCode}`); })]);
      const second = await call();
      expect(second.statusCode).toBe(402);
      expect(second.json().error.code).toBe('INSUFFICIENT_CREDITS');
    } finally {
      release();
      const response = await first;
      await sql`UPDATE api_keys SET credits_used = ${original!.creditsUsed}, status = 'ACTIVE' WHERE id = ${original!.id}`;
      expect(response.statusCode).toBe(200);
    }
  });

  it('marks a stream with no terminal usage for reconciliation and holds its reservation', async () => {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const observed = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'integration-model', input: 'interrupted-stream', stream: true }),
    });
    expect(observed.status).toBe(200);
    await expect(observed.text()).rejects.toThrow();
    const [entry] = await sql<{ status: string; errorCode: string; cost: string; held: boolean }[]>`
      SELECT status, error_code, cost::text, EXISTS (
        SELECT 1 FROM request_leases rl WHERE rl.api_key_id = ur.api_key_id AND reserved_cost > 0 AND expires_at > now()
      ) AS held FROM usage_records ur WHERE ur.request_id = ${observed.headers.get('x-proxy-request-id')}
    `;
    expect(entry).toEqual({ status: 'FAILED', errorCode: 'USAGE_UNCONFIRMED', cost: '0.00000000', held: true });
    expect((await app.inject({ method: 'GET', url: '/metrics' })).payload).toContain('kind="unconfirmed"');
  });

  it('uses a single paid balance across native model channels and enforces two buyers per upstream key', async () => {
    const address = upstream.server.address();
    if (!address || typeof address === 'string') throw new Error('Test upstream has no TCP port');
    for (const [name, protocol, model, secret, input, cached] of [
      ['Claude', 'ANTHROPIC', 'claude-integration', 'upstream-claude-key', '1', '0.1'],
      ['Gemini', 'GEMINI', 'gemini-integration', 'upstream-gemini-key', '0.5', '0.05'],
    ] as const) {
      const [channel] = await sql<{ id: string }[]>`INSERT INTO upstream_pools
        (name, slug, base_url, credential_capacity, parent_pool_id, protocol)
        VALUES (${name}, ${`${slug}-${name.toLowerCase()}`}, ${`http://127.0.0.1:${address.port}`}, 2, ${poolId}, ${protocol}) RETURNING id`;
      channels.push(channel!.id);
      const [upstreamKey] = await sql<{ id: string }[]>`INSERT INTO upstream_credentials (pool_id, label, encrypted_key, key_hint, test_only)
        VALUES (${channel!.id}, ${name}, ${encryptSecret(secret)}, 'masked', true) RETURNING id`;
      channelCredentials.push(upstreamKey!.id);
      await sql`INSERT INTO model_rates (pool_id, model, input_per_million, output_per_million, cached_input_per_million)
        VALUES (${channel!.id}, ${model}, ${input}, 2, ${cached})`;
      await refreshUpstreamCatalog(upstreamKey!.id);
    }

    const [original] = await sql<{ id: string; creditsTotal: string; creditsUsed: string }[]>`
      SELECT id, credits_total::text, credits_used::text FROM api_keys WHERE user_id = ${userIds[0]!}`;
    expect(original?.creditsTotal).toBe('20.00000000');
    const product = (await app.inject({ method: 'GET', url: '/api/products' })).json().products.find((item: { id: string }) => item.id === productId);
    expect(product.unpricedModels).toContainEqual({ model: 'gemini-unpriced', protocol: 'GEMINI' });
    expect(product.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'claude-integration', available: true, protocol: 'ANTHROPIC' }),
      expect.objectContaining({ model: 'gemini-integration', available: true, protocol: 'GEMINI' }),
    ]));
    const index = await app.inject({ method: 'GET', url: '/v1beta/models', headers: { 'x-goog-api-key': key } });
    expect(index.json().models.map((model: { name: string }) => model.name)).toEqual(['models/gemini-integration']);

    const claude = (token: string) => app.inject({ method: 'POST', url: '/v1/messages?beta=true',
      headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
      payload: { model: 'claude-integration', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Hi' }] } });
    const first = await claude(key);
    expect(first.statusCode).toBe(200);
    expect(first.payload).toContain('event: message_stop');
    expect(seenInference.at(-1)).toMatchObject({ endpoint: '/v1/messages?beta=true', headers: { 'x-api-key': 'upstream-claude-key' } });
    const gemini = await app.inject({ method: 'POST', url: '/v1beta/models/gemini-integration:streamGenerateContent?alt=sse',
      headers: { 'x-goog-api-key': key }, payload: { contents: [{ parts: [{ text: 'Hi' }] }] } });
    expect(gemini.statusCode).toBe(200);
    expect(gemini.payload).toContain('thoughtsTokenCount');
    expect(seenInference.at(-1)?.headers['x-goog-api-key']).toBe('upstream-gemini-key');

    const requestIds = [first.headers['x-proxy-request-id'], gemini.headers['x-proxy-request-id']].map(String);
    const usage = await app.inject({ method: 'GET', url: `/api/keys/${original!.id}/usage`, headers: await session(userIds[0]!) });
    const entries = usage.json().usage.filter((item: { requestId: string }) => requestIds.includes(item.requestId));
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'claude-integration', status: 'SUCCEEDED', inputTokens: '1300', cachedInputTokens: '200',
        cacheWrite5mTokens: '200', cacheWrite1hTokens: '100', outputTokens: '50', cost: '0.00274000' }),
      expect.objectContaining({ model: 'gemini-integration', status: 'SUCCEEDED', inputTokens: '510', cachedInputTokens: '100',
        outputTokens: '50', cost: '0.00062000' }),
    ]));
    const [balances] = await sql<{ debit: string; providerCost: string }[]>`
      SELECT (ak.credits_used - ${original!.creditsUsed}::numeric)::text AS debit,
        (SELECT sum(cost)::text FROM usage_records WHERE request_id IN ${sql(requestIds)}) AS provider_cost
      FROM api_keys ak WHERE ak.id = ${original!.id}
    `;
    expect(balances).toEqual({ debit: '0.00336000', providerCost: '0.00168000' });

    expect((await claude(secondKey)).statusCode).toBe(200);
    const headers = await session(userIds[2]!);
    const created = await app.inject({ method: 'POST', url: '/api/orders', headers, payload: { productId, paymentProvider: 'mock' } });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/payments/mock/${created.json().order.id}/complete`, headers })).statusCode).toBe(200);
    const [third] = await sql<{ encryptedKey: string }[]>`SELECT encrypted_key FROM api_keys WHERE user_id = ${userIds[2]!}`;
    const noClaude = await claude(decryptSecret(third!.encryptedKey));
    expect(noClaude.statusCode).toBe(404);
    expect(noClaude.json()).toMatchObject({ type: 'error', code: 'MODEL_NOT_AVAILABLE' });
    const [capacity] = await sql<{ assigned: number }[]>`SELECT assigned FROM sellable_upstream_slots WHERE id = ${channelCredentials[0]!}`;
    expect(capacity?.assigned).toBe(2);
    const saleReady = await sql.begin(async (transaction) => {
      await transaction`SET LOCAL proxykey.allow_test_upstreams = 'off'`;
      return transaction`SELECT 1 FROM sellable_upstream_slots WHERE id IN ${transaction(channelCredentials)}`;
    });
    expect(saleReady).toHaveLength(0);
  });
});
