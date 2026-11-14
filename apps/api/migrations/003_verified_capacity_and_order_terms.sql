ALTER TABLE upstream_credentials
  ADD COLUMN available_models text[] NOT NULL DEFAULT '{}',
  ADD COLUMN catalog_valid_until timestamptz,
  ALTER COLUMN status SET DEFAULT 'DEGRADED';

ALTER TABLE request_leases ADD COLUMN reserved_cost numeric(20,8) NOT NULL DEFAULT 0 CHECK (reserved_cost >= 0);

ALTER TABLE orders
  ADD COLUMN pool_id uuid REFERENCES upstream_pools(id) ON DELETE RESTRICT,
  ADD COLUMN grant_label text,
  ADD COLUMN grant_duration_days integer CHECK (grant_duration_days IS NULL OR grant_duration_days > 0),
  ADD COLUMN grant_concurrency_limit integer CHECK (grant_concurrency_limit > 0);

UPDATE orders o SET
  pool_id = COALESCE((SELECT uc.pool_id FROM upstream_credentials uc WHERE uc.id = o.upstream_credential_id), p.pool_id),
  grant_label = p.name,
  grant_duration_days = p.duration_days,
  grant_concurrency_limit = p.concurrency_limit
FROM products p WHERE p.id = o.product_id;

ALTER TABLE orders
  ALTER COLUMN pool_id SET NOT NULL,
  ALTER COLUMN grant_label SET NOT NULL,
  ALTER COLUMN grant_concurrency_limit SET NOT NULL;

CREATE INDEX orders_waiting_for_fulfillment_idx ON orders(paid_at, id) WHERE status = 'PAID';

CREATE VIEW sellable_upstream_slots AS
SELECT uc.id, uc.pool_id, up.credential_capacity,
  (SELECT count(*)::int FROM api_keys ak
    WHERE ak.upstream_credential_id = uc.id AND ak.status IN ('ACTIVE', 'PAUSED')
      AND (ak.expires_at IS NULL OR ak.expires_at > now())) AS assigned,
  (SELECT count(*)::int FROM orders o
    WHERE o.upstream_credential_id = uc.id
      AND (o.status = 'PAID' OR (o.status = 'PENDING' AND o.reserved_until > now()))) AS reserved
FROM upstream_credentials uc JOIN upstream_pools up ON up.id = uc.pool_id
WHERE up.active AND uc.status = 'ACTIVE' AND uc.catalog_valid_until > now()
  AND (uc.spend_limit IS NULL OR uc.spend_used < uc.spend_limit)
  AND EXISTS (SELECT 1 FROM model_rates mr
    WHERE mr.pool_id = uc.pool_id AND mr.active AND mr.model = ANY(uc.available_models));
