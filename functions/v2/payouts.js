import { loadFactionPermissions } from './faction-leadership.js';

const DEFAULT_WAR_RATE = 120000;
const DEFAULT_OUTSIDE_RATE = 80000;
const DEFAULT_MILESTONE_VALUE = 10;

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

    const war = await loadWar(env.DB, factionId, warId);
    if (!war) throw httpError(404, 'Imported war not found for this faction.');
    await assertWarAccess(env.DB, user, factionId, war);

    const permissions = await loadFactionPermissions(env.DB, user, factionId);
    const canSave = Number(user.is_admin) === 1 ||
      permissions.isFactionAdmin === true ||
      permissions.isAssistant === true;

    const action = String(body.action || 'preview');

    if (action === 'list') {
      const runs = await loadRuns(env.DB, factionId, warId);
      return json({
        success:true,
        factionId,
        warId,
        canSave,
        defaults:defaultSettings(),
        runs
      });
    }

    const settings = normalizeSettings(body);
    const rows = await loadPayoutRows(env.DB, factionId, warId);
    if (!rows.length) throw httpError(404, 'No member performance is stored for this war.');

    const incomplete = rows.some(row =>
      Number(row.attack_detail_complete || 0) !== 1 ||
      Number(row.payout_detail_version || 0) < 1
    );
    if (incomplete) {
      const error = httpError(
        409,
        'Payout detail is not ready for this war. Re-import or rebuild attack detail first.'
      );
      error.code = 'PAYOUT_DETAIL_REQUIRED';
      throw error;
    }

    const calculation = calculatePayoutRows(rows, settings);
    const preview = {
      warId,
      factionId,
      settings,
      ...calculation
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

      const now = unixNow();
      const result = await env.DB.prepare(`
        INSERT INTO payout_runs (
          faction_id, war_id, war_rate, outside_rate, milestone_value,
          total_payout, member_count, payload_json, created_by_user_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        factionId,
        warId,
        settings.warRate,
        settings.outsideRate,
        settings.milestoneValue,
        calculation.totalPayout,
        calculation.members.length,
        JSON.stringify(preview),
        Number(user.user_id),
        now
      ).run();

      const runId = Number(result.meta?.last_row_id || 0);
      return json({
        success:true,
        canSave:true,
        run:{
          runId,
          createdAt:now,
          createdByPlayerId:Number(user.player_id || 0) || null,
          ...preview
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

export function calculatePayoutRows(rows, settings = {}) {
  const normalized = {
    warRate:finiteNonNegative(settings.warRate, DEFAULT_WAR_RATE),
    outsideRate:finiteNonNegative(settings.outsideRate, DEFAULT_OUTSIDE_RATE),
    milestoneValue:finiteNonNegative(settings.milestoneValue, DEFAULT_MILESTONE_VALUE)
  };

  const members = (Array.isArray(rows) ? rows : []).map(row => {
    const warRespectRaw = Math.max(0, finiteNonNegative(row.respect_earned ?? row.warRespectRaw, 0));
    const warBonusRespect = Math.max(0, finiteNonNegative(row.chain_bonus_score ?? row.warBonusRespect, 0));
    const warBonusHits = Math.max(0, finiteNonNegative(row.chain_bonus_hits ?? row.warBonusHits, 0));

    const outsideHits = Math.max(0, finiteNonNegative(row.outside_chain_hits ?? row.outsideChainHits, 0));
    const outsideRespectRaw = Math.max(0, finiteNonNegative(row.outside_chain_respect ?? row.outsideRespectRaw, 0));
    const outsideBonusHits = Math.max(0, finiteNonNegative(
      row.outside_chain_bonus_hits ?? row.outsideBonusHits,
      0
    ));
    const outsideBonusRespect = Math.max(0, finiteNonNegative(
      row.outside_chain_bonus_respect ?? row.outsideBonusRespect,
      0
    ));

    const warRespect = Math.max(
      0,
      warRespectRaw - warBonusRespect + warBonusHits * normalized.milestoneValue
    );
    const outsideRespect = Math.max(
      0,
      outsideRespectRaw - outsideBonusRespect + outsideBonusHits * normalized.milestoneValue
    );

    const warPayout = Math.round(warRespect * normalized.warRate);
    const outsidePayout = Math.round(outsideRespect * normalized.outsideRate);
    const totalPayout = warPayout + outsidePayout;

    return {
      playerId:Number(row.player_id ?? row.playerId || 0),
      playerName:String(row.player_name ?? row.playerName || 'Unknown'),
      warRespectRaw,
      warBonusHits,
      warBonusRespect,
      warRespect,
      outsideHits,
      outsideRespectRaw,
      outsideBonusHits,
      outsideBonusRespect,
      outsideRespect,
      warPayout,
      outsidePayout,
      totalPayout
    };
  }).filter(member => member.playerId > 0);

  members.sort((a, b) =>
    b.totalPayout - a.totalPayout ||
    a.playerName.localeCompare(b.playerName, undefined, { sensitivity:'base', numeric:true })
  );

  return {
    members,
    totalWarRespect:members.reduce((sum, member) => sum + member.warRespect, 0),
    totalOutsideRespect:members.reduce((sum, member) => sum + member.outsideRespect, 0),
    totalWarPayout:members.reduce((sum, member) => sum + member.warPayout, 0),
    totalOutsidePayout:members.reduce((sum, member) => sum + member.outsidePayout, 0),
    totalPayout:members.reduce((sum, member) => sum + member.totalPayout, 0)
  };
}

function normalizeSettings(body) {
  const warRate = finiteNumber(body.warRate ?? DEFAULT_WAR_RATE, 'War rate');
  const outsideRate = finiteNumber(body.outsideRate ?? DEFAULT_OUTSIDE_RATE, 'Outside rate');
  const milestoneValue = finiteNumber(body.milestoneValue ?? DEFAULT_MILESTONE_VALUE, 'Milestone value');

  if (warRate < 0 || warRate > 10000000) {
    throw httpError(400, 'War rate must be between 0 and 10,000,000.');
  }
  if (outsideRate < 0 || outsideRate > 10000000) {
    throw httpError(400, 'Outside rate must be between 0 and 10,000,000.');
  }
  if (milestoneValue < 0 || milestoneValue > 1000) {
    throw httpError(400, 'Milestone value must be between 0 and 1,000 respect.');
  }

  return { warRate, outsideRate, milestoneValue };
}

function defaultSettings() {
  return {
    warRate:DEFAULT_WAR_RATE,
    outsideRate:DEFAULT_OUTSIDE_RATE,
    milestoneValue:DEFAULT_MILESTONE_VALUE
  };
}

async function loadPayoutRows(db, factionId, warId) {
  const result = await db.prepare(`
    SELECT
      player_id,
      player_name,
      attack_detail_complete,
      payout_detail_version,
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

async function loadRuns(db, factionId, warId) {
  const result = await db.prepare(`
    SELECT
      pr.run_id,
      pr.war_rate,
      pr.outside_rate,
      pr.milestone_value,
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
    let payload = null;
    try { payload = JSON.parse(String(row.payload_json || '')); } catch (_) {}
    return {
      runId:Number(row.run_id),
      warRate:Number(row.war_rate || 0),
      outsideRate:Number(row.outside_rate || 0),
      milestoneValue:Number(row.milestone_value || 0),
      totalPayout:Number(row.total_payout || 0),
      memberCount:Number(row.member_count || 0),
      createdAt:Number(row.created_at || 0),
      createdByPlayerId:Number(row.created_by_player_id || 0) || null,
      createdByPlayerName:row.created_by_player_name || null,
      preview:payload
    };
  });
}

async function ensurePayoutSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS payout_runs (
      run_id INTEGER PRIMARY KEY AUTOINCREMENT,
      faction_id INTEGER NOT NULL,
      war_id TEXT NOT NULL,
      war_rate REAL NOT NULL,
      outside_rate REAL NOT NULL,
      milestone_value REAL NOT NULL,
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
      opponent_faction_name,
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

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw httpError(400, label + ' must be a number.');
  return number;
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
