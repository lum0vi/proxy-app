import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://proxiapp:test-password@127.0.0.1:5432/proxiapp_test',
      PUBLIC_APP_URL: 'http://localhost:8080',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters',
      KEY_ENCRYPTION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      PAYMENT_METHODS: 'mock',
      ALLOW_MOCK_PAYMENTS: 'true',
      NOWPAYMENTS_API_KEY: 'test-nowpayments-key',
      NOWPAYMENTS_API_URL: 'https://nowpayments.invalid/v1',
      NOWPAYMENTS_PAY_CURRENCY: 'ton',
      NOWPAYMENTS_IPN_SECRET: 'test-nowpayments-ipn-secret',
      STRIPE_SECRET_KEY: 'sk_test_proxykey_local_only',
      STRIPE_WEBHOOK_SECRET: 'whsec_proxykey_integration_only',
      ADMIN_EMAIL: 'admin@example.test',
      ADMIN_PASSWORD: 'TestAdminPassword123!',
      LOG_LEVEL: 'silent',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/worker.ts', 'src/db/migrate.ts', 'src/db/seed.ts'],
    },
  },
});
