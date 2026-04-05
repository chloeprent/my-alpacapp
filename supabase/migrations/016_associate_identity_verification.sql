-- Migration: Associate Identity Verification
-- Version: 016
-- Description: Extends identity verification system to support associates (not just rental applicants).
-- Makes rental_application_id nullable, adds app_user_id for associate context,
-- adds verification tracking columns to associate_profiles.

BEGIN;

-- ============================================
-- 1. UPLOAD TOKENS: make rental_application_id nullable, add app_user_id
-- ============================================

ALTER TABLE upload_tokens ALTER COLUMN rental_application_id DROP NOT NULL;

ALTER TABLE upload_tokens
  ADD COLUMN IF NOT EXISTS app_user_id UUID REFERENCES app_users(id) ON DELETE CASCADE;

-- ============================================
-- 2. IDENTITY VERIFICATIONS: make rental_application_id nullable, add app_user_id
-- ============================================

ALTER TABLE identity_verifications ALTER COLUMN rental_application_id DROP NOT NULL;

ALTER TABLE identity_verifications
  ADD COLUMN IF NOT EXISTS app_user_id UUID REFERENCES app_users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_identity_verifications_app_user ON identity_verifications(app_user_id);

-- ============================================
-- 3. ASSOCIATE PROFILES: add verification tracking
-- ============================================

ALTER TABLE associate_profiles
  ADD COLUMN IF NOT EXISTS identity_verification_id UUID REFERENCES identity_verifications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS identity_verification_status TEXT DEFAULT 'pending';

COMMIT;
