ALTER TABLE upstream_credentials ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT deleted_upstream_credential_inactive CHECK (
    deleted_at IS NULL OR (status = 'DISABLED' AND encrypted_key = '' AND key_fingerprint IS NULL)
  );
