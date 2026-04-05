-- =============================================
-- RENAME ROOM TAG GROUP TO SPACE
-- AlpacApps Infra - Migration 004
-- =============================================
-- Run this in your Supabase SQL Editor
-- This renames "room" tag group to "space" and adds new space tags
-- =============================================

-- Step 1: Update existing "room" tags to "space"
UPDATE media_tags
SET tag_group = 'space'
WHERE tag_group = 'room';

-- Step 2: Add new space tags
INSERT INTO media_tags (name, tag_group, color, description) VALUES
  ('house', 'space', '#8B4513', 'Main house/building'),
  ('sparadise', 'space', '#06B6D4', 'Sparadise area'),
  ('garage-mahal', 'space', '#9333EA', 'Garage Mahal (Yoga/Fitness)'),
  ('backyard', 'space', '#84CC16', 'Backyard area'),
  ('outhouse', 'space', '#78716C', 'Outhouse'),
  ('front-yard', 'space', '#22C55E', 'Front yard area'),
  ('front-porch', 'space', '#F59E0B', 'Front porch'),
  ('skyloft-balcony', 'space', '#3B82F6', 'Skyloft balcony'),
  ('dining-room', 'space', '#EC4899', 'Dining room'),
  ('sauna', 'space', '#EF4444', 'Sauna'),
  ('swim-spa', 'space', '#0EA5E9', 'Swim spa'),
  ('deck', 'space', '#A78BFA', 'Deck area')
ON CONFLICT (name) DO NOTHING;

-- =============================================
-- DONE!
-- =============================================
