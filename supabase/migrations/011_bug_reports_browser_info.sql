-- Migration 011: Add browser/platform info and diagnostic fields to bug_reports
-- These columns capture the reporter's environment for better bug reproduction,
-- plus fields for the automated fixer to record its diagnosis and notes.

ALTER TABLE bug_reports
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS browser_name text,
  ADD COLUMN IF NOT EXISTS browser_version text,
  ADD COLUMN IF NOT EXISTS os_name text,
  ADD COLUMN IF NOT EXISTS os_version text,
  ADD COLUMN IF NOT EXISTS screen_resolution text,
  ADD COLUMN IF NOT EXISTS viewport_size text,
  ADD COLUMN IF NOT EXISTS device_type text,
  ADD COLUMN IF NOT EXISTS extension_platform text,
  ADD COLUMN IF NOT EXISTS extension_version text,
  ADD COLUMN IF NOT EXISTS diagnosis text,
  ADD COLUMN IF NOT EXISTS notes text;
