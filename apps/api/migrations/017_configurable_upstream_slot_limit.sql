CREATE FUNCTION upstream_key_slot_limit(pool_capacity integer) RETURNS integer
LANGUAGE sql STABLE
RETURN NULLIF(COALESCE(NULLIF(current_setting('proxykey.upstream_key_slot_limit', true), '')::integer, pool_capacity), 0);

CREATE OR REPLACE VIEW sellable_upstream_slots AS
SELECT uc.id, uc.pool_id, limits.slot_limit AS credential_capacity, slots.assigned, slots.reserved, uc.test_only,
  CASE WHEN limits.slot_limit IS NOT NULL THEN GREATEST(0, limits.slot_limit - slots.assigned - slots.reserved) END AS free_slots
FROM upstream_credentials uc JOIN upstream_pools up ON up.id = uc.pool_id
CROSS JOIN LATERAL (SELECT upstream_key_slot_limit(up.credential_capacity) AS slot_limit) limits
CROSS JOIN LATERAL (
  SELECT (count(*) FILTER (WHERE claim.assigned))::int AS assigned,
    (count(*) FILTER (WHERE NOT claim.assigned))::int AS reserved
  FROM upstream_slot_claims claim WHERE claim.upstream_credential_id = uc.id
) slots
WHERE up.active AND uc.status = 'ACTIVE' AND uc.catalog_valid_until > now() AND uc.key_fingerprint IS NOT NULL
  AND (NOT uc.test_only OR current_setting('proxykey.allow_test_upstreams', true) = 'on')
  AND (uc.spend_limit IS NULL OR uc.spend_used < uc.spend_limit)
  AND EXISTS (SELECT 1 FROM model_rates mr WHERE mr.pool_id = uc.pool_id AND mr.active AND mr.model = ANY(uc.available_models)
    AND GREATEST(mr.input_per_million, mr.output_per_million, mr.cached_input_per_million, mr.per_request, mr.per_second) > 0);

CREATE OR REPLACE VIEW usable_key_models AS
SELECT DISTINCT ak.id AS api_key_id, r.model, r.protocol
FROM api_keys ak JOIN orders o ON o.id = ak.order_id
JOIN routable_pool_models r ON r.root_pool_id = o.pool_id
JOIN sellable_upstream_slots s ON s.pool_id = r.pool_id
JOIN upstream_credentials uc ON uc.id = s.id AND r.model = ANY(uc.available_models)
LEFT JOIN api_key_channel_assignments a ON a.api_key_id = ak.id AND a.pool_id = r.pool_id
WHERE ak.status = 'ACTIVE' AND ak.credits_used < ak.credits_total
  AND (ak.expires_at IS NULL OR ak.expires_at > now())
  AND (NOT s.test_only OR o.payment_provider = 'mock')
  AND (s.id = ak.upstream_credential_id OR s.id = a.upstream_credential_id OR s.free_slots IS NULL OR s.free_slots > 0);
