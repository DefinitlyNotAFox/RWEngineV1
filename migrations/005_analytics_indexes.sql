PRAGMA foreign_keys = ON;

/*
  Analytics access paths.

  The application reads attack metrics by faction + imported war and then
  groups by attacker or defender. These indexes avoid falling back to broad
  faction scans as the attacks table grows.
*/

CREATE INDEX IF NOT EXISTS idx_attacks_faction_war_attacker
ON attacks(faction_id, war_id, attacker_id);

CREATE INDEX IF NOT EXISTS idx_attacks_faction_war_defender
ON attacks(faction_id, war_id, defender_id);

CREATE INDEX IF NOT EXISTS idx_member_snapshots_faction_player_time
ON member_snapshots(faction_id, player_id, snapshot_at);

CREATE INDEX IF NOT EXISTS idx_war_log_faction_war_player
ON war_log(faction_id, war_id, player_id);
