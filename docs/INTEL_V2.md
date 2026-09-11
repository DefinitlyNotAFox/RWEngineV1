# Faction Intel 2.0

Status: design / implementation staging only.

This document defines the next Faction Intel contract. It is intentionally prepared off `main` while production D1 access is unavailable.

## Product goal

Faction Intel should answer management questions, not merely expose stored columns.

The overview must make it easy to see:

- who is active,
- who is training,
- who participates in ranked wars,
- whose recent behavior changed,
- where data is missing or stale,
- and which member deserves a closer look.

It should remain a dense roster, not become a dashboard of cards and invented scores.

## Window model

Intel 2.0 does **not** use one global period for unrelated metrics.

Default comparison windows:

| Metric | Current window | Comparison |
| --- | --- | --- |
| Last action | latest observation | none |
| Battle stats | latest comparable estimate | 30-day change when reliable |
| Activity | last 30 days | previous 30 days |
| Xanax | last 30 days | previous 30 days |
| RW participation | last 4 imported wars | previous 4 wars |
| Hits / war | last 4 imported wars | previous 4 wars |
| War net score | last 4 imported wars | previous 4 wars |

Member detail may expose longer 60 / 90 day history, but the overview stays standardized.

## Overview response

Proposed endpoint:

`POST /v2/intel`

Action: `overview`

Example shape:

```json
{
  "success": true,
  "generatedAt": 0,
  "faction": {
    "factionId": 0,
    "factionName": "Example"
  },
  "freshness": {
    "state": "fresh",
    "observedAt": 0,
    "ageSeconds": 0
  },
  "summary": {
    "currentMembers": 0,
    "knownBattleStats": 0,
    "medianBattleStats": null,
    "avgActivityPerDay30d": null,
    "avgXanaxPerDay30d": null,
    "avgParticipationLast4": null,
    "membersNeedingAttention": 0
  },
  "members": []
}
```

Each member:

```json
{
  "playerId": 0,
  "playerName": "Player",
  "level": 0,
  "position": "Member",
  "current": true,
  "daysInFaction": 0,

  "presence": {
    "lastActionAt": 0,
    "lastActionStatus": "Offline",
    "statusState": null,
    "statusUntil": null
  },

  "battleStats": {
    "value": null,
    "source": null,
    "verified": false,
    "observedAt": null,
    "ageSeconds": null,
    "change30d": null,
    "changePct30d": null,
    "trendReliable": false
  },

  "activity": {
    "perDay30d": null,
    "perDayPrevious30d": null,
    "changePct": null,
    "coverageDays": 0
  },

  "xanax": {
    "perDay30d": null,
    "perDayPrevious30d": null,
    "changePct": null,
    "coverageDays": 0
  },

  "war": {
    "last4": {
      "warsAvailable": 0,
      "warsParticipated": 0,
      "participation": null,
      "hits": 0,
      "hitsPerWar": null,
      "assists": 0,
      "respectEarned": 0,
      "respectLost": 0,
      "scoreUp": 0,
      "scoreDown": 0,
      "netScore": 0
    },
    "previous4": {
      "warsAvailable": 0,
      "warsParticipated": 0,
      "participation": null,
      "hits": 0,
      "hitsPerWar": null,
      "netScore": 0
    }
  },

  "coverage": {
    "snapshotDays60d": 0,
    "battleStatsKnown": false,
    "warHistoryAvailable": 0
  },

  "insights": []
}
```

## Member detail

Action: `member`

Inputs:

```json
{
  "action": "member",
  "playerId": 123
}
```

The detail response should contain:

1. identity / current status,
2. latest battle-stat observation,
3. 90 days of snapshot history at daily resolution,
4. activity and Xanax window comparisons,
5. last 8 imported wars for the member,
6. generated factual insights,
7. data-coverage notes.

The frontend should use this for one inline analytical drill-down. No modal and no separate profile-dashboard route initially.

## Insight model

Insights are factual observations. There is no composite RWEngine score.

Shape:

```json
{
  "code": "activity_down",
  "kind": "attention",
  "text": "Activity/day is 31% lower than the previous 30 days.",
  "metric": "activity",
  "value": 12400,
  "comparisonValue": 18000
}
```

Allowed `kind` values:

- `attention`: a meaningful negative or missing-data condition,
- `note`: useful neutral context,
- `positive`: clearly favorable factual comparison.

Kinds are presentation hints, not severity scores.

### Initial insight rules

#### inactive

Current members only.

Emit when latest action is at least 48 hours old.

Text uses the observed duration rather than judgement:

> No action recorded for 3 days.

This threshold should eventually be faction-configurable.

#### low_war_participation

Require at least 4 imported wars.

Emit when participation in the last 4 wars is 50% or lower.

Example:

> Participated in 1 of the last 4 wars.

#### participation_down

Require both current and previous 4-war windows.

Emit when participation drops by at least 50 percentage points.

Example:

> Participation fell from 100% to 50% versus the previous 4 wars.

#### activity_down

Require at least 21 days of usable coverage in both 30-day windows.

Emit when:

- current activity/day is at least 25% lower, and
- absolute decline is at least 1 hour/day.

#### activity_up

Same coverage requirement.

Emit when current activity/day is at least 30% higher and the increase is at least 1 hour/day.

#### xanax_down

Require at least 21 days of usable coverage in both windows.

Emit when:

- current Xanax/day is at least 25% lower, and
- absolute decline is at least 0.5 Xanax/day.

#### xanax_up

Same coverage requirement.

Emit when current Xanax/day is at least 25% higher and the increase is at least 0.5 Xanax/day.

#### missing_battle_stats

Emit when no current battle-stat estimate exists.

#### stale_battle_stats

Emit when a battle-stat estimate exists but was observed more than 21 days ago.

#### battle_stats_growth

Only emit when the beginning and end observations are comparable:

- same source family, or
- both observations are verified.

Require a positive change of at least 5%.

#### strong_war_output

Only for members with at least 3 participations in the last 4 wars.

Emit when:

- hits/war is at least 25% above faction median, and
- net score/war is positive.

This is deliberately based on faction-relative output rather than battle-stat size.

#### incomplete_data

Emit when a trend would otherwise be shown but usable coverage is below the rule's minimum.

Do not treat missing data as zero.

## Frontend overview

The current roster remains the primary screen.

Recommended columns:

| Column | Display |
| --- | --- |
| Member | name, position, level, ID |
| Last action | relative time + state |
| Battle stats | latest value + source marker |
| Activity / day | 30d value + compact trend |
| Xanax / day | 30d value + compact trend |
| RW participation | last 4 |
| Hits / war | last 4 |
| Signal | at most one highest-priority insight marker |

The Signal column is intentionally narrow. It should show a terse factual label such as `inactive 3d`, `1/4 wars`, or `activity -31%`, not a stack of colored badges.

Clicking a row expands:

- a metric strip,
- 30/60/90 day trend plots only where useful,
- the member's last 8 wars,
- all current factual insights,
- coverage / freshness information.

## Snapshot use

`member_snapshots` remains the source for activity, Xanax, last action and battle-stat history.

A new snapshot-rollup table is **not** justified yet. At current faction sizes, 60-90 daily rows per member are cheap enough. Revisit only if D1 telemetry shows otherwise.

## War analytics dependency

Intel 2.0 should consume `war_member_metrics` when that table is enabled.

Until then, the existing optimized war-log / attack queries remain the fallback.

The API contract must remain the same regardless of which storage path supplies war metrics.


## Staged preview

The draft branch includes a standalone preview:

- `/v2/intel-preview.html` — fixture mode, no D1 access required
- `/v2/intel-preview.html?live=1` — staged live endpoint once D1 is available
- admins may append `&factionId=<id>` in live mode

Live mode loads only the overview initially. Opening a member lazily requests the member-detail contract and derives display-rate history from the returned cumulative snapshots.

This preview is intentionally separate from the production Intel route until live D1 data has been checked.
