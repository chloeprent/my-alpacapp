-- backup_files: Track individual backup file artifacts for DevControl Backups tab
CREATE TABLE backup_files (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  service     TEXT NOT NULL,                        -- 'supabase-db', 'haos-vm-image', etc.
  backup_date TIMESTAMPTZ NOT NULL,
  filename    TEXT,
  filepath    TEXT,                                 -- full path for copy/verify
  size_bytes  BIGINT
);

CREATE INDEX idx_backup_files_date ON backup_files (backup_date DESC);

-- RLS: authenticated users can read, service role can insert
ALTER TABLE backup_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read backup files"
  ON backup_files FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can insert backup files"
  ON backup_files FOR INSERT
  TO service_role
  WITH CHECK (true);
