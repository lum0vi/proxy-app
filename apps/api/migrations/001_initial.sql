CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text,
  role text NOT NULL DEFAULT 'USER' CHECK (role IN ('ADMIN', 'USER')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  wallet_network text,
  wallet_address text,
  locale text NOT NULL DEFAULT 'ru' CHECK (locale IN ('ru', 'en')),
  theme text NOT NULL DEFAULT 'SYSTEM' CHECK (theme IN ('SYSTEM', 'LIGHT', 'DARK')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS upstream_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  base_url text NOT NULL,
  protocol text NOT NULL DEFAULT 'OPENAI' CHECK (protocol IN ('OPENAI')),
  credential_capacity integer NOT NULL DEFAULT 2 CHECK (credential_capacity > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS upstream_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES upstream_pools(id) ON DELETE CASCADE,
  label text NOT NULL,
  encrypted_key text NOT NULL,
  key_hint text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEGRADED', 'DISABLED', 'EXHAUSTED')),
  priority integer NOT NULL DEFAULT 100,
  max_concurrency integer NOT NULL DEFAULT 8 CHECK (max_concurrency > 0),
  spend_limit numeric(20,8),
  spend_used numeric(20,8) NOT NULL DEFAULT 0 CHECK (spend_used >= 0),
  last_health_at timestamptz,
  last_used_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS upstream_credentials_pool_status_idx ON upstream_credentials(pool_id, status);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES upstream_pools(id) ON DELETE RESTRICT,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  wholesale_credits numeric(20,8) NOT NULL CHECK (wholesale_credits > 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  duration_days integer CHECK (duration_days IS NULL OR duration_days > 0),
  concurrency_limit integer NOT NULL DEFAULT 2 CHECK (concurrency_limit > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_active_idx ON products(active);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  upstream_credential_id uuid REFERENCES upstream_credentials(id) ON DELETE SET NULL,
  payment_provider text NOT NULL CHECK (payment_provider IN ('stripe', 'nowpayments', 'mock')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'FULFILLED', 'FAILED', 'EXPIRED', 'REFUNDED')),
  currency char(3) NOT NULL,
  amount numeric(20,8) NOT NULL CHECK (amount > 0),
  price_markup numeric(20,8) NOT NULL CHECK (price_markup > 0),
  wholesale_credits numeric(20,8) NOT NULL CHECK (wholesale_credits > 0),
  external_id text,
  checkout_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  reserved_until timestamptz NOT NULL,
  paid_at timestamptz,
  fulfilled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payment_provider, external_id)
);
CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_reserved_idx ON orders(status, reserved_until);
CREATE INDEX IF NOT EXISTS orders_upstream_status_idx ON orders(upstream_credential_id, status);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  upstream_credential_id uuid NOT NULL REFERENCES upstream_credentials(id) ON DELETE RESTRICT,
  key_hash text NOT NULL UNIQUE,
  encrypted_key text NOT NULL,
  key_hint text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'EXHAUSTED', 'EXPIRED', 'REVOKED')),
  credits_total numeric(20,8) NOT NULL CHECK (credits_total > 0),
  credits_used numeric(20,8) NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  concurrency_limit integer NOT NULL DEFAULT 2 CHECK (concurrency_limit > 0),
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_user_created_idx ON api_keys(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_keys_upstream_status_idx ON api_keys(upstream_credential_id, status);
CREATE INDEX IF NOT EXISTS api_keys_status_expires_idx ON api_keys(status, expires_at);

CREATE TABLE IF NOT EXISTS model_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES upstream_pools(id) ON DELETE CASCADE,
  model text NOT NULL,
  input_per_million numeric(20,8) NOT NULL DEFAULT 0,
  output_per_million numeric(20,8) NOT NULL DEFAULT 0,
  cached_input_per_million numeric(20,8) NOT NULL DEFAULT 0,
  per_request numeric(20,8) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(pool_id, model)
);

CREATE TABLE IF NOT EXISTS request_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  upstream_credential_id uuid NOT NULL REFERENCES upstream_credentials(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS request_leases_api_key_idx ON request_leases(api_key_id, expires_at);
CREATE INDEX IF NOT EXISTS request_leases_upstream_idx ON request_leases(upstream_credential_id, expires_at);

CREATE TABLE IF NOT EXISTS session_affinities (
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  session_hash text NOT NULL,
  upstream_credential_id uuid NOT NULL REFERENCES upstream_credentials(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(api_key_id, session_hash)
);
CREATE INDEX IF NOT EXISTS session_affinities_expires_idx ON session_affinities(expires_at);

CREATE TABLE IF NOT EXISTS usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  upstream_credential_id uuid NOT NULL REFERENCES upstream_credentials(id) ON DELETE RESTRICT,
  request_id text NOT NULL UNIQUE,
  endpoint text NOT NULL,
  model text,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,
  image_count integer NOT NULL DEFAULT 0,
  cost numeric(20,8) NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  http_status integer,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS usage_records_key_started_idx ON usage_records(api_key_id, started_at DESC);
CREATE INDEX IF NOT EXISTS usage_records_created_idx ON usage_records(started_at DESC);

CREATE TABLE IF NOT EXISTS payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL,
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  payload jsonb NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE(provider, event_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id uuid REFERENCES api_keys(id) ON DELETE CASCADE,
  kind text NOT NULL,
  channel text NOT NULL DEFAULT 'EMAIL',
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);
