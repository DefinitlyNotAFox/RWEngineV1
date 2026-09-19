import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeRankedWarDiscoveryState,
  normalizeRankedWars
} from '../functions/v2/sync-current.js';

const NOW = 2_000_000_000;

test('ranked-war discovery distinguishes completed and active wars', () => {
  const wars = normalizeRankedWars({
    rankedwars:{
      70001:{ war:{ start:NOW - 5000, end:NOW - 60, winner:53933 } },
      70002:{ war:{ start:NOW - 500, end:NOW + 5000, winner:0 } }
    }
  }, NOW);

  assert.equal(wars.length, 2);
  assert.equal(wars.find(war => war.rankId === '70001')?.completed, true);
  assert.equal(wars.find(war => war.rankId === '70002')?.completed, false);
});

test('first discovery establishes a forward-only baseline without queueing history', () => {
  const completed = [
    { rankId:'70001', completed:true },
    { rankId:'70000', completed:true }
  ];
  const result = mergeRankedWarDiscoveryState(null, completed, NOW);

  assert.equal(result.initialized, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.discovered, []);
  assert.deepEqual(result.state.baselineIds, ['70001','70000']);
  assert.deepEqual(result.state.queue, []);
});

test('a war completing after baseline is queued once', () => {
  const baseline = mergeRankedWarDiscoveryState(
    null,
    [{ rankId:'70001', completed:true }],
    NOW
  ).state;

  const discovered = mergeRankedWarDiscoveryState(
    baseline,
    [{ rankId:'70001', completed:true }, { rankId:'70002', completed:true }],
    NOW + 3600
  );
  assert.deepEqual(discovered.discovered, ['70002']);
  assert.equal(discovered.changed, true);
  assert.deepEqual(discovered.state.queue.map(job => job.rankId), ['70002']);

  const repeated = mergeRankedWarDiscoveryState(
    discovered.state,
    [{ rankId:'70001', completed:true }, { rankId:'70002', completed:true }],
    NOW + 7200
  );
  assert.deepEqual(repeated.discovered, []);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.state.queue.map(job => job.rankId), ['70002']);
});
