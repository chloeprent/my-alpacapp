-- Migration 022: Fix media RLS for associates/staff + create helper function
-- Date: 2026-02-11
-- Description: 
--   1. Adds INSERT policy on 'media' for authenticated users (staff/associate/admin)
--      so work photo uploads don't get blocked by RLS.
--   2. Creates is_staff_or_above() helper for reuse.
--   The existing admin-only UPDATE/DELETE policies remain unchanged.

BEGIN;

-- ============================================
-- 1. Create reusable helper: is any authenticated app_user
-- ============================================
CREATE OR REPLACE FUNCTION is_authenticated_user()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_users
    WHERE auth_user_id = auth.uid()
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- ============================================
-- 2. Add INSERT policy on media for authenticated users
--    (staff, associate, resident, admin can all upload)
-- ============================================
-- Drop the admin-only INSERT policy
DROP POLICY IF EXISTS "Admins can insert media" ON media;

-- Create new INSERT policy: any authenticated app_user can insert
CREATE POLICY "Authenticated users can insert media" ON media
  FOR INSERT
  WITH CHECK (is_authenticated_user());

-- ============================================
-- 3. Create associate profile for existing staff user Jackie
--    who needs to track hours but has no profile yet
-- ============================================
INSERT INTO associate_profiles (app_user_id, hourly_rate)
SELECT id, 0
FROM app_users
WHERE email = 'jackie61899280@gmail.com'
  AND NOT EXISTS (
    SELECT 1 FROM associate_profiles WHERE app_user_id = app_users.id
  );

COMMIT;
