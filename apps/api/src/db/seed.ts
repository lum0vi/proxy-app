import { config } from '../config.js';
import { hashPassword } from '../lib/crypto.js';
import { closeDatabase, sql } from './index.js';

import { seedCeCatalog } from './ce-catalog.js';

async function seed(): Promise<void> {
  const [pool] = await sql<{ id: string }[]>`
    INSERT INTO upstream_pools (name, slug, base_url, protocol, credential_capacity)
    VALUES (
      ${config.DEFAULT_UPSTREAM_NAME},
      ${config.DEFAULT_UPSTREAM_SLUG},
      ${config.UPSTREAM_BASE_URL.replace(/\/v1\/?$/, '').replace(/\/$/, '')},
      'OPENAI',
      ${config.USERS_PER_UPSTREAM_KEY}
    )
    ON CONFLICT (slug) DO UPDATE SET
      credential_capacity = EXCLUDED.credential_capacity,
      updated_at = now()
    RETURNING id
  `;
  if (!pool) throw new Error('Unable to seed default upstream pool');

  const isCePlusTemplate = config.DEFAULT_UPSTREAM_SLUG === 'codex-everywhere'
    && new URL(config.UPSTREAM_BASE_URL).hostname === 'codex-everywhere.com';
  if (isCePlusTemplate) await seedCeCatalog(pool.id, config.UPSTREAM_BASE_URL.replace(/\/+$/, '').replace(/\/v1$/, ''));

  await sql`
    INSERT INTO products (
      pool_id, name, slug, description, wholesale_credits, currency, duration_days, concurrency_limit
    ) VALUES (
      ${pool.id},
      'Developer Key',
      'developer-key',
      '',
      10,
      ${config.DEFAULT_CURRENCY.toUpperCase()},
      NULL,
      2
    )
    ON CONFLICT (slug) DO NOTHING
  `;

  if (isCePlusTemplate) {
    await sql`
      UPDATE products SET description = '', updated_at = now()
      WHERE slug = 'developer-key'
        AND description = 'Prepaid API key with $10 of wholesale usage credits. Retail price is calculated with PRICE_MARKUP.'
    `;
    await sql`
      INSERT INTO products (
        pool_id, name, slug, wholesale_credits, currency, duration_days, concurrency_limit
      ) VALUES
        (${pool.id}, 'Starter Key', 'starter-key', 1, ${config.DEFAULT_CURRENCY.toUpperCase()}, NULL, 1),
        (${pool.id}, 'Extended Key', 'extended-key', 25, ${config.DEFAULT_CURRENCY.toUpperCase()}, NULL, 2)
      ON CONFLICT (slug) DO NOTHING
    `;
  }

  await sql`
    INSERT INTO products (pool_id, name, slug, wholesale_credits, currency, duration_days, concurrency_limit)
    VALUES (${pool.id}, 'Mini Key', 'mini-key', 0.5, 'USDT', NULL, 1),
      (${pool.id}, 'Starter Key', 'starter-key', 1, 'USDT', NULL, 1),
      (${pool.id}, 'Basic Key', 'basic-key', 2.5, 'USDT', NULL, 1)
    ON CONFLICT (slug) DO NOTHING
  `;

  const admins = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM users WHERE role = 'ADMIN'`;
  if (Number(admins[0]?.count ?? 0) === 0) {
    const passwordHash = await hashPassword(config.ADMIN_PASSWORD);
    await sql`
      INSERT INTO users (email, password_hash, name, role)
      VALUES (${config.ADMIN_EMAIL}, ${passwordHash}, 'Administrator', 'ADMIN')
      ON CONFLICT (email) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        role = 'ADMIN',
        status = 'ACTIVE',
        updated_at = now()
    `;
    console.info(`Created bootstrap admin ${config.ADMIN_EMAIL}`);
  }
}

seed()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
