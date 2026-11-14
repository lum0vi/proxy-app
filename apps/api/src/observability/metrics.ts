import type { FastifyInstance } from 'fastify';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { sql } from '../db/index.js';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: 'proxiapp_' });

export const httpRequests = new Counter({
  name: 'proxiapp_http_requests_total',
  help: 'HTTP requests handled by the control plane',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metricsRegistry],
});

export const httpDuration = new Histogram({
  name: 'proxiapp_http_request_duration_seconds',
  help: 'Control-plane HTTP request duration',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const proxyRequests = new Counter({
  name: 'proxiapp_proxy_requests_total',
  help: 'Requests forwarded to upstream AI providers',
  labelNames: ['provider', 'endpoint', 'status'] as const,
  registers: [metricsRegistry],
});

export const proxyDuration = new Histogram({
  name: 'proxiapp_proxy_request_duration_seconds',
  help: 'End-to-end upstream request duration, including streams',
  labelNames: ['provider', 'endpoint', 'status'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900],
  registers: [metricsRegistry],
});

export const upstreamTimeToFirstByte = new Histogram({
  name: 'proxiapp_upstream_first_body_byte_seconds',
  help: 'Time from upstream request start to first response body byte',
  labelNames: ['provider', 'endpoint'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

export const proxyAccountingAnomalies = new Counter({
  name: 'proxiapp_proxy_accounting_anomalies_total',
  help: 'Model responses with estimated, unconfirmed or unposted usage',
  labelNames: ['provider', 'kind'] as const,
  registers: [metricsRegistry],
});

export const activeProxyRequests = new Gauge({
  name: 'proxiapp_proxy_active_requests',
  help: 'Currently active upstream requests',
  labelNames: ['provider'] as const,
  registers: [metricsRegistry],
});

export const usageCost = new Counter({
  name: 'proxiapp_wholesale_usage_cost_total',
  help: 'Wholesale usage cost recorded by the gateway',
  labelNames: ['provider', 'model'] as const,
  registers: [metricsRegistry],
});

export const paymentEvents = new Counter({
  name: 'proxiapp_payment_events_total',
  help: 'Payment webhook outcomes',
  labelNames: ['provider', 'status'] as const,
  registers: [metricsRegistry],
});

const poolCredentials = new Gauge({
  name: 'proxiapp_upstream_credentials',
  help: 'Upstream credentials by pool and status',
  labelNames: ['provider', 'status'] as const,
  registers: [metricsRegistry],
});

const poolCapacity = new Gauge({
  name: 'proxiapp_upstream_customer_key_capacity',
  help: 'Customer-key capacity and assignments by provider pool',
  labelNames: ['provider', 'kind'] as const,
  registers: [metricsRegistry],
});

const pendingOrders = new Gauge({
  name: 'proxiapp_pending_orders',
  help: 'Orders awaiting payment or key delivery',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

async function refreshBusinessMetrics(): Promise<void> {
  const pools = await sql<{ provider: string; total: number; assigned: number; reserved: number; sellable: number }[]>`
    SELECT up.slug AS provider,
      COALESCE(sum(slots.credential_capacity), 0)::int AS total,
      COALESCE(sum(slots.assigned), 0)::int AS assigned,
      COALESCE(sum(slots.reserved), 0)::int AS reserved,
      COALESCE(sum(GREATEST(0, slots.credential_capacity - slots.assigned - slots.reserved)), 0)::int AS sellable
    FROM upstream_pools up LEFT JOIN sellable_upstream_slots slots ON slots.pool_id = up.id GROUP BY up.id
  `;
  poolCapacity.reset();
  for (const pool of pools) {
    poolCapacity.set({ provider: pool.provider, kind: 'total' }, pool.total);
    poolCapacity.set({ provider: pool.provider, kind: 'assigned' }, pool.assigned);
    poolCapacity.set({ provider: pool.provider, kind: 'reserved' }, pool.reserved);
    poolCapacity.set({ provider: pool.provider, kind: 'sellable' }, pool.sellable);
  }

  const credentials = await sql<{ provider: string; status: string; count: number }[]>`
    SELECT up.slug AS provider, uc.status, count(*)::int AS count
    FROM upstream_credentials uc JOIN upstream_pools up ON up.id = uc.pool_id
    GROUP BY up.slug, uc.status
  `;
  poolCredentials.reset();
  for (const row of credentials) poolCredentials.set({ provider: row.provider, status: row.status }, row.count);

  const [orders] = await sql<{ pending: number; paid: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'PENDING' AND reserved_until > now())::int AS pending,
      count(*) FILTER (WHERE status = 'PAID')::int AS paid
    FROM orders WHERE status IN ('PENDING', 'PAID')
  `;
  pendingOrders.set({ status: 'pending' }, orders?.pending ?? 0);
  pendingOrders.set({ status: 'paid' }, orders?.paid ?? 0);
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request) => {
    request.metricsStartedAt = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/metrics') || request.url.startsWith('/v1/') || request.url.startsWith('/v1beta/')) return;
    const route = request.routeOptions.url ?? 'unmatched';
    const labels = { method: request.method, route, status: String(reply.statusCode) };
    httpRequests.inc(labels);
    if (request.metricsStartedAt) {
      httpDuration.observe(labels, Number(process.hrtime.bigint() - request.metricsStartedAt) / 1e9);
    }
  });

  app.get('/metrics', async (_request, reply) => {
    await refreshBusinessMetrics();
    reply.header('content-type', metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
}
