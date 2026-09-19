import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCumulativeWindow } from '../functions/v2/intel-v2.js';

const DAY = 86400;
const NOON = 12 * 3600;

function snapshot(day, activity, xanax, ocs) {
  return {
    snapshot_at:day * DAY + NOON,
    activity_total_seconds:activity,
    xanax_taken_total:xanax,
    organized_crimes_total:ocs
  };
}

test('Today uses the preceding daily snapshot as its cumulative baseline', () => {
  const result = buildCumulativeWindow([
    snapshot(10, 1000, 20, 4),
    snapshot(11, 8200, 23, 5)
  ], 11 * DAY, 12 * DAY - 1);

  assert.equal(result.coverageDays, 1);
  assert.equal(result.activityPerDay, 7200);
  assert.equal(result.xanaxPerDay, 3);
  assert.equal(result.organizedCrimes, 1);
  assert.equal(result.organizedCrimesPerDay, 1);
  assert.equal(result.organizedCrimesPerMonth, 30.44);
});

test('A multi-day range uses the last baseline before its start', () => {
  const result = buildCumulativeWindow([
    snapshot(3, 1000, 10, 2),
    snapshot(4, 4600, 11, 2),
    snapshot(10, 47800, 17, 5)
  ], 4 * DAY, 11 * DAY - 1);

  assert.equal(result.coverageDays, 7);
  assert.equal(result.activityPerDay, 46800 / 7);
  assert.equal(result.xanaxPerDay, 1);
  assert.equal(result.organizedCrimes, 3);
  assert.equal(result.organizedCrimesPerMonth, (3 / 7) * 30.44);
});

test('Counter resets remain missing rather than becoming negative rates', () => {
  const result = buildCumulativeWindow([
    snapshot(20, 9000, 30, 8),
    snapshot(21, 1000, 32, 9)
  ], 21 * DAY, 22 * DAY - 1);

  assert.equal(result.activityPerDay, null);
  assert.equal(result.xanaxPerDay, 2);
  assert.equal(result.organizedCrimesPerDay, 1);
  assert.equal(result.organizedCrimesPerMonth, 30.44);
});
