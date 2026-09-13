-- Persist only finalized per-member attack aggregates.
-- New imports no longer retain individual attack rows.

ALTER TABLE war_log ADD COLUMN respect_earned REAL;
ALTER TABLE war_log ADD COLUMN respect_lost REAL;
ALTER TABLE war_log ADD COLUMN attack_detail_complete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE war_log ADD COLUMN attack_detail_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE war_log ADD COLUMN chain_bonus_hits_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE war_log ADD COLUMN chain_bonus_score_in REAL NOT NULL DEFAULT 0;
ALTER TABLE war_log ADD COLUMN chain_bonus_respect_lost_in REAL NOT NULL DEFAULT 0;
