import { setTimeout as delay } from 'node:timers/promises';
import { config } from './config.js';
import { closeDatabase, sql } from './db/index.js';
import { ceLogin, checkCeBalance, ceProvisioningErrorCode, ceProvisioningSettings, listCeGroups, provisionCeKeys, syncCeKeys } from './services/ce-provisioning.js';
import { providerKeyRefreshRequested, recordProviderKeyFailure } from './services/provider-keys.js';
import { ceBalanceProvider, processProviderBalanceAlerts, recordProviderBalanceFailure } from './services/provider-balances.js';
import { processNotifications } from './services/notifications.js';
import { retryPaidOrders } from './services/orders.js';
import { refreshUpstreamCatalog } from './services/upstream-catalog.js';
import { scanTonPayments } from './services/ton-payments.js';
import { processVideoJobs } from './proxy/videos.js';

let stopping = false;
const shutdown = new AbortController();
const stop = () => { stopping = true; shutdown.abort(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

async function housekeeping(): Promise<void> {
  await sql`DELETE FROM sessions WHERE expires_at <= now()`;
  await sql`DELETE FROM request_leases WHERE expires_at <= now()`;
  await sql`DELETE FROM session_affinities WHERE expires_at <= now()`;
  await sql`
    UPDATE orders SET status = 'EXPIRED', updated_at = now()
    WHERE status = 'PENDING' AND reserved_until <= now()
  `;
  await sql`
    UPDATE api_keys SET status = 'EXPIRED', updated_at = now()
    WHERE status IN ('ACTIVE', 'PAUSED') AND expires_at IS NOT NULL AND expires_at <= now()
  `;
}

async function healthCheckUpstreams(): Promise<void> {
  const credentials = await sql<{ id: string }[]>`
    SELECT uc.id
    FROM upstream_credentials uc JOIN upstream_pools up ON up.id = uc.pool_id
    WHERE uc.status IN ('ACTIVE', 'DEGRADED') AND up.active = true AND (NOT uc.test_only OR ${config.testUpstreamsEnabled})
  `;
  for (let i = 0; i < credentials.length; i += 8) {
    const results = await Promise.allSettled(credentials.slice(i, i + 8).map(({ id }) => refreshUpstreamCatalog(id)));
    if (results.some((result) => result.status === 'rejected')) console.error('Could not persist one or more provider health checks');
  }
}

async function main(): Promise<void> {
  let ceSettings: ReturnType<typeof ceProvisioningSettings>;
  try { ceSettings = ceProvisioningSettings(); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Invalid CE provisioning configuration'); }
  let nextHealthCheck = 0;
  let nextBalanceCheck = 0;
  let nextKeySync = 0;
  while (!stopping) {
    try {
      await housekeeping();
      // Customer payments must keep being checked even when a provider's API is down.
      await scanTonPayments();
      await processVideoJobs();
      if (config.ceKeySyncEnabled && (Date.now() >= nextKeySync || await providerKeyRefreshRequested())) {
        try { await syncCeKeys(ceLogin()); }
        catch { await recordProviderKeyFailure('CE_KEY_SYNC_FAILED_OR_LOGIN_MISSING'); }
        nextKeySync = Date.now() + config.CE_KEY_SYNC_INTERVAL_MS;
      }
      if (config.ceBalanceMonitorEnabled && Date.now() >= nextBalanceCheck) {
        try { await checkCeBalance(ceLogin()); }
        catch { await recordProviderBalanceFailure(ceBalanceProvider, 'CE_BALANCE_CHECK_FAILED_OR_LOGIN_MISSING'); }
        nextBalanceCheck = Date.now() + config.PROVIDER_BALANCE_CHECK_INTERVAL_MS;
      }
      if (Date.now() >= nextHealthCheck) {
        await healthCheckUpstreams();
        nextHealthCheck = Date.now() + config.UPSTREAM_HEALTH_INTERVAL_MS;
      }
      if (ceSettings) {
        try { await provisionCeKeys(ceSettings); }
        catch (error) { console.error(`CE key provisioning paused for this cycle: ${ceProvisioningErrorCode(error)}`); }
      }
      await retryPaidOrders();
      await processProviderBalanceAlerts();
      await processNotifications();
    } catch (error) {
      console.error(error);
    }
    await delay(60_000, undefined, { signal: shutdown.signal }).catch(error => {
      if (!stopping) throw error;
    });
  }
  await closeDatabase();
}

async function showCeGroups() {
  try {
    const result = await listCeGroups(ceLogin());
    if (!result) throw new Error('CE key provisioning is running. Retry when it completes.');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof Error && /^(Set CE_PROVISION_EMAIL|CE key provisioning is running)/.test(error.message)) console.error(error.message);
    else console.error(`Could not list CE groups: ${ceProvisioningErrorCode(error)}`);
    process.exitCode = 1;
  } finally { await closeDatabase(); }
}

void (process.argv[2] === '--ce-groups' ? showCeGroups() : main());
