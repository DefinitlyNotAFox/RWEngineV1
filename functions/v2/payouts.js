import { loadFactionPermissions } from './faction-leadership.js';
import {
  calculatePayoutRows,
  loadPayoutProfile,
  normalizePayoutProfile
} from './payout-profile.js';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') {
      return json({ success:false, message:'Method not allowed. Use POST.' }, 405);
    }
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');

    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const factionId = await resolveFactionId(env.DB, user, body.factionId);
    const warId = String(body.warId || '').trim();
    if (!warId) throw httpError(400, 'Missing war ID.');

    await ensurePayoutSchema(env.DB);
    await ensurePayoutColumns(env.DB);
    await ensureAccessSchema(env.DB);

    const war = await loadWar(env.DB, factionId, warId);
    if (!war) throw httpError(404, 'Imported war not found for this faction.');
    await assertWarAccess(env.DB, user, factionId, war);

    const permissions = await loadFactionPermissions(env.DB, user, factionId);
    const canSave = Number(user.is_admin) === 1 ||
      permissions.isFactionAdmin === true ||
      permissions.isAssistant === true;
    if (!canSave) {
      throw httpError(403, 'Faction management access is required to use payout tools.');
    }
    const storedProfile = await loadPayoutProfile(env.DB, factionId);
    const action = String(body.action || 'preview');

    if (action === 'list') {
      return json({
        success:true,
        factionId,
        warId,
        canSave,
        profile:storedProfile,
        runs:await loadRuns(env.DB, factionId, warId)
      });
    }

    const profile = action === 'preview' && body.profile
      ? normalizePayoutProfile(body.profile)
      : storedProfile;

    const rows = await loadPayoutRows(env.DB, factionId, warId);
    if (!rows.length) throw httpError(404, 'No member performance is stored for this war.');

    const unavailableModules = payoutUnavailableModules(rows, profile);
    const unavailableIds = new Set(unavailableModules.map(item => item.id));
    const calculationProfile = {
      ...profile,
      modules:(profile.modules || []).map(module =>
        unavailableIds.has(String(module.id || ''))
          ? { ...module, enabled:false }
          : module
      )
    };

    const calculation = calculatePayoutRows(rows, calculationProfile);
    const preview = {
      warId,
      factionId,
      ...calculation,
      profile,
      unavailableModules
    };

    if (action === 'preview') {
      return json({
        success:true,
        canSave,
        preview
      });
    }

    if (action === 'save') {
      if (!canSave) {
        throw httpError(403, 'Assistant or faction-admin access is required to save payout runs.');
      }
      if (unavailableModules.length) {
        const error = httpError(
          422,
          unavailableModules.map(item => item.reason || (item.label + ' is unavailable for this war.')).join(' ')
        );
        error.code = 'PAYOUT_MODULE_UNAVAILABLE';
        throw error;
      }

      const now = unixNow();
      const legacy = legacyProfileFields(profile);
      const result = await env.DB.prepare(`
        INSERT INTO payout_runs (
          faction_id, war_id, war_rate, outside_rate, milestone_value,
          total_payout, member_count, payload_json, created_by_user_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        factionId,
        warId,
        legacy.warRate,
        legacy.outsideRate,
        legacy.milestoneValue,
        calculation.totalPayout,
        calculation.members.length,
        JSON.stringify(preview),
        Number(user.user_id),
        now
      ).run();

      return json({
        success:true,
        canSave:true,
        run:{
          runId:Number(result.meta?.last_row_id || 0),
          createdAt:now,
          createdByPlayerId:Number(user.player_id || 0) || null,
          preview
        },
        message:'Payout run saved.'
      });
    }

    throw httpError(400, 'Unknown payout action: ' + action);
  } catch (error) {
    return json({
      success:false,
      ...(error?.code ? { code:error.code } : {}),
      message:error?.message || 'Unexpected payout error.'
    }, error?.status || 500);
  }
}

function legacyProfileFields(profile) {
  const modules = new Map((profile?.modules || []).map(item => [item.id, item]));
  const war = modules.get('rankedRespect') || {};
  const outside = modules.get('outsideChainRespect') || {};
  return {
    warRate:Number(war.rate || 0),
    outsideRate:Number(outside.rate || 0),
    milestoneValue:Number(war.milestoneValue || outside.milestoneValue || 0)
  };
}

async function loadPayoutRows(db, factionId, warId) {
  const result = await db.prepare(`
    SELECT
      player_id,
      player_name,
      attack_detail_complete,
      payout_detail_version,
      COALESCE(war_hits, 0) AS war_hits,
      COALESCE(score_up, 0) AS score_up,
      COALESCE(assists, 0) AS assists,
      COALESCE(outside_hits, 0) AS outside_hits,
      COALESCE(respect_earned, 0) AS respect_earned,
      COALESCE(chain_bonus_hits, 0) AS chain_bonus_hits,
      COALESCE(chain_bonus_score, 0) AS chain_bonus_score,
      COALESCE(outside_chain_hits, 0) AS outside_chain_hits,
      COALESCE(outside_chain_respect, 0) AS outside_chain_respect,
      COALESCE(outside_chain_bonus_hits, 0) AS outside_chain_bonus_hits,
      COALESCE(outside_chain_bonus_respect, 0) AS outside_chain_bonus_respect
    FROM war_log
    WHERE faction_id = ? AND war_id = ?
    ORDER BY player_name COLLATE NOCASE
  `).bind(factionId, warId).all();

  return result.results || [];
}

function payoutUnavailableModules(rows, profile) {
  const enabled = new Set(
    (profile?.modules || [])
      .filter(module => module?.enabled !== false)
      .map(module => String(module.id || ''))
  );

  const unavailable = [];

  // These values were added after the original aggregate model. Older wars can
  // still calculate every other payout module directly from war_log.
  if (
    enabled.has('outsideChainRespect') &&
    rows.some(row => Number(row.payout_detail_version || 0) < 1)
  ) {
    unavailable.push({
      id:'outsideChainRespect',
      label:'Outside-chain respect',
      reason:'Outside-chain respect was not stored for this older war.'
    });
  }

  return unavailable;
}

async function loadRuns(db, factionId, warId) {
  const result = await db.prepare(`
    SELECT
      pr.run_id,
      pr.total_payout,
      pr.member_count,
      pr.payload_json,
      pr.created_at,
      u.player_id AS created_by_player_id,
      u.player_name AS created_by_player_name
    FROM payout_runs pr
    LEFT JOIN users u ON u.user_id = pr.created_by_user_id
    WHERE pr.faction_id = ? AND pr.war_id = ?
    ORDER BY pr.run_id DESC
    LIMIT 20
  `).bind(factionId, warId).all();

  return (result.results || []).map(row => {
    let preview = null;
    try { preview = JSON.parse(String(row.payload_json || '')); } catch (_) {}
    return {
      runId:Number(row.run_id),
      totalPayout:Number(row.total_payout || 0),
      memberCount:Number(row.member_count || 0),
      createdAt:Number(row.created_at || 0),
      createdByPlayerId:Number(row.created_by_player_id || 0) || null,
      createdByPlayerName:row.created_by_player_name || null,
      preview
    };
  });
}

async function ensureAccessSchema(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS resource_permissions (permission_id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, faction_id INTEGER NOT NULL, resource_type TEXT NOT NULL, resource_key TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'faction' CHECK (visibility IN ('private', 'faction', 'public')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(faction_id, resource_type, resource_key))"
  ).run();
}

async function ensurePayoutSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS payout_runs (
      run_id INTEGER PRIMARY KEY AUTOINCREMENT,
      faction_id INTEGER NOT NULL,
      war_id TEXT NOT NULL,
      war_rate REAL NOT NULL DEFAULT 0,
      outside_rate REAL NOT NULL DEFAULT 0,
      milestone_value REAL NOT NULL DEFAULT 0,
      total_payout INTEGER NOT NULL,
      member_count INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_by_user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_payout_runs_war
    ON payout_runs(faction_id, war_id, run_id DESC)
  `).run();
}

async function ensurePayoutColumns(db) {
  const columns = await db.prepare('PRAGMA table_info(war_log)').all();
  const found = new Set((columns.results || []).map(row => String(row.name)));
  const additions = [
    ['respect_earned', 'ALTER TABLE war_log ADD COLUMN respect_earned REAL'],
    ['attack_detail_complete', 'ALTER TABLE war_log ADD COLUMN attack_detail_complete INTEGER NOT NULL DEFAULT 0'],
    ['chain_bonus_hits', 'ALTER TABLE war_log ADD COLUMN chain_bonus_hits INTEGER NOT NULL DEFAULT 0'],
    ['chain_bonus_score', 'ALTER TABLE war_log ADD COLUMN chain_bonus_score REAL NOT NULL DEFAULT 0'],
    ['outside_chain_hits', 'ALTER TABLE war_log ADD COLUMN outside_chain_hits INTEGER NOT NULL DEFAULT 0'],
    ['outside_chain_respect', 'ALTER TABLE war_log ADD COLUMN outside_chain_respect REAL NOT NULL DEFAULT 0'],
    ['outside_chain_bonus_hits', 'ALTER TABLE war_log ADD COLUMN outside_chain_bonus_hits INTEGER NOT NULL DEFAULT 0'],
    ['outside_chain_bonus_respect', 'ALTER TABLE war_log ADD COLUMN outside_chain_bonus_respect REAL NOT NULL DEFAULT 0'],
    ['payout_detail_version', 'ALTER TABLE war_log ADD COLUMN payout_detail_version INTEGER NOT NULL DEFAULT 0']
  ];

  for (const [name, sql] of additions) {
    if (found.has(name)) continue;
    try { await db.prepare(sql).run(); }
    catch (error) {
      if (!/duplicate column|already exists/i.test(String(error?.message || error || ''))) throw error;
    }
  }
}

async function loadWar(db, factionId, warId) {
  return db.prepare(`
    SELECT
      war_id,
      faction_id,
      imported_by_user_id
    FROM wars
    WHERE faction_id = ? AND war_id = ?
    LIMIT 1
  `).bind(factionId, warId).first();
}

async function assertWarAccess(db, user, factionId, war) {
  if (Number(user.is_admin) === 1) return;

  const factionPermissions = await loadFactionPermissions(db, user, factionId);
  if (factionPermissions.isFactionAdmin || factionPermissions.isAssistant) return;

  const permission = await db.prepare(
    'SELECT owner_user_id, visibility FROM resource_permissions WHERE faction_id = ? AND resource_type = ? AND resource_key = ? LIMIT 1'
  ).bind(factionId, 'war', String(war.war_id)).first();

  const visibility = permission?.visibility || 'faction';
  if (visibility !== 'private') return;

  const permissionOwnerId = Number(permission?.owner_user_id || 0);
  const importOwnerId = Number(war.imported_by_user_id || 0);
  if (
    permissionOwnerId !== Number(user.user_id) &&
    importOwnerId !== Number(user.user_id)
  ) {
    throw httpError(403, 'This war report is private.');
  }
}

async function resolveFactionId(db, user, requestedValue) {
  const accountFactionId = Number(user.faction_id || 0);
  const requestedFactionId = Number(requestedValue || accountFactionId);
  if (!Number.isSafeInteger(requestedFactionId) || requestedFactionId <= 0) {
    throw httpError(400, 'A valid faction ID is required.');
  }
  if (requestedFactionId !== accountFactionId && Number(user.is_admin) !== 1) {
    throw httpError(403, 'Admin access is required to view another faction.');
  }

  const faction = await db.prepare(
    'SELECT faction_id, enabled FROM factions WHERE faction_id = ? LIMIT 1'
  ).bind(requestedFactionId).first();

  if (!faction || Number(faction.enabled) !== 1) {
    throw httpError(404, 'That faction is not currently tracked by RWE.');
  }
  return requestedFactionId;
}

async function getCurrentUser(env, request) {
  const token = getCookie(request, 'rwengine_session');
  if (!token) throw httpError(401, 'Not logged in.');

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`
    SELECT
      u.user_id,
      u.player_id,
      u.player_name,
      u.faction_id,
      u.is_admin,
      u.is_disabled
    FROM sessions s
    JOIN users u ON u.user_id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, unixNow()).first();

  if (!row) throw httpError(401, 'Session expired or invalid.');
  if (Number(row.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  return row;
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

async function readJson(request) {
  try { return await request.json(); }
  catch (_) { return {}; }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store'
    }
  });
}
