-- =============================================
-- EXPOSE DWELLING SPACES BY DEFAULT
-- AlpacApps Infra - Migration 021
-- =============================================
-- Makes dwelling spaces public/listed by default,
-- with explicit secret exceptions.
-- =============================================

-- Step 1: expose dwelling spaces in public browsing
UPDATE spaces
SET is_listed = true,
    is_secret = false
WHERE can_be_dwelling = true;

-- Step 2: keep selected spaces secret
UPDATE spaces
SET is_secret = true,
    is_listed = true
WHERE lower(name) IN ('spartan trailer', 'fuego trailer', 'magic bus');
