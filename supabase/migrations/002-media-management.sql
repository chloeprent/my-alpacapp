-- =============================================
-- MEDIA MANAGEMENT SYSTEM
-- AlpacApps Infra - Migration 002
-- =============================================
-- Run this in your Supabase SQL Editor
-- This creates a flexible media system with:
-- - Multi-provider storage (Supabase for images, GCS for videos)
-- - Flexible tagging for search/categorization
-- - Categories: mktg, projects, archive
-- =============================================

-- ============================================
-- STEP 1: Create media table (replaces photos)
-- ============================================
CREATE TABLE IF NOT EXISTS media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Storage info
  url TEXT NOT NULL,                              -- Public URL (Supabase or external)
  storage_provider TEXT DEFAULT 'supabase',       -- 'supabase', 'gcs', 'firebase', 'external'
  storage_path TEXT,                              -- Path within provider (for deletion)

  -- Media metadata
  media_type TEXT NOT NULL DEFAULT 'image',       -- 'image', 'video', 'document'
  mime_type TEXT,                                 -- 'image/jpeg', 'video/mp4', etc.
  file_size_bytes BIGINT,                         -- Track storage usage
  width INTEGER,                                  -- For images/video
  height INTEGER,
  duration_seconds INTEGER,                       -- For video/audio

  -- Descriptive metadata
  title TEXT,
  caption TEXT,
  alt_text TEXT,                                  -- Accessibility

  -- Categorization (simple top-level)
  category TEXT DEFAULT 'mktg' CHECK (category IN ('mktg', 'projects', 'archive')),

  -- Audit
  uploaded_by UUID REFERENCES app_users(id),
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),

  -- Soft delete for safety
  is_archived BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMPTZ
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_media_category ON media(category);
CREATE INDEX IF NOT EXISTS idx_media_type ON media(media_type);
CREATE INDEX IF NOT EXISTS idx_media_provider ON media(storage_provider);
CREATE INDEX IF NOT EXISTS idx_media_uploaded_at ON media(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_archived ON media(is_archived);

-- ============================================
-- STEP 2: Create flexible tagging system
-- ============================================
CREATE TABLE IF NOT EXISTS media_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,                      -- 'kitchen', 'before', 'listing'
  tag_group TEXT,                                 -- 'room', 'condition', 'purpose', 'project'
  color TEXT,                                     -- For UI display '#FF5733'
  description TEXT,                               -- Optional description
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_tags_name ON media_tags(name);
CREATE INDEX IF NOT EXISTS idx_media_tags_group ON media_tags(tag_group);

-- ============================================
-- STEP 3: Junction table - media <-> tags
-- ============================================
CREATE TABLE IF NOT EXISTS media_tag_assignments (
  media_id UUID REFERENCES media(id) ON DELETE CASCADE,
  tag_id UUID REFERENCES media_tags(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (media_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_media_tag_assignments_media ON media_tag_assignments(media_id);
CREATE INDEX IF NOT EXISTS idx_media_tag_assignments_tag ON media_tag_assignments(tag_id);

-- ============================================
-- STEP 4: Junction table - media <-> spaces
-- ============================================
CREATE TABLE IF NOT EXISTS media_spaces (
  media_id UUID REFERENCES media(id) ON DELETE CASCADE,
  space_id UUID REFERENCES spaces(id) ON DELETE CASCADE,
  display_order INTEGER DEFAULT 0,
  is_primary BOOLEAN DEFAULT FALSE,               -- Featured/thumbnail image
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (media_id, space_id)
);

CREATE INDEX IF NOT EXISTS idx_media_spaces_space ON media_spaces(space_id);
CREATE INDEX IF NOT EXISTS idx_media_spaces_order ON media_spaces(space_id, display_order);

-- ============================================
-- STEP 5: Storage usage tracking view
-- ============================================
CREATE OR REPLACE VIEW storage_usage AS
SELECT
  storage_provider,
  media_type,
  category,
  COUNT(*) as file_count,
  SUM(file_size_bytes) as total_bytes,
  ROUND(SUM(file_size_bytes) / 1048576.0, 2) as total_mb,
  ROUND(SUM(file_size_bytes) / 1073741824.0, 4) as total_gb
FROM media
WHERE is_archived = FALSE
GROUP BY storage_provider, media_type, category
ORDER BY total_bytes DESC;

-- ============================================
-- STEP 6: Insert default tags
-- ============================================

-- Purpose tags (what the media is used for)
INSERT INTO media_tags (name, tag_group, color, description) VALUES
  ('listing', 'purpose', '#22C55E', 'Active property listing photos'),
  ('social', 'purpose', '#E91E63', 'Social media content'),
  ('promo', 'purpose', '#9C27B0', 'Promotional materials'),
  ('website', 'purpose', '#2196F3', 'Website assets'),
  ('brochure', 'purpose', '#FF9800', 'Print materials'),
  ('featured', 'purpose', '#FFD700', 'Featured/hero images'),
  ('thumbnail', 'purpose', '#9333EA', 'Thumbnail images')
ON CONFLICT (name) DO NOTHING;

-- Space tags (location within property)
INSERT INTO media_tags (name, tag_group, color, description) VALUES
  ('house', 'space', '#8B4513', 'Main house/building'),
  ('front-yard', 'space', '#22C55E', 'Front yard area'),
  ('sparadise', 'space', '#06B6D4', 'Sparadise area'),
  ('garage-mahal', 'space', '#9333EA', 'Garage Mahal (Yoga/Fitness)'),
  ('backyard', 'space', '#84CC16', 'Backyard area'),
  ('outhouse', 'space', '#78716C', 'Outhouse'),
  ('front-porch', 'space', '#F59E0B', 'Front porch'),
  ('skyloft-balcony', 'space', '#3B82F6', 'Skyloft balcony'),
  ('kitchen', 'space', '#EF4444', 'Kitchen area'),
  ('living-room', 'space', '#10B981', 'Living room'),
  ('dining-room', 'space', '#EC4899', 'Dining room'),
  ('sauna', 'space', '#DC2626', 'Sauna'),
  ('swim-spa', 'space', '#0EA5E9', 'Swim spa'),
  ('deck', 'space', '#A78BFA', 'Deck area'),
  ('bathroom', 'space', '#60A5FA', 'Bathroom'),
  ('bedroom', 'space', '#8B5CF6', 'Bedroom'),
  ('exterior', 'space', '#6B7280', 'Exterior/outside'),
  ('common-area', 'space', '#F472B6', 'Shared/common areas'),
  ('garage', 'space', '#A1A1AA', 'Garage'),
  ('yard', 'space', '#65A30D', 'Yard/garden'),
  ('patio', 'space', '#14B8A6', 'Patio/deck')
ON CONFLICT (name) DO NOTHING;

-- Condition tags (state of the subject)
INSERT INTO media_tags (name, tag_group, color, description) VALUES
  ('before', 'condition', '#EF4444', 'Before renovation/work'),
  ('after', 'condition', '#22C55E', 'After renovation/work'),
  ('in-progress', 'condition', '#F97316', 'Work in progress'),
  ('needs-repair', 'condition', '#DC2626', 'Needs repair/attention')
ON CONFLICT (name) DO NOTHING;

-- Type tags (media content type)
INSERT INTO media_tags (name, tag_group, color, description) VALUES
  ('photo', 'type', '#3B82F6', 'Standard photograph'),
  ('video', 'type', '#EF4444', 'Video content'),
  ('drone', 'type', '#8B5CF6', 'Aerial/drone shot'),
  ('360', 'type', '#EC4899', '360-degree view'),
  ('floorplan', 'type', '#F97316', 'Floor plan or layout'),
  ('document', 'type', '#6B7280', 'Document or PDF')
ON CONFLICT (name) DO NOTHING;

-- Project tags (can be added dynamically)
INSERT INTO media_tags (name, tag_group, color, description) VALUES
  ('renovation-2025', 'project', '#0EA5E9', '2025 renovation project'),
  ('maintenance', 'project', '#F97316', 'General maintenance')
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- STEP 7: Enable RLS
-- ============================================
ALTER TABLE media ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_tag_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_spaces ENABLE ROW LEVEL SECURITY;

-- ============================================
-- STEP 8: RLS Policies for media
-- ============================================

-- Public can read non-archived media (for listings)
CREATE POLICY "Public read media" ON media
  FOR SELECT
  USING (is_archived = FALSE);

-- Admins can do everything
CREATE POLICY "Admins can insert media" ON media
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE auth_user_id = auth.uid()
      AND role = 'admin'
    )
  );

CREATE POLICY "Admins can update media" ON media
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE auth_user_id = auth.uid()
      AND role = 'admin'
    )
  );

CREATE POLICY "Admins can delete media" ON media
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE auth_user_id = auth.uid()
      AND role = 'admin'
    )
  );

-- ============================================
-- STEP 9: RLS Policies for media_tags
-- ============================================

-- Everyone can read tags
CREATE POLICY "Public read tags" ON media_tags
  FOR SELECT
  USING (true);

-- Only admins can manage tags
CREATE POLICY "Admins can insert tags" ON media_tags
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE auth_user_id = auth.uid()
      AND role = 'admin'
    )
  );

CREATE POLICY "Admins can update tags" ON media_tags
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE auth_user_id = auth.uid()
      AND role = 'admin'
    )
  );

CREATE POLICY "Admins can delete tags" ON media_tags
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE auth_user_id = auth.uid()
      AND role = 'admin'
    )
  );

-- ============================================
-- STEP 10: RLS Policies for media_tag_assignments
-- ============================================

-- Public can read tag assignments
CREATE POLICY "Public read tag assignments" ON media_tag_assignments
  FOR SELECT
  USING (true);

-- Admins can manage
CREATE POLICY "Admins can insert tag assignments" ON media_tag_assignments
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE auth_user_id = auth.uid()
      AND role = 'admin'
    )
  );

CREATE POLICY "Admins can delete tag assignments" ON media_tag_assignments
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE auth_user_id = auth.uid()
      AND role = 'admin'
    )
  );

-- ============================================
-- STEP 11: RLS Policies for media_spaces
-- ============================================

-- Public can read (for listings)
CREATE POLICY "Public read media_spaces" ON media_spaces
  FOR SELECT
  USING (true);

-- Admins can manage
CREATE POLICY "Admins can insert media_spaces" ON media_spaces
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE auth_user_id = auth.uid()
      AND role = 'admin'
    )
  );

CREATE POLICY "Admins can update media_spaces" ON media_spaces
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE auth_user_id = auth.uid()
      AND role = 'admin'
    )
  );

CREATE POLICY "Admins can delete media_spaces" ON media_spaces
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE auth_user_id = auth.uid()
      AND role = 'admin'
    )
  );

-- ============================================
-- STEP 12: Helper functions
-- ============================================

-- Function to get Supabase storage usage in bytes
CREATE OR REPLACE FUNCTION get_supabase_storage_bytes()
RETURNS BIGINT AS $$
  SELECT COALESCE(SUM(file_size_bytes), 0)
  FROM media
  WHERE storage_provider = 'supabase'
    AND is_archived = FALSE;
$$ LANGUAGE SQL STABLE;

-- Function to check if we're approaching storage limit
CREATE OR REPLACE FUNCTION check_storage_limit(limit_bytes BIGINT DEFAULT 1073741824) -- 1GB default
RETURNS TABLE (
  current_bytes BIGINT,
  limit_bytes BIGINT,
  percent_used NUMERIC,
  bytes_remaining BIGINT
) AS $$
  SELECT
    get_supabase_storage_bytes() as current_bytes,
    check_storage_limit.limit_bytes as limit_bytes,
    ROUND((get_supabase_storage_bytes()::NUMERIC / check_storage_limit.limit_bytes) * 100, 2) as percent_used,
    (check_storage_limit.limit_bytes - get_supabase_storage_bytes()) as bytes_remaining;
$$ LANGUAGE SQL STABLE;

-- ============================================
-- DONE!
-- Next: Run migration 003 to migrate existing photos
-- ============================================
