PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

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

  chain_adjusted_at INTEGER,
  chain_adjustment_status TEXT,
  chain_adjustment_message TEXT,

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

  /*
    score_up is the dashboard-facing score.
    Before chain adjustment it matches the official ranked-war score.
    After adjustment it matches score_up_adjusted.
  */
  score_up REAL NOT NULL DEFAULT 0,
  score_up_official REAL NOT NULL DEFAULT 0,
  score_up_adjusted REAL NOT NULL DEFAULT 0,
  score_down REAL NOT NULL DEFAULT 0,

  chain_bonus_score REAL NOT NULL DEFAULT 0,
  chain_bonus_hits INTEGER NOT NULL DEFAULT 0,

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

/* =========================
   FACTION INTELLIGENCE CORE
========================= */

CREATE TABLE IF NOT EXISTS faction_members (
  faction_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,

  player_name TEXT NOT NULL,
  level INTEGER,
  position_name TEXT,
  days_in_faction INTEGER,
  status_json TEXT,

  is_current INTEGER NOT NULL DEFAULT 1,

  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  left_at INTEGER,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (faction_id, player_id),
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

CREATE TABLE IF NOT EXISTS member_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,

  faction_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  snapshot_date TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,

  player_name TEXT NOT NULL,
  level INTEGER,
  position_name TEXT,

  last_action_at INTEGER,
  last_action_status TEXT,
  status_state TEXT,
  status_until INTEGER,

  activity_total_seconds INTEGER,
  xanax_taken_total INTEGER,

  battle_stats_estimate REAL,
  battle_stats_source TEXT,
  battle_stats_observed_at INTEGER,

  error_text TEXT,
  raw_json TEXT,
  created_at INTEGER NOT NULL,

  UNIQUE(faction_id, player_id, snapshot_date),
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

CREATE TABLE IF NOT EXISTS faction_sync_jobs (
  job_id INTEGER PRIMARY KEY AUTOINCREMENT,
  faction_id INTEGER NOT NULL,
  requested_by_user_id INTEGER NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'manual',

  status TEXT NOT NULL DEFAULT 'queued',
  phase TEXT NOT NULL DEFAULT 'initializing',
  seed_history INTEGER NOT NULL DEFAULT 0,

  members_total INTEGER NOT NULL DEFAULT 0,
  tasks_total INTEGER NOT NULL DEFAULT 0,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  tasks_failed INTEGER NOT NULL DEFAULT 0,
  api_requests INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  lease_until INTEGER,
  error_text TEXT,

  FOREIGN KEY (faction_id) REFERENCES factions(faction_id),
  FOREIGN KEY (requested_by_user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS faction_sync_tasks (
  task_id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  task_key TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  snapshot_date TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  historical_timestamp INTEGER,

  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_text TEXT,
  updated_at INTEGER NOT NULL,

  UNIQUE(job_id, task_key),
  FOREIGN KEY (job_id) REFERENCES faction_sync_jobs(job_id) ON DELETE CASCADE
);

/* =========================
   INDEXES
========================= */

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

CREATE INDEX IF NOT EXISTS idx_attacks_faction_war_attacker
ON attacks(faction_id, war_id, attacker_id);

CREATE INDEX IF NOT EXISTS idx_attacks_faction_war_defender
ON attacks(faction_id, war_id, defender_id);

CREATE INDEX IF NOT EXISTS idx_faction_members_faction_current
ON faction_members(faction_id, is_current);

CREATE INDEX IF NOT EXISTS idx_faction_members_player
ON faction_members(player_id);

CREATE INDEX IF NOT EXISTS idx_member_snapshots_faction_time
ON member_snapshots(faction_id, snapshot_at);

CREATE INDEX IF NOT EXISTS idx_member_snapshots_player_time
ON member_snapshots(player_id, snapshot_at);

CREATE INDEX IF NOT EXISTS idx_member_snapshots_faction_player_time
ON member_snapshots(faction_id, player_id, snapshot_at);

CREATE INDEX IF NOT EXISTS idx_war_log_faction_war_player
ON war_log(faction_id, war_id, player_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_faction_sync_jobs_active
ON faction_sync_jobs(faction_id)
WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_faction_sync_jobs_recent
ON faction_sync_jobs(faction_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_faction_sync_tasks_pending
ON faction_sync_tasks(job_id, status, task_id);


/* =========================
   PUBLIC SHARE LINKS
========================= */

CREATE TABLE IF NOT EXISTS share_links (
  share_id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  faction_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,

  UNIQUE(owner_user_id, faction_id, resource_type, resource_key),

  FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

CREATE INDEX IF NOT EXISTS idx_share_links_token
ON share_links(token_hash, is_enabled);

CREATE INDEX IF NOT EXISTS idx_share_links_owner
ON share_links(owner_user_id, faction_id, resource_type, updated_at DESC);


/* =========================
   RESOURCE VISIBILITY
========================= */

CREATE TABLE IF NOT EXISTS resource_permissions (
  permission_id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  faction_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'faction'
    CHECK (visibility IN ('private', 'faction', 'public')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE(faction_id, resource_type, resource_key),

  FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_permissions_lookup
ON resource_permissions(faction_id, resource_type, resource_key);

CREATE INDEX IF NOT EXISTS idx_resource_permissions_owner
ON resource_permissions(owner_user_id, faction_id, updated_at DESC);


/* =========================
   SAVED ANALYSIS SNAPSHOTS
========================= */

CREATE TABLE IF NOT EXISTS analysis_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  faction_id INTEGER NOT NULL,
  target_player_id INTEGER NOT NULL,
  target_player_name TEXT NOT NULL,
  report_type TEXT NOT NULL DEFAULT 'player-analysis',
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,

  FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

CREATE INDEX IF NOT EXISTS idx_analysis_snapshots_owner_created
ON analysis_snapshots(owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analysis_snapshots_faction_created
ON analysis_snapshots(faction_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analysis_snapshots_target
ON analysis_snapshots(faction_id, target_player_id, created_at DESC);
