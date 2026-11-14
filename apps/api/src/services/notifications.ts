import { Decimal } from 'decimal.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { sendMail } from './mailer.js';

interface NoticeRow {
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
        'key-balance:' || ak.id::text || ':' || ${percent}::numeric::text,
        jsonb_build_object(
          'threshold', ${percent}::numeric,
          'detail', (ak.credits_total - ak.credits_used)::text,
          'label', ak.label
        )
      FROM api_keys ak
      WHERE ak.status = 'ACTIVE'
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

async function pendingNotices(): Promise<NoticeRow[]> {
  return sql<NoticeRow[]>`
    SELECT n.user_id, u.email::text, u.locale, n.api_key_id AS key_id,
      COALESCE(n.payload->>'label', 'API key') AS label, n.kind,
      COALESCE((n.payload->>'threshold')::int, 0) AS threshold,
      n.dedupe_key, COALESCE(n.payload->>'detail', '') AS detail
    FROM notifications n JOIN users u ON u.id = n.user_id
    WHERE n.status = 'PENDING'
    ORDER BY n.created_at
    LIMIT 100
  `;
}

function message(notice: NoticeRow): { subject: string; text: string } {
  const ru = notice.locale === 'ru';
  if (notice.kind === 'KEY_CREATED') {
    const balance = new Decimal(notice.detail || 0).toFixed(2);
    return ru
      ? { subject: 'Ваш ключ ProxyKey готов', text: `Ключ «${notice.label}» активирован. Баланс $${balance}. Откройте кабинет, чтобы скопировать ключ.` }
      : { subject: 'Your ProxyKey is ready', text: `Key “${notice.label}” is active with a $${balance} balance. Open your dashboard to copy the key.` };
  }
  if (notice.kind === 'KEY_EXPIRY') {
    return ru
      ? { subject: 'Срок API-ключа скоро закончится', text: `Ключ «${notice.label}» истекает менее чем через ${notice.threshold} дн. Купите новый ключ заранее, чтобы избежать перерыва.` }
      : { subject: 'API key expires soon', text: `Key “${notice.label}” expires in less than ${notice.threshold} day(s). Buy a new key early to avoid interruption.` };
  }
  const remaining = new Decimal(notice.detail || 0).toFixed(4);
  return ru
    ? { subject: 'На API-ключе мало средств', text: `На ключе «${notice.label}» осталось не более ${notice.threshold}% оплаченного баланса (примерно $${remaining}).` }
    : { subject: 'API key balance is running low', text: `Key “${notice.label}” has no more than ${notice.threshold}% of its balance remaining (about $${remaining}).` };
}

export async function processNotifications(): Promise<void> {
  await enqueueNotices();
  for (const notice of await pendingNotices()) {
    try {
      await sendMail({ to: notice.email, ...message(notice) });
      await sql`UPDATE notifications SET status = 'SENT', sent_at = now() WHERE dedupe_key = ${notice.dedupeKey}`;
    } catch (error) {
      await sql`
        UPDATE notifications SET status = 'FAILED', error = ${error instanceof Error ? error.message : String(error)}
        WHERE dedupe_key = ${notice.dedupeKey}
      `;
    }
  }
}
