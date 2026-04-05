-- =============================================
-- ADD TYPE TAGS
-- AlpacApps Infra - Migration 005
-- =============================================
-- Run this in your Supabase SQL Editor
-- This adds "type" tag category for media content types
-- =============================================

-- Type tags (media content type)
INSERT INTO media_tags (name, tag_group, color, description) VALUES
  ('photo', 'type', '#3B82F6', 'Standard photograph'),
  ('video', 'type', '#EF4444', 'Video content'),
  ('drone', 'type', '#8B5CF6', 'Aerial/drone shot'),
  ('360', 'type', '#EC4899', '360-degree view'),
  ('floorplan', 'type', '#F97316', 'Floor plan or layout'),
  ('document', 'type', '#6B7280', 'Document or PDF')
ON CONFLICT (name) DO NOTHING;

-- =============================================
-- DONE!
-- =============================================
