# D1 Re-entry checklist

Use this when production D1 becomes available again.

The goal is to validate the query-optimization work before enabling the staged Intel 2.0 / Player Analysis stack.

## 1. Snapshot production state

Before migrations:

- note current D1 database size,
- note rows read / rows written for the previous 24h if Cloudflare still exposes the window,
- capture the top expensive queries,
- record row counts for:
  - `wars`
  - `war_log`
  - `attacks`
  - `faction_members`
  - `member_snapshots`

Do not delete or rewrite historical data during this pass.

## 2. Apply additive migrations in order

Pending/important migrations:

1. `004_resource_permissions.sql`
2. `005_analytics_indexes.sql`
3. `006_analysis_snapshots.sql`

Earlier migrations should already exist in production. If deployment tooling reapplies them, they are written to be idempotent.

After applying migrations, confirm these indexes exist:

- `idx_attacks_faction_war_attacker`
- `idx_attacks_faction_war_defender`
- `idx_member_snapshots_faction_player_time`
- `idx_war_log_faction_war_player`

And these tables exist:

- `resource_permissions`
- `analysis_snapshots`

## 3. Verify PR #11 first

Before testing Intel 2.0, exercise the existing production pages under normal usage:

- Performance summary
- Performance detail
- one individual war report
- current Intel page
- one member drill-down

Then inspect Cloudflare D1 analytics.

The old problem queries were reading roughly hundreds of thousands of rows per request, including examples around:

- 851k rows read
- 493k rows read
- 379k rows read

Expected result after PR #11 + migration 005:

- no attacker/defender `OR` join should dominate the query list,
- individual war-report attack aggregation should scale with attacks in that war,
- Intel respect aggregation should scale with selected wars rather than all historical attacks.

## 4. Decision gate: war_member_metrics

Do **not** create `war_member_metrics` just because the design exists.

Enable the staged read model only if, after normal usage:

- Intel / Performance still read tens of thousands of raw attack rows per request,
- raw `attacks` queries remain a dominant daily D1 consumer,
- or rows-read grows approximately linearly with historical imported wars.

If direct queries are now comfortably cheap, keep the simpler model.

The staged design is in:

`docs/sql/war_member_metrics.sql`

## 5. Live-test Intel 2.0

Intel 2.0 is staged on draft PR #12.

Test in this order:

1. overview load,
2. current members only,
3. Needs attention filter,
4. inactive filter,
5. low participation filter,
6. missing/stale stats filter,
7. former-members filter,
8. search,
9. sorting,
10. open one member,
11. 30 / 60 / 90 day trends,
12. last-eight-war history,
13. faction sync,
14. admin faction switch.

Check semantic correctness, especially:

- missing values remain `—`, not zero,
- activity and Xanax compare current 30d vs previous 30d,
- participation compares last 4 vs previous 4 wars,
- incomplete coverage does not generate false decline signals,
- old battle-stat estimates are marked stale rather than treated as current.

## 6. Live-test Player Analysis

Player Analysis is staged on draft PR #13.

Test:

- local member by name,
- local member by ID,
- external player by ID,
- external player by name,
- Torn user-search failure fallback,
- missing API key behavior,
- Intel -> Analyze handoff,
- admin selected-faction behavior.

Privacy check:

A normal faction user must never receive snapshots or war history for a player merely because that player belongs to another faction tracked by RWEngine.

External players should return public Torn profile information only unless the viewer has permitted local history.

## 7. Saved/shared Player Analysis

Saved/shared reports are staged on draft PR #14.

Apply migration 006 before this test.

Verify:

- Save report creates a private immutable snapshot.
- Reopen returns the original saved values even if the live player changes.
- Private -> Faction works.
- Private/Faction -> Public creates an opaque public URL.
- Public -> Private/Faction invalidates the old URL immediately.
- New public link rotates the old token.
- Delete invalidates the link and removes the report.
- Settings shows both war reports and player-analysis reports.
- Public Player Analysis does not expose raw snapshot history/cumulative counters.

## 8. Promotion order

If live checks pass:

1. rebase / refresh PR #12 against current `main`,
2. merge Intel 2.0,
3. refresh PR #13 and merge Player Analysis,
4. refresh PR #14 and merge saved/shared reports.

Do not merge the stacked drafts out of order.

## Useful verification SQL

```sql
SELECT name, type
FROM sqlite_master
WHERE type IN ('table', 'index')
  AND name IN (
    'resource_permissions',
    'analysis_snapshots',
    'idx_attacks_faction_war_attacker',
    'idx_attacks_faction_war_defender',
    'idx_member_snapshots_faction_player_time',
    'idx_war_log_faction_war_player'
  )
ORDER BY type, name;
```

```sql
SELECT 'wars' AS table_name, COUNT(*) AS rows FROM wars
UNION ALL
SELECT 'war_log', COUNT(*) FROM war_log
UNION ALL
SELECT 'attacks', COUNT(*) FROM attacks
UNION ALL
SELECT 'faction_members', COUNT(*) FROM faction_members
UNION ALL
SELECT 'member_snapshots', COUNT(*) FROM member_snapshots;
```

## Stop conditions

Stop live testing before adding more features if:

- D1 rows-read starts climbing unexpectedly,
- a migration produces schema drift,
- Intel 2.0 makes materially more queries than current Intel,
- Player Analysis exposes cross-faction history,
- or public reports expose raw snapshot payloads.

Those failures are easier to fix on the staged branches than after promotion.
