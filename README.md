# RWEngine

RWEngine is a server-backed Torn tools and analytics platform.

The product is deliberately broader than ranked-war analytics. Ranked War is one module inside a shared application shell with common authentication, faction context, stored data and server-owned calculations.

## Active application

The public root redirects to `/v2/`.

Current modules:
- Faction Intel
- Ranked War
- Performance
- War Archive

Sharing:
- ranked-war detail can generate revocable public read-only links
- public tokens are stored only as SHA-256 hashes
- generating a replacement link invalidates the previous URL

Module URLs are deep-linkable through hashes such as `/v2/#members`, `/v2/#performance` and `/v2/#wars`.

## Architecture

- Cloudflare Pages frontend
- Pages Functions backend
- Cloudflare D1 data store
- server-side Torn API access and aggregation
- session-based accounts with self-service registration
- reusable faction/member/war data shared between modules

The browser is the presentation layer. API keys, aggregation rules and the persistent dataset remain server-side so RWEngine functionality can be shared without distributing the implementation as userscripts.

## Repository layout

- `v2/` — active frontend and module UI
- `functions/v2/` — module-specific backend endpoints
- `functions/api.js` — shared authentication and import-compatible API actions
- `migrations/` / `schema.sql` — D1 schema
- `docs/` — product and architecture notes

New functionality should be added as a module inside the platform rather than as another top-level application.
