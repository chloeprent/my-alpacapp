-- =============================================
-- ADD SPARTAN SPACE TAGS
-- AlpacApps Infra - Migration 007
-- =============================================
-- Run this in your Supabase SQL Editor
-- Adds Spartan-related space tags for media tagging
-- =============================================

INSERT INTO media_tags (name, tag_group, color, description)
SELECT 'spartan-trailer', 'space', '#F59E0B', 'Spartan Trailer (parent)'
WHERE NOT EXISTS (SELECT 1 FROM media_tags WHERE name = 'spartan-trailer');

INSERT INTO media_tags (name, tag_group, color, description)
SELECT 'spartan-fishbowl', 'space', '#F59E0B', 'Spartan Fishbowl room'
WHERE NOT EXISTS (SELECT 1 FROM media_tags WHERE name = 'spartan-fishbowl');

INSERT INTO media_tags (name, tag_group, color, description)
SELECT 'east-spartan', 'space', '#F59E0B', 'East Spartan room'
WHERE NOT EXISTS (SELECT 1 FROM media_tags WHERE name = 'east-spartan');

INSERT INTO media_tags (name, tag_group, color, description)
SELECT 'spartan-bath', 'space', '#F59E0B', 'Spartan Trailer bathroom'
WHERE NOT EXISTS (SELECT 1 FROM media_tags WHERE name = 'spartan-bath');

INSERT INTO media_tags (name, tag_group, color, description)
SELECT 'spartan-common', 'space', '#F59E0B', 'Spartan Trailer common area'
WHERE NOT EXISTS (SELECT 1 FROM media_tags WHERE name = 'spartan-common');
