# RWEngine Platform Direction

## Product

RWEngine is a hosted Torn tools and analytics platform.

Its job is not to replicate Torn inside another website. It should collect reusable Torn data once, keep important calculations server-side, and expose focused tools that are easy to use and easy to share without distributing the underlying implementation.

Ranked-war analytics is the first mature feature set, not the boundary of the product.

## Product rules

1. A feature is a module, not a new application.
2. Shared data belongs in the common backend and D1 model.
3. Calculations and API-key handling stay server-side whenever practical.
4. The UI should be dense when comparing data and simple when navigating.
5. Do not expose placeholders as navigation. A module appears when it does useful work.
6. Remove obsolete UI and compatibility code once nothing active depends on it.
7. Prefer explicit module events and APIs over scripts intercepting each other.
8. Every important view should eventually support a stable URL or explicit share flow.
9. Preserve production data. Schema changes are migrations, never resets.

## Current module structure

### Home
Launcher and platform entry point. Shows available tools rather than pretending to be an analytics dashboard of its own.

### Faction Intel
Current roster intelligence:
- battle-stat estimates or verified values
- recent activity
- activity per day
- Xanax per day
- ranked-war participation
- average hits per war
- per-member drill-down

### Ranked War
High-level selected-period war summary and entry point to deeper war analysis.

### Performance
Cross-war member performance with sortable simplified and detailed views.

### War Archive
Imported ranked-war reports with search, individual war drill-down, chain-bonus controls and historical importing.

## Sharing model

RWEngine now supports revocable public read-only links for ranked-war reports. Share tokens are opaque, only their hashes are stored, and generating a replacement link rotates the token.

The same share-link model should be reused for future public resources rather than implementing module-specific public authentication.

## Platform roadmap

Near-term work should improve the shared platform rather than multiply features:

- extend the share/report model to other useful resources
- clearer permissions for private, faction and public views
- reusable player/faction selectors
- common data freshness indicators
- module-level URLs and share links
- API/client cleanup so modules do not wrap global browser behaviour

Future tools can cover player analysis, companies, organized crimes, calculators and other Torn utilities when their data contracts are real.

No placeholder modules should be added merely to advertise that they might exist later.
