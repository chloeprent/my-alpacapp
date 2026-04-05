-- Page Access System: per-page visibility settings + individual email grants
-- Used by personal-page-shell.js to gate access on personal pages

-- Settings: one row per page (created on first owner visit or via grant URL)
CREATE TABLE IF NOT EXISTS page_access_settings (
  page_path  TEXT PRIMARY KEY,
  visibility TEXT NOT NULL DEFAULT 'registered'
             CHECK (visibility IN ('public','registered','role:resident','role:staff','role:admin','private')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Individual email grants (for 'private' visibility or supplemental access)
CREATE TABLE IF NOT EXISTS page_access_grants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_path  TEXT NOT NULL,
  email      TEXT NOT NULL,
  granted_by UUID REFERENCES app_users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(page_path, email)
);

CREATE INDEX IF NOT EXISTS idx_page_grants_email ON page_access_grants(email);
CREATE INDEX IF NOT EXISTS idx_page_grants_page  ON page_access_grants(page_path);

-- RLS ------------------------------------------------------------------

ALTER TABLE page_access_settings ENABLE ROW LEVEL SECURITY;

-- Anyone (including anon) can read settings — needed for client-side auth gate
CREATE POLICY "Anyone can read page settings"
  ON page_access_settings FOR SELECT
  USING (true);

-- Admin/oracle can manage settings (split per-op for PostgREST upsert compat)
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

ALTER TABLE page_access_grants ENABLE ROW LEVEL SECURITY;

-- Users can read grants for their own email
CREATE POLICY "Users can see own grants"
  ON page_access_grants FOR SELECT
  USING (
    email = (SELECT lower(email) FROM app_users WHERE auth_user_id = auth.uid())
  );

-- Admin/oracle can read all grants
CREATE POLICY "Admins can read all grants"
  ON page_access_grants FOR SELECT
  USING (
    (SELECT role FROM app_users WHERE auth_user_id = auth.uid()) IN ('admin','oracle')
  );

-- Admin/oracle can manage grants (split per-op for PostgREST upsert compat)
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

-- Seed: migrate jackie/pages/permittingplan allowed users to grants
INSERT INTO page_access_settings (page_path, visibility)
VALUES ('/jackie/pages/permittingplan/index.html', 'private')
ON CONFLICT (page_path) DO NOTHING;

INSERT INTO page_access_grants (page_path, email) VALUES
  ('/jackie/pages/permittingplan/index.html', 'jackie61899280@gmail.com'),
  ('/jackie/pages/permittingplan/index.html', 'sheppardsustainable@gmail.com'),
  ('/jackie/pages/permittingplan/index.html', 'rahulioson@gmail.com'),
  ('/jackie/pages/permittingplan/index.html', 'dpmoden8888@gmail.com'),
  ('/jackie/pages/permittingplan/index.html', 'justin.gilbertson1@gmail.com')
ON CONFLICT (page_path, email) DO NOTHING;
