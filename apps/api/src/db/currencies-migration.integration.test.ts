import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sql } from './index.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integration('currency migration from an existing installation', () => {
  it('preserves a spent, topped-up key, usage, and a pending legacy payment', async () => {
    // Exercise the old schema in a separate disposable database, never by downgrading the main test database.
    const name = `currency_upgrade_${randomUUID().replaceAll('-', '')}`;
    await sql.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(config.DATABASE_URL);
    url.pathname = `/${name}`;
    const db = postgres(url.toString(), { transform: postgres.camel, max: 1, onnotice: () => undefined });
    const directory = new URL('../../migrations/', import.meta.url);
    try {
      for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql') && file < '010').sort()) {
        await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
      }
      const [user] = await db`INSERT INTO users (email, password_hash) VALUES ('upgrade@example.test', 'synthetic') RETURNING id`;
      const [pool] = await db`INSERT INTO upstream_pools (name, slug, base_url) VALUES ('Upgrade', 'upgrade', 'https://example.invalid') RETURNING id`;
      const [credential] = await db`INSERT INTO upstream_credentials (pool_id, label, encrypted_key, key_hint)
        VALUES (${pool!.id}, 'Upgrade', 'synthetic', 'synthetic') RETURNING id`;
      const [product] = await db`INSERT INTO products (pool_id, name, slug, wholesale_credits)
        VALUES (${pool!.id}, 'Upgrade key', 'upgrade-key', 10) RETURNING id`;
      const [order] = await db`INSERT INTO orders (user_id, product_id, upstream_credential_id, pool_id, payment_provider,
        status, currency, amount, price_markup, wholesale_credits, reserved_until, grant_label, grant_concurrency_limit)
        VALUES (${user!.id}, ${product!.id}, ${credential!.id}, ${pool!.id}, 'stripe', 'FULFILLED', 'USD', 20, 2, 10,
          now(), 'Upgrade key', 2) RETURNING id`;
      const [key] = await db`INSERT INTO api_keys (user_id, product_id, order_id, upstream_credential_id, key_hash,
        encrypted_key, key_hint, label, credits_total, credits_used)
        VALUES (${user!.id}, ${product!.id}, ${order!.id}, ${credential!.id}, 'synthetic-hash', 'synthetic-secret',
          'synthetic', 'Upgrade key', 40, 3.14159265) RETURNING id`;
      await db`INSERT INTO usage_records (api_key_id, upstream_credential_id, request_id, endpoint, cost, retail_cost, status)
        VALUES (${key!.id}, ${credential!.id}, 'upgrade-test', '/v1/responses', 1.570796325, 3.14159265, 'SUCCEEDED')`;
      await db`INSERT INTO orders (user_id, product_id, upstream_credential_id, pool_id, payment_provider,
        status, currency, amount, price_markup, wholesale_credits, reserved_until, grant_label, grant_concurrency_limit, top_up_key_id)
        VALUES (${user!.id}, ${product!.id}, ${credential!.id}, ${pool!.id}, 'stripe', 'FULFILLED', 'USD', 20, 2, 10,
          now(), 'Upgrade top-up', 2, ${key!.id})`;
      const [pending] = await db`INSERT INTO orders (user_id, product_id, pool_id, payment_provider, currency, amount,
        price_markup, wholesale_credits, reserved_until, grant_label, grant_concurrency_limit, external_id, metadata)
        VALUES (${user!.id}, ${product!.id}, ${pool!.id}, 'nowpayments', 'USD', 20, 2, 10, now() + interval '1 hour',
          'Legacy crypto', 2, '987654', '{"payAmount":10,"payCurrency":"ton"}') RETURNING id`;
      const before = await db`SELECT credits_total::text, credits_used::text, key_hash, encrypted_key FROM api_keys WHERE id = ${key!.id}`;
      const usage = await db`SELECT cost::text, retail_cost::text FROM usage_records`;
      await db.begin(transaction => transaction.unsafe(readMigration));
      expect(await db`SELECT credits_total::text, credits_used::text, key_hash, encrypted_key FROM api_keys WHERE id = ${key!.id}`).toEqual(before);
      expect(await db`SELECT currency, (credits_total - credits_used)::text AS balance FROM api_keys WHERE id = ${key!.id}`)
        .toEqual([{ currency: 'USDT', balance: '36.85840735' }]);
      expect(await db`SELECT cost::text, retail_cost::text FROM usage_records`).toEqual(usage);
      expect(await db`SELECT currency FROM products`).toEqual([{ currency: 'USDT' }]);
      expect(await db`SELECT amount::text, currency, credit_amount::text, external_id, metadata FROM orders WHERE id = ${pending!.id}`)
        .toEqual([{ amount: '20.00000000', currency: 'USD', creditAmount: '20.00000000', externalId: '987654', metadata: { payAmount: 10, payCurrency: 'ton' } }]);
      await expect(db`UPDATE orders SET payment_provider = 'yookassa', currency = 'RUB' WHERE id = ${pending!.id}`)
        .rejects.toMatchObject({ code: '23514' });
      await expect(db`UPDATE orders SET currency = 'USDT', amount = 21 WHERE id = ${pending!.id}`)
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await db.end();
      await sql.unsafe(`DROP DATABASE ${name}`);
    }
  });
});

const readMigration = await readFile(new URL('../../migrations/010_rub_usdt_billing.sql', import.meta.url), 'utf8');
