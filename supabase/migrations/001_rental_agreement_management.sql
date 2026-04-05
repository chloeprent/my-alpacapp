-- Migration: Rental Agreement Management System
-- Version: 001
-- Description: Creates tables for rental application workflow, payment tracking, and payment methods

BEGIN;

-- ============================================
-- 1. PAYMENT METHODS TABLE
-- ============================================
-- Stores property payment options (Venmo, Zelle, PayPal, Bank ACH)

CREATE TABLE IF NOT EXISTS payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                    -- Display name: 'Venmo', 'Zelle', etc.
  method_type TEXT NOT NULL,             -- venmo, zelle, paypal, bank_ach

  -- Account identifiers (varies by type)
  account_identifier TEXT,               -- @username, email, phone
  account_name TEXT,                     -- Name on account

  -- Bank ACH specific
  routing_number TEXT,
  account_number TEXT,
  account_type TEXT,                     -- checking, savings

  -- QR code image (links to media table)
  qr_code_media_id UUID REFERENCES media(id) ON DELETE SET NULL,

  -- Display settings
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  instructions TEXT,                     -- Payment instructions for tenants

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- 2. RENTAL APPLICATIONS TABLE
-- ============================================
-- Central tracking for rental applications through the workflow

CREATE TABLE IF NOT EXISTS rental_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Applicant link
  person_id UUID REFERENCES people(id) ON DELETE CASCADE,

  -- Application status
  application_status TEXT NOT NULL DEFAULT 'submitted',
  -- Values: submitted, under_review, approved, denied, delayed, withdrawn

  submitted_at TIMESTAMPTZ DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,                      -- Admin who reviewed

  -- Space preference (what applicant requested)
  desired_space_id UUID REFERENCES spaces(id) ON DELETE SET NULL,
  desired_move_in DATE,
  desired_term TEXT,                     -- e.g., '6 months', '1 year', 'month-to-month'

  -- Approval details (filled when approved)
  approved_space_id UUID REFERENCES spaces(id) ON DELETE SET NULL,
  approved_rate DECIMAL(10,2),
  approved_rate_term TEXT,               -- monthly, weekly, nightly
  approved_move_in DATE,
  approved_lease_end DATE,

  -- Deposit amounts
  move_in_deposit_amount DECIMAL(10,2),  -- Always 1 month's rent
  move_in_deposit_paid BOOLEAN DEFAULT false,
  move_in_deposit_paid_at TIMESTAMPTZ,
  move_in_deposit_method TEXT,           -- venmo, zelle, paypal, bank_ach, cash, check

  security_deposit_amount DECIMAL(10,2), -- Variable (can be 0)
  security_deposit_paid BOOLEAN DEFAULT false,
  security_deposit_paid_at TIMESTAMPTZ,
  security_deposit_method TEXT,

  -- Rental agreement workflow
  agreement_status TEXT DEFAULT 'pending',
  -- Values: pending, generated, sent, signed

  agreement_document_url TEXT,           -- Link to generated .docx or signed PDF
  agreement_generated_at TIMESTAMPTZ,
  agreement_sent_at TIMESTAMPTZ,
  agreement_signed_at TIMESTAMPTZ,

  -- Overall deposit status (for pipeline view)
  deposit_status TEXT DEFAULT 'pending',
  -- Values: pending, requested, partial, received, confirmed

  deposit_requested_at TIMESTAMPTZ,
  deposit_confirmed_at TIMESTAMPTZ,

  -- Move-in
  move_in_confirmed_at TIMESTAMPTZ,

  -- Resulting assignment (created when move-in confirmed)
  assignment_id UUID REFERENCES assignments(id) ON DELETE SET NULL,

  -- Notes and reasons
  admin_notes TEXT,
  denial_reason TEXT,
  delay_reason TEXT,
  delay_revisit_date DATE,               -- When to revisit delayed application

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- 3. RENTAL PAYMENTS TABLE
-- ============================================
-- Tracks all payments: deposits and rent

CREATE TABLE IF NOT EXISTS rental_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to application or assignment
  rental_application_id UUID REFERENCES rental_applications(id) ON DELETE CASCADE,
  assignment_id UUID REFERENCES assignments(id) ON DELETE CASCADE,

  -- Payment type
  payment_type TEXT NOT NULL,
  -- Values: move_in_deposit, security_deposit, rent, prorated_rent

  -- Amounts
  amount_due DECIMAL(10,2) NOT NULL,
  amount_paid DECIMAL(10,2) DEFAULT 0,

  -- Dates
  due_date DATE,
  paid_date DATE,

  -- Payment details
  payment_method TEXT,                   -- venmo, zelle, paypal, bank_ach, cash, check
  transaction_id TEXT,                   -- External reference

  -- For rent payments
  period_start DATE,
  period_end DATE,

  -- Proration
  is_prorated BOOLEAN DEFAULT false,
  prorate_days INTEGER,

  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- 4. ADD COLUMNS TO EXISTING TABLES
-- ============================================

-- Add columns to assignments table
ALTER TABLE assignments
  ADD COLUMN IF NOT EXISTS rental_application_id UUID REFERENCES rental_applications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS monthly_rent DECIMAL(10,2);

-- Add columns to people table
ALTER TABLE people
  ADD COLUMN IF NOT EXISTS application_status TEXT DEFAULT 'candidate';
  -- Values: candidate, applicant, approved, tenant, former_tenant, denied

-- ============================================
-- 5. CREATE INDEXES
-- ============================================

CREATE INDEX IF NOT EXISTS idx_rental_applications_status
  ON rental_applications(application_status, agreement_status, deposit_status);

CREATE INDEX IF NOT EXISTS idx_rental_applications_person
  ON rental_applications(person_id);

CREATE INDEX IF NOT EXISTS idx_rental_applications_space
  ON rental_applications(approved_space_id);

CREATE INDEX IF NOT EXISTS idx_rental_payments_application
  ON rental_payments(rental_application_id);

CREATE INDEX IF NOT EXISTS idx_rental_payments_assignment
  ON rental_payments(assignment_id);

CREATE INDEX IF NOT EXISTS idx_rental_payments_type
  ON rental_payments(payment_type);

CREATE INDEX IF NOT EXISTS idx_payment_methods_active
  ON payment_methods(is_active, display_order);

-- ============================================
-- 6. ROW LEVEL SECURITY
-- ============================================

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_payments ENABLE ROW LEVEL SECURITY;

-- Public read access (matches existing pattern)
CREATE POLICY "Public read payment_methods" ON payment_methods
  FOR SELECT USING (true);
CREATE POLICY "Public read rental_applications" ON rental_applications
  FOR SELECT USING (true);
CREATE POLICY "Public read rental_payments" ON rental_payments
  FOR SELECT USING (true);

-- Allow all operations (can restrict later with auth)
CREATE POLICY "Allow all payment_methods" ON payment_methods
  FOR ALL USING (true);
CREATE POLICY "Allow all rental_applications" ON rental_applications
  FOR ALL USING (true);
CREATE POLICY "Allow all rental_payments" ON rental_payments
  FOR ALL USING (true);

-- ============================================
-- 7. INSERT DEFAULT PAYMENT METHODS
-- ============================================

INSERT INTO payment_methods (name, method_type, instructions, display_order) VALUES
  ('Venmo', 'venmo', 'Send payment to our Venmo account. Include your name and "Deposit" or "Rent" in the note.', 1),
  ('Zelle', 'zelle', 'Send payment via Zelle. Include your name in the memo.', 2),
  ('PayPal', 'paypal', 'Send payment to our PayPal account. Select "Friends & Family" to avoid fees.', 3),
  ('Bank Transfer (ACH)', 'bank_ach', 'Wire transfer to our bank account. Contact us for account details.', 4)
ON CONFLICT DO NOTHING;

COMMIT;
