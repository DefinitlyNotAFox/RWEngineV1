/*
  STAGED DESIGN ONLY.
  Do not apply to production until post-PR#11 D1 telemetry is reviewed.

  One immutable-ish analytics row per faction member per imported war.
  The source-of-truth remains wars / war_log / attacks. This table is a
  derived read model for Intel, Performance and report summaries.
*/

CREATE TABLE IF NOT EXISTS war_member_metrics (
  faction_id INTEGER NOT NULL,
  war_id TEXT NOT NULL,
  player_id INTEGER NOT NULL,

  player_name TEXT,

  /* participation / output */
  war_hits INTEGER NOT NULL DEFAULT 0,
  outside_hits INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,

  /* respect */
  respect_earned REAL NOT NULL DEFAULT 0,
  respect_lost REAL NOT NULL DEFAULT 0,

  /* ranked-war score */
  score_up_official REAL NOT NULL DEFAULT 0,
  score_up_adjusted REAL NOT NULL DEFAULT 0,
  score_down REAL NOT NULL DEFAULT 0,

  /* chain decomposition */
  chain_bonus_hits_out INTEGER NOT NULL DEFAULT 0,
  chain_bonus_score_out REAL NOT NULL DEFAULT 0,
  chain_bonus_hits_in INTEGER NOT NULL DEFAULT 0,
  chain_bonus_score_in REAL NOT NULL DEFAULT 0,
  chain_bonus_respect_lost_in REAL NOT NULL DEFAULT 0,

  /* source/coverage diagnostics */
  outgoing_attack_rows INTEGER NOT NULL DEFAULT 0,
  incoming_attack_rows INTEGER NOT NULL DEFAULT 0,
  attack_detail_complete INTEGER NOT NULL DEFAULT 0,

  metric_version INTEGER NOT NULL DEFAULT 1,
  computed_at INTEGER NOT NULL,

  PRIMARY KEY (faction_id, war_id, player_id),

  FOREIGN KEY (faction_id) REFERENCES factions(faction_id),
  FOREIGN KEY (war_id) REFERENCES wars(war_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wmm_faction_player_war
ON war_member_metrics(faction_id, player_id, war_id);

CREATE INDEX IF NOT EXISTS idx_wmm_faction_war
ON war_member_metrics(faction_id, war_id);

/*
  Recommended rebuild query for one war.

  The application should run this through prepared statements and then UPSERT
  the result into war_member_metrics. The exact SQL may be split into smaller
  statements if D1 query planning proves better that way.
*/

WITH
own AS (
  SELECT
    wl.faction_id,
    wl.war_id,
    wl.player_id,
    wl.player_name,
    COALESCE(wl.war_hits, 0) AS war_hits,
    COALESCE(wl.outside_hits, 0) AS outside_hits,
    COALESCE(wl.assists, 0) AS war_log_assists,
    COALESCE(wl.score_up_official, wl.score_up, 0) AS score_up_official,
    COALESCE(wl.score_up_adjusted, wl.score_up, 0) AS score_up_adjusted,
    COALESCE(wl.score_down, 0) AS score_down
  FROM war_log wl
  WHERE wl.faction_id = :faction_id
    AND wl.war_id = :war_id
),
outgoing AS (
  SELECT
    a.attacker_id AS player_id,

    SUM(
      CASE
        WHEN LOWER(TRIM(COALESCE(a.result, ''))) LIKE '%assist%'
        THEN 1 ELSE 0
      END
    ) AS assists,

    SUM(
      CASE
        WHEN LOWER(TRIM(COALESCE(a.result, ''))) NOT LIKE '%assist%'
        THEN COALESCE(a.respect_gain, 0)
        ELSE 0
      END
    ) AS respect_earned,

    COUNT(*) AS outgoing_attack_rows,

    SUM(
      CASE
        WHEN (
          a.chain IN (10,25,50,100,250,500,1000,2500,5000,10000,25000,50000,100000)
          OR COALESCE(CAST(json_extract(a.raw_json, '$.modifiers.chain') AS REAL), 0) >= 2
        )
        AND LOWER(TRIM(COALESCE(a.result, ''))) NOT LIKE '%assist%'
        THEN 1 ELSE 0
      END
    ) AS chain_bonus_hits_out,

    SUM(
      CASE
        WHEN (
          a.chain IN (10,25,50,100,250,500,1000,2500,5000,10000,25000,50000,100000)
          OR COALESCE(CAST(json_extract(a.raw_json, '$.modifiers.chain') AS REAL), 0) >= 2
        )
        AND LOWER(TRIM(COALESCE(a.result, ''))) NOT LIKE '%assist%'
        THEN COALESCE(a.respect_gain, 0)
        ELSE 0
      END
    ) AS chain_bonus_score_out

  FROM attacks a
  WHERE a.faction_id = :faction_id
    AND a.war_id = :war_id
    AND a.attacker_id IS NOT NULL
  GROUP BY a.attacker_id
),
incoming AS (
  SELECT
    a.defender_id AS player_id,

    SUM(
      CASE
        WHEN LOWER(TRIM(COALESCE(a.result, ''))) NOT LIKE '%assist%'
        THEN ABS(COALESCE(a.respect_loss, 0))
        ELSE 0
      END
    ) AS respect_lost,

    COUNT(*) AS incoming_attack_rows,

    SUM(
      CASE
        WHEN (
          a.chain IN (10,25,50,100,250,500,1000,2500,5000,10000,25000,50000,100000)
          OR COALESCE(CAST(json_extract(a.raw_json, '$.modifiers.chain') AS REAL), 0) >= 2
        )
        AND LOWER(TRIM(COALESCE(a.result, ''))) NOT LIKE '%assist%'
        THEN 1 ELSE 0
      END
    ) AS chain_bonus_hits_in,

    SUM(
      CASE
        WHEN (
          a.chain IN (10,25,50,100,250,500,1000,2500,5000,10000,25000,50000,100000)
          OR COALESCE(CAST(json_extract(a.raw_json, '$.modifiers.chain') AS REAL), 0) >= 2
        )
        AND LOWER(TRIM(COALESCE(a.result, ''))) NOT LIKE '%assist%'
        THEN COALESCE(a.respect_gain, 0)
        ELSE 0
      END
    ) AS chain_bonus_score_in,

    SUM(
      CASE
        WHEN (
          a.chain IN (10,25,50,100,250,500,1000,2500,5000,10000,25000,50000,100000)
          OR COALESCE(CAST(json_extract(a.raw_json, '$.modifiers.chain') AS REAL), 0) >= 2
        )
        AND LOWER(TRIM(COALESCE(a.result, ''))) NOT LIKE '%assist%'
        THEN ABS(COALESCE(a.respect_loss, 0))
        ELSE 0
      END
    ) AS chain_bonus_respect_lost_in

  FROM attacks a
  WHERE a.faction_id = :faction_id
    AND a.war_id = :war_id
    AND a.defender_id IS NOT NULL
  GROUP BY a.defender_id
)
SELECT
  own.faction_id,
  own.war_id,
  own.player_id,
  own.player_name,
  own.war_hits,
  own.outside_hits,
  COALESCE(outgoing.assists, own.war_log_assists, 0) AS assists,
  COALESCE(outgoing.respect_earned, 0) AS respect_earned,
  COALESCE(incoming.respect_lost, 0) AS respect_lost,
  own.score_up_official,
  own.score_up_adjusted,
  own.score_down,
  COALESCE(outgoing.chain_bonus_hits_out, 0) AS chain_bonus_hits_out,
  COALESCE(outgoing.chain_bonus_score_out, 0) AS chain_bonus_score_out,
  COALESCE(incoming.chain_bonus_hits_in, 0) AS chain_bonus_hits_in,
  COALESCE(incoming.chain_bonus_score_in, 0) AS chain_bonus_score_in,
  COALESCE(incoming.chain_bonus_respect_lost_in, 0) AS chain_bonus_respect_lost_in,
  COALESCE(outgoing.outgoing_attack_rows, 0) AS outgoing_attack_rows,
  COALESCE(incoming.incoming_attack_rows, 0) AS incoming_attack_rows
FROM own
LEFT JOIN outgoing ON outgoing.player_id = own.player_id
LEFT JOIN incoming ON incoming.player_id = own.player_id;

/*
  Lifecycle

  1. ranked-war import creates/updates wars + war_log.
  2. attack-detail verification finishes for the war.
  3. rebuild war_member_metrics for that war only.
  4. chain adjustment changes score fields -> rebuild that war only.
  5. overwrite/reimport -> delete metrics for the war, then rebuild.
  6. deleting a war cascades metrics through the war foreign key.

  The table should never be incrementally patched attack-by-attack. Rebuilding
  one imported war is cheap, deterministic, and much easier to reason about.
*/

/*
  Read-path examples

  Faction Intel, last four wars:

  SELECT
    player_id,
    COUNT(*) AS wars,
    SUM(war_hits) AS hits,
    SUM(assists) AS assists,
    SUM(respect_earned) AS respect_earned,
    SUM(respect_lost) AS respect_lost,
    SUM(score_up_adjusted) AS score_up,
    SUM(score_down) AS score_down
  FROM war_member_metrics
  WHERE faction_id = :faction_id
    AND war_id IN (:war_1, :war_2, :war_3, :war_4)
  GROUP BY player_id;

  Performance over a date range should join war_member_metrics to wars and
  aggregate the same small per-member/per-war rows. Raw attacks should only be
  needed for attack drill-down or rebuild/verification work.
*/

/*
  Adoption gate

  Do not merge this schema solely because it is cleaner.

  After PR #11 is deployed, compare production D1 analytics under normal use.

  Adopt war_member_metrics if any of the following remains true:
  - normal Intel / Performance requests still read tens of thousands of raw
    attack rows per request,
  - attack-table queries remain among the dominant daily D1 row-read consumers,
  - growth in imported wars causes roughly linear growth in normal page reads.

  If the optimized direct queries are comfortably cheap, keep this design
  staged and avoid another derived table until it earns its complexity.
*/
