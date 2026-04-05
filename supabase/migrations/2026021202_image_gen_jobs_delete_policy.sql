-- Allow authenticated residents to delete their own image_gen_jobs.
-- The app_user_id is stored in the metadata JSONB column.
-- Also ensures SELECT works for the gallery view.

-- Ensure RLS is enabled (idempotent)
ALTER TABLE image_gen_jobs ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to SELECT their own jobs (by metadata->app_user_id matching their app_users.id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'image_gen_jobs' AND policyname = 'Users can view own image gen jobs'
  ) THEN
    CREATE POLICY "Users can view own image gen jobs"
      ON image_gen_jobs FOR SELECT
      TO authenticated
      USING (
        metadata->>'app_user_id' IN (
          SELECT id::text FROM app_users WHERE auth_user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Allow authenticated users to INSERT their own jobs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'image_gen_jobs' AND policyname = 'Users can insert own image gen jobs'
  ) THEN
    CREATE POLICY "Users can insert own image gen jobs"
      ON image_gen_jobs FOR INSERT
      TO authenticated
      WITH CHECK (
        metadata->>'app_user_id' IN (
          SELECT id::text FROM app_users WHERE auth_user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Allow authenticated users to DELETE their own jobs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'image_gen_jobs' AND policyname = 'Users can delete own image gen jobs'
  ) THEN
    CREATE POLICY "Users can delete own image gen jobs"
      ON image_gen_jobs FOR DELETE
      TO authenticated
      USING (
        metadata->>'app_user_id' IN (
          SELECT id::text FROM app_users WHERE auth_user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Service role bypass (for the image-gen worker and cron function)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'image_gen_jobs' AND policyname = 'Service role full access on image_gen_jobs'
  ) THEN
    CREATE POLICY "Service role full access on image_gen_jobs"
      ON image_gen_jobs FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
