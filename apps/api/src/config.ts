import 'dotenv/config';
import { z } from 'zod';

const envBoolean = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => typeof value === 'boolean' ? value : value === 'true');
const booleanString = (defaultValue = false) => envBoolean.default(defaultValue);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().min(1).default('ProxyKey'),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:8080'),
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
  PRICE_RATES_URL: z.string().url().default('https://tonapi.io/v2/rates?tokens=ton&currencies=usd%2Crub'),
  USERS_PER_UPSTREAM_KEY: z.coerce.number().int().positive().default(2),
  DEFAULT_CURRENCY: z.string().default('USD').transform((value) => value.toUpperCase()).pipe(z.literal('USD')),
  DEFAULT_UPSTREAM_NAME: z.string().default('Codex Everywhere'),
  DEFAULT_UPSTREAM_SLUG: z.string().regex(/^[a-z0-9-]+$/).default('codex-everywhere'),
  UPSTREAM_BASE_URL: z.string().url().default('https://codex-everywhere.com'),
  CE_AUTO_PROVISION_KEYS: booleanString(),
  CE_PROVISION_GROUPS: z.string().default(''),
  CE_PROVISION_FREE_SLOTS: z.coerce.number().int().min(1).max(100).default(2),
  UPSTREAM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  UPSTREAM_HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  PROXY_ASSUMED_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(1_000_000).default(128_000),
  PROXY_UNCONFIRMED_COOLDOWN_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  FORCE_STREAM_USAGE: booleanString(true),
  AFFINITY_TTL_HOURS: z.coerce.number().int().positive().default(24),
  PROXY_ALLOWED_PATHS: z.string().default('/v1/models,/v1/responses,/v1/responses/compact,/v1/chat/completions,/v1/images/generations,/v1/messages,/v1beta/models,/v1beta/generateContent,/v1beta/streamGenerateContent'),
  PAYMENT_METHODS: z.string().default('mock'),
  SALES_ENABLED: envBoolean.optional(),
  ALLOW_MOCK_PAYMENTS: booleanString(),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  NOWPAYMENTS_API_KEY: z.string().default(''),
  NOWPAYMENTS_IPN_SECRET: z.string().default(''),
  NOWPAYMENTS_PAY_CURRENCY: z.string().trim().min(1).toLowerCase().default('ton'),
  NOWPAYMENTS_API_URL: z.string().url().default('https://api.nowpayments.io/v1'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanString(),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().default('ProxyKey <noreply@example.com>'),
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

if (!/[1-9]/.test(parsed.data.PRICE_MARKUP)) throw new Error('PRICE_MARKUP must be positive');

for (const method of paymentMethods) {
  if (!['stripe', 'nowpayments', 'mock'].includes(method)) {
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
  if (new URL(env.DATABASE_URL).password === 'change-me-in-production') throw new Error('Replace the default PostgreSQL password before starting in production');
  if (['local-development-session-secret-32-chars', 'replace-with-at-least-32-random-characters'].includes(env.SESSION_SECRET)
    || env.KEY_ENCRYPTION_SECRET.toLowerCase() === '0123456789abcdef'.repeat(4)
    || env.ADMIN_PASSWORD === 'ChangeThisAdminPassword123!') {
    throw new Error('Replace development secrets before starting in production');
  }
  if (paymentMethods.includes('stripe') && (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET)) {
    throw new Error('Stripe is enabled but its API key or webhook secret is missing');
  }
  if (paymentMethods.includes('nowpayments') && (!env.NOWPAYMENTS_API_KEY || !env.NOWPAYMENTS_IPN_SECRET)) {
    throw new Error('NOWPayments is enabled but its API key or IPN secret is missing');
  }
}

export const config = {
  ...parsed.data,
  paymentMethods,
  testUpstreamsEnabled: parsed.data.NODE_ENV !== 'production' && parsed.data.ALLOW_MOCK_PAYMENTS
    && paymentMethods.length === 1 && paymentMethods[0] === 'mock',
  salesEnabled: parsed.data.SALES_ENABLED ?? parsed.data.NODE_ENV !== 'production',
  expiryNoticeDays: parsed.data.KEY_EXPIRY_NOTICE_DAYS.split(',').map(Number).filter(Number.isFinite),
  balanceNoticePercent: parsed.data.KEY_BALANCE_NOTICE_PERCENT.split(',').map(Number).filter(Number.isFinite),
  proxyAllowedPaths: parsed.data.PROXY_ALLOWED_PATHS.split(',').map((value) => value.trim()).filter(Boolean),
} as const;

export type AppConfig = typeof config;
