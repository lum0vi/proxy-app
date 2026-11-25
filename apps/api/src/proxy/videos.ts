import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { decryptSecret, sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { proxyRequests } from '../observability/metrics.js';
import type { AuthenticatedRequest } from '../types.js';
import { acquireLease, emptyUsage, finalizeUsage, keyHash, resolveKey, type LeaseContext } from './accounting.js';
import { prepareMedia } from './media.js';

interface VideoJob {
  id: string;
  apiKeyId: string;
  upstreamCredentialId: string;
  upstreamId: string | null;
  requestId: string;
  model: string;
  seconds: number;
  size: string | null;
  state: 'SUBMITTING' | 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'REVIEW';
  progress: number;
  inputHash: string;
  accounting: LeaseContext;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
  lastError: string | null;
}

const jobId = (value: unknown) => z.string().regex(/^video_[a-f0-9-]{36}$/).transform(value => value.slice(6)).pipe(z.string().uuid()).parse(value);
const notFound = () => new AppError(404, 'VIDEO_NOT_FOUND', 'Video not found');
const publicId = (id: string) => `video_${id}`;
const secondsAt = (value: Date | null) => value ? Math.floor(value.getTime() / 1000) : null;

function publicJob(job: VideoJob) {
  return { id: publicId(job.id), object: 'video', model: job.model, seconds: String(job.seconds), size: job.size,
    status: job.state === 'COMPLETED' ? 'completed' : job.state === 'FAILED' ? 'failed' : job.state === 'QUEUED' || job.state === 'SUBMITTING' ? 'queued' : 'in_progress',
    progress: job.progress, created_at: secondsAt(job.createdAt), completed_at: secondsAt(job.completedAt), expires_at: secondsAt(job.expiresAt),
    billing_status: job.state === 'REVIEW' ? 'review_required' : job.state === 'COMPLETED' ? 'charged' : job.state === 'FAILED' ? 'released' : 'reserved',
    error: job.state === 'FAILED' ? { code: 'VIDEO_GENERATION_FAILED', message: 'The video could not be generated. No balance was charged.' } : null };
}

async function jobRow(id: string) {
  const [job] = await sql<VideoJob[]>`SELECT * FROM video_jobs WHERE id = ${id}`;
  if (!job) throw notFound();
  return job;
}

async function credential(job: VideoJob) {
  const [row] = await sql<{ encryptedKey: string }[]>`SELECT encrypted_key FROM upstream_credentials WHERE id = ${job.upstreamCredentialId}`;
  if (!row) throw new Error('Video credential unavailable');
  return decryptSecret(row.encryptedKey);
}

function upstreamUrl(job: VideoJob, suffix = '') {
  if (!job.upstreamId) throw new Error('Missing upstream video ID');
  return `${job.accounting.credential.baseUrl.replace(/\/+$/, '')}/v1/videos/${encodeURIComponent(job.upstreamId)}${suffix}`;
}

async function jsonResponse(response: Response) {
  if (!response.body || !response.headers.get('content-type')?.includes('json')) {
    await response.body?.cancel(); throw new Error('Invalid video response');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error('Video response too large');
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid video response');
    return body;
  } finally { await reader.cancel().catch(() => undefined); }
}

async function review(id: string, reason: string) {
  await sql.begin(async tx => {
    const [job] = await tx<VideoJob[]>`UPDATE video_jobs SET state = 'REVIEW', last_error = ${reason},
      poll_locked_until = NULL, updated_at = now() WHERE id = ${id} AND state NOT IN ('COMPLETED','FAILED') RETURNING *`;
    if (job) await tx`UPDATE usage_records SET error_code = ${reason} WHERE request_id = ${job.requestId} AND status = 'STARTED'`;
  });
}

async function applyResult(id: string, value: Record<string, unknown>, release = false,
  audit?: { actorId: string; action: string; metadata: Record<string, string>; ip: string }) {
  await sql.begin(async tx => {
    const [job] = await tx<VideoJob[]>`SELECT * FROM video_jobs WHERE id = ${id} FOR UPDATE`;
    if (!job || ['COMPLETED', 'FAILED'].includes(job.state)) {
      if (audit) throw new AppError(409, 'VIDEO_ALREADY_SETTLED', 'This video is already settled');
      return;
    }
    if (release && audit && job.state !== 'REVIEW') throw new AppError(409, 'VIDEO_NOT_IN_REVIEW', 'Release requires a video awaiting review');
    const state = release ? 'failed' : value.status;
    if (!['queued', 'in_progress', 'completed', 'failed'].includes(String(state))) throw new Error('Unknown video status');
    if (!release && (typeof value.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value.id)
      || (job.upstreamId !== null && value.id !== job.upstreamId)
      || (value.model !== undefined && value.model !== job.model)
      || (value.seconds !== undefined && Number(value.seconds) !== job.seconds)
      || (job.size !== null && value.size !== undefined && value.size !== job.size))) throw new Error('Video result does not match the request');
    // Completion without a confirmed duration cannot be billed safely.
    if (state === 'completed' && Number(value.seconds) !== job.seconds) throw new Error('Missing video duration');
    const terminal = state === 'completed' || state === 'failed';
    if (terminal) await finalizeUsage(job.accounting, job.model, {
      usage: state === 'completed' ? { ...emptyUsage, videoSeconds: job.seconds } : null,
      status: state === 'completed' ? 'SUCCEEDED' : 'FAILED', httpStatus: 200,
      ...(state === 'failed' && { errorCode: release ? 'VIDEO_RESERVATION_RELEASED' : 'VIDEO_GENERATION_FAILED' }),
    }, tx);
    const progress = state === 'completed' ? 100 : typeof value.progress === 'number' && Number.isFinite(value.progress)
      ? Math.min(99, Math.max(0, Math.floor(value.progress))) : job.progress;
    const expires = typeof value.expires_at === 'number' && Number.isSafeInteger(value.expires_at)
      && value.expires_at > 0 && value.expires_at < 253402300799 ? new Date(value.expires_at * 1000) : null;
    await tx`UPDATE video_jobs SET upstream_id = COALESCE(upstream_id, ${release ? null : String(value.id)}),
      state = ${String(state).toUpperCase()}, progress = ${progress},
      completed_at = ${terminal ? new Date() : null}, expires_at = ${expires}, last_error = NULL,
      poll_after = now() + interval '10 seconds', poll_locked_until = NULL, updated_at = now() WHERE id = ${id}`;
    if (audit) await tx`INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata, ip_address)
      VALUES (${audit.actorId}, ${audit.action}, 'VIDEO', ${id}, ${tx.json(audit.metadata)}, ${audit.ip})`;
  });
}

export async function refreshVideoJob(id: string, force = false): Promise<void> {
  const [job] = await sql<VideoJob[]>`UPDATE video_jobs SET poll_locked_until = now() + interval '45 seconds'
    WHERE id = ${id} AND state IN ('QUEUED','IN_PROGRESS') AND upstream_id IS NOT NULL
      AND (${force} OR poll_after <= now()) AND (poll_locked_until IS NULL OR poll_locked_until < now()) RETURNING *`;
  if (!job) return;
  if (Date.now() - job.createdAt.getTime() > config.VIDEO_JOB_TIMEOUT_MS) return review(id, 'VIDEO_TIMEOUT_UNCONFIRMED');
  try {
    const response = await fetch(upstreamUrl(job), { headers: { authorization: `Bearer ${await credential(job)}` },
      redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      await response.body?.cancel();
      // A missing/expired job is not evidence that generation failed.
      if ([400, 401, 402, 403, 404, 410].includes(response.status)) return review(id, 'VIDEO_STATUS_UNCONFIRMED');
      throw new Error('Video status unavailable');
    }
    await applyResult(id, await jsonResponse(response));
  } catch {
    await sql`UPDATE video_jobs SET poll_locked_until = NULL, poll_after = now() + interval '30 seconds',
      last_error = 'VIDEO_POLL_RETRY', updated_at = now() WHERE id = ${id} AND state IN ('QUEUED','IN_PROGRESS')`;
  }
}

export async function processVideoJobs(): Promise<void> {
  const abandoned = await sql<{ id: string }[]>`SELECT id FROM video_jobs WHERE state = 'SUBMITTING' AND created_at < now() - interval '2 minutes'`;
  for (const job of abandoned) await review(job.id, 'VIDEO_SUBMISSION_UNCONFIRMED');
  const jobs = await sql<{ id: string }[]>`SELECT id FROM video_jobs WHERE state IN ('QUEUED','IN_PROGRESS')
    AND poll_after <= now() AND (poll_locked_until IS NULL OR poll_locked_until < now()) ORDER BY poll_after LIMIT 20`;
  for (let index = 0; index < jobs.length; index += 4) await Promise.all(jobs.slice(index, index + 4).map(job => refreshVideoJob(job.id)));
}

async function owner(request: FastifyRequest) {
  if (!config.proxyAllowedPaths.includes('/v1/videos')) throw new AppError(404, 'ENDPOINT_NOT_ALLOWED', 'Videos API is not enabled');
  return resolveKey(sql, keyHash(request), false, true);
}

async function ownedJob(request: FastifyRequest) {
  const key = await owner(request);
  const { id } = request.params as { id: string };
  const job = await jobRow(jobId(id));
  if (job.apiKeyId !== key.id) throw notFound();
  return job;
}

export async function videoRoutes(app: FastifyInstance) {
  app.post('/v1/videos', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    const key = await owner(request);
    if (request.url.includes('?')) throw new AppError(400, 'QUERY_NOT_SUPPORTED', 'Use the request body');
    const body = await prepareMedia(request, true);
    const supplied = request.headers['idempotency-key'];
    if (supplied !== undefined && (typeof supplied !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(supplied))) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Invalid Idempotency-Key');
    const idempotency = supplied ? sha256(String(supplied)) : null;
    const created = await sql.begin(async tx => {
      if (idempotency) {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`video:${key.id}:${idempotency}`}, 0))`;
        const [previous] = await tx<VideoJob[]>`SELECT * FROM video_jobs WHERE api_key_id = ${key.id} AND idempotency_key = ${idempotency}`;
        if (previous) {
          if (previous.inputHash !== body.inputHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for another request');
          return { id: previous.id, fresh: false, lease: previous.accounting };
        }
      }
      const lease = await acquireLease(keyHash(request), '/v1/videos', body, tx);
      const id = randomUUID();
      // Async reservations survive restarts and cannot expire while billing is uncertain.
      await tx`UPDATE request_leases SET expires_at = '9999-12-31T00:00:00Z' WHERE id = ${lease.id}`;
      const snapshot = { ...lease, credential: { ...lease.credential, encryptedKey: '' } };
      await tx`INSERT INTO video_jobs (id, api_key_id, upstream_credential_id, lease_id, request_id, model, seconds, size, idempotency_key, input_hash, accounting)
        VALUES (${id}, ${key.id}, ${lease.credential.id}, ${lease.id}, ${lease.requestId}, ${body.model}, ${body.videoSeconds!},
          ${typeof body.media?.size === 'string' ? body.media.size : null}, ${idempotency}, ${body.inputHash!}, ${tx.json(JSON.parse(JSON.stringify(snapshot)))})`;
      return { id, fresh: true, lease };
    });
    reply.header('cache-control', 'no-store').header('x-proxy-request-id', created.lease.requestId);
    if (created.fresh) {
      let status = '502';
      try {
        const response = await fetch(`${created.lease.credential.baseUrl.replace(/\/+$/, '')}/v1/videos`, {
          method: 'POST', headers: { authorization: `Bearer ${decryptSecret(created.lease.credential.encryptedKey)}`,
            'content-type': body.contentType, 'idempotency-key': created.id, 'x-proxy-request-id': created.lease.requestId },
          body: new Uint8Array(body.buffer), redirect: 'manual', signal: AbortSignal.timeout(Math.min(60_000, config.UPSTREAM_REQUEST_TIMEOUT_MS)),
        });
        status = String(response.status);
        if (response.ok) await applyResult(created.id, await jsonResponse(response));
        else {
          await response.body?.cancel();
          if ([400, 401, 402, 403, 404, 413, 415, 422, 429].includes(response.status)) await applyResult(created.id, {}, true);
          else await review(created.id, 'VIDEO_SUBMISSION_UNCONFIRMED');
        }
      } catch { await review(created.id, 'VIDEO_SUBMISSION_UNCONFIRMED'); }
      finally { proxyRequests.inc({ provider: created.lease.credential.providerSlug, endpoint: '/v1/videos', status }); }
    }
    return publicJob(await jobRow(created.id));
  });

  app.get('/v1/videos', async (request, reply) => {
    const key = await owner(request);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), after: z.string().optional(), order: z.enum(['asc', 'desc']).default('desc') }).strict().parse(request.query);
    const after = query.after ? jobId(query.after) : null;
    if (after && (await jobRow(after)).apiKeyId !== key.id) throw notFound();
    const jobs = await sql<VideoJob[]>`SELECT * FROM video_jobs WHERE api_key_id = ${key.id}
      ${after ? sql`AND (created_at, id) ${query.order === 'asc' ? sql`>` : sql`<`} (SELECT created_at, id FROM video_jobs WHERE id = ${after})` : sql``}
      ORDER BY created_at ${query.order === 'asc' ? sql`ASC` : sql`DESC`}, id ${query.order === 'asc' ? sql`ASC` : sql`DESC`} LIMIT ${query.limit + 1}`;
    reply.header('cache-control', 'no-store');
    return { object: 'list', data: jobs.slice(0, query.limit).map(publicJob), has_more: jobs.length > query.limit,
      first_id: jobs[0] ? publicId(jobs[0].id) : null, last_id: jobs.slice(0, query.limit).at(-1) ? publicId(jobs.slice(0, query.limit).at(-1)!.id) : null };
  });

  app.get('/v1/videos/:id', async (request, reply) => {
    const job = await ownedJob(request);
    await refreshVideoJob(job.id);
    reply.header('cache-control', 'no-store');
    return publicJob(await jobRow(job.id));
  });

  app.get('/v1/videos/:id/content', async (request, reply) => {
    const job = await ownedJob(request);
    const { variant } = z.object({ variant: z.enum(['video', 'thumbnail', 'spritesheet']).default('video') }).strict().parse(request.query);
    if (job.state !== 'COMPLETED') throw new AppError(409, 'VIDEO_NOT_READY', 'Video is not completed');
    if (job.expiresAt && job.expiresAt.getTime() <= Date.now()) throw new AppError(410, 'VIDEO_EXPIRED', 'Video download has expired');
    const disconnect = new AbortController();
    const close = () => disconnect.abort();
    reply.raw.once('close', close);
    try {
      const headers = new Headers({ authorization: `Bearer ${await credential(job)}` });
      const range = request.headers.range;
      if (range !== undefined) {
        if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new AppError(400, 'INVALID_RANGE', 'Use a single byte range');
        headers.set('range', range);
      }
      const response = await fetch(upstreamUrl(job, `/content?variant=${variant}`), { headers, redirect: 'manual',
        signal: AbortSignal.any([disconnect.signal, AbortSignal.timeout(300_000)]) });
      if (![200, 206].includes(response.status) || !response.body) {
        await response.body?.cancel();
        throw new AppError(response.status === 404 || response.status === 410 ? 410 : response.status === 416 ? 416 : 502,
          'VIDEO_DOWNLOAD_UNAVAILABLE', 'Video download is unavailable');
      }
      const type = response.headers.get('content-type')?.split(';')[0];
      if (!type || !['video/mp4', 'video/webm', 'image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'].includes(type)) {
        await response.body.cancel(); throw new AppError(502, 'INVALID_VIDEO_CONTENT', 'Invalid video content type');
      }
      reply.code(response.status).header('content-type', type).header('cache-control', 'private, no-store')
        .header('content-disposition', `attachment; filename="${publicId(job.id)}.${variant === 'video' ? 'mp4' : 'jpg'}"`);
      for (const name of ['content-range', 'accept-ranges']) if (response.headers.has(name)) reply.header(name, response.headers.get(name)!);
      const stream = response.body;
      async function* bytes() {
        const reader = stream!.getReader(); let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.length;
            if (size > 512 * 1024 * 1024) throw new Error('Video exceeds download limit');
            yield chunk.value;
          }
        } finally { await reader.cancel().catch(() => undefined); reply.raw.off('close', close); }
      }
      return reply.send(Readable.from(bytes()));
    } catch (error) { reply.raw.off('close', close); throw error; }
  });
}

// Registered inside the existing admin-only scope. No client can assign an
// arbitrary provider job ID or release reservations without audited review.
export async function adminVideoRoutes(app: FastifyInstance) {
  app.get('/api/admin/videos', async () => {
    const jobs = await sql`SELECT v.id, v.model, v.seconds, v.state, v.progress, v.last_error, v.created_at, v.upstream_id,
      u.email::text, ak.key_hint, r.retail_reserved_cost::text AS reserved_cost
      FROM video_jobs v JOIN api_keys ak ON ak.id = v.api_key_id JOIN users u ON u.id = ak.user_id
      LEFT JOIN request_leases r ON r.id = v.lease_id ORDER BY (v.state = 'REVIEW') DESC, v.created_at DESC LIMIT 100`;
    return { jobs };
  });
  app.post('/api/admin/videos/:id/reconcile', async (request) => {
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const body = z.object({ action: z.enum(['refresh', 'release']), upstreamId: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/).optional(), reason: z.string().trim().min(10).max(1000) }).parse(request.body);
    const job = await jobRow(id);
    const audit = { actorId: (request as AuthenticatedRequest).authUser.id, action: `VIDEO_${body.action.toUpperCase()}`,
      metadata: { action: body.action, reason: body.reason, ...(body.upstreamId && { upstreamId: body.upstreamId }) }, ip: request.ip };
    if (['COMPLETED', 'FAILED'].includes(job.state)) throw new AppError(409, 'VIDEO_ALREADY_SETTLED', 'This video is already settled');
    if (body.action === 'release') {
      if (job.state !== 'REVIEW') throw new AppError(409, 'VIDEO_NOT_IN_REVIEW', 'Release requires a video awaiting review');
      await applyResult(id, {}, true, audit);
    } else {
      const upstreamId = job.upstreamId ?? body.upstreamId;
      if (!upstreamId) throw new AppError(400, 'UPSTREAM_ID_REQUIRED', 'Specify the verified provider video ID');
      const response = await fetch(upstreamUrl({ ...job, upstreamId }), { headers: { authorization: `Bearer ${await credential(job)}` },
        redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) { await response.body?.cancel(); throw new AppError(502, 'VIDEO_STATUS_UNAVAILABLE', 'Could not verify the provider video'); }
      const result = await jsonResponse(response);
      if (result.id !== upstreamId || result.model !== job.model || Number(result.seconds) !== job.seconds) throw new AppError(409, 'VIDEO_RESULT_MISMATCH', 'Provider model or duration does not match');
      await applyResult(id, result, false, audit);
    }
    return { video: publicJob(await jobRow(id)) };
  });
}
