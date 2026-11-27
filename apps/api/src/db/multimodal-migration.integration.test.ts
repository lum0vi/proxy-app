import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sql } from './index.js';

const integration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

integration('multimodal upgrade from migration 013', () => {
  it('preserves existing published prices and adds small packages without replacing custom products', async () => {
    const name = `media_upgrade_${randomUUID().replaceAll('-', '')}`;
    await sql.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(config.DATABASE_URL); url.pathname = `/${name}`;
    const db = postgres(url.toString(), { transform: postgres.camel, max: 1, onnotice: () => undefined });
    const directory = new URL('../../migrations/', import.meta.url);
    try {
      for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql') && file < '014').sort()) {
        await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
      }
      const [pool] = await db`INSERT INTO upstream_pools(name, slug, base_url) VALUES ('Upgrade', 'upgrade', 'https://example.invalid') RETURNING id`;
      await db`INSERT INTO model_rates(pool_id, model, input_per_million, output_per_million) VALUES (${pool!.id}, 'old-model', 1, 2)`;
      await db`INSERT INTO products(pool_id, name, slug, wholesale_credits, currency) VALUES
        (${pool!.id}, 'Developer', 'developer-key', 10, 'USDT'), (${pool!.id}, 'Custom starter', 'starter-key', 3, 'USDT')`;
      const before = await db`SELECT root_pool_id, model, input_per_million::text, output_per_million::text FROM public_pool_models`;
      for (const file of ['014_multimodal_api.sql', '015_small_credit_packages.sql']) {
        const script = await readFile(new URL(file, directory), 'utf8');
        await db.begin(tx => tx.unsafe(script));
      }
      expect(await db`SELECT root_pool_id, model, input_per_million::text, output_per_million::text FROM public_pool_models`).toEqual(before);
      expect(await db`SELECT per_second::text, media_options FROM public_pool_models`).toEqual([{ perSecond: '0.00000000', mediaOptions: {} }]);
      expect(await db`SELECT slug, (wholesale_credits * 2)::text AS price FROM products ORDER BY wholesale_credits`).toEqual([
        { slug: 'mini-key', price: '1.00000000' }, { slug: 'basic-key', price: '5.00000000' },
        { slug: 'starter-key', price: '6.00000000' }, { slug: 'developer-key', price: '20.00000000' },
      ]);
    } finally { await db.end(); await sql.unsafe(`DROP DATABASE ${name}`); }
  });
});
