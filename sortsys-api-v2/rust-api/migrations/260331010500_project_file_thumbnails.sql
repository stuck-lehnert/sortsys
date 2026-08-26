ALTER TABLE project_files
ADD COLUMN IF NOT EXISTS thumbnail_status TEXT NOT NULL DEFAULT 'none' CHECK (
  thumbnail_status IN ('none', 'queued', 'processing', 'ready', 'failed')
),
ADD COLUMN IF NOT EXISTS thumbnail_object_key TEXT,
ADD COLUMN IF NOT EXISTS thumbnail_mime_type TEXT,
ADD COLUMN IF NOT EXISTS thumbnail_width INTEGER CHECK (
  thumbnail_width IS NULL
  OR thumbnail_width > 0
),
ADD COLUMN IF NOT EXISTS thumbnail_height INTEGER CHECK (
  thumbnail_height IS NULL
  OR thumbnail_height > 0
),
ADD COLUMN IF NOT EXISTS thumbnail_size_bytes BIGINT CHECK (
  thumbnail_size_bytes IS NULL
  OR thumbnail_size_bytes >= 0
),
ADD COLUMN IF NOT EXISTS thumbnail_etag TEXT,
ADD COLUMN IF NOT EXISTS thumbnail_generated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_project_files_thumbnail_status ON project_files (thumbnail_status);

CREATE INDEX IF NOT EXISTS idx_project_files_thumbnail_object_key ON project_files (thumbnail_object_key);
