PRAGMA foreign_keys = ON;

/* Current Torn-verified faction leadership, shared by Intel and reports. */
CREATE TABLE IF NOT EXISTS faction_leadership (
  faction_id INTEGER PRIMARY KEY,
  leader_player_id INTEGER,
  co_leader_player_id INTEGER,
  verified_at INTEGER NOT NULL,
  FOREIGN KEY (faction_id) REFERENCES factions(faction_id) ON DELETE CASCADE
);
