-- Add archive flag to spaces for soft delete
-- Archived spaces are hidden from normal views but remain in the database

ALTER TABLE spaces ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;

-- Index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_spaces_archived ON spaces(is_archived) WHERE is_archived = true;

-- Comment for documentation
COMMENT ON COLUMN spaces.is_archived IS 'Soft delete flag - archived spaces are hidden but recoverable';
