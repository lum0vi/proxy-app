import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { sessionCookieName } from '../auth/session.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { ceBalanceProvider, providerBalanceStatus, recordProviderBalance, recordProviderBalanceFailure } from './provider-balances.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integration('provider balance visibility and metrics', () => {
  it('restricts account balances to administrators and marks failed or stale readings separately', async () => {
    const app = await buildApp();
    const userIds: string[] = [];
    try {
      expect((await app.inject({ url: '/api/admin/provider-balances' })).statusCode).toBe(401);
      await recordProviderBalance(ceBalanceProvider, '12.3456');
      for (const role of ['USER', 'ADMIN']) {
        const [user] = await sql<{ id: string }[]>`INSERT INTO users (email, name, password_hash, role)
          VALUES (${`balance-${randomUUID()}@example.test`}, 'Balance QA', 'unused', ${role}) RETURNING id`;
        userIds.push(user!.id);
        const token = randomUUID();
        await sql`INSERT INTO sessions (user_id, token_hash, expires_at)
          VALUES (${user!.id}, ${sha256(`${config.SESSION_SECRET}:${token}`)}, now() + interval '1 hour')`;
        const response = await app.inject({ url: '/api/admin/provider-balances', headers: { cookie: `${sessionCookieName}=${token}` } });
        expect(response.statusCode).toBe(role === 'ADMIN' ? 200 : 403);
        if (role === 'ADMIN') {
          expect(response.json()).toMatchObject({ monitoring: { ceEnabled: true, smtpConfigured: false },
            balances: [{ provider: ceBalanceProvider, balanceUsd: '12.34560000', lowBalance: true, stale: false, notificationStatus: 'PENDING' }] });
        } else expect(response.payload).not.toContain('12.3456');
      }
      const metrics = async () => (await app.inject({ url: '/metrics' })).payload;
      expect(await metrics()).toContain('proxiapp_provider_account_balance_usd{provider="codex-everywhere"} 12.3456');
      expect(await metrics()).toContain('proxiapp_provider_account_balance_check_healthy{provider="codex-everywhere"} 1');
      await recordProviderBalanceFailure(ceBalanceProvider, 'CE_HTTP_ERROR_503');
      expect((await providerBalanceStatus())[0]).toMatchObject({ stale: true, balanceUsd: '12.34560000', lastError: 'CE_HTTP_ERROR_503' });
      expect(await metrics()).toContain('proxiapp_provider_account_balance_check_healthy{provider="codex-everywhere"} 0');
      expect(await metrics()).toContain('proxiapp_provider_account_balance_usd{provider="codex-everywhere"} 12.3456');
      await recordProviderBalance(ceBalanceProvider, 30);
      await sql`UPDATE provider_balances SET checked_at = now() - interval '1 day' WHERE provider = ${ceBalanceProvider}`;
      expect(await metrics()).toContain('proxiapp_provider_account_balance_check_healthy{provider="codex-everywhere"} 0');
    } finally {
      await app.close();
      await sql`DELETE FROM provider_balances WHERE provider = ${ceBalanceProvider}`;
      if (userIds.length) await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    }
  });
});
