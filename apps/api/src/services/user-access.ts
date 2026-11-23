import type { Sql } from 'postgres';
import { AppError, assertFound } from '../lib/errors.js';

export async function updateUserAccess(database: Sql, actorId: string, userId: string, body: {
  role?: 'ADMIN' | 'USER' | undefined; status?: 'ACTIVE' | 'SUSPENDED' | undefined;
}): Promise<void> {
  if (userId === actorId && body.status === 'SUSPENDED') {
    throw new AppError(409, 'CANNOT_SUSPEND_SELF', 'You cannot suspend your own account');
  }
  await database.begin(async transaction => {
    // Serialize all administrator changes, including two concurrent self-demotions.
    // Row locks on separate targets alone do not protect the active-admin count.
    await transaction`SELECT pg_advisory_xact_lock(hashtext('proxykey:admin-user-management'))`;
    const [actor] = await transaction`SELECT 1 FROM users WHERE id = ${actorId} AND role = 'ADMIN' AND status = 'ACTIVE'`;
    if (!actor) throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access required');
    const [target] = await transaction<{ role: string; status: string }[]>`
      SELECT role, status FROM users WHERE id = ${userId} FOR UPDATE`;
    const current = assertFound(target, 'USER_NOT_FOUND', 'User not found');
    if (current.role === 'ADMIN' && current.status === 'ACTIVE'
      && (body.role === 'USER' || body.status === 'SUSPENDED')) {
      const [admins] = await transaction<{ count: number }[]>`SELECT count(*)::int AS count FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'`;
      if ((admins?.count ?? 0) <= 1) {
        throw new AppError(409, 'LAST_ADMIN', 'The last active administrator must remain active');
      }
    }
    await transaction`
      UPDATE users SET role = COALESCE(${body.role ?? null}, role),
        status = COALESCE(${body.status ?? null}, status), updated_at = now()
      WHERE id = ${userId}
    `;
  });
}
