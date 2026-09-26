CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  mc_version TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  lockfile_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  pregen_done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- At most one active world.
CREATE UNIQUE INDEX worlds_one_active ON worlds (status) WHERE status = 'active';

CREATE TABLE snapshots (
  world_id TEXT NOT NULL REFERENCES worlds (id),
  rev INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, rev)
);

CREATE TABLE users (
  discord_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- A single row; holder_id IS NULL means nobody is hosting.
CREATE TABLE lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder_id TEXT REFERENCES users (discord_id),
  session_id TEXT,
  world_id TEXT,
  base_rev INTEGER,
  host_address TEXT,
  claimed_at INTEGER,
  expires_at INTEGER
);
INSERT INTO lease (id) VALUES (1);
