-- One pending /setup code per person. Only the code's sha256 is stored.
CREATE TABLE enrollments (
  discord_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('play', 'host')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- Set when the installer redeems the code; /enroll/device accepts it for 15 minutes after.
  used_at INTEGER
);

-- Tailnet devices the installer reported, so /tailnet revoke deletes exactly these.
CREATE TABLE devices (
  node_id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX devices_by_user ON devices (discord_id);
