-- =============================================
-- MIGRATE EXISTING PHOTOS TO MEDIA SYSTEM
-- AlpacApps Infra - Migration 003
-- =============================================
-- Run this AFTER 002-media-management.sql
-- This migrates data from photos/photo_spaces to new media tables
-- =============================================

-- ============================================
-- STEP 1: Get the 'listing' tag ID for assignment
-- ============================================
DO $$
DECLARE
  listing_tag_id UUID;
  photo_record RECORD;
  new_media_id UUID;
BEGIN
  -- Get the listing tag ID
  SELECT id INTO listing_tag_id FROM media_tags WHERE name = 'listing';

  -- Loop through existing photos and migrate
  FOR photo_record IN
    SELECT
      p.id as photo_id,
      p.url,
      p.caption,
      p.uploaded_by
    FROM photos p
  LOOP
    -- Insert into media table
    INSERT INTO media (
      id,  -- Keep same ID for easy reference
      url,
      storage_provider,
      storage_path,
      media_type,
      caption,
      category,
      uploaded_by,
      uploaded_at
    ) VALUES (
      photo_record.photo_id,
      photo_record.url,
      'supabase',
      -- Extract path from URL (after /housephotos/)
      CASE
        WHEN photo_record.url LIKE '%/housephotos/%'
        THEN substring(photo_record.url from '/housephotos/(.*)$')
        ELSE NULL
      END,
      'image',
      photo_record.caption,
      'mktg',  -- All existing photos are marketing
      photo_record.uploaded_by,
      NOW()
    )
    ON CONFLICT (id) DO NOTHING;

    -- Assign 'listing' tag to all migrated photos
    IF listing_tag_id IS NOT NULL THEN
      INSERT INTO media_tag_assignments (media_id, tag_id)
      VALUES (photo_record.photo_id, listing_tag_id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  RAISE NOTICE 'Migrated photos to media table';
END $$;

-- ============================================
-- STEP 2: Migrate photo_spaces to media_spaces
-- ============================================
INSERT INTO media_spaces (media_id, space_id, display_order, is_primary)
SELECT
  ps.photo_id as media_id,
  ps.space_id,
  ps.display_order,
  (ps.display_order = 0) as is_primary  -- First photo is primary
FROM photo_spaces ps
WHERE EXISTS (SELECT 1 FROM media WHERE id = ps.photo_id)
ON CONFLICT (media_id, space_id) DO NOTHING;

-- ============================================
-- STEP 3: Verify migration
-- ============================================
DO $$
DECLARE
  old_photo_count INTEGER;
  new_media_count INTEGER;
  old_link_count INTEGER;
  new_link_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO old_photo_count FROM photos;
  SELECT COUNT(*) INTO new_media_count FROM media;
  SELECT COUNT(*) INTO old_link_count FROM photo_spaces;
  SELECT COUNT(*) INTO new_link_count FROM media_spaces;

  RAISE NOTICE '=== Migration Summary ===';
  RAISE NOTICE 'Photos table: % records', old_photo_count;
  RAISE NOTICE 'Media table: % records', new_media_count;
  RAISE NOTICE 'Photo_spaces: % links', old_link_count;
  RAISE NOTICE 'Media_spaces: % links', new_link_count;

  IF old_photo_count = new_media_count AND old_link_count = new_link_count THEN
    RAISE NOTICE 'Migration successful!';
  ELSE
    RAISE WARNING 'Count mismatch - please verify manually';
  END IF;
END $$;

-- ============================================
-- STEP 4: Create view for backward compatibility
-- ============================================
-- This allows old code to keep working while you migrate
CREATE OR REPLACE VIEW photos_compat AS
SELECT
  id,
  url,
  caption,
  uploaded_by
FROM media
WHERE media_type = 'image';

CREATE OR REPLACE VIEW photo_spaces_compat AS
SELECT
  media_id as photo_id,
  space_id,
  display_order
FROM media_spaces;

-- ============================================
-- OPTIONAL: Drop old tables after full migration
-- ============================================
-- Only run these after you've updated all code to use new tables!
-- DROP TABLE IF EXISTS photo_spaces;
-- DROP TABLE IF EXISTS photos;

-- ============================================
-- DONE!
-- Old photos are now in the media system with:
-- - category: 'mktg'
-- - tag: 'listing'
-- ============================================
