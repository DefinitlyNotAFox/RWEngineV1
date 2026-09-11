PRAGMA foreign_keys = ON;

/*
  Immutable saved analytical reports.

  Player Analysis is the first consumer. Payloads are frozen server-generated
  snapshots so public links cannot silently change as live data changes.
*/

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
