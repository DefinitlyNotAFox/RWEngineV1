import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function loadEngine() {
  let source = readFileSync(new URL('../v2/auto-tag-engine.js', import.meta.url), 'utf8');
  source = source
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ');
  return new Function(source + '\nreturn { buildAutoTags, DEFAULT_AUTO_TAG_SETTINGS };')();
}

test('automatic tags apply the strongest matching war tier only', () => {
  const { buildAutoTags } = loadEngine();
  const tags = buildAutoTags(
    { current:true, presence:{ lastActionAt:1_000_000 } },
    {
      wars:2,
      warHits:10,
      avgHitsPerWar:5,
      outsideHits:0,
      assists:0,
      respectEarned:40,
      attackDetailWars:2
    },
    null,
    1_000_100
  );

  const hitTags = tags.filter(tag => tag.category === 'war_hits');
  assert.equal(hitTags.length, 1);
  assert.equal(hitTags[0].code, 'auto_low_war_hits');
  assert.equal(hitTags[0].tier, 'red');
});

test('war averages produce configured positive and concern tags', () => {
  const { buildAutoTags } = loadEngine();
  const tags = buildAutoTags(
    { current:true, presence:{ lastActionAt:2_000_000 } },
    {
      wars:2,
      warHits:20,
      avgHitsPerWar:10,
      outsideHits:22,
      assists:70,
      respectEarned:74,
      attackDetailWars:2
    },
    null,
    2_000_100
  );

  assert.equal(tags.find(tag => tag.code === 'auto_assists')?.tier, 'bright');
  assert.equal(tags.find(tag => tag.code === 'auto_outside_hits')?.tier, 'yellow');
  assert.equal(tags.find(tag => tag.code === 'auto_low_respect_per_hit')?.tier, 'orange');
});

test('inactivity and training use their configured tier families', () => {
  const { buildAutoTags } = loadEngine();
  const now = 5_000_000;
  const tags = buildAutoTags(
    {
      current:true,
      presence:{ lastActionAt:now - 50 * 3600 },
      trainingEnergyPerDay:1400
    },
    null,
    null,
    now
  );

  assert.equal(tags.find(tag => tag.code === 'auto_inactive')?.tier, 'orange');
  assert.equal(tags.find(tag => tag.code === 'auto_training_energy')?.tier, 'green');
});

test('disabled tag families do not apply', () => {
  const { buildAutoTags, DEFAULT_AUTO_TAG_SETTINGS } = loadEngine();
  const settings = structuredClone(DEFAULT_AUTO_TAG_SETTINGS);
  settings.assists.enabled = false;

  const tags = buildAutoTags(
    { current:true, presence:{} },
    { wars:1, warHits:20, avgHitsPerWar:20, assists:100, outsideHits:0 },
    settings,
    10_000
  );

  assert.equal(tags.some(tag => tag.code === 'auto_assists'), false);
});
