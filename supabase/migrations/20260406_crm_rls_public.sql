DROP POLICY IF EXISTS "Authenticated users can manage CRM contacts" ON swoon_crm_contacts;
DROP POLICY IF EXISTS "Authenticated users can manage CRM activity" ON swoon_crm_activity;

CREATE POLICY "Allow all access to CRM contacts"
  ON swoon_crm_contacts FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow all access to CRM activity"
  ON swoon_crm_activity FOR ALL
  USING (true)
  WITH CHECK (true);
