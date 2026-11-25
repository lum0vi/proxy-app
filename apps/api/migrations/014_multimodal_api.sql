ALTER TABLE upstream_pools DROP CONSTRAINT upstream_pools_protocol_check;
ALTER TABLE upstream_pools ADD CONSTRAINT upstream_pools_protocol_check
  CHECK (protocol IN ('OPENAI', 'OPENAI_CHAT', 'ANTHROPIC', 'GEMINI', 'IMAGES', 'VIDEOS'));
ALTER TABLE model_rates ADD COLUMN per_second numeric(20,8) NOT NULL DEFAULT 0 CHECK (per_second >= 0),
  ADD COLUMN media_options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(media_options) = 'object');
ALTER TABLE usage_records ADD COLUMN video_seconds integer NOT NULL DEFAULT 0 CHECK (video_seconds >= 0);

DROP VIEW usable_key_models, unpriced_pool_models, routable_pool_models, public_pool_models, priced_pool_models;
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
    AND GREATEST(mr.input_per_million, mr.output_per_million, mr.cached_input_per_million, mr.per_request, mr.per_second) > 0);

CREATE VIEW priced_pool_models AS
SELECT c.root_pool_id, c.protocol, c.routing_priority, r.pool_id, r.model,
  r.input_per_million * price.factor AS input_per_million,
  r.output_per_million * price.factor AS output_per_million,
  r.cached_input_per_million * price.factor AS cached_input_per_million,
  r.per_request * price.factor AS per_request,
  r.long_context_threshold, r.long_context_multiplier, r.peak_multiplier,
  r.per_second * price.factor AS per_second, r.media_options
FROM pool_channels c JOIN model_rates r ON r.pool_id = c.pool_id
CROSS JOIN LATERAL (SELECT CASE WHEN r.rate_multiplier_from <= now() THEN r.rate_multiplier_after ELSE 1 END AS factor) price
WHERE r.active AND GREATEST(r.input_per_million, r.output_per_million, r.cached_input_per_million, r.per_request, r.per_second) > 0;

CREATE VIEW public_pool_models AS
SELECT DISTINCT ON (r.root_pool_id, r.model) r.*, live.available
FROM priced_pool_models r
CROSS JOIN LATERAL (SELECT EXISTS (
  SELECT 1 FROM sellable_upstream_slots s JOIN upstream_credentials uc ON uc.id = s.id
  WHERE s.pool_id = r.pool_id AND r.model = ANY(uc.available_models)
) AS available) live
ORDER BY r.root_pool_id, r.model, live.available DESC, r.routing_priority DESC, r.pool_id;

-- A fallback may charge less than the public rate, never more.
CREATE VIEW routable_pool_models AS
SELECT r.* FROM priced_pool_models r
JOIN public_pool_models quote USING (root_pool_id, model)
WHERE r.pool_id = quote.pool_id OR (
  r.protocol = quote.protocol AND r.long_context_threshold IS NOT DISTINCT FROM quote.long_context_threshold
  AND r.long_context_multiplier <= quote.long_context_multiplier AND r.peak_multiplier <= quote.peak_multiplier
  AND r.input_per_million <= quote.input_per_million AND r.output_per_million <= quote.output_per_million
  AND r.cached_input_per_million <= quote.cached_input_per_million AND r.per_request <= quote.per_request
  AND r.per_second <= quote.per_second AND r.media_options = quote.media_options
);

CREATE VIEW unpriced_pool_models AS
SELECT DISTINCT ON (root_pool_id, model) root_pool_id, model, protocol
FROM (
  SELECT c.root_pool_id, mr.model, c.protocol, c.routing_priority
  FROM pool_channels c JOIN model_rates mr ON mr.pool_id = c.pool_id AND mr.listed_without_rate
  UNION ALL
  SELECT c.root_pool_id, discovered.model, c.protocol, c.routing_priority
  FROM pool_channels c JOIN upstream_credentials uc ON uc.pool_id = c.pool_id
  CROSS JOIN LATERAL unnest(uc.available_models) AS discovered(model)
  WHERE uc.status = 'ACTIVE' AND uc.catalog_valid_until > now() AND uc.key_fingerprint IS NOT NULL
    AND (NOT uc.test_only OR current_setting('proxykey.allow_test_upstreams', true) = 'on')
    AND NOT EXISTS (SELECT 1 FROM model_rates mr WHERE mr.pool_id = c.pool_id AND mr.model = discovered.model)
) AS known
WHERE NOT EXISTS (SELECT 1 FROM priced_pool_models priced WHERE priced.root_pool_id = known.root_pool_id AND priced.model = known.model)
ORDER BY root_pool_id, model, routing_priority DESC, protocol;

CREATE VIEW usable_key_models AS
SELECT DISTINCT ak.id AS api_key_id, r.model, r.protocol
FROM api_keys ak JOIN orders o ON o.id = ak.order_id
JOIN routable_pool_models r ON r.root_pool_id = o.pool_id
JOIN sellable_upstream_slots s ON s.pool_id = r.pool_id
JOIN upstream_credentials uc ON uc.id = s.id AND r.model = ANY(uc.available_models)
LEFT JOIN api_key_channel_assignments a ON a.api_key_id = ak.id AND a.pool_id = r.pool_id
WHERE ak.status = 'ACTIVE' AND ak.credits_used < ak.credits_total
  AND (ak.expires_at IS NULL OR ak.expires_at > now())
  AND (NOT s.test_only OR o.payment_provider = 'mock')
  AND (s.id = ak.upstream_credential_id OR s.id = a.upstream_credential_id OR s.assigned + s.reserved < s.credential_capacity);

-- No prompts, uploaded media or clear-text provider credentials are persisted here.
CREATE TABLE video_jobs (
  id uuid PRIMARY KEY,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  upstream_credential_id uuid NOT NULL REFERENCES upstream_credentials(id) ON DELETE RESTRICT,
  lease_id uuid REFERENCES request_leases(id) ON DELETE SET NULL,
  request_id text NOT NULL UNIQUE REFERENCES usage_records(request_id),
  upstream_id text,
  model text NOT NULL,
  seconds integer NOT NULL CHECK (seconds BETWEEN 1 AND 120),
  size text,
  state text NOT NULL DEFAULT 'SUBMITTING' CHECK (state IN ('SUBMITTING','QUEUED','IN_PROGRESS','COMPLETED','FAILED','REVIEW')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  idempotency_key text,
  input_hash text NOT NULL,
  accounting jsonb NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz,
  poll_after timestamptz NOT NULL DEFAULT now(),
  poll_locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, idempotency_key),
  UNIQUE (upstream_credential_id, upstream_id)
);
CREATE INDEX video_jobs_poll_idx ON video_jobs(poll_after) WHERE state IN ('QUEUED','IN_PROGRESS');
CREATE INDEX video_jobs_owner_idx ON video_jobs(api_key_id, created_at DESC, id DESC);
