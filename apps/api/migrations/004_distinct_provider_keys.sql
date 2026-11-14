ALTER TABLE upstream_credentials ADD COLUMN key_fingerprint text;
CREATE UNIQUE INDEX upstream_credentials_key_fingerprint_idx ON upstream_credentials (key_fingerprint)
  WHERE key_fingerprint IS NOT NULL;

-- Older records receive a fingerprint during their next successful catalog check.
-- Exclude unchecked records from the sale inventory in the meantime.
CREATE OR REPLACE VIEW sellable_upstream_slots AS
SELECT uc.id, uc.pool_id, up.credential_capacity,
  (SELECT count(*)::int FROM api_keys ak
    WHERE ak.upstream_credential_id = uc.id AND ak.status IN ('ACTIVE', 'PAUSED')
      AND (ak.expires_at IS NULL OR ak.expires_at > now())) AS assigned,
  (SELECT count(*)::int FROM orders o
    WHERE o.upstream_credential_id = uc.id
      AND (o.status = 'PAID' OR (o.status = 'PENDING' AND o.reserved_until > now()))) AS reserved
FROM upstream_credentials uc JOIN upstream_pools up ON up.id = uc.pool_id
WHERE up.active AND uc.status = 'ACTIVE' AND uc.catalog_valid_until > now() AND uc.key_fingerprint IS NOT NULL
  AND (uc.spend_limit IS NULL OR uc.spend_used < uc.spend_limit)
  AND EXISTS (SELECT 1 FROM model_rates mr
    WHERE mr.pool_id = uc.pool_id AND mr.active AND mr.model = ANY(uc.available_models));
