import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { AuthUser, AuthenticatedRequest } from '../types.js';

export const sessionCookieName = 'proxy_session';

export async function createSession(userId: string, reply: FastifyReply): Promise<void> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_DAYS * 86_400_000);
  await sql`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${sha256(`${config.SESSION_SECRET}:${token}`)}, ${expiresAt})
  `;
  reply.setCookie(sessionCookieName, token, {
    path: '/',
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
  });
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[sessionCookieName];
  if (token) {
    await sql`DELETE FROM sessions WHERE token_hash = ${sha256(`${config.SESSION_SECRET}:${token}`)}`;
  }
  reply.clearCookie(sessionCookieName, { path: '/' });
}

export async function resolveAuthUser(request: FastifyRequest): Promise<AuthUser | null> {
  const token = request.cookies[sessionCookieName];
  if (!token) return null;

  const rows = await sql<AuthUser[]>`
    UPDATE sessions AS s
    SET last_seen_at = now()
    FROM users AS u
    WHERE s.token_hash = ${sha256(`${config.SESSION_SECRET}:${token}`)}
      AND s.expires_at > now()
      AND u.id = s.user_id
      AND u.status = 'ACTIVE'
    RETURNING u.id, u.email::text, u.name, u.role, u.status
  `;
  return rows[0] ?? null;
}

export async function requireAuth(request: FastifyRequest): Promise<void> {
  const user = await resolveAuthUser(request);
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication required');
  request.authUser = user;
}

export async function requireAdmin(request: FastifyRequest): Promise<void> {
  await requireAuth(request);
  if ((request as AuthenticatedRequest).authUser.role !== 'ADMIN') {
    throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access required');
  }
}
