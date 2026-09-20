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


test('notes editor is separate from tag management and sits under Notes', () => {
  const source = readFileSync(new URL('../v2/intel-v2.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../v2/app.css', import.meta.url), 'utf8');

  const notesPanelStart = source.indexOf('function renderMemberNotesPanel');
  const notesPanelEnd = source.indexOf('function renderTraitGroup', notesPanelStart);
  const notesPanel = source.slice(notesPanelStart, notesPanelEnd);

  assert.ok(notesPanelStart >= 0 && notesPanelEnd > notesPanelStart);
  assert.match(notesPanel, /textarea name="noteText"/);
  assert.doesNotMatch(notesPanel, /name="tags"/);
  assert.doesNotMatch(notesPanel, />Tags</);
  assert.match(source, /tags:existingNotes\.tags/);
  assert.match(source, /function renderMemberTagsPanel/);
  assert.match(source, /class="intel2-member-tags"/);
  assert.doesNotMatch(notesPanel, /intel2-note-tags/);
  assert.match(css, /\.intel2-member-tags\s*\{[\s\S]*grid-column:\s*1\s*\/\s*2/);
  assert.match(css, /\.intel2-notes\s*\{[\s\S]*grid-column:\s*13\s*\/\s*14/);
});


test('tag filters merge automatic and manual tags that actually exist', () => {
  const source = readFileSync(new URL('../v2/intel-v2.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../v2/app.css', import.meta.url), 'utf8');

  assert.match(source, /const tagOptions = activeTagFilterOptions\(\)/);
  assert.match(source, /function activeTagFilterOptions\(\)/);
  assert.match(source, /if \(member\.current === false && !showFormerMembers\) continue/);
  assert.match(source, /for \(const autoTag of automaticTags\(member\)\)/);
  assert.match(source, /normalizeMemberNotes\(member\.notes\)\.tags/);
  assert.match(source, /filter\(tag => tag\.count > 0\)/);
  assert.doesNotMatch(source, /<strong>Signals<\/strong>/);
  assert.doesNotMatch(source, /signal:\$\{key\}/);
  assert.match(source, /<strong>Tags<\/strong>/);
  assert.match(source, /const suggestions = workflowTagOptions\(\)/);
  assert.match(css, /#intelFilters \.intel-filter-menu\s*\{[\s\S]*width:\s*250px;[\s\S]*grid-template-columns:\s*1fr;/);
});
