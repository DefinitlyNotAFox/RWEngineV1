# Player Analysis

Status: staged on top of Faction Intel 2.0.

Player Analysis is RWEngine's first tool that is not fundamentally a faction-management screen.

## Goal

Given a Torn player, show a compact analytical profile using:

1. current public Torn profile data,
2. RWEngine observations the current user is allowed to access,
3. faction/war context when available,
4. explicit data provenance.

Do not imply knowledge RWEngine does not have.

## Privacy boundary

RWEngine may track multiple factions, but normal users must not gain historical intelligence from another tracked faction merely because the database contains it.

Rules:

- normal user:
  - may use deep RWEngine history for members of their own faction,
  - may use Torn public API data for any player,
  - must not receive snapshot/war history belonging to a different tracked faction.
- admin:
  - may use tracked-faction history according to the selected admin faction context.
- public Torn information is labelled `Torn`.
- historical local information is labelled `RWEngine`.
- FF/other estimates retain their source labels.

## Endpoint

`POST /v2/player-analysis`

### search

```json
{
  "action": "search",
  "query": "player name or ID"
}
```

Returns up to 25 candidates.

Local permitted matches are merged with Torn's public user search endpoint. Duplicate player IDs are collapsed.

`/user/search` is currently marked unstable by Torn, so failure of the external name search must never make local search fail.

### analyze

```json
{
  "action": "analyze",
  "playerId": 123
}
```

Response:

```json
{
  "success": true,
  "generatedAt": 0,
  "player": {
    "playerId": 123,
    "playerName": "Example",
    "level": 100,
    "rank": "Absolute beginner",
    "title": "Example",
    "ageDays": 5000,
    "signedUpAt": 0,
    "gender": "Male",
    "factionId": 12345,
    "lastActionAt": 0,
    "lastActionStatus": "Online",
    "statusState": "Okay",
    "statusUntil": null,
    "revivable": true
  },
  "context": {
    "localHistoryAvailable": true,
    "localFactionId": 12345,
    "localFactionName": "Example Faction",
    "currentFactionMember": true,
    "observedAt": 0
  },
  "battleStats": {
    "value": null,
    "source": null,
    "verified": false,
    "observedAt": null,
    "change30d": null,
    "changePct30d": null
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
    "last4": null,
    "history": []
  },
  "history": {
    "snapshots": []
  },
  "sources": []
}
```

For external players without permitted RWEngine history, the analysis still succeeds. Local-only fields are `null`/empty and the UI explains why.

## UI

Player Analysis should be a single search-driven workbench.

No permanent roster and no dashboard grid.

Flow:

1. search player,
2. choose result,
3. show identity line,
4. show available metrics,
5. show RWEngine history only when allowed,
6. make missing context obvious rather than filling it with zeroes.

Recommended primary surface:

- identity / Torn status
- battle-stat estimate if known
- 30d activity if locally observed
- 30d Xanax if locally observed
- recent war output if locally observed
- source/provenance line
- trends and last wars only when local history exists

## External API

Verified against Torn API v2/OpenAPI:

- `GET /user/{id}/basic` is stable and requires public access.
- `GET /user/{id}/profile` is stable and requires public access.
- `GET /user/search?name=...` requires public access and is currently marked unstable.

RWEngine should therefore:

- use `profile` for analysis,
- use `search` for name discovery when available,
- treat user-search failure as non-fatal,
- use player ID lookup as the most reliable direct path.

## Sharing

Not implemented in this stage.

If Player Analysis becomes shareable, RWEngine should create an immutable analysis snapshot and share that resource. A public URL should not silently turn into a live surveillance view as the player's data changes.
