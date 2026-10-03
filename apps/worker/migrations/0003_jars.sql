-- Mod jars uploaded with /mod upload or mc-host admin jar add. The bytes are in R2 at jars/<sha512>.jar.
CREATE TABLE jars (
  sha512 TEXT PRIMARY KEY,
  sha1 TEXT NOT NULL,
  size INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mod_id TEXT,
  version TEXT,
  minecraft_range TEXT,
  java_range TEXT,
  depends_json TEXT NOT NULL,
  -- Discord user ID, or "admin" for the CLI.
  uploaded_by TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);
