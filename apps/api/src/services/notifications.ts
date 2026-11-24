import { Decimal } from 'decimal.js';
import type postgres from 'postgres';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { sendMail } from './mailer.js';

interface NoticeRow {
  attempts: number;
  userId: string;
  email: string;
  locale: 'ru' | 'en';
  keyId: string;
  label: string;
  kind: string;
  threshold: number;
  dedupeKey: string;
  detail: string;
}

async function enqueueNotices(): Promise<void> {
  for (const days of config.expiryNoticeDays) {
    await sql`
      INSERT INTO notifications (user_id, api_key_id, kind, dedupe_key, payload)
      SELECT ak.user_id, ak.id, 'KEY_EXPIRY',
        'key-expiry:' || ak.id::text || ':' || ${days}::int::text,
        jsonb_build_object('threshold', ${days}::int, 'detail', ak.expires_at::text, 'label', ak.label)
      FROM api_keys ak
      WHERE ak.status = 'ACTIVE'
        AND ak.expires_at IS NOT NULL
        AND ak.expires_at > now()
        AND ak.expires_at <= now() + make_interval(days => ${days}::int)
      ON CONFLICT (dedupe_key) DO NOTHING
    `;
  }

  for (const percent of config.balanceNoticePercent) {
    await sql`
      INSERT INTO notifications (user_id, api_key_id, kind, dedupe_key, payload)
      SELECT ak.user_id, ak.id, 'KEY_BALANCE',
        'key-balance:' || ak.id::text || ':' || ${percent}::numeric::text
          || CASE WHEN ak.credits_total = COALESCE(o.credit_amount, o.amount) THEN '' ELSE ':' || ak.credits_total::text END,
        jsonb_build_object(
          'threshold', ${percent}::numeric,
          'detail', (ak.credits_total - ak.credits_used)::text,
          'label', ak.label
        )
      FROM api_keys ak JOIN orders o ON o.id = ak.order_id
      WHERE ak.status IN ('ACTIVE', 'EXHAUSTED')
        AND (ak.expires_at IS NULL OR ak.expires_at > now())
        AND ((ak.credits_total - ak.credits_used) / ak.credits_total * 100) <= ${percent}::numeric
      ON CONFLICT (dedupe_key) DO NOTHING
    `;
  }

  await sql`
    INSERT INTO notifications (user_id, api_key_id, kind, dedupe_key, payload)
    SELECT ak.user_id, ak.id, 'KEY_CREATED', 'key-created:' || ak.id::text,
      jsonb_build_object('label', ak.label, 'detail', ak.credits_total::text)
    FROM api_keys ak
    ON CONFLICT (dedupe_key) DO NOTHING
  `;
}

async function pendingNotices(db: postgres.TransactionSql): Promise<NoticeRow[]> {
  return db<NoticeRow[]>`
    SELECT n.attempts, n.user_id, u.email::text, u.locale, n.api_key_id AS key_id,
      COALESCE(n.payload->>'label', 'API key') AS label, n.kind,
      COALESCE((n.payload->>'threshold')::int, 0) AS threshold,
      n.dedupe_key, COALESCE(n.payload->>'detail', '') AS detail
    FROM notifications n JOIN users u ON u.id = n.user_id
    WHERE n.status IN ('PENDING', 'FAILED') AND n.retry_at <= now() AND u.status = 'ACTIVE'
    ORDER BY n.created_at
    LIMIT 1 FOR UPDATE OF n SKIP LOCKED
  `;
}

function message(notice: NoticeRow): { subject: string; text: string } {
  const ru = notice.locale === 'ru';
  if (notice.kind === 'KEY_CREATED') {
    const balance = new Decimal(notice.detail || 0).toFixed(2);
    return ru
      ? { subject: 'Ваш ключ Ksapi готов', text: `Ключ «${notice.label}» активирован. Баланс ${balance} USDT. Откройте кабинет, чтобы скопировать ключ.` }
      : { subject: 'Your Ksapi is ready', text: `Key “${notice.label}” is active with a ${balance} USDT balance. Open your dashboard to copy the key.` };
  }
  if (notice.kind === 'KEY_EXPIRY') {
    return ru
      ? { subject: 'Срок API-ключа скоро закончится', text: `Ключ «${notice.label}» истекает менее чем через ${notice.threshold} дн. Купите новый ключ заранее, чтобы избежать перерыва.` }
      : { subject: 'API key expires soon', text: `Key “${notice.label}” expires in less than ${notice.threshold} day(s). Buy a new key early to avoid interruption.` };
  }
  const remaining = new Decimal(notice.detail || 0).toFixed(4);
  return ru
    ? { subject: 'На API-ключе мало средств', text: `На ключе «${notice.label}» осталось не более ${notice.threshold}% оплаченного баланса (примерно ${remaining} USDT).` }
    : { subject: 'API key balance is running low', text: `Key “${notice.label}” has no more than ${notice.threshold}% of its balance remaining (about ${remaining} USDT).` };
}

export async function processNotifications(deliver: typeof sendMail = sendMail, smtpConfigured = Boolean(config.SMTP_HOST)): Promise<void> {
  await enqueueNotices();
  // Lock only the current delivery so parallel workers cannot send the same notice.
  for (let index = 0; index < 100; index++) {
    const handled = await sql.begin(async db => {
      const [notice] = await pendingNotices(db);
      if (!notice) return false;
      try {
        if (!smtpConfigured) throw new Error('SMTP_NOT_CONFIGURED');
        await deliver({ to: notice.email, ...message(notice) });
        await db`UPDATE notifications SET status = 'SENT', sent_at = now(), error = NULL,
          attempts = attempts + 1 WHERE dedupe_key = ${notice.dedupeKey}`;
      } catch {
        const code = smtpConfigured ? 'SMTP_DELIVERY_FAILED' : 'SMTP_NOT_CONFIGURED';
        await db`UPDATE notifications SET status = 'PENDING', error = ${code}, attempts = attempts + 1,
          retry_at = now() + make_interval(secs => ${Math.min(3600, 60 * 2 ** Math.min(notice.attempts, 6))})
          WHERE dedupe_key = ${notice.dedupeKey}`;
      }
      return true;
    });
    if (!handled) break;
  }
}
