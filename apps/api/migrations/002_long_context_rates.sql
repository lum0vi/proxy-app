ALTER TABLE model_rates
  ADD COLUMN IF NOT EXISTS long_context_threshold bigint,
  ADD COLUMN IF NOT EXISTS long_context_multiplier numeric(10,4) NOT NULL DEFAULT 1;

ALTER TABLE model_rates
  DROP CONSTRAINT IF EXISTS model_rates_long_context_threshold_check,
  ADD CONSTRAINT model_rates_long_context_threshold_check
    CHECK (long_context_threshold IS NULL OR long_context_threshold > 0),
  DROP CONSTRAINT IF EXISTS model_rates_long_context_multiplier_check,
  ADD CONSTRAINT model_rates_long_context_multiplier_check
    CHECK (long_context_multiplier >= 1);
