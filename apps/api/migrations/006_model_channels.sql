ALTER TABLE upstream_pools DROP CONSTRAINT upstream_pools_protocol_check;
ALTER TABLE upstream_pools ADD CONSTRAINT upstream_pools_protocol_check
  CHECK (protocol IN ('OPENAI', 'OPENAI_CHAT', 'ANTHROPIC', 'GEMINI', 'IMAGES'));
ALTER TABLE upstream_pools ADD COLUMN parent_pool_id uuid REFERENCES upstream_pools(id) ON DELETE SET NULL,
  ADD COLUMN routing_priority integer NOT NULL DEFAULT 0;
CREATE INDEX upstream_pools_parent_idx ON upstream_pools (parent_pool_id);
ALTER TABLE upstream_credentials ADD COLUMN test_only boolean NOT NULL DEFAULT false;

ALTER TABLE model_rates ADD COLUMN peak_multiplier numeric(8,4) NOT NULL DEFAULT 1 CHECK (peak_multiplier >= 1),
  ADD COLUMN rate_multiplier_from timestamptz,
  ADD COLUMN rate_multiplier_after numeric(8,4) NOT NULL DEFAULT 1 CHECK (rate_multiplier_after >= 1),
  ADD COLUMN listed_without_rate boolean NOT NULL DEFAULT false CHECK (NOT (listed_without_rate AND active));
ALTER TABLE usage_records ADD COLUMN cache_write_5m_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN cache_write_1h_tokens bigint NOT NULL DEFAULT 0;

CREATE TABLE api_key_channel_assignments (
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  pool_id uuid NOT NULL REFERENCES upstream_pools(id) ON DELETE RESTRICT,
  upstream_credential_id uuid NOT NULL REFERENCES upstream_credentials(id) ON DELETE RESTRICT,
  PRIMARY KEY (api_key_id, pool_id)
);
CREATE INDEX api_key_channel_credential_idx ON api_key_channel_assignments (upstream_credential_id);

CREATE OR REPLACE VIEW sellable_upstream_slots AS
SELECT uc.id, uc.pool_id, up.credential_capacity,
  ((SELECT count(*) FROM api_keys ak
    WHERE ak.upstream_credential_id = uc.id AND ak.status IN ('ACTIVE', 'PAUSED')
      AND (ak.expires_at IS NULL OR ak.expires_at > now()))
   + (SELECT count(*) FROM api_key_channel_assignments aca JOIN api_keys ak ON ak.id = aca.api_key_id
    WHERE aca.upstream_credential_id = uc.id AND ak.status IN ('ACTIVE', 'PAUSED')
      AND (ak.expires_at IS NULL OR ak.expires_at > now())))::int AS assigned,
  (SELECT count(*)::int FROM orders o WHERE o.upstream_credential_id = uc.id
    AND (o.status = 'PAID' OR (o.status = 'PENDING' AND o.reserved_until > now()))) AS reserved,
  uc.test_only
FROM upstream_credentials uc JOIN upstream_pools up ON up.id = uc.pool_id
WHERE up.active AND uc.status = 'ACTIVE' AND uc.catalog_valid_until > now() AND uc.key_fingerprint IS NOT NULL
  AND (NOT uc.test_only OR current_setting('proxykey.allow_test_upstreams', true) = 'on')
  AND (uc.spend_limit IS NULL OR uc.spend_used < uc.spend_limit)
  AND EXISTS (SELECT 1 FROM model_rates mr WHERE mr.pool_id = uc.pool_id AND mr.active AND mr.model = ANY(uc.available_models)
    AND GREATEST(mr.input_per_million, mr.output_per_million, mr.cached_input_per_million, mr.per_request) > 0);

CREATE VIEW pool_channels AS
SELECT root.id AS root_pool_id, channel.id AS pool_id, channel.protocol, channel.routing_priority
FROM upstream_pools root JOIN upstream_pools channel ON channel.id = root.id OR channel.parent_pool_id = root.id
WHERE root.active AND channel.active;

CREATE VIEW priced_pool_models AS
SELECT c.root_pool_id, c.protocol, c.routing_priority, r.pool_id, r.model,
  r.input_per_million * price.factor AS input_per_million,
  r.output_per_million * price.factor AS output_per_million,
  r.cached_input_per_million * price.factor AS cached_input_per_million,
  r.per_request * price.factor AS per_request,
  r.long_context_threshold, r.long_context_multiplier, r.peak_multiplier
FROM pool_channels c JOIN model_rates r ON r.pool_id = c.pool_id
CROSS JOIN LATERAL (SELECT CASE WHEN r.rate_multiplier_from <= now() THEN r.rate_multiplier_after ELSE 1 END AS factor) price
WHERE r.active AND GREATEST(r.input_per_million, r.output_per_million, r.cached_input_per_million, r.per_request) > 0;

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
