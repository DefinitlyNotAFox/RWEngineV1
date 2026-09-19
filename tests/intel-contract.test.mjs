import assert from 'node:assert/strict';
import { intelFixture } from '../v2/fixtures/intel-v2.js';

assert.equal(intelFixture.success, undefined);
assert(Number.isInteger(intelFixture.generatedAt));
assert(Number.isInteger(intelFixture.faction.factionId));
assert(typeof intelFixture.faction.factionName === 'string');
assert(intelFixture.summary.currentMembers > 0);
assert(Array.isArray(intelFixture.members));
assert(intelFixture.members.length > intelFixture.summary.currentMembers);

for (const member of intelFixture.members) {
  assert(Number.isInteger(member.playerId));
  assert(typeof member.playerName === 'string');
  assert(typeof member.current === 'boolean');

  assert(member.presence && 'lastActionAt' in member.presence);
  assert(member.battleStats && 'value' in member.battleStats);
  assert(member.activity && 'perDay30d' in member.activity);
  assert(member.activity && 'perDayPrevious30d' in member.activity);
  assert(member.xanax && 'perDay30d' in member.xanax);
  assert(member.xanax && 'perDayPrevious30d' in member.xanax);
  assert(member.ocs && 'perMonth' in member.ocs);
  assert(member.ocs && 'perMonthPrevious' in member.ocs);

  assert(member.war?.last4);
  assert(member.war?.previous4);
  assert(Number.isInteger(member.war.last4.warsAvailable));
  assert(Number.isInteger(member.war.previous4.warsAvailable));

  assert(member.coverage);
  assert(Array.isArray(member.insights));

  assert(member.history);
  assert(Array.isArray(member.history.stats));
  assert(Array.isArray(member.history.activity));
  assert(Array.isArray(member.history.xanax));
  assert(Array.isArray(member.history.ocs));
  assert(Array.isArray(member.history.wars));
}

const former = intelFixture.members.filter(member => member.current === false);
assert(former.length > 0);

const withAttention = intelFixture.members.filter(member =>
  member.insights.some(insight => insight.kind === 'attention')
);
assert(withAttention.length >= intelFixture.summary.membersNeedingAttention);

console.log('Intel fixture contract tests passed.');
