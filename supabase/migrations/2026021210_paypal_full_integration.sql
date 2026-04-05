-- PayPal Full Integration: payments table, ledger columns, config activation
-- Adds support for receiving PayPal payments (not just payouts)

-- 1. Create paypal_payments table (mirrors square_payments pattern)
CREATE TABLE IF NOT EXISTS paypal_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- PayPal identifiers
  paypal_order_id text,             -- PayPal Orders API order ID
  paypal_capture_id text,           -- PayPal capture/transaction ID
  paypal_payer_id text,             -- PayPal payer account ID
  paypal_payer_email text,          -- Payer's PayPal email
  paypal_payer_name text,           -- Payer's name from PayPal
  -- Payment details
  amount numeric NOT NULL,
  currency text DEFAULT 'USD',
  status text DEFAULT 'pending',     -- pending, approved, completed, failed, refunded
  payment_type text,                 -- rent, security_deposit, move_in_deposit, application_fee, event_fee, other
  -- Reference links
  reference_type text,               -- assignment, rental_application, event_hosting_request, direct_payment
  reference_id uuid,
  person_id uuid REFERENCES people(id),
  person_name text,
  description text,
  -- Refund tracking
  refund_id text,
  refund_amount numeric,
  refunded_at timestamptz,
  -- Meta
  is_test boolean DEFAULT false,
  raw_response jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes for lookup
CREATE INDEX IF NOT EXISTS idx_paypal_payments_order_id ON paypal_payments(paypal_order_id);
CREATE INDEX IF NOT EXISTS idx_paypal_payments_capture_id ON paypal_payments(paypal_capture_id);
CREATE INDEX IF NOT EXISTS idx_paypal_payments_person ON paypal_payments(person_id);
CREATE INDEX IF NOT EXISTS idx_paypal_payments_status ON paypal_payments(status);
CREATE INDEX IF NOT EXISTS idx_paypal_payments_reference ON paypal_payments(reference_type, reference_id);

-- RLS policies
ALTER TABLE paypal_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on paypal_payments"
  ON paypal_payments FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Authenticated users can read paypal_payments"
  ON paypal_payments FOR SELECT
  USING (auth.role() = 'authenticated');

-- 2. Add paypal_payment_id column to ledger (links to paypal_payments.id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ledger' AND column_name = 'paypal_payment_id'
  ) THEN
    ALTER TABLE ledger ADD COLUMN paypal_payment_id uuid REFERENCES paypal_payments(id);
  END IF;
END $$;

-- 3. Add paypal_transaction_id to ledger for quick dedup by PayPal capture ID
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ledger' AND column_name = 'paypal_transaction_id'
  ) THEN
    ALTER TABLE ledger ADD COLUMN paypal_transaction_id text;
  END IF;
END $$;

-- Index for deduplication
CREATE INDEX IF NOT EXISTS idx_ledger_paypal_transaction ON ledger(paypal_transaction_id) WHERE paypal_transaction_id IS NOT NULL;

-- 4. Ensure paypal_config row exists and is active
INSERT INTO paypal_config (id, is_active, test_mode)
VALUES (1, true, false)
ON CONFLICT (id) DO UPDATE SET
  is_active = true,
  updated_at = now();

-- 5. Add PayPal to payment_methods table (for pay page display)
INSERT INTO payment_methods (method_type, name, account_identifier, instructions, is_active, display_order)
VALUES (
  'paypal',
  'PayPal',
  'alpacaplayhouse@gmail.com',
  'Send payment to alpacaplayhouse@gmail.com via PayPal. Include your name and what the payment is for in the note.',
  true,
  1  -- First in display order (preferred)
)
ON CONFLICT DO NOTHING;

-- Move PayPal to top of display order
UPDATE payment_methods SET display_order = display_order + 1 WHERE method_type != 'paypal';
UPDATE payment_methods SET display_order = 1 WHERE method_type = 'paypal';
