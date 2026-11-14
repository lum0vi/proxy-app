import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { sql } from '../db/index.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/live', async () => ({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) }));

  app.get('/health/ready', async (request, reply) => {
    const startedAt = performance.now();
    try {
      await sql`SELECT 1`;
      const migrations = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM schema_migrations`;
      const upstream = await sql<{ active: number; degraded: number; disabled: number; sellable: number }[]>`
        SELECT
          (SELECT count(*)::int FROM sellable_upstream_slots) AS active,
          count(*) FILTER (WHERE uc.status = 'DEGRADED' OR (uc.status = 'ACTIVE'
            AND NOT EXISTS (SELECT 1 FROM sellable_upstream_slots s WHERE s.id = uc.id)))::int AS degraded,
          count(*) FILTER (WHERE uc.status IN ('DISABLED', 'EXHAUSTED'))::int AS disabled,
          (SELECT COALESCE(sum(GREATEST(0, s.credential_capacity - s.assigned - s.reserved)), 0)::int
            FROM sellable_upstream_slots s) AS sellable
        FROM upstream_credentials uc JOIN upstream_pools up ON up.id = uc.pool_id WHERE up.active
          AND (NOT uc.test_only OR ${config.testUpstreamsEnabled})
      `;
      return {
        status: 'ready',
        database: { status: 'ok', latencyMs: Math.round(performance.now() - startedAt), migrations: migrations[0]?.count ?? 0 },
        upstream: upstream[0] ?? { active: 0, degraded: 0, disabled: 0, sellable: 0 },
      };
    } catch (error) {
      request.log.error({ err: error }, 'Readiness check failed');
      return reply.code(503).send({
        status: 'not_ready',
        database: { status: 'error', latencyMs: Math.round(performance.now() - startedAt) },
      });
    }
  });

  app.get('/health/serving', async (_request, reply) => {
    try {
      const [row] = await sql<{ available: boolean }[]>`SELECT EXISTS (SELECT 1 FROM sellable_upstream_slots) AS available`;
      return reply.code(row?.available ? 200 : 503).send({ status: row?.available ? 'available' : 'unavailable' });
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
