import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { updateUserAccess } from './user-access.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integration('administrator access changes', () => {
  const schema = `admin_access_${randomUUID().replaceAll('-', '')}`;
  const first = randomUUID(), second = randomUUID();
  const db = postgres(config.DATABASE_URL, { max: 4, connection: { search_path: schema } });

  beforeAll(async () => {
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await db`CREATE TABLE users (id uuid PRIMARY KEY, role text NOT NULL, status text NOT NULL, updated_at timestamptz DEFAULT now())`;
  });
  afterAll(async () => {
    await db.end();
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });

  it('keeps one active administrator when both admins demote themselves concurrently', async () => {
    await db`INSERT INTO users (id, role, status) VALUES (${first}, 'ADMIN', 'ACTIVE'), (${second}, 'ADMIN', 'ACTIVE')`;
    const results = await Promise.allSettled([
      updateUserAccess(db, first, first, { role: 'USER' }),
      updateUserAccess(db, second, second, { role: 'USER' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'LAST_ADMIN', statusCode: 409 } });
    const [count] = await db`SELECT count(*)::int AS total FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'`;
    expect(count?.total).toBe(1);
  });

  it('rechecks actor access after a concurrent administrator change', async () => {
    await db`UPDATE users SET role = 'ADMIN', status = 'ACTIVE'`;
    let unlock!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const blocker = db.begin(async transaction => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext('proxykey:admin-user-management'))`;
      await transaction`UPDATE users SET role = 'USER' WHERE id = ${first}`;
      locked();
      await gate;
    });
    await acquired;
    const pending = updateUserAccess(db, first, second, { status: 'SUSPENDED' });
    const check = expect(pending).rejects.toMatchObject({ code: 'ADMIN_REQUIRED', statusCode: 403 });
    unlock();
    await blocker;
    await check;
    expect(await db`SELECT role, status FROM users WHERE id = ${second}`).toEqual([{ role: 'ADMIN', status: 'ACTIVE' }]);
    await expect(updateUserAccess(db, second, second, { status: 'SUSPENDED' }))
      .rejects.toMatchObject({ code: 'CANNOT_SUSPEND_SELF' });
  });
});
