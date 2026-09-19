import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('faction filters combine signals and member tags', () => {
  const source = readFileSync(new URL('../v2/intel-v2.js', import.meta.url), 'utf8');

  assert.match(source, /data-filter-clear>None<\/button>/);
  assert.match(source, /data-filter-menu-toggle/);
  assert.match(source, /Signals/);
  assert.match(source, /Tags/);
  assert.match(source, /data-filter-remove/);
  assert.match(source, /const activeFilters = new Set\(\)/);
  assert.doesNotMatch(source, /activeTagFilter/);
  assert.doesNotMatch(source, /activeFilter = 'all'/);
});
