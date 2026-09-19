import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('tag manager keeps table geometry stable', () => {
  const source = readFileSync(new URL('../v2/intel-v2.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../v2/app.css', import.meta.url), 'utf8');

  assert.match(source, /renderMemberTagSelector\(member\)/);
  assert.match(source, /tag-row-selector/);
  assert.doesNotMatch(source, /col-member\$\{workflowSelectable/);
  assert.match(css, /\.intel-tag-manage[\s\S]*min-width:\s*86px/);
  assert.match(css, /#intelTagToolbar\.hidden[\s\S]*display:\s*grid\s*!important/);
  assert.match(css, /\.faction-grid-wrap[\s\S]*padding-left:\s*28px/);
  assert.match(css, /\.tag-row-selector[\s\S]*position:\s*absolute/);
  assert.match(css, /\.faction-grid-cell:not\(\.col-member\)[\s\S]*text-align:\s*center/);
});
