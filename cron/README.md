# RWEngine scheduled faction sync

This Worker is the scheduler for RWEngine's daily faction snapshots.

## How it works

The Cron Trigger fires hourly at minute 17 UTC. The Worker does **not** create an hourly snapshot. It asks the Pages sync endpoint for a plan; that endpoint only queues a new faction sync when today's UTC snapshot coverage is incomplete.

Active jobs are continued automatically. Failed scheduled jobs wait six hours before retrying, with a maximum of three scheduled attempts per faction per UTC day.

The hourly trigger is intentional: it gives interrupted jobs a way to continue without requiring anyone to open RWEngine.

The same plan request also discovers newly completed own-faction ranked wars.
Its first successful run records existing completed reports as a forward-only
baseline. Later reports are imported automatically, while historical reports
remain available through the manual Archive importer. Attack pages remain
transient; only member and war aggregates are stored.

## Required secret

Create the same `CRON_SECRET` value in both places:

1. The RWEngine Pages project environment variables/secrets.
2. This Worker using Wrangler:

```bash
npx wrangler secret put CRON_SECRET --config cron/wrangler.toml
```

Do not commit the secret to the repository.

## Deploy

From the repository root:

```bash
npx wrangler deploy --config cron/wrangler.toml
```

Cloudflare Cron Triggers use UTC. The configured trigger is `17 * * * *`.

## Runtime behavior

Each scheduled invocation advances up to 12 sync steps per faction. Most normal faction syncs finish in one invocation. If an invocation stops early, the next hourly trigger resumes the active job.

Sync job state, task counts, failures, API-request counts, and timestamps continue to be recorded in the existing `faction_sync_jobs` and `faction_sync_tasks` tables. The compact automatic-war queue is stored in `app_meta` and removes completed jobs.
