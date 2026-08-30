# RWEngine Rebuild

## Product direction

RWEngine is a faction intelligence hub for Torn.

The original ranked-war analytics remains a first-class feature, but it is one part of a broader faction view. The product should make it possible to move from faction overview -> member -> war -> individual attack without leaving RWEngine.

Initial navigation target:

- Overview
- Members
- Wars
- Current War
- Settings

Later modules can add Activity, Organized Crimes and other faction systems without coupling them to the war importer.

## Rebuild principles

1. Preserve production. `main` stays deployable while rebuild work happens on a separate branch.
2. Keep the existing D1 data. Do not recreate or reset the production database.
3. Treat faction, members, wars, attacks and historical snapshots as core data entities.
4. Historical war analytics and Current War matchup intelligence are separate features using shared data.
5. Prefer drill-down views over one giant table.
6. Add features only after the underlying data contract is stable.
7. Keep schema.sql aligned with the schema the application actually expects.

## Recovery baseline

The rebuild starts from commit `899fd73146212fdd145ce8bd9008ce7a08e993ef` (June 1, 2026), before the large Current War/UI expansion.

## Phase 1: stable faction/war core

- Verify authentication/session restore.
- Verify D1 bindings and application secret handling.
- Reconcile `schema.sql` with the backend and production database.
- Verify imported-war listing and dashboard aggregation.
- Verify attack-summary import.
- Verify chain-bonus adjustment.
- Establish one known regression war for calculation checks.

## Phase 2: core faction model

- Overview page.
- Members directory.
- Member detail page with historical war performance.
- War directory.
- War detail page with faction summary, member breakdown and attack drill-down.

## Phase 3: Current War

Current War answers a different question from historical analytics: who are we fighting and what does the matchup look like?

It should provide:

- Own and opponent rosters.
- Useful member-level historical context.
- Battle-stat estimates when available.
- Participation/activity context.
- Clear, explainable threat indicators.
- Matchup summaries based on underlying data rather than opaque scores.

## Phase 4: additional faction intelligence

Potential modules include activity/development trends, Organized Crimes and other faction-management views. These should plug into the same faction/member data model rather than expand the war module itself.
