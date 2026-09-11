# RWEngine

RWEngine is a server-backed Torn data and tools platform.

The application is deliberately utilitarian: the frontend is a thin workbench over shared server-side data, not a collection of distributed userscripts.

## Active application

The public root redirects to `/v2/`.

Primary views:
- Faction Intel
- Ranked War overview
- Performance
- War Archive
- Account / admin settings

Ranked-war reports use the shared resource-access model:
- private — report owner and RWEngine admins
- faction — authenticated members of the faction
- public — faction access plus a revocable public URL under `/share/`

The same visibility model is intended for future shareable modules.

## Frontend architecture

The active authenticated frontend is intentionally small:

- `v2/index.html` — semantic application shell
- `v2/app.css` — complete visual system
- `v2/core.js` — shared state, API adapters, routing and formatting
- `v2/app.js` — authentication, application lifecycle and admin context
- `v2/intel.js` — faction intelligence and member drill-down
- `v2/wars.js` — war overview, performance, archive, import, detail and sharing

Do not add presentation scripts that intercept or patch other frontend modules. New tools should own a clear route and data contract.

## Backend

- `functions/api.js` — authentication and legacy-compatible ranked-war import actions
- `functions/v2/` — current data, sync, analytics, sharing, freshness and admin endpoints
- `migrations/` / `schema.sql` — Cloudflare D1 schema

Torn API keys, persistent data, aggregation rules and sensitive calculations remain server-side.

## Product direction

RWEngine is a host for focused Torn utilities. Shared infrastructure should be reused across modules, but modules do not need to share the same page layout. Dense data should remain dense; navigation and setup should remain quiet.


## Data freshness

`/v2/freshness` is the shared freshness contract for module data. Faction Intel is considered stale after 36 hours without a newer roster, snapshot or successful sync observation. War/archive data is event data, so RWEngine reports its last update rather than incorrectly marking old completed wars as stale.
