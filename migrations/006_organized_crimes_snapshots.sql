-- Start forward-only organized crime tracking.
-- Existing rows intentionally remain NULL; no historical backfill is performed.

ALTER TABLE member_snapshots
ADD COLUMN organized_crimes_total INTEGER;
