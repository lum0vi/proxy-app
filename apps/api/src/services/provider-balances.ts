import { Decimal } from 'decimal.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { sendMail } from './mailer.js';

export const ceBalanceProvider = 'codex-everywhere';

export async function recordProviderBalance(provider: string, balance: number | string): Promise<void> {
  const amount = new Decimal(balance);
  if (!amount.isFinite() || amount.isNegative()) throw new Error('Invalid provider balance');
  const low = amount.lte(config.PROVIDER_BALANCE_LOW_USD);
  await sql.begin(async (db) => {
    // The upsert locks one account across all its pools and concurrent workers.
    await db`
      INSERT INTO provider_balances (provider, balance_usd, low_threshold_usd, checked_at)
      VALUES (${provider}, ${amount.toFixed(8)}, ${config.PROVIDER_BALANCE_LOW_USD}, now())
      ON CONFLICT (provider) DO UPDATE SET balance_usd = EXCLUDED.balance_usd,
        low_threshold_usd = EXCLUDED.low_threshold_usd, checked_at = now(), last_attempt_at = now(), last_error = NULL
    `;
    if (!low) {
      await db`UPDATE provider_balances SET low_since = NULL, next_notification_at = NULL WHERE provider = ${provider}`;
      await db`UPDATE provider_balance_alerts SET status = 'CANCELLED' WHERE provider = ${provider} AND status = 'PENDING'`;
      return;
    }
    await db`UPDATE provider_balances SET low_since = COALESCE(low_since, now()) WHERE provider = ${provider}`;
    const inserted = await db`
      INSERT INTO provider_balance_alerts (provider, balance_usd, threshold_usd)
      SELECT provider, balance_usd, low_threshold_usd FROM provider_balances
      WHERE provider = ${provider} AND (next_notification_at IS NULL OR next_notification_at <= now())
      ON CONFLICT (provider) WHERE status = 'PENDING' DO NOTHING RETURNING id
    `;
    if (inserted.length) {
      await db`UPDATE provider_balances SET next_notification_at = now() + make_interval(hours => ${config.PROVIDER_BALANCE_ALERT_REPEAT_HOURS})
        WHERE provider = ${provider}`;
    }
  });
}

export async function recordProviderBalanceFailure(provider: string, code: string): Promise<void> {
  await sql`
    INSERT INTO provider_balances (provider, low_threshold_usd, last_error)
    VALUES (${provider}, ${config.PROVIDER_BALANCE_LOW_USD}, ${code})
    ON CONFLICT (provider) DO UPDATE SET low_threshold_usd = EXCLUDED.low_threshold_usd,
      last_attempt_at = now(), last_error = EXCLUDED.last_error
  `;
}

export async function providerBalanceStatus() {
  const balances = await sql<{
    provider: string; balanceUsd: string | null; lowThresholdUsd: string; checkedAt: Date | null;
    lastAttemptAt: Date; lastError: string | null; lowSince: Date | null;
    notificationStatus: string | null; notificationError: string | null; lastNotifiedAt: Date | null;
  }[]>`
    SELECT b.provider, b.balance_usd::text, b.low_threshold_usd::text, b.checked_at, b.last_attempt_at, b.last_error, b.low_since,
      (SELECT status FROM provider_balance_alerts a WHERE a.provider = b.provider ORDER BY created_at DESC LIMIT 1) AS notification_status,
      (SELECT last_error FROM provider_balance_alerts a WHERE a.provider = b.provider ORDER BY created_at DESC LIMIT 1) AS notification_error,
      (SELECT max(sent_at) FROM provider_balance_alerts a WHERE a.provider = b.provider) AS last_notified_at
    FROM provider_balances b ORDER BY b.provider
  `;
  return balances.map(row => ({ ...row,
    enabled: row.provider === ceBalanceProvider && config.ceBalanceMonitorEnabled,
    lowBalance: row.balanceUsd !== null && new Decimal(row.balanceUsd).lte(row.lowThresholdUsd),
    stale: !row.checkedAt || Boolean(row.lastError) || Date.now() - row.checkedAt.getTime() > config.PROVIDER_BALANCE_CHECK_INTERVAL_MS * 2,
  }));
}

export async function processProviderBalanceAlerts(deliver: typeof sendMail = sendMail, smtpConfigured = Boolean(config.SMTP_HOST)): Promise<void> {
  // A transaction lock prevents duplicate concurrent deliveries. Failed sends stay pending.
  await sql.begin(async db => {
    const alerts = await db<{ id: string; provider: string; balanceUsd: string; thresholdUsd: string; attempts: number }[]>`
      SELECT a.id, a.provider, b.balance_usd::text, b.low_threshold_usd::text AS threshold_usd, a.attempts
      FROM provider_balance_alerts a JOIN provider_balances b ON b.provider = a.provider
      WHERE a.status = 'PENDING' AND a.retry_at <= now() AND b.low_since IS NOT NULL
        AND b.last_error IS NULL AND b.checked_at > now() - make_interval(secs => ${config.PROVIDER_BALANCE_CHECK_INTERVAL_MS * 2 / 1000})
        AND a.provider = ${ceBalanceProvider} AND ${config.ceBalanceMonitorEnabled}
      ORDER BY a.created_at LIMIT 20 FOR UPDATE OF b SKIP LOCKED
    `;
    for (const alert of alerts) {
      try {
        if (!smtpConfigured) throw new Error('SMTP_NOT_CONFIGURED');
        await deliver({
          to: config.ADMIN_ALERT_EMAIL,
          subject: `ProxyKey: низкий баланс провайдера ${alert.provider}`,
          text: `На аккаунте провайдера ${alert.provider} осталось $${new Decimal(alert.balanceUsd).toFixed(2)}. `
            + `Порог уведомления $${new Decimal(alert.thresholdUsd).toFixed(2)}. Пополните аккаунт провайдера, чтобы продолжить обслуживание ключей.\n\n`
            + `Баланс проверен через API провайдера. Панель администратора: ${config.PUBLIC_APP_URL}/admin/providers`,
        });
        await db`UPDATE provider_balance_alerts SET status = 'SENT', sent_at = now(), last_error = NULL WHERE id = ${alert.id}`;
        await db`UPDATE provider_balances SET next_notification_at = now() + make_interval(hours => ${config.PROVIDER_BALANCE_ALERT_REPEAT_HOURS})
          WHERE provider = ${alert.provider}`;
      } catch {
        const code = smtpConfigured ? 'SMTP_DELIVERY_FAILED' : 'SMTP_NOT_CONFIGURED';
        await db`UPDATE provider_balance_alerts SET attempts = attempts + 1, last_error = ${code},
          retry_at = now() + make_interval(secs => ${Math.min(3600, 60 * 2 ** Math.min(alert.attempts, 6))})
          WHERE id = ${alert.id}`;
      }
    }
  });
}
