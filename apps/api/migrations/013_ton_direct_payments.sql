ALTER TABLE orders DROP CONSTRAINT orders_payment_provider_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_provider_check
  CHECK (payment_provider IN ('stripe', 'nowpayments', 'yookassa', 'mock', 'ton'));
CREATE UNIQUE INDEX orders_ton_comment_unique ON orders ((metadata->>'payinExtraId')) WHERE payment_provider = 'ton';

-- Only finalized, successful transfers of the allowlisted USDT token enter this ledger.
CREATE TABLE ton_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id text NOT NULL,
  action_id text NOT NULL,
  transaction_hash text NOT NULL,
  receiver text NOT NULL,
  sender text NOT NULL,
  master text NOT NULL,
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units > 0),
  comment text,
  transferred_at timestamptz NOT NULL,
  order_id uuid REFERENCES orders(id),
  status text NOT NULL DEFAULT 'REVIEW' CHECK (status IN ('REVIEW', 'APPROVED', 'REJECTED')),
  reason text NOT NULL,
  reviewed_by uuid REFERENCES users(id),
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(trace_id, action_id)
);
CREATE UNIQUE INDEX ton_payments_one_approval_per_order ON ton_payments(order_id) WHERE status = 'APPROVED';
CREATE INDEX ton_payments_review ON ton_payments(status, created_at);

-- Fixed scan windows and durable pagination survive restarts and indexer outages.
CREATE TABLE ton_payment_scans (
  address text PRIMARY KEY,
  scanned_through timestamptz NOT NULL,
  window_end timestamptz,
  page_cursor text,
  page_offset integer NOT NULL DEFAULT 0,
  checked_at timestamptz,
  error_code text
);
