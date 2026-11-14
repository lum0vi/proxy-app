import type postgres from 'postgres';
import { AppError } from '../lib/errors.js';

export interface ReservedCredential {
  id: string;
  poolId: string;
}

export async function selectCredentialWithCapacity(
  transaction: postgres.TransactionSql,
  poolId: string,
  options: { paidReservationId?: string | null; model?: string | null; linkedPools?: boolean; allowTest?: boolean } = {},
): Promise<ReservedCredential> {
  const reservedCredential = options.paidReservationId ?? null;
  const model = options.model ?? null;
  const rows = await transaction<ReservedCredential[]>`
    SELECT uc.id, uc.pool_id
    FROM upstream_credentials AS uc
    JOIN sellable_upstream_slots AS slots ON slots.id = uc.id
    JOIN pool_channels c ON c.pool_id = uc.pool_id AND c.root_pool_id = ${poolId}
    WHERE (${options.linkedPools === true} OR c.pool_id = c.root_pool_id)
      AND (${options.allowTest === true} OR NOT slots.test_only)
      AND (${model}::text IS NULL OR ${model} = ANY(uc.available_models))
      AND slots.assigned + slots.reserved - CASE WHEN uc.id = ${reservedCredential}::uuid THEN 1 ELSE 0 END < slots.credential_capacity
    ORDER BY
      (uc.id IS NOT DISTINCT FROM ${reservedCredential}::uuid) DESC,
      c.routing_priority DESC,
      uc.priority DESC,
      uc.last_used_at ASC NULLS FIRST,
      uc.created_at ASC,
      uc.id ASC
    FOR UPDATE OF uc SKIP LOCKED
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
      WHERE slots.id = ${credential.id} AND (${options.linkedPools === true} OR c.pool_id = c.root_pool_id)
        AND (${options.allowTest === true} OR NOT slots.test_only)
        AND (${model}::text IS NULL OR ${model} = ANY(uc.available_models))
        AND slots.assigned + slots.reserved - CASE WHEN slots.id = ${reservedCredential}::uuid THEN 1 ELSE 0 END < slots.credential_capacity
    `;
    if (confirmed) return confirmed;
  }
  throw new AppError(409, 'NO_UPSTREAM_CAPACITY', 'No verified upstream key currently has free capacity');
}
