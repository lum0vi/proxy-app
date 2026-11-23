ALTER TABLE notifications
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN retry_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX notifications_delivery_idx ON notifications(retry_at, created_at)
  WHERE status IN ('PENDING', 'FAILED');
