import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { apiKeyBelongsToUser, closedAccountPlayerId, isFactionLeader } from '../functions/api.js';
import {
  factionLeadershipRole,
  resolveFactionPermissions
} from '../functions/v2/faction-leadership.js';
import {
  normalizeMemberNote,
  normalizeMemberTags
} from '../functions/v2/intel-v2.js';
import {
  canSetFactionRole,
  roleGrantCapabilities
} from '../functions/v2/roles.js';
import { canManageReportVisibility } from '../functions/v2/share.js';
import {
  actualUserRole,
  availableViewRoles,
  normalizeViewRole,
  renderLeadershipMarker
} from '../v2/core.js';
import {
  compareDisplayNames,
  sortFactionAccounts,
  sortTrackedFactions
} from '../v2/sort.js';

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
  const platformAdmin = { isAdmin:true, isFactionAdmin:false, isAssistant:false };
  const factionAdmin = { isAdmin:false, isFactionAdmin:true, isAssistant:false };
  const assistant = { isAdmin:false, isFactionAdmin:false, isAssistant:true };
  const member = { isAdmin:false, isFactionAdmin:false, isAssistant:false };

  assert.equal(actualUserRole(platformAdmin), 'platform_admin');
  assert.deepEqual(
    availableViewRoles(platformAdmin),
    ['platform_admin','faction_admin','assistant','member']
  );
  assert.deepEqual(availableViewRoles(factionAdmin), ['faction_admin','assistant','member']);
  assert.deepEqual(availableViewRoles(assistant), ['assistant','member']);
  assert.deepEqual(availableViewRoles(member), ['member']);
  assert.equal(normalizeViewRole('platform_admin', factionAdmin), 'faction_admin');
  assert.equal(normalizeViewRole('faction_admin', assistant), 'assistant');
  assert.equal(normalizeViewRole('faction_admin', member), 'member');
});

test('leadership creates protected and revocable faction-admin states', () => {
  const leadership = { leaderPlayerId:101, coLeaderPlayerId:102 };

  const leader = resolveFactionPermissions(leadership, 101, { adminRevoked:true });
  assert.equal(leader.leadershipRole, 'leader');
  assert.equal(leader.role, 'faction_admin');
  assert.equal(leader.isFactionAdmin, true);

  const coLeader = resolveFactionPermissions(leadership, 102);
  assert.equal(coLeader.role, 'faction_admin');

  const revokedCoLeader = resolveFactionPermissions(leadership, 102, {
    adminRevoked:true,
    isAssistant:true
  });
  assert.equal(revokedCoLeader.role, 'assistant');
  assert.equal(revokedCoLeader.isFactionAdmin, false);

  assert.equal(
    resolveFactionPermissions(leadership, 103, { isFactionAdmin:true }).role,
    'faction_admin'
  );
});

test('leader and co-leader role-management authority is bounded', () => {
  const leadership = { leaderPlayerId:101, coLeaderPlayerId:102 };
  const leader = roleGrantCapabilities({ player_id:101, faction_id:7 }, leadership, 7);
  const coLeader = roleGrantCapabilities({ player_id:102, faction_id:7 }, leadership, 7);
  const member = roleGrantCapabilities({ player_id:103, faction_id:7 }, leadership, 7);

  assert.deepEqual(
    { admin:leader.canGrantAdmin, assistant:leader.canGrantAssistant },
    { admin:true, assistant:true }
  );
  assert.deepEqual(
    { admin:coLeader.canGrantAdmin, assistant:coLeader.canGrantAssistant },
    { admin:false, assistant:true }
  );
  assert.equal(member.canGrantAdmin, false);
  assert.equal(member.canGrantAssistant, false);

  assert.equal(canSetFactionRole(leader, { protected:true, role:'faction_admin' }, 'member'), false);
  assert.equal(canSetFactionRole(leader, { protected:false, role:'member' }, 'faction_admin'), true);
  assert.equal(canSetFactionRole(coLeader, { protected:false, role:'member' }, 'assistant'), true);
  assert.equal(canSetFactionRole(coLeader, { protected:false, role:'member' }, 'faction_admin'), false);
  assert.equal(canSetFactionRole(coLeader, { protected:false, role:'faction_admin' }, 'assistant'), false);
});

test('report visibility changes require faction management', () => {
  assert.equal(canManageReportVisibility({ isAdmin:true }, 7), true);
  assert.equal(canManageReportVisibility({ factionId:7, isFactionAdmin:true }, 7), true);
  assert.equal(canManageReportVisibility({ factionId:7, isAssistant:true }, 7), true);
  assert.equal(canManageReportVisibility({ factionId:7 }, 7), false);
  assert.equal(canManageReportVisibility({ factionId:8, isAssistant:true }, 7), false);
});

test('personal API replacement is bound to the logged-in player', () => {
  assert.equal(apiKeyBelongsToUser({ player_id:101 }, { player_id:101 }), true);
  assert.equal(apiKeyBelongsToUser({ player_id:102 }, { player_id:101 }), false);
  assert.equal(apiKeyBelongsToUser({}, { player_id:101 }), false);
});

test('closed accounts receive a non-Torn tombstone player ID', () => {
  assert.equal(closedAccountPlayerId(42), -42);
  assert.throws(() => closedAccountPlayerId(0), /valid user ID/);
});

test('settings entities sort alphabetically with numeric names', () => {
  const names = [
    { name:'Faction 10', id:10 },
    { name:'alpha', id:3 },
    { name:'Faction 2', id:2 },
    { name:'Bravo', id:4 }
  ];
  names.sort((left, right) => compareDisplayNames(left.name, right.name, left.id, right.id));
  assert.deepEqual(names.map(item => item.name), ['alpha', 'Bravo', 'Faction 2', 'Faction 10']);

  const accounts = sortFactionAccounts([
    { playerName:'Zulu', playerId:9 },
    { playerName:'Alpha', playerId:2 }
  ]);
  assert.deepEqual(accounts.map(item => item.playerName), ['Alpha', 'Zulu']);

  const factions = sortTrackedFactions([
    { factionName:'WIT-Horizon', factionId:4 },
    { factionName:'Goodfellas Inc.', factionId:1 }
  ]);
  assert.deepEqual(factions.map(item => item.factionName), ['Goodfellas Inc.', 'WIT-Horizon']);
});

test('the obsolete Workspace route is absent and Settings exposes personal API access', () => {
  const html = readFileSync(new URL('../v2/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../v2/app.css', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.doesNotMatch(html, /data-view=["']home["']/);
  assert.doesNotMatch(html, />Workspace</);
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs must remain unique');
  assert.doesNotMatch(html, /class="settings-profile"/);
  assert.doesNotMatch(html, /Signed-in account/);
  assert.match(html, /id="personalApiKeyForm"/);
  assert.match(html, /id="personalApiKeyRemove"/);
  assert.match(html, /id="closeAccountButton"/);
  assert.doesNotMatch(html, /class="settings-panel account-close-section"/);
  assert.match(html, /class="settings-account-actions"[\s\S]*id="closeAccountButton"[\s\S]*id="logoutButton"/);
  assert.match(html, /id="factionRolesSection"/);
  assert.match(html, /id="factionRolesList" class="access-list settings-scroll-list"/);
  assert.match(html, /id="adminFactionList" class="admin-faction-list settings-scroll-list"/);
  assert.match(html, /class="settings-columns"/);
  assert.match(html, /id="factionRoleAddToggle"/);
  assert.match(html, /id="factionRoleMemberSearch"[^>]+list="factionRoleMemberOptions"/);
  assert.match(html, /id="factionRoleNewRole"/);
  assert.match(css, /Settings: flat account and permissions ledger/);
  assert.match(css, /#settingsView \.settings-panel-head/);
  assert.match(css, /#settingsView \.settings-scroll-list\s*\{[^}]*max-height:\s*244px;/s);
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
