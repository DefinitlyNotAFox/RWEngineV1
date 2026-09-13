PRAGMA foreign_keys = ON;

/*
  Analytics access paths.

  Raw attacks are no longer persisted. Analytics read finalized member totals
  from war_log and roster history from member_snapshots.
*/

CREATE INDEX IF NOT EXISTS idx_member_snapshots_faction_player_time
ON member_snapshots(faction_id, player_id, snapshot_at);

CREATE INDEX IF NOT EXISTS idx_war_log_faction_war_player
ON war_log(faction_id, war_id, player_id);
