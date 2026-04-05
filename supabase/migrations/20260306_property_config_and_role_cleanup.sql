-- Migration: property_config table + demo role standardization
-- Applied: 2026-03-06

-- ============================================
-- 1. Standardize 'demon' → 'demo' role
-- ============================================
UPDATE app_users SET role = 'demo' WHERE role = 'demon';
UPDATE user_invitations SET role = 'demo' WHERE role = 'demon';
UPDATE role_permissions SET role = 'demo' WHERE role = 'demon'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp2
    WHERE rp2.role = 'demo' AND rp2.permission_key = role_permissions.permission_key
  );
DELETE FROM role_permissions WHERE role = 'demon';

ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
ALTER TABLE app_users ADD CONSTRAINT app_users_role_check
  CHECK (role IN ('admin', 'staff', 'resident', 'associate', 'demo', 'oracle', 'public', 'prospect'));

ALTER TABLE user_invitations DROP CONSTRAINT IF EXISTS user_invitations_role_check;
ALTER TABLE user_invitations ADD CONSTRAINT user_invitations_role_check
  CHECK (role IN ('admin', 'staff', 'resident', 'associate', 'demo', 'oracle', 'public', 'prospect'));

-- ============================================
-- 2. Create property_config table
-- ============================================
CREATE TABLE IF NOT EXISTS property_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES app_users(id)
);

ALTER TABLE property_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read property_config" ON property_config
  FOR SELECT USING (true);

CREATE POLICY "Admin can update property_config" ON property_config
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM app_users WHERE auth_user_id = auth.uid() AND role IN ('admin', 'oracle'))
  );

CREATE POLICY "Admin can insert property_config" ON property_config
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM app_users WHERE auth_user_id = auth.uid() AND role IN ('admin', 'oracle'))
  );

-- Seed with YOUR_APP_NAME defaults
INSERT INTO property_config (id, config) VALUES (1, '{
  "property": {
    "name": "YOUR_PROPERTY_NAME",
    "short_name": "YOUR_APP_NAME",
    "tagline": "Your tagline here",
    "address": "123 Main St, Your City, ST 00000",
    "city": "Your City",
    "state": "TX",
    "zip": "00000",
    "country": "US",
    "latitude": 30.13,
    "longitude": -97.46,
    "timezone": "America/Chicago"
  },
  "domain": {
    "primary": "YOUR_DOMAIN",
    "cloudflare_pages": "YOUR_PROJECT.pages.dev",
    "camera_proxy": "YOUR_CAMERA_PROXY"
  },
  "email": {
    "team": "team@YOUR_DOMAIN",
    "admin_gmail": "admin@YOUR_DOMAIN",
    "notifications_from": "notifications@YOUR_DOMAIN",
    "noreply_from": "noreply@YOUR_DOMAIN",
    "automation": "automation@YOUR_DOMAIN"
  },
  "payment": {
    "zelle_email": "admin@YOUR_DOMAIN",
    "venmo_handle": "@YourVenmo"
  },
  "ai_assistant": {
    "name": "PAI",
    "full_name": "Property AI Assistant",
    "personality": "the AI assistant for the property",
    "email_from": "pai@YOUR_DOMAIN"
  },
  "wifi": {
    "network_name": "Black Rock City"
  },
  "mobile_app": {
    "name": "YOUR_PROPERTY_NAME",
    "id": "com.yourorg.app"
  }
}'::jsonb) ON CONFLICT (id) DO NOTHING;
