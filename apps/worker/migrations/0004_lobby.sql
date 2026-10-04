-- Who a token is for: someone who hosts, or a lobby server. Lobby tokens can't host.
ALTER TABLE users ADD COLUMN scope TEXT NOT NULL DEFAULT 'host' CHECK (scope IN ('host', 'lobby'));

-- A single row; holder_id IS NULL means no lobby is running.
CREATE TABLE lobby_slot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder_id TEXT REFERENCES users (discord_id),
  machine TEXT,
  session_id TEXT,
  address TEXT,
  claimed_at INTEGER,
  expires_at INTEGER
);
INSERT INTO lobby_slot (id) VALUES (1);

-- The lobby folder (world, plugins, configs) zipped. The bytes are in R2 at lobby/<rev>-<uuid>.zip.
CREATE TABLE lobby_backups (
  rev INTEGER PRIMARY KEY,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
