PRAGMA foreign_keys = ON;

/*
  Additive rebuild migration.

  This deliberately does not alter or delete the existing war tables.
  `users` remains authentication/account data. Faction members are modeled
  separately so RWEngine can track every member whether or not they use RWE.
*/

CREATE TABLE IF NOT EXISTS faction_members (
  faction_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,

  player_name TEXT NOT NULL,
  position_name TEXT,

  is_current INTEGER NOT NULL DEFAULT 1,

  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  left_at INTEGER,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (faction_id, player_id),
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

/*
  Daily/cadenced snapshots store raw cumulative member values where possible.
  Deltas such as Xanax/day and activity/day should be calculated from snapshots
  rather than permanently storing a derived value that can become inconsistent.
*/
CREATE TABLE IF NOT EXISTS member_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,

  faction_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
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

  raw_json TEXT,
  created_at INTEGER NOT NULL,

  UNIQUE(faction_id, player_id, snapshot_at),
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
);

CREATE INDEX IF NOT EXISTS idx_faction_members_faction_current
ON faction_members(faction_id, is_current);

CREATE INDEX IF NOT EXISTS idx_faction_members_player
ON faction_members(player_id);

CREATE INDEX IF NOT EXISTS idx_member_snapshots_faction_time
ON member_snapshots(faction_id, snapshot_at);

CREATE INDEX IF NOT EXISTS idx_member_snapshots_player_time
ON member_snapshots(player_id, snapshot_at);
