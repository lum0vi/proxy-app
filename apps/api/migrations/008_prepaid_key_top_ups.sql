ALTER TABLE orders ADD COLUMN top_up_key_id uuid REFERENCES api_keys(id) ON DELETE RESTRICT;
CREATE INDEX orders_top_up_key_idx ON orders(top_up_key_id) WHERE top_up_key_id IS NOT NULL;

-- A key and its pending top-ups share one slot on the same credential.
CREATE VIEW upstream_slot_claims AS
SELECT upstream_credential_id, api_key_id, order_id, bool_or(assigned) AS assigned
FROM (
  SELECT ak.upstream_credential_id, ak.id AS api_key_id, NULL::uuid AS order_id, true AS assigned
  FROM api_keys ak
  WHERE ak.status IN ('ACTIVE', 'PAUSED') AND (ak.expires_at IS NULL OR ak.expires_at > now())
  UNION ALL
  SELECT a.upstream_credential_id, ak.id, NULL::uuid, true
  FROM api_key_channel_assignments a JOIN api_keys ak ON ak.id = a.api_key_id
  WHERE ak.status IN ('ACTIVE', 'PAUSED') AND (ak.expires_at IS NULL OR ak.expires_at > now())
  UNION ALL
  SELECT o.upstream_credential_id, o.top_up_key_id, CASE WHEN o.top_up_key_id IS NULL THEN o.id END, false
  FROM orders o
  WHERE o.upstream_credential_id IS NOT NULL
    AND (o.status = 'PAID' OR (o.status = 'PENDING' AND o.reserved_until > now()))
) claims
GROUP BY upstream_credential_id, api_key_id, order_id;

CREATE OR REPLACE VIEW sellable_upstream_slots AS
SELECT uc.id, uc.pool_id, up.credential_capacity, slots.assigned, slots.reserved, uc.test_only
FROM upstream_credentials uc JOIN upstream_pools up ON up.id = uc.pool_id
CROSS JOIN LATERAL (
  SELECT (count(*) FILTER (WHERE claim.assigned))::int AS assigned,
    (count(*) FILTER (WHERE NOT claim.assigned))::int AS reserved
  FROM upstream_slot_claims claim WHERE claim.upstream_credential_id = uc.id
) slots
WHERE up.active AND uc.status = 'ACTIVE' AND uc.catalog_valid_until > now() AND uc.key_fingerprint IS NOT NULL
  AND (NOT uc.test_only OR current_setting('proxykey.allow_test_upstreams', true) = 'on')
  AND (uc.spend_limit IS NULL OR uc.spend_used < uc.spend_limit)
  AND EXISTS (SELECT 1 FROM model_rates mr WHERE mr.pool_id = uc.pool_id AND mr.active AND mr.model = ANY(uc.available_models)
    AND GREATEST(mr.input_per_million, mr.output_per_million, mr.cached_input_per_million, mr.per_request) > 0);

-- Apply the new terms to the standard packages and their still-valid keys.
UPDATE products SET duration_days = NULL, updated_at = now()
WHERE slug IN ('starter-key', 'developer-key', 'extended-key') AND duration_days = 30;

WITH converted_keys AS (
  UPDATE api_keys ak SET expires_at = NULL, updated_at = now()
  FROM orders o JOIN products p ON p.id = o.product_id
  WHERE ak.order_id = o.id AND p.slug IN ('starter-key', 'developer-key', 'extended-key')
    AND o.grant_duration_days = 30 AND ak.expires_at > now()
    AND ak.status IN ('ACTIVE', 'PAUSED', 'EXHAUSTED')
  RETURNING ak.id
)
DELETE FROM notifications
WHERE api_key_id IN (SELECT id FROM converted_keys) AND kind = 'KEY_EXPIRY' AND status = 'PENDING';

UPDATE orders o SET grant_duration_days = NULL, updated_at = now()
FROM products p
WHERE o.product_id = p.id AND p.slug IN ('starter-key', 'developer-key', 'extended-key')
  AND o.grant_duration_days = 30 AND o.status IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED');
