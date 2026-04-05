-- Migration: Bug Reporting System
-- Version: 010
-- Description: Creates table for automated bug reports from Chrome extension

BEGIN;

-- ============================================
-- 1. BUG REPORTS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS bug_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Reporter info
  reporter_name TEXT NOT NULL,
  reporter_email TEXT NOT NULL,

  -- Bug details
  description TEXT NOT NULL,
  screenshot_url TEXT NOT NULL,
  page_url TEXT,

  -- Processing status
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'fixed', 'failed', 'skipped')),
  fix_summary TEXT,
  fix_commit_sha TEXT,
  error_message TEXT,
  processed_at TIMESTAMPTZ,
  notified_at TIMESTAMPTZ
);

-- ============================================
-- 2. ROW LEVEL SECURITY
-- ============================================

ALTER TABLE bug_reports ENABLE ROW LEVEL SECURITY;

-- Allow anonymous inserts from the Chrome extension
CREATE POLICY "anon_insert_bug_reports"
  ON bug_reports
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Allow anonymous reads so extension can show status
CREATE POLICY "anon_select_bug_reports"
  ON bug_reports
  FOR SELECT
  TO anon
  USING (true);

-- Service role gets full access (for the DO worker)
CREATE POLICY "service_role_all_bug_reports"
  ON bug_reports
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================
-- 3. INDEX FOR WORKER POLLING
-- ============================================

CREATE INDEX idx_bug_reports_status ON bug_reports(status) WHERE status = 'pending';

COMMIT;
