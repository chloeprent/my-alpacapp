-- backup_logs: Track automated backup runs for DevControl Backups tab
CREATE TABLE backup_logs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source      TEXT NOT NULL,                        -- 'alpaca-mac'
  backup_type TEXT NOT NULL,                        -- 'full-to-rvault'
  status      TEXT NOT NULL DEFAULT 'success',      -- 'success' | 'error'
  duration_seconds INTEGER,
  details     JSONB,                                -- per-service stats
  r2_key      TEXT                                  -- optional R2 key reference
);

CREATE INDEX idx_backup_logs_created ON backup_logs (created_at DESC);

-- RLS: authenticated users can read, service role can insert
ALTER TABLE backup_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read backup logs"
  ON backup_logs FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can insert backup logs"
  ON backup_logs FOR INSERT
  TO service_role
  WITH CHECK (true);
