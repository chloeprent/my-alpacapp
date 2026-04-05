-- Add telegram field to app_users table
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS telegram text;

COMMENT ON COLUMN app_users.telegram IS 'Telegram username (without @ prefix)';
