-- Migration: Add transaction ID fields for deposits
-- Purpose: Store transaction IDs/reference numbers when recording deposit payments

BEGIN;

ALTER TABLE rental_applications
  ADD COLUMN IF NOT EXISTS move_in_deposit_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS security_deposit_transaction_id TEXT;

COMMENT ON COLUMN rental_applications.move_in_deposit_transaction_id IS 'Transaction ID or reference number for move-in deposit payment';
COMMENT ON COLUMN rental_applications.security_deposit_transaction_id IS 'Transaction ID or reference number for security deposit payment';

COMMIT;
