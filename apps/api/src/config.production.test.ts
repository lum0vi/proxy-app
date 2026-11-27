import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const valid = {
  NODE_ENV: 'production', DATABASE_URL: 'postgres://qa:qa-only@127.0.0.1/unused',
  PUBLIC_APP_URL: 'https://checkout.example', ADDITIONAL_BROWSER_ORIGINS: '',
  SESSION_SECRET: 'production-guard-synthetic-secret-32-characters', KEY_ENCRYPTION_SECRET: 'ab'.repeat(32),
  ADMIN_PASSWORD: 'SyntheticProductionAdminPassword!', PAYMENT_METHODS: 'nowpayments', PAYMENT_CURRENCIES: 'USDT',
  ALLOW_MOCK_PAYMENTS: 'false', NOWPAYMENTS_API_KEY: 'synthetic-api-key', NOWPAYMENTS_IPN_SECRET: 'synthetic-ipn-secret',
  NOWPAYMENTS_API_URL: 'https://api.nowpayments.io/v1', YOOKASSA_API_URL: 'https://api.yookassa.ru/v3',
  TONCENTER_API_URL: 'https://toncenter.com/api/v3', TON_RECEIVER_ADDRESS: `0:${'11'.repeat(32)}`, TONCENTER_API_KEY: 'synthetic-key',
  UPSTREAM_BASE_URL: 'https://provider.example', SALES_ENABLED: 'false',
};
function run(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', 'await import("./src/config.ts")'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, ...valid, ...overrides }, encoding: 'utf8', timeout: 10_000,
  });
}
describe('production configuration', () => {
  it('accepts a crypto-only configuration with sales held off', () => {
    expect(run({}).status).toBe(0);
  });
  it('accepts direct TON payments without a payment processor', () => {
    expect(run({ PAYMENT_METHODS: 'ton', NOWPAYMENTS_API_KEY: '', NOWPAYMENTS_IPN_SECRET: '' }).status).toBe(0);
  });
  it.each([
    [{ PAYMENT_METHODS: 'mock' }, 'Mock payments cannot be enabled'],
    [{ ALLOW_MOCK_PAYMENTS: 'true' }, 'ALLOW_MOCK_PAYMENTS must be false'],
    [{ NOWPAYMENTS_IPN_SECRET: '' }, 'API key or IPN secret is missing'],
    [{ PAYMENT_METHODS: 'ton', TON_RECEIVER_ADDRESS: '' }, 'TON_RECEIVER_ADDRESS and TONCENTER_API_KEY'],
    [{ PAYMENT_METHODS: 'ton', TONCENTER_API_KEY: '' }, 'TON_RECEIVER_ADDRESS and TONCENTER_API_KEY'],
    [{ PAYMENT_METHODS: 'ton', TONCENTER_API_URL: 'https://testnet.toncenter.com/api/v3' }, 'mainnet TON Center API'],
    [{ NOWPAYMENTS_API_URL: 'https://sandbox.nowpayments.io/v1' }, 'official NOWPayments API'],
    [{ PUBLIC_APP_URL: 'http://checkout.example' }, 'PUBLIC_APP_URL must use HTTPS'],
    [{ PAYMENT_CURRENCIES: 'RUB', SALES_ENABLED: 'true' }, 'No enabled payment method supports'],
  ] as const)('rejects unsafe launch settings %j', (overrides, message) => {
    const result = run(overrides);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });
});
