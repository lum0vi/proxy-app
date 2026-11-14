import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db/index.js';
import { createSession, destroySession, requireAuth } from '../auth/session.js';
import { AppError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import type { AuthenticatedRequest, AuthUser } from '../types.js';

const credentialsSchema = z.object({
  email: z.string().email().max(320).transform((value) => value.trim().toLowerCase()),
  password: z.string().min(12).max(200),
});

const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(2).max(100),
});

const profileSchema = z.object({
  name: z.string().trim().min(2).max(100),
  walletNetwork: z.string().trim().max(50).nullable().optional(),
  walletAddress: z.string().trim().max(256).nullable().optional(),
  locale: z.enum(['ru', 'en']).optional(),
  theme: z.enum(['SYSTEM', 'LIGHT', 'DARK']).optional(),
}).superRefine((value, context) => {
  if (Boolean(value.walletNetwork) !== Boolean(value.walletAddress)) {
    context.addIssue({
      code: 'custom',
      message: 'Wallet network and public address must be provided together',
      path: ['walletAddress'],
    });
  }
});

function publicUser(user: Record<string, unknown>) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    walletNetwork: user.walletNetwork ?? null,
    walletAddress: user.walletAddress ?? null,
    locale: user.locale ?? 'ru',
    theme: user.theme ?? 'SYSTEM',
    createdAt: user.createdAt,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const passwordHash = await hashPassword(body.password);
    const rows = await sql<AuthUser[]>`
      INSERT INTO users (email, password_hash, name)
      VALUES (${body.email}, ${passwordHash}, ${body.name})
      ON CONFLICT (email) DO NOTHING
      RETURNING id, email::text, name, role, status
    `;
    const user = rows[0];
    if (!user) throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists');
    await createSession(user.id, reply);
    return reply.code(201).send({ user: publicUser(user as unknown as Record<string, unknown>) });
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = credentialsSchema.parse(request.body);
    const rows = await sql<(AuthUser & { passwordHash: string })[]>`
      SELECT id, email::text, name, role, status, password_hash
      FROM users
      WHERE email = ${body.email}
      LIMIT 1
    `;
    const user = rows[0];
    if (!user || user.status !== 'ACTIVE' || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    await createSession(user.id, reply);
    return { user: publicUser(user as unknown as Record<string, unknown>) };
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    await destroySession(request, reply);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => {
    const userId = (request as AuthenticatedRequest).authUser.id;
    const [user] = await sql<Record<string, unknown>[]>`
      SELECT id, email::text, name, role, wallet_network, wallet_address, locale, theme, created_at
      FROM users WHERE id = ${userId}
    `;
    return { user: publicUser(user ?? {}) };
  });

  app.patch('/api/profile', { preHandler: requireAuth }, async (request) => {
    const body = profileSchema.parse(request.body);
    const userId = (request as AuthenticatedRequest).authUser.id;
    const [user] = await sql<Record<string, unknown>[]>`
      UPDATE users SET
        name = ${body.name},
        wallet_network = ${body.walletNetwork ?? null},
        wallet_address = ${body.walletAddress ?? null},
        locale = COALESCE(${body.locale ?? null}, locale),
        theme = COALESCE(${body.theme ?? null}, theme),
        updated_at = now()
      WHERE id = ${userId}
      RETURNING id, email::text, name, role, wallet_network, wallet_address, locale, theme, created_at
    `;
    return { user: publicUser(user ?? {}) };
  });
}
