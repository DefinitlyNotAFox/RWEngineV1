import assert from 'node:assert/strict';
import { playerAnalysisFixture } from '../v2/fixtures/player-analysis.js';

assert(Array.isArray(playerAnalysisFixture.search));
assert(playerAnalysisFixture.search.length >= 2);

for (const result of playerAnalysisFixture.search) {
  assert(Number.isInteger(result.playerId));
  assert(typeof result.playerName === 'string');
  assert('source' in result);
}

for (const payload of [playerAnalysisFixture.analysis, playerAnalysisFixture.external]) {
  assert(Number.isInteger(payload.generatedAt));
  assert(Number.isInteger(payload.player.playerId));
  assert(typeof payload.player.playerName === 'string');
  assert(payload.context && typeof payload.context.localHistoryAvailable === 'boolean');
  assert(payload.battleStats);
  assert(payload.activity);
  assert(payload.xanax);
  assert(payload.war);
  assert(payload.history);
  assert(Array.isArray(payload.history.snapshots));
  assert(Array.isArray(payload.war.history));
  assert(Array.isArray(payload.sources));
}

assert.equal(playerAnalysisFixture.analysis.context.localHistoryAvailable, true);
assert(playerAnalysisFixture.analysis.history.snapshots.length > 0);
assert(playerAnalysisFixture.analysis.war.history.length > 0);

assert.equal(playerAnalysisFixture.external.context.localHistoryAvailable, false);
assert.equal(playerAnalysisFixture.external.history.snapshots.length, 0);
assert.equal(playerAnalysisFixture.external.war.history.length, 0);
assert.equal(playerAnalysisFixture.external.activity.perDay30d, null);
assert.equal(playerAnalysisFixture.external.xanax.perDay30d, null);

console.log('Player Analysis contract tests passed.');
