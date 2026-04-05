-- Add facebook_url field to app_users table
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS facebook_url text;

COMMENT ON COLUMN app_users.facebook_url IS 'Facebook profile URL (normalized to full URL format)';
