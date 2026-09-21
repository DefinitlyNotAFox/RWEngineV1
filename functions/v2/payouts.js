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
    const action = String(body.action || 'preview');

    await ensurePayoutSchema(env.DB);
    await ensurePayoutColumns(env.DB);
    await ensureAccessSchema(env.DB);
    await ensureWarPayoutColumns(env.DB);
    await ensureMemberPaymentSchema(env.DB);

    const permissions = await loadFactionPermissions(env.DB, user, factionId);
    const canManage = Number(user.is_admin) === 1 || permissions.isFactionAdmin === true;

    if (action === 'wars') {
      const result = await env.DB.prepare(`
        SELECT
          war_id,
          report_id,
          opponent_faction_id,
          opponent_faction_name,
          start_timestamp,
          end_timestamp,
          imported_at,
          COALESCE(payout_status, 'outstanding') AS payout_status,
          payout_confirmed_at
        FROM wars
        WHERE faction_id = ?
        ORDER BY COALESCE(end_timestamp, start_timestamp, imported_at, 0) DESC
        LIMIT 200
      `).bind(factionId).all();

      return json({
        success:true,
        factionId,
        canManage,
        wars:(result.results || []).map(row => ({
          warId:String(row.war_id || row.report_id || ''),
          reportId:String(row.report_id || row.war_id || ''),
          opponentFactionId:Number(row.opponent_faction_id || 0) || null,
          opponentFactionName:row.opponent_faction_name || 'Unknown opponent',
          startTimestamp:Number(row.start_timestamp || 0) || null,
          endTimestamp:Number(row.end_timestamp || 0) || null,
          importedAt:Number(row.imported_at || 0) || null,
          payoutStatus:String(row.payout_status || 'outstanding') === 'paid' ? 'paid' : 'outstanding',
          payoutConfirmedAt:Number(row.payout_confirmed_at || 0) || null
        }))
      });
    }

    const warId = String(body.warId || '').trim();
    if (!warId) throw httpError(400, 'Missing war ID.');

    const war = await loadWar(env.DB, factionId, warId);
    if (!war) throw httpError(404, 'Imported war not found for this faction.');

    const payoutStatus = String(war.payout_status || 'outstanding') === 'paid'
      ? 'paid'
      : 'outstanding';

    if (!canManage && payoutStatus !== 'paid') {
      throw httpError(403, 'This payout is still outstanding.');
    }

    const storedProfile = await loadPayoutProfile(env.DB, factionId);
    const confirmedPreview = payoutStatus === 'paid'
      ? parseSnapshot(war.payout_snapshot_json)
      : null;

    if (action === 'list') {
      return json({
        success:true,
        factionId,
        warId,
        canSave:canManage,
        canManage,
        status:payoutStatus,
        confirmedAt:Number(war.payout_confirmed_at || 0) || null,
        profile:confirmedPreview?.profile || storedProfile,
        preview:confirmedPreview
      });
    }

    if (payoutStatus === 'paid') {
      if (action !== 'preview') {
        throw httpError(409, 'This payout has already been confirmed.');
      }
      if (!confirmedPreview) {
        throw httpError(409, 'Confirmed payout snapshot is unavailable.');
      }
      return json({
        success:true,
        canSave:canManage,
        canManage,
        status:'paid',
        preview:confirmedPreview
      });
    }

    if (!canManage) {
      throw httpError(403, 'Faction-admin access is required for outstanding payouts.');
    }

    const profile = body.profile
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

    const marketCalculation = calculatePayoutRows(rows, calculationProfile);
    const marketValuePayout = Math.max(0, Math.round(Number(marketCalculation.totalPayout || 0)));
    let payoutTotalOverride = storedPayoutTotalOverride(war.payout_total_override);

    if (action === 'setTotalPayout') {
      const requestedTotal = requestedPayoutTotal(body.amount);
      payoutTotalOverride = requestedTotal === null || requestedTotal === marketValuePayout
        ? null
        : requestedTotal;

      await env.DB.prepare(
        'UPDATE wars SET payout_total_override = ?, updated_at = ? WHERE faction_id = ? AND war_id = ?'
      ).bind(
        payoutTotalOverride,
        unixNow(),
        factionId,
        warId
      ).run();
    }

    const calculation = applyPayoutTotalOverride(marketCalculation, payoutTotalOverride);
    const payments = await loadMemberPayments(env.DB, factionId, warId);
    const preview = attachPaymentState({
      warId,
      factionId,
      ...calculation,
      profile,
      unavailableModules,
      status:'outstanding'
    }, payments);

    if (action === 'setTotalPayout') {
      return json({
        success:true,
        canSave:true,
        canManage:true,
        status:'outstanding',
        preview
      });
    }

    if (action === 'preview') {
      return json({
        success:true,
        canSave:true,
        canManage:true,
        status:'outstanding',
        preview
      });
    }

    if (action === 'setMemberPaid') {
      const playerId = Number(body.playerId || 0);
      const paid = body.paid === true;
      const member = preview.members.find(item => Number(item.playerId) === playerId);
      if (!member) throw httpError(404, 'Payout member not found.');

      if (paid && Number(member.totalPayout || 0) > 0) {
        const now = unixNow();
        await env.DB.prepare(`
          INSERT INTO payout_member_payments (
            faction_id, war_id, player_id, amount, paid_at, paid_by_user_id
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(faction_id, war_id, player_id) DO UPDATE SET
            amount = excluded.amount,
            paid_at = excluded.paid_at,
            paid_by_user_id = excluded.paid_by_user_id
        `).bind(
          factionId,
          warId,
          playerId,
          Math.round(Number(member.totalPayout || 0)),
          now,
          Number(user.user_id)
        ).run();
      } else {
        await env.DB.prepare(
          'DELETE FROM payout_member_payments WHERE faction_id = ? AND war_id = ? AND player_id = ?'
        ).bind(factionId, warId, playerId).run();
      }

      const nextPayments = await loadMemberPayments(env.DB, factionId, warId);
      return json({
        success:true,
        canManage:true,
        preview:attachPaymentState({
          warId,
          factionId,
          ...calculation,
          profile,
          unavailableModules,
          status:'outstanding'
        }, nextPayments)
      });
    }

    if (action === 'confirm') {
      if (unavailableModules.length) {
        throw httpError(
          422,
          unavailableModules.map(item => item.reason || (item.label + ' is unavailable for this war.')).join(' ')
        );
      }

      const missing = preview.members.filter(member =>
        Number(member.totalPayout || 0) > 0 && member.paid !== true
      );

      if (missing.length) {
        const error = httpError(
          409,
          `Mark every payout as paid before confirming. ${missing.length} member${missing.length === 1 ? '' : 's'} remaining.`
        );
        error.code = 'PAYOUT_MEMBERS_OUTSTANDING';
        throw error;
      }

      const now = unixNow();
      const confirmed = {
        ...preview,
        status:'paid',
        confirmedAt:now
      };

      await env.DB.prepare(`
        UPDATE wars
        SET payout_status = 'paid',
            payout_confirmed_at = ?,
            payout_confirmed_by_user_id = ?,
            payout_snapshot_json = ?
        WHERE faction_id = ? AND war_id = ?
      `).bind(
        now,
        Number(user.user_id),
        JSON.stringify(confirmed),
        factionId,
        warId
      ).run();

      return json({
        success:true,
        canManage:true,
        status:'paid',
        confirmedAt:now,
        preview:confirmed,
        message:'Payout confirmed.'
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
function requestedPayoutTotal(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw httpError(400, 'Payout total must be a whole money amount of 0 or more.');
  }
  return number;
}

function storedPayoutTotalOverride(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function applyPayoutTotalOverride(calculation, overrideValue) {
  const marketValuePayout = Math.max(0, Math.round(Number(calculation?.totalPayout || 0)));
  const override = storedPayoutTotalOverride(overrideValue);

  if (override === null) {
    return {
      ...calculation,
      marketValuePayout,
      payoutTotalOverride:null
    };
  }

  const members = Array.isArray(calculation?.members) ? calculation.members : [];
  const entries = [];

  for (const member of members) {
    for (const component of Array.isArray(member.components) ? member.components : []) {
      const source = Math.max(0, Math.round(Number(component.payout || 0)));
      if (source <= 0) continue;
      entries.push({ member, component, source });
    }
  }

  const sourceTotal = entries.reduce((sum, item) => sum + item.source, 0);
  if (override > 0 && sourceTotal <= 0) {
    throw httpError(422, 'A custom payout total cannot be distributed because the calculated payout is 0.');
  }

  for (const member of members) {
    for (const component of Array.isArray(member.components) ? member.components : []) {
      component.marketPayout = Math.max(0, Math.round(Number(component.payout || 0)));
      component.payout = 0;
    }
  }

  if (sourceTotal > 0 && override > 0) {
    const allocations = entries.map((item, index) => {
      const exact = override * item.source / sourceTotal;
      const floor = Math.floor(exact);
      return {
        ...item,
        index,
        floor,
        fraction:exact - floor
      };
    });

    let remainder = override - allocations.reduce((sum, item) => sum + item.floor, 0);
    allocations.sort((a, b) =>
      b.fraction - a.fraction ||
      b.source - a.source ||
      String(a.member.playerName || '').localeCompare(String(b.member.playerName || ''), undefined, {
        sensitivity:'base',
        numeric:true
      }) ||
      String(a.component.id || '').localeCompare(String(b.component.id || ''))
    );

    for (const allocation of allocations) {
      const extra = remainder > 0 ? 1 : 0;
      if (extra) remainder -= 1;
      allocation.component.payout = allocation.floor + extra;
    }
  }

  for (const member of members) {
    member.totalPayout = (member.components || []).reduce(
      (sum, component) => sum + Math.max(0, Math.round(Number(component.payout || 0))),
      0
    );
  }

  members.sort((a, b) =>
    Number(b.totalPayout || 0) - Number(a.totalPayout || 0) ||
    String(a.playerName || '').localeCompare(String(b.playerName || ''), undefined, {
      sensitivity:'base',
      numeric:true
    })
  );

  const modules = Array.isArray(calculation?.modules) ? calculation.modules : [];
  for (const module of modules) {
    module.marketPayout = Math.max(0, Math.round(Number(module.payout || 0)));
    module.payout = members.reduce((sum, member) => {
      const component = (member.components || []).find(item => item.id === module.id);
      return sum + Math.max(0, Math.round(Number(component?.payout || 0)));
    }, 0);
  }

  return {
    ...calculation,
    members,
    modules,
    activeModules:modules.filter(module => module.enabled !== false),
    marketValuePayout,
    payoutTotalOverride:override,
    totalPayout:override
  };
}

function parseSnapshot(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function attachPaymentState(preview, payments) {
  const byPlayer = new Map(
    (Array.isArray(payments) ? payments : []).map(item => [Number(item.playerId), item])
  );

  return {
    ...preview,
    members:(preview.members || []).map(member => {
      const payment = byPlayer.get(Number(member.playerId));
      const expected = Math.round(Number(member.totalPayout || 0));
      const paid = Boolean(payment && Number(payment.amount || 0) === expected && expected > 0);
      return {
        ...member,
        paid,
        paidAt:paid ? Number(payment.paidAt || 0) || null : null
      };
    })
  };
}

async function loadMemberPayments(db, factionId, warId) {
  const result = await db.prepare(`
    SELECT player_id, amount, paid_at, paid_by_user_id
    FROM payout_member_payments
    WHERE faction_id = ? AND war_id = ?
  `).bind(factionId, warId).all();

  return (result.results || []).map(row => ({
    playerId:Number(row.player_id),
    amount:Number(row.amount || 0),
    paidAt:Number(row.paid_at || 0) || null,
    paidByUserId:Number(row.paid_by_user_id || 0) || null
  }));
}

async function ensureMemberPaymentSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS payout_member_payments (
      faction_id INTEGER NOT NULL,
      war_id TEXT NOT NULL,
      player_id INTEGER NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      paid_at INTEGER NOT NULL,
      paid_by_user_id INTEGER NOT NULL,
      PRIMARY KEY (faction_id, war_id, player_id)
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_payout_member_payments_war
    ON payout_member_payments(faction_id, war_id)
  `).run();
}

async function ensureWarPayoutColumns(db) {
  const columns = await db.prepare('PRAGMA table_info(wars)').all();
  const found = new Set((columns.results || []).map(row => String(row.name)));
  const additions = [
    ['payout_status', "ALTER TABLE wars ADD COLUMN payout_status TEXT NOT NULL DEFAULT 'outstanding'"],
    ['payout_confirmed_at', 'ALTER TABLE wars ADD COLUMN payout_confirmed_at INTEGER'],
    ['payout_confirmed_by_user_id', 'ALTER TABLE wars ADD COLUMN payout_confirmed_by_user_id INTEGER'],
    ['payout_snapshot_json', 'ALTER TABLE wars ADD COLUMN payout_snapshot_json TEXT'],
    ['payout_total_override', 'ALTER TABLE wars ADD COLUMN payout_total_override INTEGER']
  ];

  for (const [name, sql] of additions) {
    if (found.has(name)) continue;
    try { await db.prepare(sql).run(); }
    catch (error) {
      if (!/duplicate column|already exists/i.test(String(error?.message || error || ''))) throw error;
    }
  }
}


function legacyProfileFields(profile) {
  const modules = new Map((profile?.modules || []).map(item => [item.id, item]));
  const war = modules.get('rankedRespect') || {};
  const outside = modules.get('outsideChainRespect') || {};
  return {
    warRate:Number(war.rate || 0),
    outsideRate:Number(outside.rate || 0),
    milestoneValue:Number(war.milestoneRate || outside.milestoneRate || 0)
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
      imported_by_user_id,
      COALESCE(payout_status, 'outstanding') AS payout_status,
      payout_confirmed_at,
      payout_snapshot_json,
      payout_total_override
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
