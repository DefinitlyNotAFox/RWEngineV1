import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('manual war imports are handed off to a persisted background job', () => {
  const backend = readFileSync(new URL('../functions/v2/war-import-job.js', import.meta.url), 'utf8');
  const frontend = readFileSync(new URL('../v2/wars.js', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../v2/core.js', import.meta.url), 'utf8');

  assert.match(backend, /war_import_job_v1/);
  assert.match(backend, /context\.waitUntil\(task\)/);
  assert.match(backend, /action === 'startBatch'/);
  assert.match(backend, /action === 'status'/);
  assert.match(backend, /status:'running'/);
  assert.match(backend, /status:'stalled'/);

  assert.match(core, /warImportJobApi/);
  assert.match(core, /post\('\/v2\/war-import-job'/);
  assert.match(frontend, /warImportJobApi\('startBatch'/);
  assert.match(frontend, /warImportJobApi\('status'/);
  assert.match(frontend, /resumeBackgroundImports/);
});

test('archive only reports war plus chain data ready after attack verification', () => {
  const frontend = readFileSync(new URL('../v2/wars.js', import.meta.url), 'utf8');
  const normalApi = readFileSync(new URL('../functions/api.js', import.meta.url), 'utf8');
  const adminApi = readFileSync(new URL('../functions/v2/admin.js', import.meta.url), 'utf8');
  const backend = readFileSync(new URL('../functions/v2/war-import-job.js', import.meta.url), 'utf8');

  assert.match(normalApi, /AS attack_detail_complete/);
  assert.match(adminApi, /AS attack_detail_complete/);

  assert.match(frontend, /const attackDetailComplete = Number\(/);
  assert.match(frontend, /if \(!attackDetailComplete\)[\s\S]*label:'Incomplete'/);
  assert.match(frontend, /\['applied','skipped','complete','completed','done'\]\.includes\(status\)/);
  assert.match(frontend, /label:'Ready', detail:'War \+ chain data'/);

  assert.match(backend, /const chainFinished = Boolean\(/);
  assert.match(backend, /!chainFinished[\s\S]*job\.status = 'failed'/);
  assert.match(backend, /job\.status = 'completed'[\s\S]*Import complete/);
});
