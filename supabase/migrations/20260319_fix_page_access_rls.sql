-- Fix: split FOR ALL into per-operation policies so INSERT/upsert works through PostgREST
-- FOR ALL policies have quirks with PostgREST upsert; explicit per-op policies are reliable

-- ── page_access_settings ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage page settings" ON page_access_settings;

CREATE POLICY "Admins can insert page settings"
  ON page_access_settings FOR INSERT
  WITH CHECK (
    (SELECT role FROM app_users WHERE auth_user_id = auth.uid()) IN ('admin','oracle')
  );

CREATE POLICY "Admins can update page settings"
  ON page_access_settings FOR UPDATE
  USING (
    (SELECT role FROM app_users WHERE auth_user_id = auth.uid()) IN ('admin','oracle')
  )
  WITH CHECK (
    (SELECT role FROM app_users WHERE auth_user_id = auth.uid()) IN ('admin','oracle')
  );

CREATE POLICY "Admins can delete page settings"
  ON page_access_settings FOR DELETE
  USING (
    (SELECT role FROM app_users WHERE auth_user_id = auth.uid()) IN ('admin','oracle')
  );

-- ── page_access_grants ────────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage grants" ON page_access_grants;

CREATE POLICY "Admins can insert grants"
  ON page_access_grants FOR INSERT
  WITH CHECK (
    (SELECT role FROM app_users WHERE auth_user_id = auth.uid()) IN ('admin','oracle')
  );

CREATE POLICY "Admins can update grants"
  ON page_access_grants FOR UPDATE
  USING (
    (SELECT role FROM app_users WHERE auth_user_id = auth.uid()) IN ('admin','oracle')
  )
  WITH CHECK (
    (SELECT role FROM app_users WHERE auth_user_id = auth.uid()) IN ('admin','oracle')
  );

CREATE POLICY "Admins can delete grants"
  ON page_access_grants FOR DELETE
  USING (
    (SELECT role FROM app_users WHERE auth_user_id = auth.uid()) IN ('admin','oracle')
  );
