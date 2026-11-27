import { Decimal } from 'decimal.js';
import { config } from '../config.js';
import { closeDatabase, sql } from '../db/index.js';
import { verifyPassword } from '../lib/crypto.js';

// Read-only preflight. Prints check names and aggregates, never credentials or user data.
async function main() {
  let failures = 0;
  const check = (ok: boolean, message: string) => {
    console.info(`${ok ? 'PASS' : 'FAIL'} ${message}`);
    if (!ok) failures++;
  };
  check(config.NODE_ENV === 'production', 'NODE_ENV=production');
  check(!config.ALLOW_MOCK_PAYMENTS && !config.paymentMethods.includes('mock'), 'Mock payments disabled');
  check(config.paymentMethods.length > 0 && config.paymentMethods.every(method => ['ton', 'nowpayments'].includes(method))
    && config.paymentCurrencies.length === 1 && config.paymentCurrencies[0] === 'USDT', 'Crypto-only checkout: USDT TON');
  if (config.paymentMethods.includes('ton')) {
    check(Boolean(config.TON_RECEIVER_ADDRESS && config.TONCENTER_API_KEY), 'Direct TON wallet and indexer API key configured');
    const [scan] = await sql<{ healthy: boolean }[]>`SELECT count(*) > 0 AND bool_and(error_code IS NULL
      AND checked_at > now() - interval '3 minutes' AND scanned_through > now() - interval '10 minutes') AS healthy FROM ton_payment_scans`;
    check(scan?.healthy === true, 'TON worker has a fresh, successful blockchain scan');
    const [review] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ton_payments WHERE status = 'REVIEW'`;
    check((review?.count ?? 0) === 0, 'No unresolved USDT transfers');
    console.info(`INFO TON payment approval: ${config.TON_AUTO_APPROVE ? 'automatic exact-match payments' : 'manual administrator review'}`);
  }
  if (config.paymentMethods.includes('nowpayments')) check(Boolean(config.NOWPAYMENTS_API_KEY && config.NOWPAYMENTS_IPN_SECRET), 'NOWPayments API key and webhook secret configured');
  const url = new URL(config.PUBLIC_APP_URL);
  check(url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash
    && !/^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)
    && !/\.(example|invalid|test)$/.test(url.hostname), 'Public HTTPS origin configured (DNS and certificate still need a live check)');
  check(new Decimal(config.PRICE_MARKUP).gt(1), 'New-sale markup is above wholesale cost');
  check(Boolean(config.SMTP_HOST), 'SMTP configured for customer and low-balance notifications');
  const grafanaPassword = process.env.GRAFANA_ADMIN_PASSWORD ?? '';
  check(grafanaPassword.length >= 16 && !['admin', 'change-me-in-production'].includes(grafanaPassword), 'Non-default Grafana bootstrap password configured');

  const admins = await sql<{ passwordHash: string }[]>`SELECT password_hash FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'`;
  check(admins.length > 0, 'At least one active administrator exists');
  let defaultAdmin = false;
  for (const admin of admins) defaultAdmin ||= await verifyPassword('ChangeThisAdminPassword123!', admin.passwordHash);
  check(!defaultAdmin, 'Existing active administrators do not use the development bootstrap password');
  const [capacity] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM sellable_upstream_slots
    WHERE NOT test_only AND (free_slots IS NULL OR free_slots > 0)`;
  check((capacity?.count ?? 0) > 0, 'Verified paid provider capacity available for sale');
  const [products] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM products WHERE active AND wholesale_credits > 0 AND currency = 'USDT'`;
  check((products?.count ?? 0) > 0, 'Active USDT packages configured');
  const [keys] = await sql<{ unprofitable: number; test: number }[]>`SELECT
    count(*) FILTER (WHERE o.payment_provider <> 'mock' AND COALESCE(o.metadata->>'testPayment', 'false') <> 'true'
      AND o.credit_amount <= o.wholesale_credits * ${config.BILLING_USDT_PER_USD}::numeric)::int AS unprofitable,
    count(*) FILTER (WHERE o.payment_provider = 'mock' OR o.metadata->>'testPayment' = 'true')::int AS test
    FROM api_keys ak JOIN orders o ON o.id = ak.order_id WHERE ak.status = 'ACTIVE'`;
  check((keys?.unprofitable ?? 0) === 0, 'Existing paid keys have a positive gross margin at the configured conversion');
  console.info(`INFO Test keys blocked from production inference: ${keys?.test ?? 0}`);
  const [orders] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM orders WHERE status = 'PAID'`;
  check((orders?.count ?? 0) === 0, 'No paid orders waiting for fulfillment');
  const [usage] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM usage_records
    WHERE error_code LIKE '%UNCONFIRMED%' OR (status = 'STARTED' AND started_at < now() - interval '30 minutes')`;
  check((usage?.count ?? 0) === 0, 'No unresolved usage requiring provider reconciliation');
  console.info(`INFO Sales switch: ${config.salesEnabled ? 'ON' : 'OFF (enable after live payment and provider checks)'}`);
  console.info('INFO This check does not send payments, infer models, deliver email, or verify DNS/backups/TLS. Complete the live launch checklist.');
  process.exitCode = failures ? 1 : 0;
}

main().catch(() => {
  console.error('FAIL Unable to complete database checks. Verify connection and migrations; no secrets were printed.');
  process.exitCode = 1;
}).finally(closeDatabase);
