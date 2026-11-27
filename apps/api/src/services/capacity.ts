import type postgres from 'postgres';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';

export interface ReservedCredential {
  id: string;
  poolId: string;
}

interface CapacityOptions {
  orderId?: string;
  apiKeyId?: string;
  preferredCredentialId?: string | null;
  minimumBudget?: string;
  model?: string | null;
  linkedPools?: boolean;
  allowTest?: boolean;
}

export async function selectCredentialWithCapacity(
  transaction: postgres.TransactionSql,
  poolId: string,
  options: CapacityOptions = {},
): Promise<ReservedCredential> {
  const preferred = options.preferredCredentialId ?? null;
  const model = options.model ?? null;
  const slotAvailable = transaction`
    slots.credential_capacity IS NULL OR slots.assigned + slots.reserved - CASE WHEN EXISTS (
      SELECT 1 FROM upstream_slot_claims claim
      WHERE claim.upstream_credential_id = slots.id
        AND (claim.order_id = ${options.orderId ?? null}::uuid OR claim.api_key_id = ${options.apiKeyId ?? null}::uuid)
    ) THEN 1 ELSE 0 END < slots.credential_capacity
  `;
  const eligible = transaction`
    (${options.linkedPools === true} OR c.pool_id = c.root_pool_id)
    AND (${options.allowTest === true} OR NOT slots.test_only)
    AND (${model}::text IS NULL OR ${model} = ANY(uc.available_models))
    AND (uc.spend_limit IS NULL OR uc.spend_limit - uc.spend_used - COALESCE((
      SELECT sum(lease.reserved_cost) FROM request_leases lease
      WHERE lease.upstream_credential_id = uc.id AND lease.expires_at > now()
    ), 0) >= ${options.minimumBudget ?? '0'}::numeric)
    AND (${slotAvailable})
  `;
  const lockCredential = config.UPSTREAM_KEY_SLOT_LIMIT === 0
    ? transaction`FOR UPDATE OF uc`
    : transaction`FOR UPDATE OF uc SKIP LOCKED`;
  const rows = await transaction<ReservedCredential[]>`
    SELECT uc.id, uc.pool_id
    FROM upstream_credentials AS uc
    JOIN sellable_upstream_slots AS slots ON slots.id = uc.id
    JOIN pool_channels c ON c.pool_id = uc.pool_id AND c.root_pool_id = ${poolId}
    WHERE ${eligible}
    ORDER BY
      (uc.id IS NOT DISTINCT FROM ${preferred}::uuid) DESC,
      c.routing_priority DESC,
      uc.priority DESC,
      uc.last_used_at ASC NULLS FIRST,
      uc.created_at ASC,
      uc.id ASC
    ${lockCredential}
    LIMIT 1
  `;
  const credential = rows[0];
  if (credential) {
    // The candidate SELECT can start before a concurrent holder commits. Check capacity
    // again with a fresh statement snapshot after acquiring the credential row lock.
    const [confirmed] = await transaction<ReservedCredential[]>`
      SELECT slots.id, slots.pool_id FROM sellable_upstream_slots slots
      JOIN upstream_credentials uc ON uc.id = slots.id
      JOIN pool_channels c ON c.pool_id = uc.pool_id AND c.root_pool_id = ${poolId}
      WHERE slots.id = ${credential.id} AND ${eligible}
    `;
    if (confirmed) return confirmed;
  }
  throw new AppError(409, 'NO_UPSTREAM_CAPACITY', 'No verified upstream key currently has free capacity');
}
