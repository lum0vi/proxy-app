import { Decimal } from 'decimal.js';
import { config } from '../config.js';
import type { Protocol } from '../proxy/protocols.js';
import { sql } from './index.js';

type TokenRate = readonly [model: string, cached: string, input: string, output: string, longContextThreshold?: number];

const gpt = [
  ['gpt-6-astra', '1', '10', '50', 272000],
  ['gpt-6.1-terra', '0.05', '1', '5', 272000],
  ['gpt-6.1-sol', '0.10', '2', '10', 272000],
  ['gpt-6-sol', '0.20', '2', '10', 272000],
  ['gpt-6-luna', '0.01', '0.10', '0.50', 272000],
  ['gpt-5.6-sol', '0.50', '5', '30', 272000],
  ['gpt-5.6-terra', '0.20', '2', '12', 272000],
  ['gpt-5.6-luna', '0.02', '0.20', '1.20', 272000],
] satisfies TokenRate[];

const claude = [
  ['claude-fable-5-2', '0.20', '8', '40'],
  ['claude-fable-5-1', '0.25', '10', '50'],
  ['claude-opus-5-5', '0.20', '4', '20'],
  ['claude-opus-5', '0.50', '5', '25'],
  ['claude-opus-4-8', '0.50', '5', '25'],
  ['claude-opus-4-7', '0.50', '5', '25'],
  ['claude-opus-4-6', '0.50', '5', '25'],
  ['claude-sonnet-5-5', '0.10', '2', '10'],
  ['claude-sonnet-5', '0.20', '2', '10'],
  ['claude-sonnet-4-6', '0.30', '3', '15'],
  ['claude-haiku-5-5', '0.01', '0.10', '0.50'],
  ['claude-haiku-4-5', '0.10', '1', '5'],
] satisfies TokenRate[];

const grok = [
  ['grok-4.7', '0.50', '2', '6', 200000],
  ['grok-4.6', '0.50', '2', '6', 200000],
  ['grok-4.5', '0.30', '2', '6', 200000],
] satisfies TokenRate[];

const gemini = [
  ['gemini-3.1-pro', '0.20', '2', '12', 200000],
  ['gemini-3.8-flash', '0.075', '0.75', '3.75'],
  ['gemini-3.7-flash', '0.075', '0.75', '3.75'],
  ['gemini-3.6-flash', '0.075', '0.75', '3.75'],
  ['gemini-3-flash-preview', '0.05', '0.50', '3'],
] satisfies TokenRate[];

const deepSeek = [
  ['deepseek-flash', '0.003', '0.15', '0.60'],
  ['deepseek-v4-flash-vision-exp', '0.003', '0.15', '0.60'],
  ['deepseek-v4-pro', '0.022', '0.66', '1.98'],
] satisfies TokenRate[];

export async function seedCeCatalog(rootId: string, baseUrl: string) {
  async function channel(slug: string, name: string, protocol: Protocol, priority = 0) {
    await sql`
      INSERT INTO upstream_pools (name, slug, base_url, protocol, credential_capacity, parent_pool_id, routing_priority)
      VALUES (${name}, ${slug}, ${baseUrl}, ${protocol}, ${config.USERS_PER_UPSTREAM_KEY}, ${rootId}, ${priority})
      ON CONFLICT (slug) DO UPDATE SET credential_capacity = EXCLUDED.credential_capacity
      WHERE upstream_pools.parent_pool_id = EXCLUDED.parent_pool_id AND upstream_pools.protocol = EXCLUDED.protocol
    `;
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM upstream_pools WHERE slug = ${slug} AND parent_pool_id = ${rootId} AND protocol = ${protocol}
    `;
    return row?.id;
  }

  async function tokens(poolId: string | undefined, models: TokenRate[], multiplier: string, peak = 1, flashPromo = false) {
    if (!poolId) return;
    const rate = (price: string) => new Decimal(price).mul(multiplier).toFixed(8);
    const rows = models.map(([model, cached, input, output, threshold]) => ({
      pool_id: poolId, model, cached_input_per_million: rate(cached), input_per_million: rate(input), output_per_million: rate(output),
      long_context_threshold: threshold ?? null, long_context_multiplier: threshold ? 2 : 1, peak_multiplier: peak,
      rate_multiplier_from: flashPromo ? '2027-01-01T00:00:00Z' : null, rate_multiplier_after: flashPromo ? 2 : 1,
    }));
    await sql`INSERT INTO model_rates ${sql(rows)} ON CONFLICT (pool_id, model) DO NOTHING`;
  }

  // Identifiers and group-specific rates from https://docs.codex-everywhere.com/models/.
  await sql`UPDATE upstream_pools SET routing_priority = 10 WHERE id = ${rootId} AND routing_priority = 0`;
  await tokens(rootId, gpt, '0.03');
  await tokens(await channel('ce-codex-pro', 'CE · Codex Pro PayGo', 'OPENAI', 20), gpt, '0.05');
  // Listed by CE, without a separate published price. Disabled for inference until priced.
  await sql`INSERT INTO model_rates (pool_id, model, input_per_million, output_per_million, active, listed_without_rate)
    VALUES (${rootId}, 'codex-auto-review', 0, 0, false, true) ON CONFLICT (pool_id, model) DO NOTHING`;
  const maxPool = await channel('ce-claude-max', 'CE · Claude Max PayGo', 'ANTHROPIC', 20);
  await tokens(maxPool, claude, '0.24');
  const kiroModels = claude.filter(([model]) => !model.startsWith('claude-fable-') && model !== 'claude-haiku-5-5');
  await tokens(await channel('ce-claude-kiro', 'CE · Claude Kiro PayGo', 'ANTHROPIC', 10), kiroModels, '0.08');
  await tokens(await channel('ce-grok-heavy', 'CE · Grok Heavy PayGo', 'OPENAI'), grok, '0.06');
  const geminiPool = await channel('ce-gemini', 'CE · Gemini Antigravity', 'GEMINI');
  const flash = new Set(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']);
  await tokens(geminiPool, gemini.filter(([model]) => !flash.has(model)), '0.08');
  await tokens(geminiPool, gemini.filter(([model]) => flash.has(model)), '0.08', 1, true);
  await tokens(await channel('ce-deepseek', 'CE · DeepSeek Official', 'OPENAI_CHAT'), deepSeek, '0.90', 2);

  const imagePool = await channel('ce-images', 'CE · GPT Image PayGo', 'IMAGES');
  if (imagePool) {
    const rows = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'].map((model) => ({
      pool_id: imagePool, model, per_request: '0.015',
    }));
    await sql`INSERT INTO model_rates ${sql(rows)} ON CONFLICT (pool_id, model) DO NOTHING`;
    // Older local catalogs used the text channel for these three default image rates.
    await sql`
      UPDATE model_rates SET active = false
      WHERE pool_id = ${rootId} AND model IN ('gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst')
        AND per_request = 0.015 AND input_per_million = 0 AND output_per_million = 0 AND cached_input_per_million = 0 AND active
    `;
  }
}
