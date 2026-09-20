-- Payout workflow: outstanding/paid war state and per-member payment tracking.

ALTER TABLE wars ADD COLUMN payout_status TEXT NOT NULL DEFAULT 'outstanding';
ALTER TABLE wars ADD COLUMN payout_confirmed_at INTEGER;
ALTER TABLE wars ADD COLUMN payout_confirmed_by_user_id INTEGER;
ALTER TABLE wars ADD COLUMN payout_snapshot_json TEXT;

CREATE TABLE IF NOT EXISTS payout_member_payments (
  faction_id INTEGER NOT NULL,
  war_id TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  paid_at INTEGER NOT NULL,
  paid_by_user_id INTEGER NOT NULL,
  PRIMARY KEY (faction_id, war_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_payout_member_payments_war
ON payout_member_payments(faction_id, war_id);
