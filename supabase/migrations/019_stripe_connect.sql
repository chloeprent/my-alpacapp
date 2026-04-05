-- Stripe Connect: config, associate Connect accounts, inbound payment tracking
-- Run via: psql $SUPABASE_DB_URL -f migrations/019_stripe_connect.sql

-- 1. stripe_config (single-row pattern)
CREATE TABLE stripe_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  publishable_key text,
  secret_key text,
  sandbox_publishable_key text,
  sandbox_secret_key text,
  webhook_secret text,
  sandbox_webhook_secret text,
  connect_enabled boolean DEFAULT false,
  is_active boolean DEFAULT false,
  test_mode boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

INSERT INTO stripe_config (id) VALUES (1);

ALTER TABLE stripe_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on stripe_config" ON stripe_config
  FOR ALL USING (true) WITH CHECK (true);

-- 2. associate_profiles: add stripe to payment_method and stripe_connect_account_id
ALTER TABLE associate_profiles DROP CONSTRAINT IF EXISTS associate_profiles_payment_method_check;
ALTER TABLE associate_profiles ADD CONSTRAINT associate_profiles_payment_method_check
  CHECK (payment_method IN ('paypal', 'venmo', 'zelle', 'square', 'cash', 'check', 'bank_ach', 'stripe', 'other'));

ALTER TABLE associate_profiles ADD COLUMN IF NOT EXISTS stripe_connect_account_id text;

-- 3. stripe_payments — inbound payment tracking (mirror square_payments)
CREATE TABLE stripe_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_type text NOT NULL,
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  amount numeric NOT NULL,
  fee_code_used text,
  original_amount numeric,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  stripe_payment_intent_id text,
  stripe_charge_id text,
  receipt_url text,
  error_message text,
  person_id uuid,
  person_name text,
  ledger_id uuid,
  is_test boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_stripe_payments_reference ON stripe_payments (reference_type, reference_id);
CREATE INDEX idx_stripe_payments_intent ON stripe_payments (stripe_payment_intent_id);

ALTER TABLE stripe_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on stripe_payments" ON stripe_payments
  FOR ALL USING (true) WITH CHECK (true);
