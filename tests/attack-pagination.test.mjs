import assert from 'node:assert/strict';
import {
  applyAttackPagination,
  canonicalAttackPage
} from '../functions/v2/war-attack-detail.js';

const first = 'https://api.torn.com/v2/faction/attacksfull?limit=250&sort=ASC&from=100&to=900&comment=RWE';
const second = 'https://api.torn.com/v2/faction/attacksfull?to=900&from=400&sort=asc&limit=250';
const secondCached = 'https://api.torn.com/v2/faction/attacksfull?timestamp=123&limit=250&sort=ASC&from=400&to=900&key=secret';

assert.equal(canonicalAttackPage(second), canonicalAttackPage(secondCached));

{
  const state = { seenPageKeys:[] };
  assert.equal(applyAttackPagination(state, first, second), false);
  assert.equal(state.done, false);
  assert.equal(state.nextUrl, second);
  assert.deepEqual(state.seenPageKeys, [canonicalAttackPage(first)]);

  assert.equal(applyAttackPagination(state, second, secondCached), true);
  assert.equal(state.done, true);
  assert.equal(state.nextUrl, null);
  assert.equal(state.paginationStopReason, 'repeated-link');
}

{
  const state = { seenPageKeys:[canonicalAttackPage(first)] };
  assert.equal(applyAttackPagination(state, second, first), true);
  assert.equal(state.done, true);
}

{
  const legacyState = {};
  assert.equal(applyAttackPagination(legacyState, second, second), true);
  assert.equal(legacyState.done, true);
}

{
  const state = {};
  assert.equal(applyAttackPagination(state, first, null), false);
  assert.equal(state.done, true);
  assert.equal(state.paginationStopReason, null);
}

console.log('Attack pagination tests passed.');
