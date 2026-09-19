import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const collectors = [
  'functions/v2/sync-current.js',
  'functions/v2/admin.js',
  'functions/v2/intel.js'
];

for (const relativePath of collectors) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  assert.doesNotMatch(source, /\bSEED_DAYS\b/, `${relativePath} must not seed historical snapshots`);
  assert.doesNotMatch(source, /\bfullHistory\b/, `${relativePath} must ignore historical backfill requests`);
  assert.doesNotMatch(source, /JSON\.stringify\(payload\)/, `${relativePath} must not persist raw personal-stat payloads`);
  assert.match(source, /raw_json\s*=\s*NULL/, `${relativePath} must clear legacy raw snapshot payloads on upsert`);
  assert.match(source, /historical_timestamp\s+IS\s+NOT\s+NULL/i, `${relativePath} must discard legacy backfill tasks`);
  assert.match(source, /DELETE\s+FROM\s+faction_sync_tasks\s+WHERE\s+job_id/i, `${relativePath} must compact completed task rows`);
}

const core = await readFile(path.join(root, 'v2/core.js'), 'utf8');
const syncAdapter = core.match(/export async function syncApi[\s\S]*?\n}/)?.[0] || '';
assert.match(syncAdapter, /post\('\/v2\/sync-current'/, 'all frontend syncs must use the current-only collector');
assert.doesNotMatch(syncAdapter, /adminApi\(/, 'admin syncs must not use the legacy duplicate collector');

const currentCollector = await readFile(path.join(root, 'functions/v2/sync-current.js'), 'utf8');
assert.match(currentCollector, /STORAGE_COMPACTION_KEY/, 'the live collector must run the one-time cleanup');
assert.match(currentCollector, /UPDATE\s+member_snapshots\s+SET\s+raw_json\s*=\s*NULL/i);
assert.match(currentCollector, /status\s+IN\s*\('completed',\s*'failed'\)/i);

const migration = await readFile(path.join(root, 'migrations/009_compact_sync_storage.sql'), 'utf8');
assert.match(migration, /SET\s+raw_json\s*=\s*NULL/i);
assert.match(migration, /historical_timestamp\s+IS\s+NOT\s+NULL/i);
assert.match(migration, /status\s+IN\s*\('completed',\s*'failed'\)/i);

console.log('Lean sync-storage regression tests passed.');
