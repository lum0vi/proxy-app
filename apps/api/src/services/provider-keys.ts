import { Decimal } from 'decimal.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { keyHint, upstreamKeyFingerprint } from '../lib/crypto.js';
import type { CeInventoryKey } from './ce-management.js';

export const ceKeyProvider = 'codex-everywhere';

export async function beginProviderKeySync(): Promise<Date> {
  const [row] = await sql<{ attemptedAt: Date }[]>`
    INSERT INTO provider_key_sync(provider, attempted_at) VALUES (${ceKeyProvider}, now())
    ON CONFLICT (provider) DO UPDATE SET attempted_at = now() RETURNING attempted_at
  `;
  return row!.attemptedAt;
}

export async function recordProviderKeys(accountId: number, keys: CeInventoryKey[], startedAt: Date): Promise<void> {
  const records = keys.map(key => ({
    provider: ceKeyProvider, account_id: accountId, external_id: key.id, group_id: key.group_id ?? null,
    group_name: key.group?.name ?? null, name: key.name, key_hint: keyHint(key.key),
    key_fingerprint: upstreamKeyFingerprint(key.key), status: key.status,
    quota_usd: key.quota > 0 ? new Decimal(key.quota).toFixed(8) : null,
    quota_used_usd: new Decimal(key.quota_used).toFixed(8),
    expires_at: key.expires_at ? new Date(key.expires_at) : null,
    last_used_at: key.last_used_at ? new Date(key.last_used_at) : null,
    present: true, checked_at: startedAt,
  }));
  await sql.begin(async tx => {
    // Only a complete, validated list can replace the previous snapshot.
    await tx`UPDATE provider_key_inventory SET present = false WHERE provider = ${ceKeyProvider}`;
    for (let index = 0; index < records.length; index += 500) {
      await tx`INSERT INTO provider_key_inventory ${tx(records.slice(index, index + 500))}
        ON CONFLICT (provider, account_id, external_id) DO UPDATE SET
          group_id = EXCLUDED.group_id, group_name = EXCLUDED.group_name, name = EXCLUDED.name,
          key_hint = EXCLUDED.key_hint, key_fingerprint = EXCLUDED.key_fingerprint, status = EXCLUDED.status,
          quota_usd = EXCLUDED.quota_usd, quota_used_usd = EXCLUDED.quota_used_usd,
          expires_at = EXCLUDED.expires_at, last_used_at = EXCLUDED.last_used_at,
          present = true, checked_at = EXCLUDED.checked_at`;
    }
    await tx`UPDATE provider_key_sync SET account_id = ${accountId}, checked_at = ${startedAt}, last_error = NULL,
      refresh_requested_at = CASE WHEN refresh_requested_at <= ${startedAt} THEN NULL ELSE refresh_requested_at END
      WHERE provider = ${ceKeyProvider}`;
  });
}

export async function recordProviderKeyFailure(code: string, startedAt = new Date()): Promise<void> {
  await sql`INSERT INTO provider_key_sync(provider, attempted_at, last_error) VALUES (${ceKeyProvider}, ${startedAt}, ${code})
    ON CONFLICT (provider) DO UPDATE SET attempted_at = EXCLUDED.attempted_at, last_error = EXCLUDED.last_error,
      refresh_requested_at = CASE WHEN provider_key_sync.refresh_requested_at <= ${startedAt} THEN NULL ELSE provider_key_sync.refresh_requested_at END`;
}

export async function requestProviderKeyRefresh() {
  await sql`INSERT INTO provider_key_sync(provider, refresh_requested_at) VALUES (${ceKeyProvider}, now())
    ON CONFLICT (provider) DO UPDATE SET refresh_requested_at = COALESCE(provider_key_sync.refresh_requested_at, now())`;
}

export async function providerKeyRefreshRequested(): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM provider_key_sync WHERE provider = ${ceKeyProvider} AND refresh_requested_at IS NOT NULL`;
  return rows.length > 0;
}

export async function listProviderKeys(options: { activeOnly: boolean; page: number; pageSize: number }) {
  const [state] = await sql<{ accountId: string | null; checkedAt: Date | null; attemptedAt: Date | null;
    lastError: string | null; refreshRequestedAt: Date | null }[]>`
    SELECT account_id::text, checked_at, attempted_at, last_error, refresh_requested_at FROM provider_key_sync WHERE provider = ${ceKeyProvider}`;
  const active = sql`k.present AND k.status = 'active' AND (k.expires_at IS NULL OR k.expires_at > now())
    AND (k.quota_usd IS NULL OR k.quota_used_usd < k.quota_usd)`;
  const filter = sql`k.provider = ${ceKeyProvider} AND (${!options.activeOnly} OR (${active}))`;
  const [count] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM provider_key_inventory k WHERE ${filter}`;
  const keys = await sql<Record<string, unknown>[]>`
    SELECT k.external_id::text, k.account_id::text, k.group_id::text, k.group_name, k.name, k.key_hint,
      k.status, k.present, (${active}) AS active, k.quota_usd::text, k.quota_used_usd::text,
      CASE WHEN k.quota_usd IS NOT NULL THEN GREATEST(0, k.quota_usd - k.quota_used_usd)::text END AS remaining_usd,
      k.expires_at, k.last_used_at, k.checked_at, uc.id AS credential_id, uc.label AS credential_label,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('keyId', ak.id, 'keyHint', ak.key_hint, 'label', ak.label,
          'userId', u.id, 'email', u.email, 'remainingUsdt', GREATEST(0, ak.credits_total - ak.credits_used)::text)
          ORDER BY u.email, ak.id)
        FROM customer_key_upstreams link JOIN api_keys ak ON ak.id = link.api_key_id JOIN users u ON u.id = ak.user_id
        WHERE link.upstream_credential_id = uc.id AND ak.status = 'ACTIVE' AND ak.credits_used < ak.credits_total
          AND (ak.expires_at IS NULL OR ak.expires_at > now())), '[]'::jsonb) AS customer_keys
    FROM provider_key_inventory k
    LEFT JOIN upstream_credentials uc ON uc.key_fingerprint = k.key_fingerprint
      AND EXISTS (SELECT 1 FROM upstream_pools p WHERE p.id = uc.pool_id AND p.base_url = 'https://codex-everywhere.com')
    WHERE ${filter} ORDER BY k.present DESC, k.account_id, k.external_id
    LIMIT ${options.pageSize} OFFSET ${(options.page - 1) * options.pageSize}
  `;
  return { keys, total: count?.total ?? 0, page: options.page, pageSize: options.pageSize,
    sync: { enabled: config.ceKeySyncEnabled, intervalMs: config.CE_KEY_SYNC_INTERVAL_MS,
      accountId: state?.accountId ?? null, checkedAt: state?.checkedAt ?? null, attemptedAt: state?.attemptedAt ?? null,
      lastError: state?.lastError ?? null, requested: Boolean(state?.refreshRequestedAt),
      stale: !state?.checkedAt || Boolean(state.lastError) || Date.now() - state.checkedAt.getTime() > config.CE_KEY_SYNC_INTERVAL_MS * 2 },
  };
}

export async function listUserKeys(userId: string, options: { activeOnly: boolean; page: number; pageSize: number }) {
  const [user] = await sql<{ id: string; email: string; name: string | null }[]>`SELECT id, email::text, name FROM users WHERE id = ${userId}`;
  if (!user) return null;
  const active = sql`ak.status = 'ACTIVE' AND ak.credits_used < ak.credits_total AND (ak.expires_at IS NULL OR ak.expires_at > now())`;
  const filter = sql`ak.user_id = ${userId} AND (${!options.activeOnly} OR (${active}))`;
  const [count] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM api_keys ak WHERE ${filter}`;
  const keys = await sql<Record<string, unknown>[]>`
    SELECT ak.id, ak.label, ak.key_hint, ak.status, (${active}) AS active, ak.credits_total::text, ak.credits_used::text,
      GREATEST(0, ak.credits_total - ak.credits_used)::text AS remaining_usdt, ak.currency, ak.expires_at, ak.last_used_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', uc.id, 'label', uc.label, 'keyHint', uc.key_hint, 'status', uc.status, 'providerName', p.name,
        'localRemainingUsd', CASE WHEN uc.spend_limit IS NOT NULL THEN GREATEST(0, uc.spend_limit - uc.spend_used)::text END,
        'externalId', remote.external_id::text, 'remoteStatus', remote.status, 'remotePresent', remote.present,
        'remoteQuotaUsd', remote.quota_usd::text, 'remoteUsedUsd', remote.quota_used_usd::text,
        'remoteRemainingUsd', CASE WHEN remote.quota_usd IS NOT NULL THEN GREATEST(0, remote.quota_usd - remote.quota_used_usd)::text END,
        'remoteExpiresAt', remote.expires_at, 'remoteCheckedAt', remote.checked_at,
        'remoteStale', remote.checked_at IS NULL OR sync.last_error IS NOT NULL OR remote.checked_at < now() - ${config.CE_KEY_SYNC_INTERVAL_MS * 2} * interval '1 millisecond',
        'sharedKeyCount', (SELECT count(*)::int FROM customer_key_upstreams shared JOIN api_keys owner ON owner.id = shared.api_key_id
          WHERE shared.upstream_credential_id = uc.id AND owner.status = 'ACTIVE' AND owner.credits_used < owner.credits_total
            AND (owner.expires_at IS NULL OR owner.expires_at > now()))
        ) ORDER BY p.name, uc.id)
      FROM customer_key_upstreams link JOIN upstream_credentials uc ON uc.id = link.upstream_credential_id
      JOIN upstream_pools p ON p.id = uc.pool_id
      LEFT JOIN LATERAL (SELECT k.* FROM provider_key_inventory k
        WHERE k.key_fingerprint = uc.key_fingerprint AND k.provider = ${ceKeyProvider}
          AND p.base_url = 'https://codex-everywhere.com'
        ORDER BY k.present DESC, k.checked_at DESC LIMIT 1) remote ON true
      LEFT JOIN provider_key_sync sync ON sync.provider = remote.provider
      WHERE link.api_key_id = ak.id), '[]'::jsonb) AS upstreams
    FROM api_keys ak WHERE ${filter} ORDER BY ak.created_at DESC, ak.id
    LIMIT ${options.pageSize} OFFSET ${(options.page - 1) * options.pageSize}
  `;
  return { user, keys, total: count?.total ?? 0, page: options.page, pageSize: options.pageSize };
}
