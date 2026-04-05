-- =============================================
-- ADD SPARTAN SPACES
-- AlpacApps Infra - Migration 006
-- =============================================
-- Run this in your Supabase SQL Editor
-- Adds new Spartan Trailer spaces
-- =============================================

-- Step 1: Create Spartan Trailer as the parent space (if not exists)
INSERT INTO spaces (name, can_be_dwelling, is_listed, is_secret)
SELECT 'Spartan Trailer', true, true, false
WHERE NOT EXISTS (SELECT 1 FROM spaces WHERE name = 'Spartan Trailer');

-- Step 2: Add child spaces with Spartan Trailer as parent
INSERT INTO spaces (name, parent_id, can_be_dwelling, is_listed, is_secret)
SELECT 'Spartan Fishbowl', id, true, true, false FROM spaces WHERE name = 'Spartan Trailer'
AND NOT EXISTS (SELECT 1 FROM spaces WHERE name = 'Spartan Fishbowl');

INSERT INTO spaces (name, parent_id, can_be_dwelling, is_listed, is_secret)
SELECT 'East Spartan', id, true, true, false FROM spaces WHERE name = 'Spartan Trailer'
AND NOT EXISTS (SELECT 1 FROM spaces WHERE name = 'East Spartan');

INSERT INTO spaces (name, parent_id, can_be_dwelling, is_listed, is_secret)
SELECT 'Spartan Bath', id, false, false, false FROM spaces WHERE name = 'Spartan Trailer'
AND NOT EXISTS (SELECT 1 FROM spaces WHERE name = 'Spartan Bath');

INSERT INTO spaces (name, parent_id, can_be_dwelling, is_listed, is_secret)
SELECT 'Spartan Common', id, false, false, false FROM spaces WHERE name = 'Spartan Trailer'
AND NOT EXISTS (SELECT 1 FROM spaces WHERE name = 'Spartan Common');
