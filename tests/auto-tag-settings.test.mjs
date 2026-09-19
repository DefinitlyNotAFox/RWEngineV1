import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('auto-tag settings expose the agreed faction defaults', () => {
  const api = readFileSync(new URL('../functions/v2/auto-tags.js', import.meta.url), 'utf8');

  assert.match(api, /lowWarHits:[\s\S]*yellow:15[\s\S]*orange:10[\s\S]*red:6/);
  assert.match(api, /highWarHits:[\s\S]*teal:25[\s\S]*green:40[\s\S]*bright:60/);
  assert.match(api, /outsideHits:[\s\S]*yellow:10/);
  assert.match(api, /respectPerHit:[\s\S]*yellow:4\.5[\s\S]*orange:4[\s\S]*red:3\.5[\s\S]*minimumHits:10/);
  assert.match(api, /assists:[\s\S]*teal:10[\s\S]*green:20[\s\S]*bright:35/);
  assert.match(api, /trainingEnergy:[\s\S]*red:400[\s\S]*orange:550[\s\S]*yellow:700[\s\S]*teal:1200[\s\S]*green:1350[\s\S]*bright:1500/);
  assert.match(api, /inactivity:[\s\S]*yellowHours:24[\s\S]*orangeHours:48[\s\S]*redHours:72/);
});

test('settings page provides faction auto-tag controls', () => {
  const html = readFileSync(new URL('../v2/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../v2/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../v2/app.css', import.meta.url), 'utf8');

  assert.match(html, /class="settings-section-heading">Personal<\/div>/);
  assert.match(html, /id="factionSettingsHeading" class="settings-section-heading settings-section-divider hidden">Faction<\/div>/);
  assert.match(html, /id="adminSection" class="admin-section settings-admin-column hidden">[\s\S]*class="settings-section-heading">Site admin<\/div>/);
  assert.match(html, /id="autoTagSettingsSection"/);
  assert.match(html, /<h2>Tags<\/h2>/);
  assert.match(html, /id="autoTagSettingsForm"/);
  assert.match(html, /id="autoTagSettingsReset"/);
  assert.match(app, /key:'highWarHits'[\s\S]*\['teal'[\s\S]*\['green'[\s\S]*\['bright'/);
  assert.match(app, /key:'assists'[\s\S]*\['teal'[\s\S]*\['green'[\s\S]*\['bright'/);
  assert.match(app, /key:'lowWarHits'[\s\S]*\['yellow'[\s\S]*\['orange'[\s\S]*\['red'/);
  assert.match(app, /key:'respectPerHit'[\s\S]*\['yellow'[\s\S]*\['orange'[\s\S]*\['red'[\s\S]*\['minimumHits'/);
  assert.match(app, /key:'trainingEnergy'[\s\S]*\['yellow'[\s\S]*\['orange'[\s\S]*\['red'[\s\S]*\['teal'[\s\S]*\['green'[\s\S]*\['bright'/);
  assert.match(app, /key:'inactivity'[\s\S]*\['yellowHours'[\s\S]*\['orangeHours'[\s\S]*\['redHours'/);
  assert.match(app, /group:'War'[\s\S]*title:'Low war hits \/ war'/);
  assert.match(app, /group:'Training'[\s\S]*title:'Training E \/ day'/);
  assert.match(app, /group:'Activity'[\s\S]*title:'Inactivity'/);
  assert.match(app, /auto-tag-group-heading/);
  assert.match(app, /hasPositive && hasNegative[\s\S]*auto-tag-threshold-lanes[\s\S]*lanes\.map/);
  assert.match(app, /autoTagsApi\('get'\)/);
  assert.match(app, /autoTagsApi\('save'/);
  assert.match(app, /autoTagsApi\('reset'\)/);
  assert.match(app, /canManageAutoTagSettingsView/);
  assert.match(css, /\.auto-tag-settings-list[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /\.settings-columns:not\(:has\(> \.settings-admin-column:not\(\.hidden\)\)\)[\s\S]*width:\s*min\(100%,\s*980px\)[\s\S]*margin-left:\s*0[\s\S]*margin-right:\s*auto/);
  assert.match(css, /\.settings-admin-column[\s\S]*border-left:\s*1px solid var\(--line-soft\)/);
  assert.match(css, /\.settings-admin-column \.settings-panel-head\.settings-panel-head-simple \+ \.settings-panel-body[\s\S]*margin-left:\s*0/);
  assert.match(css, /Settings typography: keep readable content at 13–14px/);
  assert.match(css, /#settingsView \.settings-section-heading[\s\S]*font-size:\s*var\(--font-body\)/);
  assert.match(css, /#settingsView \.auto-tag-threshold input[\s\S]*font-size:\s*var\(--font-body\)/);
  assert.match(css, /#settingsView \.status-line[\s\S]*font-size:\s*var\(--font-small\)/);
  assert.match(css, /Settings hierarchy cleanup/);
  assert.match(css, /\.auto-tag-group-heading[\s\S]*text-transform:\s*uppercase/);
  assert.match(css, /\.settings-main-column > \.settings-panel \+ \.settings-panel[\s\S]*border-top:\s*1px solid var\(--line-soft\)/);
  assert.match(css, /Compact tag threshold rows/);
  assert.match(css, /\.auto-tag-thresholds[\s\S]*flex-wrap:\s*nowrap/);
  assert.match(css, /\.auto-tag-setting-row\.split[\s\S]*min-height:\s*78px/);
});
