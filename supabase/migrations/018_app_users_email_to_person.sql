-- Migration 018: Single source of truth for email — app_users join to people only
-- - Backfill person_id for every app_user (create person from email if needed)
-- - Update handle_new_user() to set person_id instead of email
-- - Drop email column from app_users
-- Run in Supabase SQL Editor after 017.

-- ============================================
-- 1. Ensure person_id exists on app_users (if not already)
-- ============================================
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES people(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_app_users_person_id ON app_users(person_id);

-- ============================================
-- 2. Backfill person_id for all app_users
-- ============================================
DO $$
DECLARE
  r RECORD;
  pid UUID;
BEGIN
  FOR r IN
    SELECT id, email, display_name
    FROM app_users
    WHERE person_id IS NULL AND email IS NOT NULL AND TRIM(email) <> ''
  LOOP
    -- Find existing person by email (case-insensitive)
    SELECT id INTO pid
    FROM people
    WHERE LOWER(TRIM(email)) = LOWER(TRIM(r.email))
    LIMIT 1;

    IF pid IS NULL THEN
      -- Create person with this email
      INSERT INTO people (email, first_name, last_name)
      VALUES (
        r.email,
        COALESCE(SPLIT_PART(r.display_name, ' ', 1), 'Unknown'),
        NULLIF(TRIM(SUBSTRING(r.display_name FROM POSITION(' ' IN COALESCE(r.display_name, ' ') + 1))), '')
      )
      RETURNING id INTO pid;
    END IF;

    UPDATE app_users SET person_id = pid WHERE id = r.id;
  END LOOP;
END $$;

-- ============================================
-- 3. Trigger: create app_user with person_id (find/create person by auth email)
-- ============================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  invitation_record user_invitations%ROWTYPE;
  pid UUID;
  inv_email TEXT;
BEGIN
  inv_email := LOWER(TRIM(NEW.email));

  -- Check for a pending invitation for this email
  SELECT * INTO invitation_record
  FROM user_invitations
  WHERE LOWER(TRIM(email)) = inv_email
    AND status = 'pending'
    AND expires_at > NOW()
  LIMIT 1;

  IF invitation_record.id IS NOT NULL THEN
    -- Find or create person by email
    SELECT id INTO pid FROM people WHERE LOWER(TRIM(email)) = inv_email LIMIT 1;
    IF pid IS NULL THEN
      INSERT INTO people (email, first_name, last_name)
      VALUES (
        NEW.email,
        COALESCE(SPLIT_PART(NEW.raw_user_meta_data->>'full_name', ' ', 1), 'Unknown'),
        NULLIF(TRIM(SUBSTRING(COALESCE(NEW.raw_user_meta_data->>'full_name', '') FROM POSITION(' ' IN COALESCE(NEW.raw_user_meta_data->>'full_name', ' ') + 1))), '')
      )
      RETURNING id INTO pid;
    END IF;

    INSERT INTO app_users (auth_user_id, person_id, display_name, role, invited_by)
    VALUES (
      NEW.id,
      pid,
      COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
      invitation_record.role,
      invitation_record.invited_by
    );

    UPDATE user_invitations SET status = 'accepted' WHERE id = invitation_record.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 4. Drop email column from app_users
-- ============================================
ALTER TABLE app_users DROP COLUMN IF EXISTS email;
DROP INDEX IF EXISTS idx_app_users_email;
