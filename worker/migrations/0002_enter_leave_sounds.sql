ALTER TABLE members ADD COLUMN enter_sound_key TEXT;
ALTER TABLE members ADD COLUMN enter_sound_type TEXT;
ALTER TABLE members ADD COLUMN leave_sound_key TEXT;
ALTER TABLE members ADD COLUMN leave_sound_type TEXT;

UPDATE members
SET enter_sound_key = sound_object_key,
    enter_sound_type = sound_content_type
WHERE sound_object_key IS NOT NULL;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO settings (key, value, updated_at) VALUES
  ('default_enter_sound_key', '', datetime('now')),
  ('default_enter_sound_type', '', datetime('now')),
  ('default_leave_sound_key', '', datetime('now')),
  ('default_leave_sound_type', '', datetime('now'));
