import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import OpenAI, { toFile } from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { sql } from '../db/index.js';
import { config } from '../config.js';
import { sessionCookieName } from '../auth/session.js';
import { decryptSecret, encryptSecret, sha256 } from '../lib/crypto.js';
import { createOrder, markOrderPaid, tryFulfillPaidOrder } from '../services/orders.js';
import { refreshUpstreamCatalog } from '../services/upstream-catalog.js';
import { processVideoJobs, refreshVideoJob } from './videos.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integration('native SDKs, images and durable video billing', () => {
  let app: FastifyInstance, upstream: FastifyInstance, origin: string, productId: string;
  let client: OpenAI, claude: Anthropic, gemini: GoogleGenAI;
  const pools: string[] = [], credentials: string[] = [], users: string[] = [], keyIds: string[] = [], keys: string[] = [];
  const seen: { url: string; body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];
  const videos = new Map<string, Record<string, unknown>>();
  let videoCalls = 0;
  let adminHeaders: { cookie: string };
  const rootSlug = `sdk-${randomUUID()}`;
  const headers = (index = 0) => ({ authorization: `Bearer ${keys[index]}` });
  const balance = async () => (await sql<{ used: string }[]>`SELECT credits_used::text AS used FROM api_keys WHERE id = ${keyIds[0]!}`)[0]!.used;
  const videoBody = (prompt = 'lake') => ({ model: 'video-test', prompt, seconds: '4', size: '1280x720' });

  async function bodyOf(request: { url: string; headers: Record<string, unknown>; body: unknown }) {
    let body = request.body as Record<string, unknown>;
    if (Buffer.isBuffer(request.body)) {
      const form = await new Request('http://test.invalid', { method: 'POST', headers: { 'content-type': String(request.headers['content-type']) }, body: new Uint8Array(request.body) }).formData();
      body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { type: v.type, size: v.size }]));
    }
    seen.push({ url: request.url, body, headers: request.headers });
    return body;
  }

  beforeAll(async () => {
    upstream = Fastify();
    upstream.addContentTypeParser('*', { parseAs: 'buffer' }, (_r, body, done) => done(null, body));
    upstream.get('/v1/models', async () => ({ data: ['grok-test', 'claude-test', 'gemini-test', 'image-test', 'video-test'].map(id => ({ id })) }));
    upstream.get('/v1beta/models', async () => ({ models: [{ name: 'models/gemini-test' }] }));
    upstream.post('/v1/messages/count_tokens', async request => { await bodyOf(request); return { input_tokens: 17 }; });
    upstream.post('/v1/messages', async (request, reply) => {
      const body = await bodyOf(request);
      const message = { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30 } };
      if (!body.stream) return message;
      reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
        { type: 'message_stop' },
      ]) reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      reply.raw.end();
    });
    upstream.post('/v1beta/models/*', async (request, reply) => {
      await bodyOf(request);
      if (request.url.endsWith(':countTokens')) return { totalTokens: 17 };
      const data = { candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 30, totalTokenCount: 125 }, modelVersion: 'gemini-test' };
      if (!request.url.includes('streamGenerateContent')) return data;
      reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.end(`data: ${JSON.stringify(data)}\n\n`);
    });
    upstream.post('/v1/chat/completions', async (request, reply) => {
      const body = await bodyOf(request);
      const result = { id: 'chat_test', object: 'chat.completion', created: 0, model: 'grok-test',
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Moscow"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } };
      if (!body.stream) return result;
      reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.end(`data: ${JSON.stringify({ ...result, object: 'chat.completion.chunk', choices: [{ index: 0, delta: result.choices[0]!.message, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
    for (const path of ['/v1/images/generations', '/v1/images/edits']) upstream.post(path, async request => {
      const body = await bodyOf(request);
      return { created: 0, data: Array.from({ length: Number(body.n ?? 1) }, () => ({ b64_json: 'aW1hZ2U=' })) };
    });
    upstream.post('/v1/videos', async (request, reply) => {
      const body = await bodyOf(request); videoCalls++;
      if (body.prompt === 'reject') return reply.code(422).send({ error: { message: 'private upstream detail' } });
      if (body.prompt === 'ambiguous') return reply.code(503).send({ error: { message: 'private upstream detail' } });
      const id = `provider_video_${videoCalls}`;
      const data = { id, object: 'video', model: body.model, seconds: String(body.seconds), size: body.size, status: 'queued', progress: 0 };
      videos.set(id, data); return data;
    });
    upstream.get('/v1/videos/:id', async request => videos.get((request.params as { id: string }).id));
    upstream.get('/v1/videos/:id/content', async (_request, reply) => reply.type('video/mp4').send(Buffer.from('mock-mp4-content')));
    await upstream.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`;
    for (const [index, protocol] of ['OPENAI', 'ANTHROPIC', 'GEMINI', 'IMAGES', 'VIDEOS'].entries()) {
      const [pool] = await sql<{ id: string }[]>`INSERT INTO upstream_pools(name, slug, base_url, protocol, credential_capacity, parent_pool_id)
        VALUES (${protocol}, ${`${rootSlug}-${index}`}, ${url}, ${protocol}, 2, ${pools[0] ?? null}) RETURNING id`;
      pools.push(pool!.id);
      const model = ['grok-test', 'claude-test', 'gemini-test', 'image-test', 'video-test'][index]!;
      await sql`INSERT INTO model_rates(pool_id, model, input_per_million, output_per_million, cached_input_per_million, per_request, per_second, media_options)
        VALUES (${pool!.id}, ${model}, ${index < 3 ? 1 : 0}, ${index < 3 ? 2 : 0}, ${index < 3 ? 0.1 : 0}, ${index === 3 ? 0.015 : 0}, ${index === 4 ? 0.1 : 0},
          ${sql.json(index === 4 ? { seconds: [4, 8], size: ['1280x720'] } : index === 3 ? { operations: ['edit'] } : {})})`;
      const [cred] = await sql<{ id: string }[]>`INSERT INTO upstream_credentials(pool_id, label, encrypted_key, key_hint, max_concurrency)
        VALUES (${pool!.id}, 'SDK test', ${encryptSecret(`${rootSlug}-upstream-${index}`)}, 'masked', 16) RETURNING id`;
      credentials.push(cred!.id); await refreshUpstreamCatalog(cred!.id);
    }
    const [product] = await sql<{ id: string }[]>`INSERT INTO products(pool_id, name, slug, wholesale_credits, currency, duration_days, concurrency_limit)
      VALUES (${pools[0]!}, 'SDK test', ${rootSlug}, 50, 'USDT', NULL, 4) RETURNING id`;
    productId = product!.id;
    for (let index = 0; index < 3; index++) {
      const [user] = await sql<{ id: string }[]>`INSERT INTO users(email, name, password_hash, role)
        VALUES (${`${rootSlug}-${index}@example.test`}, 'SDK test', 'unused', ${index === 2 ? 'ADMIN' : 'USER'}) RETURNING id`;
      users.push(user!.id);
      if (index === 2) {
        const token = randomUUID();
        await sql`INSERT INTO sessions(user_id, token_hash, expires_at) VALUES (${user!.id}, ${sha256(`${config.SESSION_SECRET}:${token}`)}, now() + interval '1 hour')`;
        adminHeaders = { cookie: `${sessionCookieName}=${token}` }; continue;
      }
      const order = await createOrder({ userId: user!.id, userEmail: `${rootSlug}-${index}@example.test`, productId, paymentProvider: 'mock' });
      await sql.begin(tx => markOrderPaid(String(order.id), tx)); await tryFulfillPaidOrder(String(order.id));
      const [key] = await sql<{ id: string; encryptedKey: string }[]>`SELECT id, encrypted_key FROM api_keys WHERE user_id = ${user!.id}`;
      keyIds.push(key!.id); keys.push(decryptSecret(key!.encryptedKey));
    }
    app = await buildApp(); await app.listen({ host: '127.0.0.1', port: 0 });
    origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    client = new OpenAI({ apiKey: keys[0]!, baseURL: `${origin}/v1`, maxRetries: 0 });
    claude = new Anthropic({ apiKey: keys[0]!, baseURL: origin, maxRetries: 0 });
    gemini = new GoogleGenAI({ apiKey: keys[0]!, httpOptions: { baseUrl: origin, apiVersion: 'v1beta' } });
  });

  afterAll(async () => {
    await app?.close(); await upstream?.close();
    if (users.length) {
      await sql`DELETE FROM video_jobs WHERE api_key_id IN ${sql(keyIds)}`;
      await sql`DELETE FROM usage_records WHERE api_key_id IN ${sql(keyIds)}`;
      await sql`DELETE FROM orders WHERE user_id IN ${sql(users)} AND top_up_key_id IS NOT NULL`;
      await sql`DELETE FROM api_keys WHERE user_id IN ${sql(users)}`;
      await sql`DELETE FROM orders WHERE user_id IN ${sql(users)}`;
      await sql`DELETE FROM users WHERE id IN ${sql(users)}`;
    }
    if (pools.length) { await sql`DELETE FROM products WHERE pool_id IN ${sql(pools)}`; await sql`DELETE FROM upstream_credentials WHERE pool_id IN ${sql(pools)}`; await sql`DELETE FROM upstream_pools WHERE id IN ${sql(pools)}`; }
  });

  it('supports native model discovery and retrieval in official SDKs', async () => {
    const anthropic = await claude.models.list();
    expect(anthropic.data.map(model => model.id)).toEqual(['claude-test']);
    expect((await claude.models.retrieve('claude-test')).id).toBe('claude-test');
    expect((await client.models.retrieve('grok-test')).id).toBe('grok-test');
    const models = await gemini.models.list();
    const names: (string | undefined)[] = []; for await (const model of models) names.push(model.name);
    expect(names).toEqual(['models/gemini-test']);
    expect((await gemini.models.get({ model: 'gemini-test' })).name).toBe('models/gemini-test');
  });

  it('counts native tokens without debit and forwards only the assigned upstream key', async () => {
    const before = await balance();
    expect((await claude.messages.countTokens({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] })).input_tokens).toBe(17);
    expect((await gemini.models.countTokens({ model: 'gemini-test', contents: 'hi' })).totalTokens).toBe(17);
    expect(await balance()).toBe(before);
    expect(seen.at(-1)!.headers['x-goog-api-key']).toBe(`${rootSlug}-upstream-2`);
    expect(seen.at(-1)!.headers.authorization).toBeUndefined();
    expect((await sql`SELECT error_code, retail_cost::text FROM usage_records WHERE api_key_id = ${keyIds[0]!}`)
      .every(row => row.errorCode === null && row.retailCost === '0.00000000')).toBe(true);
    const invalid = await app.inject({ method: 'POST', url: '/v1beta/models/gemini-test:countTokens', headers: headers(),
      payload: { generateContentRequest: { model: 'models/another-model', contents: [] } } });
    expect(invalid.statusCode).toBe(400);
  });

  it('streams Claude and Gemini with exact native usage and preserves client-side Grok tools', async () => {
    expect((await claude.messages.stream({ model: 'claude-test', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }).finalMessage()).content).toEqual([{ type: 'text', text: 'hello' }]);
    const stream = await gemini.models.generateContentStream({ model: 'gemini-test', contents: 'hi', config: { maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 0 } } });
    let text = ''; for await (const chunk of stream) text += chunk.text ?? '';
    expect(text).toBe('hello');
    const response = await client.chat.completions.create({ model: 'grok-test', messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }] });
    expect(response.choices[0]?.message.tool_calls?.[0]?.id).toBe('call_1');
    const rows = await sql`SELECT model, input_tokens::int, output_tokens::int, cached_input_tokens::int, retail_cost::text
      FROM usage_records WHERE api_key_id = ${keyIds[0]!} AND endpoint NOT LIKE '%count%' ORDER BY started_at`;
    expect(rows).toEqual([
      { model: 'claude-test', inputTokens: 130, outputTokens: 20, cachedInputTokens: 30, retailCost: '0.00028600' },
      { model: 'gemini-test', inputTokens: 100, outputTokens: 25, cachedInputTokens: 30, retailCost: '0.00024600' },
      { model: 'grok-test', inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, retailCost: '0.00022600' },
    ]);
  });

  it('accepts SDK multipart image edits, charges only returned images and rejects unpriced options', async () => {
    const before = Number(await balance());
    const image = await toFile(Buffer.from('test-image'), 'input.png', { type: 'image/png' });
    const result = await client.images.edit({ model: 'image-test', image, prompt: 'edit', n: 2 });
    expect(result.data).toHaveLength(2);
    expect(seen.at(-1)?.body.image).toMatchObject({ type: 'image/png', size: 10 });
    expect(Number(await balance()) - before).toBeCloseTo(0.06, 8);
    const calls = seen.length;
    const response = await app.inject({ method: 'POST', url: '/v1/images/generations', headers: headers(), payload: { model: 'image-test', prompt: 'hi', quality: 'high' } });
    expect(response.statusCode).toBe(400); expect(seen).toHaveLength(calls);
  });

  it('accepts non-streaming Claude and Gemini SDK calls and returns native errors for the stable Gemini alias', async () => {
    const before = Number(await balance());
    expect((await claude.messages.create({ model: 'claude-test', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] })).content).toEqual([{ type: 'text', text: 'hello' }]);
    expect((await gemini.models.generateContent({ model: 'gemini-test', contents: 'hi', config: { maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 0 } } })).text).toBe('hello');
    expect(Number(await balance()) - before).toBeCloseTo(0.000532, 8);
    const denied = await app.inject({ method: 'POST', url: '/v1/models/gemini-test:generateContent', payload: { contents: [] } });
    expect(denied.statusCode).toBe(401); expect(denied.json().error.status).toBe('UNAUTHENTICATED');
  });

  it('creates a video once, reserves its exact price, settles once and allows only owner downloads', async () => {
    const before = await balance(); const calls = videoCalls; const idempotency = randomUUID();
    const [a, b] = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/v1/videos', headers: { ...headers(), 'idempotency-key': idempotency }, payload: videoBody() })));
    expect(a!.statusCode).toBe(200); expect(b!.json().id).toBe(a!.json().id); expect(videoCalls).toBe(calls + 1);
    const id = a!.json().id as string;
    expect(id).toMatch(/^video_/); expect(a!.payload).not.toContain('provider_video');
    expect(await balance()).toBe(before);
    const job = (await sql<{ upstreamId: string }[]>`SELECT upstream_id FROM video_jobs WHERE id = ${id.slice(6)}`)[0]!;
    expect((await sql`SELECT retail_reserved_cost::text AS cost FROM request_leases l JOIN video_jobs j ON j.lease_id = l.id WHERE j.id = ${id.slice(6)}`)[0]?.cost).toBe('0.80000000');
    expect((await app.inject({ method: 'GET', url: `/v1/videos/${id}`, headers: headers(1) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/videos/${id}/content`, headers: headers() })).statusCode).toBe(409);
    videos.get(job.upstreamId)!.status = 'completed';
    await Promise.all([refreshVideoJob(id.slice(6), true), refreshVideoJob(id.slice(6), true)]);
    expect((await client.videos.retrieve(id)).status).toBe('completed');
    expect(Buffer.from(await (await client.videos.downloadContent(id)).arrayBuffer()).toString()).toBe('mock-mp4-content');
    expect(Number(await balance()) - Number(before)).toBeCloseTo(0.8, 8);
    const replay = await app.inject({ method: 'POST', url: '/v1/videos', headers: { ...headers(), 'idempotency-key': idempotency }, payload: videoBody() });
    expect(replay.json().status).toBe('completed'); expect(videoCalls).toBe(calls + 1);
    const conflict = await app.inject({ method: 'POST', url: '/v1/videos', headers: { ...headers(), 'idempotency-key': idempotency }, payload: videoBody('different') });
    expect(conflict.statusCode).toBe(409);
    const used = await balance(); await sql`UPDATE api_keys SET credits_used = credits_total, status = 'EXHAUSTED' WHERE id = ${keyIds[0]!}`;
    try { expect((await client.videos.downloadContent(id)).status).toBe(200); }
    finally { await sql`UPDATE api_keys SET credits_used = ${used}, status = 'ACTIVE' WHERE id = ${keyIds[0]!}`; }
  });

  it('supports SDK multipart video input, polls after restart and releases a confirmed failure', async () => {
    const before = await balance();
    const result = await client.videos.create({ model: 'video-test', prompt: 'reference', seconds: '4', size: '1280x720',
      input_reference: await toFile(Buffer.from('reference'), 'image.png', { type: 'image/png' }) });
    expect(seen.at(-1)?.body.input_reference).toMatchObject({ type: 'image/png' });
    const job = (await sql<{ upstreamId: string }[]>`SELECT upstream_id FROM video_jobs WHERE id = ${result.id.slice(6)}`)[0]!;
    videos.get(job.upstreamId)!.status = 'failed';
    await sql`UPDATE video_jobs SET poll_after = now() - interval '1 minute' WHERE id = ${result.id.slice(6)}`;
    await processVideoJobs();
    expect((await client.videos.retrieve(result.id)).status).toBe('failed'); expect(await balance()).toBe(before);
    expect(await sql`SELECT 1 FROM request_leases l JOIN video_jobs j ON j.lease_id = l.id WHERE j.id = ${result.id.slice(6)}`).toHaveLength(0);
  });

  it('retains uncertain reservations, exposes admin review and never retries ambiguous generation', async () => {
    const before = await balance(); const idempotency = randomUUID(); const calls = videoCalls;
    const create = () => app.inject({ method: 'POST', url: '/v1/videos', headers: { ...headers(), 'idempotency-key': idempotency }, payload: videoBody('ambiguous') });
    const response = await create(); const id = (response.json().id as string).slice(6);
    expect(response.json().billing_status).toBe('review_required'); expect(response.payload).not.toContain('private');
    await create(); await processVideoJobs(); expect(videoCalls).toBe(calls + 1); expect(await balance()).toBe(before);
    expect((await app.inject('/api/admin/videos')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/videos', headers: adminHeaders })).json().jobs.find((job: { id: string }) => job.id === id).reservedCost).toBe('0.80000000');
    const release = await app.inject({ method: 'POST', url: `/api/admin/videos/${id}/reconcile`, headers: adminHeaders,
      payload: { action: 'release', reason: 'Confirmed with provider: job was not accepted.' } });
    expect(release.statusCode).toBe(200); expect(release.json().video.status).toBe('failed');
    expect(await balance()).toBe(before);
    expect(await sql`SELECT 1 FROM audit_logs WHERE entity_id = ${id} AND action = 'VIDEO_RELEASE'`).toHaveLength(1);
  });

  it('rejects unpriced video durations before provider calls and quotes seconds at the same x2 tariff', async () => {
    const calls = videoCalls;
    const bad = await app.inject({ method: 'POST', url: '/v1/videos', headers: headers(), payload: { ...videoBody(), seconds: '120' } });
    expect(bad.statusCode).toBe(400); expect(videoCalls).toBe(calls);
    const quote = await app.inject(`/api/products/${productId}/estimate?model=video-test&videoSeconds=4`);
    expect(quote.json().cost).toBe('0.80000000');
    const badQuote = await app.inject(`/api/products/${productId}/estimate?model=video-test&videoSeconds=120`);
    expect(badQuote.statusCode).toBe(400);
    const products = (await app.inject('/api/products')).json().products;
    expect(products.find((p: { id: string }) => p.id === productId).models.find((m: { model: string }) => m.model === 'video-test').perSecond).toBe('0.200000000000');
  });

  it('prevents concurrent video jobs from spending the same final balance', async () => {
    const [original] = await sql<{ total: string; used: string }[]>`SELECT credits_total::text AS total, credits_used::text AS used FROM api_keys WHERE id = ${keyIds[0]!}`;
    await sql`UPDATE api_keys SET credits_total = credits_used + 0.9 WHERE id = ${keyIds[0]!}`;
    try {
      const responses = await Promise.all([1, 2].map(n => app.inject({ method: 'POST', url: '/v1/videos', headers: headers(), payload: videoBody(`last-balance-${n}`) })));
      expect(responses.map(r => r.statusCode).sort()).toEqual([200, 402]);
      const id = String(responses.find(r => r.statusCode === 200)!.json().id).slice(6);
      const [row] = await sql<{ upstreamId: string }[]>`SELECT upstream_id FROM video_jobs WHERE id = ${id}`;
      videos.get(row!.upstreamId)!.status = 'failed'; await refreshVideoJob(id, true);
      expect(await balance()).toBe(original!.used);
    } finally { await sql`UPDATE api_keys SET credits_total = ${original!.total} WHERE id = ${keyIds[0]!}`; }
  });

  it('buys 1, 2 and 5 USDT top-ups and their RUB equivalents without changing the existing key', async () => {
    const rate = config.USDT_RUB_RATE; Object.assign(config, { USDT_RUB_RATE: '82.43' });
    const [before] = await sql<{ total: string; hash: string }[]>`SELECT credits_total::text AS total, key_hash AS hash FROM api_keys WHERE id = ${keyIds[1]!}`;
    try {
      for (const amount of [1, 2, 5]) {
        const [product] = await sql<{ id: string }[]>`INSERT INTO products(pool_id, name, slug, wholesale_credits, currency, duration_days, concurrency_limit)
          VALUES (${pools[0]!}, 'Small package', ${`${rootSlug}-small-${amount}`}, ${amount / 2}, 'USDT', NULL, 1) RETURNING id`;
        for (const paymentCurrency of ['USDT', 'RUB'] as const) {
          const order = await createOrder({ productId: product!.id, userId: users[1]!, userEmail: `${rootSlug}-1@example.test`,
            paymentProvider: 'mock', paymentCurrency, topUpKeyId: keyIds[1]! });
          expect(Number(order.amount)).toBeCloseTo(amount * (paymentCurrency === 'RUB' ? 82.43 : 1), 2);
          expect(Number(order.creditAmount)).toBe(amount);
          await sql.begin(tx => markOrderPaid(String(order.id), tx)); await tryFulfillPaidOrder(String(order.id));
          await tryFulfillPaidOrder(String(order.id));
        }
      }
      const [after] = await sql<{ total: string; hash: string }[]>`SELECT credits_total::text AS total, key_hash AS hash FROM api_keys WHERE id = ${keyIds[1]!}`;
      expect(Number(after!.total) - Number(before!.total)).toBe(16); expect(after!.hash).toBe(before!.hash);
    } finally { Object.assign(config, { USDT_RUB_RATE: rate }); }
  });
});
