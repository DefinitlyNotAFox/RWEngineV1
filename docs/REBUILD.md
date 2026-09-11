# RWEngine Frontend Rebuild

## Why this exists

The previous frontend grew through many local improvements. Individual changes were reasonable, but the result accumulated presentation scripts, late DOM overrides and overlapping CSS layers.

The current frontend was rebuilt from zero around the product RWEngine is becoming: a hosted Torn data workbench.

## Interface principles

- Data first. Tables and reports are the visual focus.
- No dashboard-card default. Use rules, spacing and typography before containers.
- No gradients, glows, floating panels or decorative metrics.
- Navigation is always visible and predictable.
- Numeric data is right-aligned and uses tabular figures.
- Secondary information belongs under the primary value, not in another column when it can be avoided.
- Color is functional. The copper accent marks selection, links and active controls.
- Modules may have different layouts when their jobs differ.
- Mobile is usable, but desktop remains the primary information-dense surface.

## Active frontend

The authenticated application intentionally consists of six files:

- `v2/index.html`
- `v2/app.css`
- `v2/core.js`
- `v2/app.js`
- `v2/intel.js`
- `v2/wars.js`

Do not reintroduce scripts whose purpose is to patch, intercept or restyle another frontend module after it loads.

## Views

### Home
A plain index of available tools plus faction/data coverage.

### Faction Intel
Roster analytics, period controls, sync, sorting and inline member history.

### Ranked War
Period-level totals, recent war reports and leading contributors.

### Performance
Cross-war member comparison with optional detail and chain-bonus filtering.

### Archive
Historical import, search, individual war detail and public sharing.

### Settings
Account identity plus tracked-faction/API-key administration for admins.

## Data ownership

The frontend does not own Torn API keys, long-term datasets or sensitive calculations. Those remain in Pages Functions and D1.

Public sharing uses opaque, revocable share tokens and exposes read-only result data rather than application internals.

## Adding a new tool

A new module should have:
1. one clear job,
2. a stable backend data contract,
3. a route or explicit entry point,
4. no dependency on DOM interception from another module.

If a tool does not yet do useful work, it does not appear in navigation.


## Shared platform contracts

### Resource visibility

Shareable resources use `resource_permissions` rather than module-specific flags.

Visibility values:
- `private`: owner/admin only
- `faction`: authenticated faction members
- `public`: faction access plus an opaque revocable public token

A missing permission row uses the module's default. Ranked-war reports default to `faction`.

Public tokens never override visibility. A valid token stops working immediately when the resource leaves `public`.

### Freshness

Modules consume `/v2/freshness` instead of inventing their own timestamps. Live-ish datasets may define a stale threshold; immutable/event datasets should expose last-update information without pretending age alone means stale.
