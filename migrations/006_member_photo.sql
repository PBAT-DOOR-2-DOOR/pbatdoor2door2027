-- Custom profile photo stored as bytes on the member row (Postgres, so backups keep it).
-- Empty photo_mime means "no custom photo"; the Google picture is used instead.

ALTER TABLE members ADD COLUMN IF NOT EXISTS photo BYTEA;
ALTER TABLE members ADD COLUMN IF NOT EXISTS photo_mime TEXT NOT NULL DEFAULT '';
ALTER TABLE members ADD COLUMN IF NOT EXISTS photo_updated_at BIGINT;
