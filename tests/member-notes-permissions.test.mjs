import assert from 'node:assert/strict';
import test from 'node:test';

import { isFactionLeader } from '../functions/api.js';
import { factionLeadershipRole } from '../functions/v2/faction-leadership.js';
import {
  normalizeMemberNote,
  normalizeMemberTags
} from '../functions/v2/intel-v2.js';
import {
  actualUserRole,
  availableViewRoles,
  normalizeViewRole,
  renderLeadershipMarker
} from '../v2/core.js';

test('leader and co-leader IDs receive faction leadership status', () => {
  const basic = { leader_id:101, co_leader_id:102 };
  assert.equal(isFactionLeader(basic, 101), true);
  assert.equal(isFactionLeader(basic, 102), true);
  assert.equal(isFactionLeader(basic, 103), false);
  assert.equal(factionLeadershipRole(basic, 101), 'leader');
  assert.equal(factionLeadershipRole(basic, 102), 'co_leader');
  assert.equal(factionLeadershipRole(basic, 103), null);
  assert.match(renderLeadershipMarker('leader'), />L</);
  assert.match(renderLeadershipMarker('co_leader'), />CO</);
});

test('role preview can only reduce or retain actual authority', () => {
  const platformAdmin = { isAdmin:true, isFactionAdmin:false };
  const factionAdmin = { isAdmin:false, isFactionAdmin:true };
  const member = { isAdmin:false, isFactionAdmin:false };

  assert.equal(actualUserRole(platformAdmin), 'platform_admin');
  assert.deepEqual(
    availableViewRoles(platformAdmin),
    ['platform_admin','faction_admin','member']
  );
  assert.deepEqual(availableViewRoles(factionAdmin), ['faction_admin','member']);
  assert.deepEqual(availableViewRoles(member), ['member']);
  assert.equal(normalizeViewRole('platform_admin', factionAdmin), 'faction_admin');
  assert.equal(normalizeViewRole('faction_admin', member), 'member');
});

test('member notes are trimmed and bounded', () => {
  assert.equal(normalizeMemberNote('  Coordinate revive cover.  '), 'Coordinate revive cover.');
  assert.throws(
    () => normalizeMemberNote('x'.repeat(2001)),
    /2,000 characters/
  );
});

test('member tags are compact, case-insensitive, and bounded', () => {
  assert.deepEqual(
    normalizeMemberTags([' Recruit ', 'RW Lead', 'recruit', '', 'Needs   review']),
    ['Recruit', 'RW Lead', 'Needs review']
  );
  assert.throws(
    () => normalizeMemberTags(Array.from({ length:9 }, (_, index) => `tag-${index}`)),
    /at most 8 tags/
  );
  assert.throws(
    () => normalizeMemberTags(['x'.repeat(25)]),
    /24 characters/
  );
});
