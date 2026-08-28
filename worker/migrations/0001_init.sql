CREATE TABLE members (
  student_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  sound_object_key TEXT,
  sound_content_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('enter', 'leave')),
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'reader',
  device_id TEXT,
  idm TEXT,
  FOREIGN KEY (student_id) REFERENCES members(student_id)
);

CREATE INDEX visits_occurred_at_idx ON visits (occurred_at);
CREATE INDEX visits_student_occurred_idx ON visits (student_id, occurred_at);
