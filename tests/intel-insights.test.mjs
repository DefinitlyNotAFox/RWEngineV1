import assert from 'node:assert/strict';
import { buildIntelInsights } from '../functions/v2/intel-insights.js';

const NOW = 1_800_000_000;
const DAY = 86400;

function codes(member, context = {}) {
  return buildIntelInsights(member, context, NOW).map(item => item.code);
}

{
  const result = buildIntelInsights({
    current: true,
    presence: { lastActionAt: NOW - 3 * DAY },
    battleStats: { value: null },
    activity: {},
    xanax: {},
    war: { last4: {}, previous4: {} }
  }, {}, NOW);

  assert(result.some(item => item.code === 'inactive'));
  const missingStats = result.find(item => item.code === 'missing_battle_stats');
  assert(missingStats);
  assert.equal(missingStats.kind, 'note');
}

{
  const result = buildIntelInsights({
    current: true,
    presence: { lastActionAt: NOW - 2 * 3600 },
    battleStats: { value: 1_000_000_000, observedAt: NOW - 2 * DAY },
    activity: {
      perDay30d: 4 * 3600,
      perDayPrevious30d: 7 * 3600,
      coverageDays: 30,
      previousCoverageDays: 30
    },
    xanax: {
      perDay30d: 1.8,
      perDayPrevious30d: 2.6,
      coverageDays: 30,
      previousCoverageDays: 30
    },
    war: {
      last4: {
        warsAvailable: 4,
        warsParticipated: 4,
        participation: 1,
        hitsPerWar: 35,
        netScore: 500
      },
      previous4: {
        warsAvailable: 4,
        warsParticipated: 4,
        participation: 1
      }
    }
  }, { factionMedianHitsPerWarLast4: 20 }, NOW);

  assert(result.some(item => item.code === 'activity_down'));
  assert(result.some(item => item.code === 'xanax_down'));
  assert(result.some(item => item.code === 'strong_war_output'));
}

{
  const result = buildIntelInsights({
    current: true,
    presence: { lastActionAt: NOW - 3600 },
    battleStats: {
      value: 800_000_000,
      observedAt: NOW - DAY,
      changePct30d: 0.07,
      trendReliable: true
    },
    activity: {
      perDay30d: 8 * 3600,
      perDayPrevious30d: 5 * 3600,
      coverageDays: 30,
      previousCoverageDays: 30
    },
    xanax: {
      perDay30d: 3,
      perDayPrevious30d: 2.2,
      coverageDays: 30,
      previousCoverageDays: 30
    },
    war: {
      last4: {
        warsAvailable: 4,
        warsParticipated: 2,
        participation: 0.5,
        hitsPerWar: 10,
        netScore: 20
      },
      previous4: {
        warsAvailable: 4,
        warsParticipated: 4,
        participation: 1
      }
    }
  }, { factionMedianHitsPerWarLast4: 14 }, NOW);

  assert(result.some(item => item.code === 'activity_up'));
  assert(result.some(item => item.code === 'xanax_up'));
  assert(result.some(item => item.code === 'battle_stats_growth'));
  assert(result.some(item => item.code === 'low_war_participation'));
  assert(result.some(item => item.code === 'participation_down'));
}

{
  const result = buildIntelInsights({
    current: true,
    presence: { lastActionAt: NOW - 3600 },
    battleStats: { value: 900_000_000, observedAt: NOW - DAY },
    activity: {
      perDay30d: 6 * 3600,
      perDayPrevious30d: 8 * 3600,
      coverageDays: 10,
      previousCoverageDays: 30
    },
    xanax: {
      perDay30d: 2,
      perDayPrevious30d: 3,
      coverageDays: 30,
      previousCoverageDays: 12
    },
    war: { last4: {}, previous4: {} }
  }, {}, NOW);

  assert(result.some(item => item.code === 'incomplete_activity_data'));
  assert(result.some(item => item.code === 'incomplete_xanax_data'));
  assert(!result.some(item => item.code === 'activity_down'));
  assert(!result.some(item => item.code === 'xanax_down'));
}

{
  const result = codes({
    current: false,
    presence: { lastActionAt: NOW - 30 * DAY },
    battleStats: { value: 1_000_000, observedAt: NOW - DAY },
    activity: {},
    xanax: {},
    war: { last4: {}, previous4: {} }
  });

  assert(!result.includes('inactive'));
}

console.log('Intel insight tests passed.');
