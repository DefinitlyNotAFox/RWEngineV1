# RWEngine

RWEngine is a server-backed Torn tools and analytics platform.

## Current application

The public root redirects to `/v2/`, which is the active application shell.

Active modules:
- Faction Intel
- Ranked War Analytics
- Performance
- War Archive

The platform uses Cloudflare Pages, Pages Functions and D1. Torn API access, aggregation and stored data remain server-side so functionality can be shared without distributing the implementation as userscripts.

## Repository layout

- `v2/` — active frontend
- `functions/v2/` — v2 backend endpoints
- `functions/api.js` — shared authentication and legacy-compatible API actions
- `migrations/` / `schema.sql` — D1 schema
- root `app.js` / `styles.css` — legacy frontend retained temporarily for rollback

New functionality should be added as a module inside the v2 platform rather than as another top-level application.
