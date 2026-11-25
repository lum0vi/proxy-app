import 'dotenv/config';
import { z } from 'zod';
import { tonAddress } from './lib/ton.js';
import { browserOrigins } from './lib/browser-origins.js';

const envBoolean = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => typeof value === 'boolean' ? value : value === 'true');
const booleanString = (defaultValue = false) => envBoolean.default(defaultValue);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().min(1).default('Ksapi'),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:8080'),
  ADDITIONAL_BROWSER_ORIGINS: z.string().default(''),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: z.union([z.boolean(), z.string()]).default(false).transform((value) => {
    if (value === true || value === 'true') return (_address: string, hop: number) => hop === 0;
    if (value === false || value === 'false') return false;
    return value;
  }),
  DATABASE_URL: z.string().min(1),
  ADMIN_EMAIL: z.string().email().default('admin@example.com'),
  ADMIN_PASSWORD: z.string().min(12).default('ChangeThisAdminPassword123!'),
  SESSION_SECRET: z.string().min(32),
  KEY_ENCRYPTION_SECRET: z.string().regex(/^[a-fA-F0-9]{64}$/),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  API_KEY_PREFIX: z.string().min(3).max(24).default('pk_live_'),
  PRICE_MARKUP: z.string().regex(/^\d+(?:\.\d+)?$/).default('2'),
  PRICE_RATES_URL: z.string().url().default('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd,rub&include_last_updated_at=true'),
  PRICE_RATES_API_KEY: z.string().default(''),
  USDT_RUB_RATE: z.string().regex(/^(?:\d+(?:\.\d{1,8})?)?$/).default(''),
  BILLING_USDT_PER_USD: z.string().regex(/^\d+(?:\.\d{1,8})?$/).default('1'),
  USERS_PER_UPSTREAM_KEY: z.coerce.number().int().positive().default(2),
  DEFAULT_CURRENCY: z.string().default('USDT').transform((value) => value.toUpperCase()).pipe(z.literal('USDT')),
  DEFAULT_UPSTREAM_NAME: z.string().default('Codex Everywhere'),
  DEFAULT_UPSTREAM_SLUG: z.string().regex(/^[a-z0-9-]+$/).default('codex-everywhere'),
  UPSTREAM_BASE_URL: z.string().url().default('https://codex-everywhere.com'),
  CE_AUTO_PROVISION_KEYS: booleanString(),
  CE_BALANCE_MONITOR_ENABLED: booleanString(),
  CE_KEY_SYNC_ENABLED: booleanString(),
  CE_KEY_SYNC_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),
  PROVIDER_BALANCE_LOW_USD: z.string().regex(/^\d+(?:\.\d{1,8})?$/).default('20'),
  PROVIDER_BALANCE_CHECK_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),
  PROVIDER_BALANCE_ALERT_REPEAT_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  CE_PROVISION_GROUPS: z.string().default(''),
  CE_PROVISION_FREE_SLOTS: z.coerce.number().int().min(1).max(100).default(2),
  UPSTREAM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  UPSTREAM_HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  VIDEO_JOB_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(604_800_000).default(86_400_000),
  PROXY_ASSUMED_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(1_000_000).default(128_000),
  PROXY_UNCONFIRMED_COOLDOWN_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  FORCE_STREAM_USAGE: booleanString(true),
  AFFINITY_TTL_HOURS: z.coerce.number().int().positive().default(24),
  PROXY_ALLOWED_PATHS: z.string().default('/v1/models,/v1/responses,/v1/responses/compact,/v1/chat/completions,/v1/images/generations,/v1/images/edits,/v1/videos,/v1/messages,/v1/messages/count_tokens,/v1beta/models,/v1beta/generateContent,/v1beta/streamGenerateContent,/v1beta/countTokens'),
  PAYMENT_METHODS: z.string().default('mock'),
  PAYMENT_CURRENCIES: z.string().default('USDT'),
  SALES_ENABLED: envBoolean.optional(),
  ALLOW_MOCK_PAYMENTS: booleanString(),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  NOWPAYMENTS_API_KEY: z.string().default(''),
  NOWPAYMENTS_IPN_SECRET: z.string().default(''),
  NOWPAYMENTS_PAY_CURRENCY: z.literal('usdtton').default('usdtton'),
  NOWPAYMENTS_API_URL: z.string().url().default('https://api.nowpayments.io/v1'),
  TON_RECEIVER_ADDRESS: z.string().trim().default('').refine(value => {
    try { return !value || Boolean(tonAddress(value)); } catch { return false; }
  }, 'Use a valid mainnet TON wallet address'),
  TONCENTER_API_KEY: z.string().default(''),
  TONCENTER_API_URL: z.string().url().default('https://toncenter.com/api/v3'),
  TON_AUTO_APPROVE: booleanString(true),
  TON_INVOICE_TTL_MINUTES: z.coerce.number().int().min(10).max(1440).default(60),
  YOOKASSA_SHOP_ID: z.string().default(''),
  YOOKASSA_SECRET_KEY: z.string().default(''),
  YOOKASSA_API_URL: z.string().url().default('https://api.yookassa.ru/v3'),
  YOOKASSA_TEST_MODE: booleanString(true),
  YOOKASSA_RECEIPTS_ENABLED: booleanString(),
  YOOKASSA_VAT_CODE: z.coerce.number().int().min(1).max(12).default(1),
  YOOKASSA_TAX_SYSTEM_CODE: z.coerce.number().int().min(1).max(6).optional(),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanString(),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().default('Ksapi <noreply@example.com>'),
  ADMIN_ALERT_EMAIL: z.string().email().default('admin@example.com'),
  KEY_EXPIRY_NOTICE_DAYS: z.string().default('7,3,1'),
  KEY_BALANCE_NOTICE_PERCENT: z.string().default('20,10,5'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`);
}

const paymentMethods = parsed.data.PAYMENT_METHODS.split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const allowedPaymentCurrencies = [...new Set(parsed.data.PAYMENT_CURRENCIES.split(',').map(value => value.trim().toUpperCase()).filter(Boolean))];
if (!allowedPaymentCurrencies.length || allowedPaymentCurrencies.some(value => !['USDT', 'RUB'].includes(value))) {
  throw new Error('PAYMENT_CURRENCIES must contain USDT and/or RUB');
}
const paymentCurrencies = allowedPaymentCurrencies.filter(currency => paymentMethods.some(method => method === 'mock'
  || (currency === 'RUB' ? method === 'yookassa' : ['nowpayments', 'ton'].includes(method))));

if (!/[1-9]/.test(parsed.data.PRICE_MARKUP)) throw new Error('PRICE_MARKUP must be positive');
if (!/[1-9]/.test(parsed.data.BILLING_USDT_PER_USD)) throw new Error('BILLING_USDT_PER_USD must be positive');
if (parsed.data.USDT_RUB_RATE && !/[1-9]/.test(parsed.data.USDT_RUB_RATE)) throw new Error('USDT_RUB_RATE must be positive');

for (const method of paymentMethods) {
  if (!['yookassa', 'nowpayments', 'ton', 'mock'].includes(method)) {
    throw new Error(`Unsupported payment method: ${method}`);
  }
}

if (parsed.data.NODE_ENV === 'production' && paymentMethods.includes('mock')) {
  throw new Error('Mock payments cannot be enabled in production');
}

if (parsed.data.NODE_ENV === 'production') {
  const env = parsed.data;
  if (new URL(env.PUBLIC_APP_URL).protocol !== 'https:') throw new Error('PUBLIC_APP_URL must use HTTPS in production');
  if (new URL(env.UPSTREAM_BASE_URL).protocol !== 'https:') throw new Error('UPSTREAM_BASE_URL must use HTTPS in production');
  if (env.SALES_ENABLED && paymentMethods.length === 0) throw new Error('Enable a real payment method before enabling production sales');
  if (env.SALES_ENABLED && paymentCurrencies.length === 0) throw new Error('No enabled payment method supports PAYMENT_CURRENCIES');
  if (env.ALLOW_MOCK_PAYMENTS) throw new Error('ALLOW_MOCK_PAYMENTS must be false in production');
  if (new URL(env.DATABASE_URL).password === 'change-me-in-production') throw new Error('Replace the default PostgreSQL password before starting in production');
  if (['local-development-session-secret-32-chars', 'replace-with-at-least-32-random-characters'].includes(env.SESSION_SECRET)
    || env.KEY_ENCRYPTION_SECRET.toLowerCase() === '0123456789abcdef'.repeat(4)
    || env.ADMIN_PASSWORD === 'ChangeThisAdminPassword123!') {
    throw new Error('Replace development secrets before starting in production');
  }
  if (paymentMethods.includes('nowpayments') && (!env.NOWPAYMENTS_API_KEY || !env.NOWPAYMENTS_IPN_SECRET)) {
    throw new Error('NOWPayments is enabled but its API key or IPN secret is missing');
  }
  if (env.NOWPAYMENTS_API_URL !== 'https://api.nowpayments.io/v1') throw new Error('Use the official NOWPayments API in production');
  if (paymentMethods.includes('ton') && (!env.TON_RECEIVER_ADDRESS || !env.TONCENTER_API_KEY)) {
    throw new Error('Configure TON_RECEIVER_ADDRESS and TONCENTER_API_KEY before enabling direct TON payments');
  }
  if (env.TONCENTER_API_URL !== 'https://toncenter.com/api/v3') throw new Error('Use the mainnet TON Center API in production');
  if (paymentMethods.includes('yookassa') && (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY || env.YOOKASSA_TEST_MODE)) {
    throw new Error('Configure live YooKassa credentials and disable YOOKASSA_TEST_MODE for production payments');
  }
  if (env.YOOKASSA_API_URL !== 'https://api.yookassa.ru/v3') throw new Error('Use the official YooKassa API in production');
}

export const config = {
  ...parsed.data,
  browserOrigins: browserOrigins(parsed.data.PUBLIC_APP_URL, parsed.data.ADDITIONAL_BROWSER_ORIGINS, parsed.data.NODE_ENV === 'production'),
  ceBalanceMonitorEnabled: parsed.data.CE_AUTO_PROVISION_KEYS || parsed.data.CE_BALANCE_MONITOR_ENABLED,
  ceKeySyncEnabled: parsed.data.CE_AUTO_PROVISION_KEYS || parsed.data.CE_KEY_SYNC_ENABLED,
  paymentMethods,
  paymentCurrencies,
  testUpstreamsEnabled: parsed.data.NODE_ENV !== 'production' && parsed.data.ALLOW_MOCK_PAYMENTS
    && paymentMethods.length === 1 && paymentMethods[0] === 'mock',
  salesEnabled: parsed.data.SALES_ENABLED ?? parsed.data.NODE_ENV !== 'production',
  expiryNoticeDays: parsed.data.KEY_EXPIRY_NOTICE_DAYS.split(',').map(Number).filter(Number.isFinite),
  balanceNoticePercent: parsed.data.KEY_BALANCE_NOTICE_PERCENT.split(',').map(Number).filter(Number.isFinite),
  proxyAllowedPaths: parsed.data.PROXY_ALLOWED_PATHS.split(',').map((value) => value.trim()).filter(Boolean),
} as const;

export type AppConfig = typeof config;
