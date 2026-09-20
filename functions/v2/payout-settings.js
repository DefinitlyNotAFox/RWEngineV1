import { loadFactionPermissions } from './faction-leadership.js';
import {
  cloneDefaultPayoutProfile,
  loadPayoutProfile,
  normalizePayoutProfile,
  payoutCatalog,
  resetPayoutProfile,
  savePayoutProfile
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
    const action = String(body.action || 'get');

    if (action === 'get') {
      return json({
        success:true,
        factionId,
        canEdit:await canEditSettings(env.DB, user, factionId),
        catalog:payoutCatalog(),
        defaults:cloneDefaultPayoutProfile(),
        profile:await loadPayoutProfile(env.DB, factionId)
      });
    }

    if (!await canEditSettings(env.DB, user, factionId)) {
      throw httpError(403, 'Faction-admin access is required to change payout settings.');
    }

    if (action === 'save') {
      const profile = normalizePayoutProfile(body.profile);
      await savePayoutProfile(env.DB, factionId, profile);
      return json({
        success:true,
        factionId,
        profile,
        catalog:payoutCatalog(),
        message:'Payout profile saved.'
      });
    }

    if (action === 'reset') {
      const profile = await resetPayoutProfile(env.DB, factionId);
      return json({
        success:true,
        factionId,
        profile,
        catalog:payoutCatalog(),
        message:'Payout profile reset to defaults.'
      });
    }

    throw httpError(400, 'Unknown payout settings action: ' + action);
  } catch (error) {
    return json({
      success:false,
      message:error?.message || 'Unexpected payout settings error.'
    }, error?.status || 500);
  }
}

async function canEditSettings(db, user, factionId) {
  if (Number(user?.is_admin) === 1) return true;
  const permissions = await loadFactionPermissions(db, user, factionId);
  return permissions.isFactionAdmin === true;
}

async function resolveFactionId(db, user, requestedValue) {
  const accountFactionId = Number(user.faction_id || 0);
  const requestedFactionId = Number(requestedValue || accountFactionId);
  if (!Number.isSafeInteger(requestedFactionId) || requestedFactionId <= 0) {
    throw httpError(400, 'A valid faction is required.');
  }
  if (requestedFactionId !== accountFactionId && Number(user.is_admin) !== 1) {
    throw httpError(403, 'Platform-admin access is required for another faction.');
  }

  const faction = await db.prepare(
    'SELECT faction_id FROM factions WHERE faction_id = ? AND enabled = 1 LIMIT 1'
  ).bind(requestedFactionId).first();

  if (!faction) throw httpError(404, 'That faction is not tracked by RWEngine.');
  return requestedFactionId;
}

async function getCurrentUser(env, request) {
  const token = cookie(request, 'rwengine_session');
  if (!token) throw httpError(401, 'Not logged in.');
  const tokenHash = await sha256(token);

  const user = await env.DB.prepare(`
    SELECT
      u.user_id, u.player_id, u.player_name, u.faction_id,
      u.is_admin, u.is_disabled
    FROM sessions s
    JOIN users u ON u.user_id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, unixNow()).first();

  if (!user) throw httpError(401, 'Session expired or invalid.');
  if (Number(user.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  return user;
}

function cookie(request, name) {
  const source = request.headers.get('Cookie') || '';
  for (const part of source.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
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
    headers:{ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }
  });
}
