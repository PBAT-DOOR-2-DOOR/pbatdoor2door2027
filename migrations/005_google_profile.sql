-- Google account link and profile fields pulled from OAuth (picture, names, locale, hd).
-- Empty string means "not set"; applyGoogleProfile only fills blanks except google_id / picture.

ALTER TABLE members ADD COLUMN IF NOT EXISTS google_id TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS google_picture TEXT NOT NULL DEFAULT '';
ALTER TABLE members ADD COLUMN IF NOT EXISTS given_name TEXT NOT NULL DEFAULT '';
ALTER TABLE members ADD COLUMN IF NOT EXISTS family_name TEXT NOT NULL DEFAULT '';
ALTER TABLE members ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT '';
ALTER TABLE members ADD COLUMN IF NOT EXISTS hd TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS members_google_id_uq
  ON members (google_id) WHERE google_id IS NOT NULL AND google_id <> '';
