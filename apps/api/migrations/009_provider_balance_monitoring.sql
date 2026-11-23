CREATE TABLE provider_balances (
  provider text PRIMARY KEY,
  balance_usd numeric(20,8),
  low_threshold_usd numeric(20,8) NOT NULL CHECK (low_threshold_usd >= 0),
  checked_at timestamptz,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  low_since timestamptz,
  next_notification_at timestamptz
);

CREATE TABLE provider_balance_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL REFERENCES provider_balances(provider) ON DELETE CASCADE,
  balance_usd numeric(20,8) NOT NULL,
  threshold_usd numeric(20,8) NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'CANCELLED')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE UNIQUE INDEX provider_balance_pending_alert_idx ON provider_balance_alerts(provider) WHERE status = 'PENDING';
