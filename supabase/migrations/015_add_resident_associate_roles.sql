-- Migration 015: Add resident and associate roles
-- Date: 2026-02-07
-- Description: Adds 'resident' and 'associate' roles to the role hierarchy.
--   Role hierarchy: admin > staff > resident = associate
--   - admin: Full access (manage spaces, users, settings, etc.)
--   - staff: Read access to admin dashboard (spaces, occupants, etc.)
--   - resident: Access to resident area (cameras, lighting, house info)
--   - associate: Same access as resident (workers, contractors, etc.)

-- Update CHECK constraint on app_users
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('admin', 'staff', 'resident', 'associate'));
ALTER TABLE app_users ALTER COLUMN role SET DEFAULT 'resident';

-- Update CHECK constraint on user_invitations
ALTER TABLE user_invitations DROP CONSTRAINT IF EXISTS user_invitations_role_check;
ALTER TABLE user_invitations ADD CONSTRAINT user_invitations_role_check CHECK (role IN ('admin', 'staff', 'resident', 'associate'));
ALTER TABLE user_invitations ALTER COLUMN role SET DEFAULT 'resident';
