-- Snapshot collection is forward-only. Keep only normalized values used by
-- Intel and remove completed task payloads that no longer serve a runtime job.

UPDATE member_snapshots
SET raw_json = NULL
WHERE raw_json IS NOT NULL;

DELETE FROM faction_sync_tasks
WHERE historical_timestamp IS NOT NULL;

UPDATE faction_sync_jobs
SET seed_history = 0
WHERE seed_history <> 0;

DELETE FROM faction_sync_tasks
WHERE job_id IN (
  SELECT job_id
  FROM faction_sync_jobs
  WHERE status IN ('completed', 'failed')
);
