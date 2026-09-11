/*
  D1 post-migration benchmark / query-plan checks.

  Replace the sample values before running manually in the D1 console.
  These statements are read-only.

  Suggested values:
    :faction_id -> a tracked faction, e.g. 53933
    :war_id     -> an imported war for that faction
    :player_id  -> a current member
    :from_ts    -> period start
    :to_ts      -> period end
*/

/* ---------------------------------------------------------
   1. Confirm staged analytics indexes exist.
--------------------------------------------------------- */

SELECT name, sql
FROM sqlite_master
WHERE type = 'index'
  AND name IN (
    'idx_attacks_faction_war_attacker',
    'idx_attacks_faction_war_defender',
    'idx_member_snapshots_faction_player_time',
    'idx_war_log_faction_war_player'
  )
ORDER BY name;

/* ---------------------------------------------------------
   2. One-war outgoing attack aggregation.

   Desired plan:
   use idx_attacks_faction_war_attacker or an equivalent
   faction_id + war_id index. Avoid a broad attacks scan.
--------------------------------------------------------- */

EXPLAIN QUERY PLAN
SELECT
  attacker_id,
  COUNT(*) AS outgoing_rows,
  SUM(COALESCE(respect_gain, 0)) AS respect_earned
FROM attacks
WHERE faction_id = :faction_id
  AND war_id = :war_id
  AND attacker_id IS NOT NULL
GROUP BY attacker_id;

/* ---------------------------------------------------------
   3. One-war incoming attack aggregation.

   Desired plan:
   use idx_attacks_faction_war_defender or equivalent.
--------------------------------------------------------- */

EXPLAIN QUERY PLAN
SELECT
  defender_id,
  COUNT(*) AS incoming_rows,
  SUM(ABS(COALESCE(respect_loss, 0))) AS respect_lost
FROM attacks
WHERE faction_id = :faction_id
  AND war_id = :war_id
  AND defender_id IS NOT NULL
GROUP BY defender_id;

/* ---------------------------------------------------------
   4. Intel snapshot history for one member.

   Desired plan:
   idx_member_snapshots_faction_player_time.
--------------------------------------------------------- */

EXPLAIN QUERY PLAN
SELECT *
FROM member_snapshots
WHERE faction_id = :faction_id
  AND player_id = :player_id
  AND snapshot_at >= :from_ts
ORDER BY snapshot_at;

/* ---------------------------------------------------------
   5. War-log lookup for one member/war.

   Desired plan:
   idx_war_log_faction_war_player.
--------------------------------------------------------- */

EXPLAIN QUERY PLAN
SELECT
  war_hits,
  outside_hits,
  assists,
  score_up,
  score_down
FROM war_log
WHERE faction_id = :faction_id
  AND war_id = :war_id
  AND player_id = :player_id;

/* ---------------------------------------------------------
   6. Selected-war Intel respect path.

   This is the query shape introduced by PR #11.
   The planner should narrow attacks through selected war IDs.
--------------------------------------------------------- */

EXPLAIN QUERY PLAN
WITH selected_wars AS (
  SELECT war_id
  FROM wars
  WHERE faction_id = :faction_id
    AND COALESCE(end_timestamp, start_timestamp, imported_at, 0)
      BETWEEN :from_ts AND :to_ts
),
metrics AS (
  SELECT
    a.attacker_id AS player_id,
    SUM(COALESCE(a.respect_gain, 0)) AS respect_earned,
    0 AS respect_lost
  FROM attacks a
  JOIN selected_wars sw ON sw.war_id = a.war_id
  WHERE a.faction_id = :faction_id
    AND a.attacker_id IS NOT NULL
  GROUP BY a.attacker_id

  UNION ALL

  SELECT
    a.defender_id AS player_id,
    0 AS respect_earned,
    SUM(ABS(COALESCE(a.respect_loss, 0))) AS respect_lost
  FROM attacks a
  JOIN selected_wars sw ON sw.war_id = a.war_id
  WHERE a.faction_id = :faction_id
    AND a.defender_id IS NOT NULL
  GROUP BY a.defender_id
)
SELECT
  player_id,
  SUM(respect_earned) AS respect_earned,
  SUM(respect_lost) AS respect_lost
FROM metrics
GROUP BY player_id;

/* ---------------------------------------------------------
   7. Optional real execution samples.

   Only run these once normal access is restored and you are
   deliberately measuring rows-read in Cloudflare analytics.

   They intentionally mirror the EXPLAIN queries above.
--------------------------------------------------------- */

/*
SELECT
  attacker_id,
  COUNT(*) AS outgoing_rows,
  SUM(COALESCE(respect_gain, 0)) AS respect_earned
FROM attacks
WHERE faction_id = :faction_id
  AND war_id = :war_id
  AND attacker_id IS NOT NULL
GROUP BY attacker_id;
*/

/*
SELECT *
FROM member_snapshots
WHERE faction_id = :faction_id
  AND player_id = :player_id
  AND snapshot_at >= :from_ts
ORDER BY snapshot_at;
*/

/* ---------------------------------------------------------
   Interpretation

   Good:
   SEARCH attacks USING INDEX idx_attacks_faction_war_attacker (...)
   SEARCH attacks USING INDEX idx_attacks_faction_war_defender (...)
   SEARCH member_snapshots USING INDEX idx_member_snapshots_faction_player_time (...)
   SEARCH war_log USING INDEX idx_war_log_faction_war_player (...)

   Suspicious:
   SCAN attacks
   SCAN member_snapshots
   SCAN war_log

   A temp B-tree for GROUP BY may still appear and is not by itself a problem.
--------------------------------------------------------- */
