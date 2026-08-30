PRAGMA foreign_keys = ON;

/*
  Resumable faction-intel collector.

  A sync job initializes the current faction roster once, then processes member
  personal-stat snapshots in small batches. The first successful sync seeds
  90/30/7/current anchors; normal later syncs collect only the current day.
*/

CREATE TABLE IF NOT EXISTS faction_sync_jobs (
  job_id INTEGER PRIMARY KEY AUTOINCREMENT,
  faction_id INTEGER NOT NULL,
  requested_by_user_id INTEGER NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'manual',

  status TEXT NOT NULL DEFAULT 'queued',
  phase TEXT NOT NULL DEFAULT 'initializing',
  seed_history INTEGER NOT NULL DEFAULT 0,

  members_total INTEGER NOT NULL DEFAULT 0,
  tasks_total INTEGER NOT NULL DEFAULT 0,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  tasks_failed INTEGER NOT NULL DEFAULT 0,
  api_requests INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  lease_until INTEGER,
  error_text TEXT,

  FOREIGN KEY (faction_id) REFERENCES factions(faction_id),
  FOREIGN KEY (requested_by_user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_faction_sync_jobs_active
ON faction_sync_jobs(faction_id)
WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_faction_sync_jobs_recent
ON faction_sync_jobs(faction_id, created_at DESC);

CREATE TABLE IF NOT EXISTS faction_sync_tasks (
  task_id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  task_key TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  snapshot_date TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  historical_timestamp INTEGER,

  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_text TEXT,
  updated_at INTEGER NOT NULL,

  UNIQUE(job_id, task_key),
  FOREIGN KEY (job_id) REFERENCES faction_sync_jobs(job_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_faction_sync_tasks_pending
ON faction_sync_tasks(job_id, status, task_id);
