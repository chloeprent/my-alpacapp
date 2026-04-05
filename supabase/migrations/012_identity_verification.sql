-- Migration: Identity Verification System
-- Version: 012
-- Description: Creates tables for DL upload tokens and identity verifications

BEGIN;

-- ============================================
-- 1. UPLOAD TOKENS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS upload_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rental_application_id UUID NOT NULL REFERENCES rental_applications(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  token UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  token_type TEXT NOT NULL DEFAULT 'identity_verification',
  expires_at TIMESTAMPTZ NOT NULL,
  is_used BOOLEAN DEFAULT false,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT
);

CREATE INDEX idx_upload_tokens_token ON upload_tokens(token) WHERE is_used = false;
CREATE INDEX idx_upload_tokens_application ON upload_tokens(rental_application_id);

-- ============================================
-- 2. IDENTITY VERIFICATIONS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS identity_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rental_application_id UUID NOT NULL REFERENCES rental_applications(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  upload_token_id UUID REFERENCES upload_tokens(id) ON DELETE SET NULL,
  document_url TEXT NOT NULL,
  document_type TEXT DEFAULT 'drivers_license',
  extracted_full_name TEXT,
  extracted_first_name TEXT,
  extracted_last_name TEXT,
  extracted_dob TEXT,
  extracted_address TEXT,
  extracted_dl_number TEXT,
  extracted_expiration_date TEXT,
  extracted_state TEXT,
  extraction_raw_json JSONB,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  name_match_score DECIMAL(5,2),
  name_match_details TEXT,
  is_expired_dl BOOLEAN DEFAULT false,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_identity_verifications_application ON identity_verifications(rental_application_id);
CREATE INDEX idx_identity_verifications_status ON identity_verifications(verification_status);

-- ============================================
-- 3. ADD COLUMNS TO RENTAL_APPLICATIONS
-- ============================================

ALTER TABLE rental_applications
  ADD COLUMN IF NOT EXISTS identity_verification_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS identity_verification_id UUID REFERENCES identity_verifications(id) ON DELETE SET NULL;

-- ============================================
-- 4. ROW LEVEL SECURITY
-- ============================================

ALTER TABLE upload_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_upload_tokens" ON upload_tokens
  FOR SELECT TO anon USING (true);
CREATE POLICY "service_role_all_upload_tokens" ON upload_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all_upload_tokens" ON upload_tokens
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "anon_select_identity_verifications" ON identity_verifications
  FOR SELECT TO anon USING (true);
CREATE POLICY "service_role_all_identity_verifications" ON identity_verifications
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all_identity_verifications" ON identity_verifications
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
