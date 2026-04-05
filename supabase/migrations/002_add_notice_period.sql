-- Migration: Add notice_period to rental_applications
-- Version: 002

ALTER TABLE rental_applications
  ADD COLUMN IF NOT EXISTS notice_period TEXT DEFAULT '30_days';

-- Values: 'none', '1_day', '1_week', '30_days', '60_days'
-- 'none' = fixed-length lease (no early termination)

COMMENT ON COLUMN rental_applications.notice_period IS 'Termination notice period: none, 1_day, 1_week, 30_days, 60_days';
