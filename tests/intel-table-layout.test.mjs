import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('war performance cells use totals first and compact participation text', () => {
  const source = readFileSync(new URL('../v2/intel-v2.js', import.meta.url), 'utf8');

  assert.match(source, /hits:\['Hits',''\]/);
  assert.doesNotMatch(source, /Hits per war/);
  assert.match(source, /col-participation[^]*formatPercent\(performance\.participation\)<\/span>/);
  assert.doesNotMatch(source, /formatPercent\(performance\.participation\)\} participation/);
  assert.match(source, /col-hits[^]*<strong>\$\{formatNumber\(performance\.warHits\)\}<\/strong>[^]*formatDecimal\(performance\.avgHitsPerWar, 1\)\} \/ war/);
  assert.match(source, /if \(key === 'hits'\) return nullable\(performance\?\.warHits\)/);
});

test('missing OC values are not bold', () => {
  const source = readFileSync(new URL('../v2/intel-v2.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../v2/app.css', import.meta.url), 'utf8');

  assert.match(source, /member-meta member-meta-primary">No data/);
  assert.match(css, /\.member-meta\.member-meta-primary[\s\S]*font-size:\s*inherit/);
});
