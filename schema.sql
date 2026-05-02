PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS factions (
  faction_id INTEGER PRIMARY KEY,
  faction_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,

  player_id INTEGER NOT NULL UNIQUE,
  player_name TEXT NOT NULL,

  faction_id INTEGER,
  faction_name TEXT,

  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,

  api_key_encrypted TEXT,
  api_key_iv TEXT,

  is_admin INTEGER NOT NULL DEFAULT 0,
  is_disabled INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,

  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,

  token_hash TEXT NOT NULL UNIQUE,

  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,

  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_users_player_id
ON users(player_id);

CREATE INDEX IF NOT EXISTS idx_users_faction_id
ON users(faction_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id
ON sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash
ON sessions(token_hash);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
ON sessions(expires_at);
