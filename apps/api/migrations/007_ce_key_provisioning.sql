CREATE TABLE ce_management_session (
  bootstrap_hash text PRIMARY KEY,
  encrypted_access_token text NOT NULL,
  encrypted_refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE ce_key_provisioning_jobs (
  pool_id uuid PRIMARY KEY REFERENCES upstream_pools(id) ON DELETE RESTRICT,
  id uuid NOT NULL UNIQUE,
  account_id bigint NOT NULL CHECK (account_id > 0),
  group_id bigint NOT NULL CHECK (group_id > 0),
  name text NOT NULL UNIQUE,
  quota numeric(20,8) NOT NULL CHECK (quota > 0),
  encrypted_key text NOT NULL,
  credential_id uuid REFERENCES upstream_credentials(id) ON DELETE RESTRICT,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
