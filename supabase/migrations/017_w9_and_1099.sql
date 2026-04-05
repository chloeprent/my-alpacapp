-- W-9 Collection & 1099-NEC Tracking
-- Associates must submit W-9 before receiving payouts

-- W-9 submissions table
CREATE TABLE w9_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id UUID REFERENCES app_users(id),
  legal_name TEXT NOT NULL,
  business_name TEXT,
  tax_classification TEXT NOT NULL,
  tax_classification_other TEXT,
  exempt_payee_code TEXT,
  fatca_exemption_code TEXT,
  address_street TEXT NOT NULL,
  address_city TEXT NOT NULL,
  address_state TEXT NOT NULL,
  address_zip TEXT NOT NULL,
  tin_type TEXT NOT NULL CHECK (tin_type IN ('ssn', 'ein')),
  tin_encrypted TEXT NOT NULL,      -- AES-256-GCM encrypted
  tin_last_four TEXT NOT NULL,      -- Last 4 digits for display
  tin_iv TEXT NOT NULL,             -- IV for decryption
  certification_agreed BOOLEAN NOT NULL DEFAULT FALSE,
  certification_timestamp TIMESTAMPTZ NOT NULL,
  certification_ip TEXT,
  upload_token_id UUID REFERENCES upload_tokens(id),
  status TEXT NOT NULL DEFAULT 'submitted',
  superseded_by UUID REFERENCES w9_submissions(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_w9_submissions_app_user ON w9_submissions(app_user_id);

ALTER TABLE w9_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_view_w9" ON w9_submissions FOR SELECT
  USING (EXISTS (SELECT 1 FROM app_users WHERE auth_user_id = auth.uid() AND role IN ('admin','staff')));

CREATE POLICY "associate_view_own_w9" ON w9_submissions FOR SELECT
  USING (app_user_id IN (SELECT id FROM app_users WHERE auth_user_id = auth.uid()));

-- Add W-9 tracking to associate_profiles
ALTER TABLE associate_profiles
  ADD COLUMN w9_status TEXT DEFAULT 'pending',
  ADD COLUMN w9_submission_id UUID REFERENCES w9_submissions(id);
