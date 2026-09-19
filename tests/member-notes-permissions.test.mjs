import assert from 'node:assert/strict';
import test from 'node:test';

import { isFactionLeader } from '../functions/api.js';
import {
  normalizeMemberNote,
  normalizeMemberTags
} from '../functions/v2/intel-v2.js';

test('leader and co-leader IDs receive faction leadership status', () => {
  const basic = { leader_id:101, co_leader_id:102 };
  assert.equal(isFactionLeader(basic, 101), true);
  assert.equal(isFactionLeader(basic, 102), true);
  assert.equal(isFactionLeader(basic, 103), false);
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
