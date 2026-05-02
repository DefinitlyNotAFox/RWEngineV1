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

CREATE TABLE IF NOT EXISTS faction_config (
  config_id INTEGER PRIMARY KEY AUTOINCREMENT,

  faction_id INTEGER,
  config_key TEXT NOT NULL,
  config_value TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE(faction_id, config_key),
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

CREATE TABLE IF NOT EXISTS wars (
  war_id TEXT PRIMARY KEY,

  faction_id INTEGER NOT NULL,
  faction_name TEXT,

  opponent_faction_id INTEGER,
  opponent_faction_name TEXT,

  start_timestamp INTEGER,
  end_timestamp INTEGER,

  report_id TEXT,
  war_type TEXT NOT NULL DEFAULT 'ranked',

  imported_by_user_id INTEGER,
  imported_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (faction_id) REFERENCES factions(faction_id),
  FOREIGN KEY (imported_by_user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS war_log (
  war_log_id INTEGER PRIMARY KEY AUTOINCREMENT,

  war_id TEXT NOT NULL,
  faction_id INTEGER NOT NULL,

  player_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,

  is_member INTEGER NOT NULL DEFAULT 1,
  termed INTEGER NOT NULL DEFAULT 0,

  war_hits INTEGER NOT NULL DEFAULT 0,
  outside_hits INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,

  score_up REAL NOT NULL DEFAULT 0,
  score_down REAL NOT NULL DEFAULT 0,

  synced_at INTEGER NOT NULL,

  UNIQUE(war_id, player_id),

  FOREIGN KEY (war_id) REFERENCES wars(war_id) ON DELETE CASCADE,
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

CREATE TABLE IF NOT EXISTS attacks (
  attack_id TEXT PRIMARY KEY,

  war_id TEXT,
  faction_id INTEGER,

  attacker_id INTEGER,
  attacker_name TEXT,

  defender_id INTEGER,
  defender_name TEXT,

  attacker_faction_id INTEGER,
  defender_faction_id INTEGER,

  result TEXT,
  respect_gain REAL,
  respect_loss REAL,

  chain INTEGER,
  is_ranked_war INTEGER NOT NULL DEFAULT 0,

  timestamp_started INTEGER,
  timestamp_ended INTEGER,

  raw_json TEXT,

  created_at INTEGER NOT NULL,

  FOREIGN KEY (war_id) REFERENCES wars(war_id) ON DELETE CASCADE,
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

CREATE INDEX IF NOT EXISTS idx_wars_faction_id
ON wars(faction_id);

CREATE INDEX IF NOT EXISTS idx_wars_imported_at
ON wars(imported_at);

CREATE INDEX IF NOT EXISTS idx_war_log_war_id
ON war_log(war_id);

CREATE INDEX IF NOT EXISTS idx_war_log_faction_id
ON war_log(faction_id);

CREATE INDEX IF NOT EXISTS idx_war_log_player_id
ON war_log(player_id);

CREATE INDEX IF NOT EXISTS idx_attacks_war_id
ON attacks(war_id);

CREATE INDEX IF NOT EXISTS idx_attacks_faction_id
ON attacks(faction_id);

CREATE INDEX IF NOT EXISTS idx_attacks_attacker_id
ON attacks(attacker_id);

CREATE INDEX IF NOT EXISTS idx_attacks_defender_id
ON attacks(defender_id);

CREATE INDEX IF NOT EXISTS idx_attacks_timestamp_started
ON attacks(timestamp_started);
