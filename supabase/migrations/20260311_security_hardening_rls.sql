-- =====================================================
-- Security hardening: RLS fixes for sensitive tables
-- Applied: 2026-03-11
-- =====================================================

-- 1. inbound_emails: Enable RLS (was completely disabled)
ALTER TABLE public.inbound_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY inbound_emails_staff_read ON public.inbound_emails
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM app_users WHERE auth_user_id = auth.uid() AND role IN ('admin', 'oracle', 'staff'))
  );

CREATE POLICY inbound_emails_admin_write ON public.inbound_emails
  FOR ALL USING (is_admin_user()) WITH CHECK (is_admin_user());

CREATE POLICY inbound_emails_service ON public.inbound_emails
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. ledger: Replace wide-open policies with admin/staff access
DROP POLICY IF EXISTS "Allow all ledger" ON public.ledger;
DROP POLICY IF EXISTS "Public read ledger" ON public.ledger;

CREATE POLICY ledger_staff_read ON public.ledger
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM app_users WHERE auth_user_id = auth.uid() AND role IN ('admin', 'oracle', 'staff'))
  );

CREATE POLICY ledger_admin_write ON public.ledger
  FOR ALL USING (is_admin_user()) WITH CHECK (is_admin_user());

CREATE POLICY ledger_service ON public.ledger
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. stripe_payments: Replace wide-open policy with restricted access
DROP POLICY IF EXISTS "Service role full access on stripe_payments" ON public.stripe_payments;

CREATE POLICY stripe_payments_staff_read ON public.stripe_payments
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM app_users WHERE auth_user_id = auth.uid() AND role IN ('admin', 'oracle', 'staff'))
  );

CREATE POLICY stripe_payments_admin_write ON public.stripe_payments
  FOR ALL USING (is_admin_user()) WITH CHECK (is_admin_user());

CREATE POLICY stripe_payments_service ON public.stripe_payments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. sms_messages: Tighten from public read/write to staff read, service write
DROP POLICY IF EXISTS "Public insert access" ON public.sms_messages;
DROP POLICY IF EXISTS "Public read access" ON public.sms_messages;
DROP POLICY IF EXISTS "Public update access" ON public.sms_messages;

CREATE POLICY sms_messages_staff_read ON public.sms_messages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM app_users WHERE auth_user_id = auth.uid() AND role IN ('admin', 'oracle', 'staff'))
  );

CREATE POLICY sms_messages_admin_write ON public.sms_messages
  FOR ALL USING (is_admin_user()) WITH CHECK (is_admin_user());

CREATE POLICY sms_messages_service ON public.sms_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. vehicles: Replace public read-all with owner + staff
DROP POLICY IF EXISTS "anon_read_vehicles" ON public.vehicles;

CREATE POLICY vehicles_owner_or_staff_read ON public.vehicles
  FOR SELECT USING (
    owner_id = (SELECT person_id FROM app_users WHERE auth_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM app_users WHERE auth_user_id = auth.uid() AND role IN ('admin', 'oracle', 'staff'))
  );
