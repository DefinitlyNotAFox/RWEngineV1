import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('timeline scope uses the requested preset dropdown', () => {
  const html = readFileSync(new URL('../v2/index.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../v2/intel-v2.js', import.meta.url), 'utf8');

  assert.match(html, /id="factionScopePreset"/);
  assert.doesNotMatch(html, /id="factionScopeAll"/);

  for (const label of [
    'All Time (2022+)',
    'Today',
    'Yesterday',
    'Last 7 Days',
    'Previous 7 Days',
    'Last 30 Days',
    'This Month',
    'Last Month'
  ]) {
    assert.ok(source.includes(label), `missing preset: ${label}`);
  }

  assert.match(source, /\['year', String\(year\)\]/);
  assert.match(source, /applyTimelinePreset/);
});
