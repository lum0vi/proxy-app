import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '../db/index.js';
import { processNotifications } from './notifications.js';
import { sendMail } from './mailer.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integration('notification delivery and recovery', () => {
  let userId: string;
  const prefix = randomUUID();
  async function enqueue(suffix: string, status = 'PENDING') {
    const dedupeKey = `${prefix}:${suffix}`;
    await sql`INSERT INTO notifications(user_id, kind, dedupe_key, status, payload)
      VALUES (${userId}, 'KEY_CREATED', ${dedupeKey}, ${status}, '{"detail":"20","label":"Test key"}')`;
    return dedupeKey;
  }
  const notice = async (key: string) => (await sql`SELECT status, error, attempts, sent_at, retry_at > now() AS delayed
    FROM notifications WHERE dedupe_key = ${key}`)[0]!;
  beforeAll(async () => {
    const [user] = await sql`INSERT INTO users(email, password_hash) VALUES (${`${prefix}@example.test`}, 'unused') RETURNING id`;
    userId = user!.id;
  });
  afterAll(async () => { if (userId) await sql`DELETE FROM users WHERE id = ${userId}`; });

  it('does not mark missing SMTP as sent, delays retries and delivers once configuration recovers', async () => {
    const key = await enqueue('no-smtp');
    const deliver = vi.fn<typeof sendMail>().mockResolvedValue(undefined);
    await expect(sendMail({ to: 'test@example.test', subject: 'Test', text: 'Test' })).rejects.toThrow('SMTP_NOT_CONFIGURED');
    await processNotifications(deliver, false);
    expect(deliver).not.toHaveBeenCalled();
    expect(await notice(key)).toMatchObject({ status: 'PENDING', error: 'SMTP_NOT_CONFIGURED', sentAt: null, attempts: 1, delayed: true });
    await processNotifications(deliver, true);
    expect(deliver).not.toHaveBeenCalled();
    await sql`UPDATE notifications SET retry_at = now() WHERE dedupe_key = ${key}`;
    await processNotifications(deliver, true);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await notice(key)).toMatchObject({ status: 'SENT', error: null, attempts: 2 });
    await processNotifications(deliver, true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('retries legacy failures without leaking SMTP errors and prevents concurrent delivery', async () => {
    const key = await enqueue('retry', 'FAILED');
    const failing = vi.fn<typeof sendMail>().mockRejectedValue(new Error('private SMTP details'));
    await processNotifications(failing, true);
    expect(await notice(key)).toMatchObject({ status: 'PENDING', error: 'SMTP_DELIVERY_FAILED', attempts: 1, delayed: true });
    await sql`UPDATE notifications SET retry_at = now() WHERE dedupe_key = ${key}`;
    let started!: () => void, release!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    const deliver = vi.fn<typeof sendMail>(async () => { started(); await finish; });
    const first = processNotifications(deliver, true);
    await sending;
    try { await processNotifications(deliver, true); expect(deliver).toHaveBeenCalledTimes(1); }
    finally { release(); await first; }
    expect(await notice(key)).toMatchObject({ status: 'SENT', error: null, attempts: 2 });
  });
});
