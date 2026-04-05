-- Migration: Vehicle Rentals System
-- Version: 010
-- Description: Creates table for tracking vehicle rental agreements, rate schedules, and deposits

BEGIN;

-- ============================================
-- 1. VEHICLE RENTALS TABLE
-- ============================================
-- Tracks car rental agreements linked to vehicles and people

CREATE TABLE IF NOT EXISTS vehicle_rentals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  person_id UUID REFERENCES people(id) ON DELETE SET NULL,

  -- Renter info (denormalized for contract reference)
  renter_name TEXT NOT NULL,
  renter_email TEXT,
  renter_phone TEXT,
  renter_address TEXT,
  renter_dl_number TEXT,
  renter_dl_state TEXT,

  -- Vehicle snapshot at rental start (denormalized)
  vehicle_vin TEXT,
  vehicle_make TEXT,
  vehicle_model TEXT,
  vehicle_year INTEGER,
  vehicle_color TEXT,
  starting_mileage INTEGER,

  -- Rental period
  start_date DATE NOT NULL,
  end_date DATE,                          -- Initial term end; NULL = open-ended
  auto_renew BOOLEAN DEFAULT true,
  cancel_notice_days INTEGER DEFAULT 14,  -- Days notice required to cancel

  -- Status
  status TEXT NOT NULL DEFAULT 'active',
  -- Values: draft, active, ended, cancelled

  -- Rate schedule (JSONB array for rate changes over time)
  -- Example: [{"from":"2025-05-21","to":"2025-12-31","rate":495},{"from":"2026-01-01","to":null,"rate":295}]
  rate_schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_monthly_rate DECIMAL(10,2),     -- Current effective rate (convenience column)

  -- Deposit
  security_deposit_amount DECIMAL(10,2),
  security_deposit_paid BOOLEAN DEFAULT false,
  security_deposit_paid_at TIMESTAMPTZ,
  security_deposit_returned BOOLEAN DEFAULT false,
  security_deposit_returned_at TIMESTAMPTZ,
  deposit_deductions DECIMAL(10,2) DEFAULT 0,
  deposit_deduction_notes TEXT,

  -- Insurance
  insurance_provider TEXT,
  insurance_policy_number TEXT,
  insurance_verified BOOLEAN DEFAULT false,
  insurance_notes TEXT,

  -- Mileage tracking
  monthly_mileage_limit INTEGER,          -- NULL = unlimited local
  mileage_overage_rate DECIMAL(5,2),      -- Per-mile overage charge
  current_mileage INTEGER,                -- Last known odometer
  mileage_notes TEXT,                     -- e.g., "Austin local free, $0.15/mi road trips"

  -- Fees
  late_return_hourly_rate DECIMAL(10,2),
  accident_deductible_max DECIMAL(10,2),

  -- Existing damage at rental start
  existing_damage TEXT,                   -- Free-text description

  -- Contract document
  contract_pdf_url TEXT,
  contract_signed_at TIMESTAMPTZ,
  signwell_document_id TEXT,

  -- Notes
  admin_notes TEXT,
  additional_terms TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

-- ============================================
-- 2. INDEXES
-- ============================================

CREATE INDEX IF NOT EXISTS idx_vehicle_rentals_status
  ON vehicle_rentals(status);

CREATE INDEX IF NOT EXISTS idx_vehicle_rentals_vehicle
  ON vehicle_rentals(vehicle_id);

CREATE INDEX IF NOT EXISTS idx_vehicle_rentals_person
  ON vehicle_rentals(person_id);

CREATE INDEX IF NOT EXISTS idx_vehicle_rentals_dates
  ON vehicle_rentals(start_date, end_date);

-- ============================================
-- 3. ROW LEVEL SECURITY
-- ============================================

ALTER TABLE vehicle_rentals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read vehicle_rentals" ON vehicle_rentals
  FOR SELECT USING (true);

CREATE POLICY "Allow all vehicle_rentals" ON vehicle_rentals
  FOR ALL USING (true);

COMMIT;
