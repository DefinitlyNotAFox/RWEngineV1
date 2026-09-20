import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PAYOUT_PROFILE,
  calculatePayoutRows,
  normalizePayoutProfile
} from '../functions/v2/payout-profile.js';

test('default payout profile enables the two respect modules', () => {
  const enabled = DEFAULT_PAYOUT_PROFILE.modules
    .filter(module => module.enabled)
    .map(module => module.id);

  assert.deepEqual(enabled, ['rankedRespect', 'outsideChainRespect']);
});

test('respect modules can pay milestone hits at an alternative flat amount', () => {
  const result = calculatePayoutRows([
    {
      player_id:1,
      player_name:'Fox',
      respect_earned:100,
      chain_bonus_hits:1,
      chain_bonus_score:50,
      outside_chain_respect:20,
      outside_chain_bonus_hits:1,
      outside_chain_bonus_respect:15,
      war_hits:10,
      assists:3,
      outside_hits:4
    }
  ], DEFAULT_PAYOUT_PROFILE);

  const member = result.members[0];
  const ranked = member.components.find(component => component.id === 'rankedRespect');
  const outside = member.components.find(component => component.id === 'outsideChainRespect');

  assert.equal(ranked.quantity, 50);
  assert.equal(ranked.payout, 7_200_000);
  assert.equal(outside.quantity, 5);
  assert.equal(outside.payout, 1_200_000);
  assert.equal(member.totalPayout, 8_400_000);
});

test('count modules can be enabled independently per faction', () => {
  const profile = normalizePayoutProfile({
    modules:[
      { id:'rankedRespect', enabled:false, rate:120000, milestonesIncluded:false, milestoneRate:1200000 },
      { id:'outsideChainRespect', enabled:false, rate:80000, milestonesIncluded:false, milestoneRate:800000 },
      { id:'warHits', enabled:true, rate:250000 },
      { id:'assists', enabled:true, rate:100000 },
      { id:'outsideHits', enabled:false, rate:0 }
    ]
  });

  const result = calculatePayoutRows([
    {
      player_id:2,
      player_name:'Member',
      war_hits:12,
      assists:4,
      outside_hits:7
    }
  ], profile);

  assert.deepEqual(result.activeModules.map(module => module.id), ['warHits', 'assists']);
  assert.equal(result.members[0].totalPayout, 3_400_000);
});

test('milestones can be paid normally at the respect rate', () => {
  const profile = normalizePayoutProfile({
    modules:[
      { id:'rankedRespect', enabled:true, rate:1000, milestonesIncluded:true, milestoneRate:10000 },
      { id:'outsideChainRespect', enabled:false, rate:0, milestonesIncluded:true, milestoneRate:0 }
    ]
  });

  const result = calculatePayoutRows([
    {
      player_id:3,
      player_name:'Member',
      respect_earned:100,
      chain_bonus_hits:1,
      chain_bonus_score:50
    }
  ], profile);

  assert.equal(result.members[0].components[0].quantity, 100);
  assert.equal(result.members[0].totalPayout, 100000);
});
