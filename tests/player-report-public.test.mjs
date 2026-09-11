import assert from 'node:assert/strict';
import { sanitizePlayerAnalysisForPublic } from '../functions/v2/share.js';
import { playerAnalysisFixture } from '../v2/fixtures/player-analysis.js';

const source = structuredClone(playerAnalysisFixture.analysis);
assert(source.history?.snapshots?.length > 0);

const publicReport = sanitizePlayerAnalysisForPublic(source, 1700000000);

assert.equal(publicReport.player.playerId, source.player.playerId);
assert.equal(publicReport.battleStats.value, source.battleStats.value);
assert.equal(publicReport.activity.perDay30d, source.activity.perDay30d);
assert.equal(publicReport.xanax.perDay30d, source.xanax.perDay30d);
assert(Array.isArray(publicReport.war.history));
assert(publicReport.war.history.length > 0);
assert(Array.isArray(publicReport.sources));

assert.equal('history' in publicReport, false);
assert.equal('localFactionId' in publicReport.context, false);

console.log('Public Player Analysis sanitization tests passed.');
