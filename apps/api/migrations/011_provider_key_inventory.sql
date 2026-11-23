CREATE TABLE provider_key_sync (
  provider text PRIMARY KEY,
  account_id bigint,
  checked_at timestamptz,
  attempted_at timestamptz,
  last_error text,
  refresh_requested_at timestamptz
);

-- An inventory snapshot, never a second store of API secrets.
CREATE TABLE provider_key_inventory (
  provider text NOT NULL REFERENCES provider_key_sync(provider) ON DELETE CASCADE,
  account_id bigint NOT NULL,
  external_id bigint NOT NULL,
  group_id bigint,
  group_name text,
  name text NOT NULL,
  key_hint text NOT NULL,
  key_fingerprint text NOT NULL,
  status text NOT NULL,
  quota_usd numeric(20,8) CHECK (quota_usd IS NULL OR quota_usd > 0),
  quota_used_usd numeric(20,8) NOT NULL CHECK (quota_used_usd >= 0),
  expires_at timestamptz,
  last_used_at timestamptz,
  present boolean NOT NULL DEFAULT true,
  checked_at timestamptz NOT NULL,
  PRIMARY KEY (provider, account_id, external_id)
);
CREATE INDEX provider_key_inventory_fingerprint_idx ON provider_key_inventory(key_fingerprint) WHERE present;

CREATE VIEW customer_key_upstreams AS
SELECT id AS api_key_id, upstream_credential_id FROM api_keys
UNION
SELECT api_key_id, upstream_credential_id FROM api_key_channel_assignments;
