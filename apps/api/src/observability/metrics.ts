import type { FastifyInstance } from 'fastify';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { sql } from '../db/index.js';
import { config } from '../config.js';
import { ceBalanceProvider, providerBalanceStatus } from '../services/provider-balances.js';

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
const tonMonitoring = new Gauge({ name: 'proxiapp_ton_monitor_enabled', help: 'Direct TON payment monitoring enabled', registers: [metricsRegistry] });
const tonScanLag = new Gauge({ name: 'proxiapp_ton_scan_lag_seconds', help: 'Oldest TON scan watermark lag; 86400 when not started', registers: [metricsRegistry] });
const tonScanErrors = new Gauge({ name: 'proxiapp_ton_scan_errors', help: 'Wallet scans with an indexer error', registers: [metricsRegistry] });
const tonReviewCount = new Gauge({ name: 'proxiapp_ton_payments_review', help: 'Finalized USDT deposits awaiting manual resolution', registers: [metricsRegistry] });
const videoJobs = new Gauge({ name: 'proxiapp_video_jobs', help: 'Durable video jobs by state', labelNames: ['state'] as const, registers: [metricsRegistry] });
const videoPollLag = new Gauge({ name: 'proxiapp_video_poll_lag_seconds', help: 'Oldest overdue video status check', registers: [metricsRegistry] });

const providerBalance = new Gauge({ name: 'proxiapp_provider_account_balance_usd', help: 'Last confirmed provider account balance in USD',
  labelNames: ['provider'] as const, registers: [metricsRegistry] });
const providerBalanceThreshold = new Gauge({ name: 'proxiapp_provider_account_low_balance_threshold_usd', help: 'Provider low balance alert threshold in USD',
  labelNames: ['provider'] as const, registers: [metricsRegistry] });
const providerBalanceChecked = new Gauge({ name: 'proxiapp_provider_account_balance_checked_timestamp_seconds', help: 'Time of last successful account balance check',
  labelNames: ['provider'] as const, registers: [metricsRegistry] });
const providerBalanceHealthy = new Gauge({ name: 'proxiapp_provider_account_balance_check_healthy', help: 'Whether enabled account balance monitoring is fresh and successful',
  labelNames: ['provider'] as const, registers: [metricsRegistry] });
const providerBalanceMonitoring = new Gauge({ name: 'proxiapp_provider_account_balance_monitor_enabled', help: 'Whether account balance monitoring is enabled',
  labelNames: ['provider'] as const, registers: [metricsRegistry] });

async function refreshBusinessMetrics(): Promise<void> {
  videoJobs.reset();
  for (const row of await sql<{ state: string; count: number }[]>`SELECT state, count(*)::int AS count FROM video_jobs GROUP BY state`) videoJobs.set({ state: row.state }, row.count);
  const [videoLag] = await sql<{ lag: number }[]>`SELECT GREATEST(0, COALESCE(extract(epoch FROM now() - min(poll_after)), 0))::float AS lag
    FROM video_jobs WHERE state IN ('QUEUED','IN_PROGRESS')`;
  videoPollLag.set(videoLag?.lag ?? 0);
  tonMonitoring.set(Number(config.paymentMethods.includes('ton')));
  const [ton] = await sql<{ lag: string; errors: number; review: number }[]>`SELECT
    greatest(COALESCE((SELECT extract(epoch FROM now() - min(scanned_through)) FROM ton_payment_scans), 86400), 0)::text AS lag,
    (SELECT count(*)::int FROM ton_payment_scans WHERE error_code IS NOT NULL) AS errors,
    (SELECT count(*)::int FROM ton_payments WHERE status = 'REVIEW') AS review`;
  tonScanLag.set(Number(ton?.lag ?? 86400)); tonScanErrors.set(ton?.errors ?? 0); tonReviewCount.set(ton?.review ?? 0);
  for (const gauge of [providerBalance, providerBalanceThreshold, providerBalanceChecked, providerBalanceHealthy, providerBalanceMonitoring]) gauge.reset();
  const ceLabels = { provider: ceBalanceProvider };
  providerBalanceMonitoring.set(ceLabels, Number(config.ceBalanceMonitorEnabled));
  if (config.ceBalanceMonitorEnabled) providerBalanceHealthy.set(ceLabels, 0);
  for (const balance of await providerBalanceStatus()) {
    const labels = { provider: balance.provider };
    providerBalanceMonitoring.set(labels, Number(balance.enabled));
    if (!balance.enabled) continue;
    if (balance.balanceUsd !== null) providerBalance.set(labels, Number(balance.balanceUsd));
    providerBalanceThreshold.set(labels, Number(balance.lowThresholdUsd));
    providerBalanceChecked.set(labels, balance.checkedAt ? balance.checkedAt.getTime() / 1000 : 0);
    providerBalanceHealthy.set(labels, Number(!balance.stale && !balance.lastError));
  }
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
