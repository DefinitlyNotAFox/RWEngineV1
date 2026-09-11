import { buildPlayerAnalysis } from './player-analysis.js';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') {
      return json({ success:false, message:'Method not allowed. Use POST.' }, 405);
    }
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');

    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const factionId = resolveFactionId(user, body.factionId);
    const action = String(body.action || 'list');

    if (action === 'save') {
      const playerId = positiveInt(body.playerId, 'playerId');
      return json(await saveSnapshot(env, user, factionId, playerId));
    }

    if (action === 'list') {
      return json(await listSnapshots(env.DB, user, factionId));
    }

    if (action === 'get') {
      const snapshotId = positiveInt(body.snapshotId, 'snapshotId');
      return json(await getSnapshot(env.DB, user, factionId, snapshotId));
    }

    if (action === 'delete') {
      const snapshotId = positiveInt(body.snapshotId, 'snapshotId');
      return json(await deleteSnapshot(env.DB, user, factionId, snapshotId));
    }

    return json({ success:false, message:'Unknown Player report action: ' + action }, 400);
  } catch (error) {
    return json(
      { success:false, message:error?.message || 'Unexpected saved-report error.' },
      error?.status || 500
    );
  }
}

async function saveSnapshot(env, user, factionId, playerId) {
  const payload = await buildPlayerAnalysis(env, user, factionId, playerId);
  const now = unixNow();

  const result = await env.DB.prepare(
    "INSERT INTO analysis_snapshots (owner_user_id, faction_id, target_player_id, target_player_name, report_type, payload_json, created_at) VALUES (?, ?, ?, ?, 'player-analysis', ?, ?)"
  ).bind(
    Number(user.user_id),
    factionId,
    Number(payload.player.playerId),
    String(payload.player.playerName || 'Player ' + payload.player.playerId),
    JSON.stringify(payload),
    now
  ).run();

  const snapshotId = Number(result.meta?.last_row_id || 0);
  if (!snapshotId) throw new Error('Saved report was created but no snapshot ID was returned.');

  await env.DB.prepare(
    "INSERT INTO resource_permissions (owner_user_id, faction_id, resource_type, resource_key, visibility, created_at, updated_at) VALUES (?, ?, 'player-analysis', ?, 'private', ?, ?) ON CONFLICT(faction_id, resource_type, resource_key) DO UPDATE SET owner_user_id = excluded.owner_user_id, visibility = 'private', updated_at = excluded.updated_at"
  ).bind(
    Number(user.user_id),
    factionId,
    String(snapshotId),
    now,
    now
  ).run();

  return {
    success:true,
    snapshot:{
      snapshotId,
      resourceType:'player-analysis',
      resourceKey:String(snapshotId),
      playerId:Number(payload.player.playerId),
      playerName:payload.player.playerName,
      createdAt:now,
      visibility:'private'
    },
    message:'Analysis snapshot saved privately.'
  };
}

async function listSnapshots(db, user, factionId) {
  const admin = Number(user.is_admin) === 1;
  const result = admin
    ? await db.prepare(
        "SELECT s.snapshot_id, s.owner_user_id, s.target_player_id, s.target_player_name, s.created_at, COALESCE(rp.visibility, 'private') AS visibility FROM analysis_snapshots s LEFT JOIN resource_permissions rp ON rp.faction_id = s.faction_id AND rp.resource_type = 'player-analysis' AND rp.resource_key = CAST(s.snapshot_id AS TEXT) WHERE s.faction_id = ? AND s.report_type = 'player-analysis' ORDER BY s.created_at DESC LIMIT 100"
      ).bind(factionId).all()
    : await db.prepare(
        "SELECT s.snapshot_id, s.owner_user_id, s.target_player_id, s.target_player_name, s.created_at, COALESCE(rp.visibility, 'private') AS visibility FROM analysis_snapshots s LEFT JOIN resource_permissions rp ON rp.faction_id = s.faction_id AND rp.resource_type = 'player-analysis' AND rp.resource_key = CAST(s.snapshot_id AS TEXT) WHERE s.faction_id = ? AND s.report_type = 'player-analysis' AND s.owner_user_id = ? ORDER BY s.created_at DESC LIMIT 100"
      ).bind(factionId, Number(user.user_id)).all();

  return {
    success:true,
    snapshots:(result.results || []).map(row => ({
      snapshotId:Number(row.snapshot_id),
      resourceType:'player-analysis',
      resourceKey:String(row.snapshot_id),
      ownerUserId:Number(row.owner_user_id),
      playerId:Number(row.target_player_id),
      playerName:row.target_player_name,
      createdAt:Number(row.created_at),
      visibility:String(row.visibility || 'private')
    }))
  };
}

async function getSnapshot(db, user, factionId, snapshotId) {
  const row = await db.prepare(
    "SELECT s.*, COALESCE(rp.visibility, 'private') AS visibility, rp.owner_user_id AS permission_owner_user_id FROM analysis_snapshots s LEFT JOIN resource_permissions rp ON rp.faction_id = s.faction_id AND rp.resource_type = 'player-analysis' AND rp.resource_key = CAST(s.snapshot_id AS TEXT) WHERE s.faction_id = ? AND s.snapshot_id = ? AND s.report_type = 'player-analysis' LIMIT 1"
  ).bind(factionId, snapshotId).first();

  if (!row) throw httpError(404, 'Saved player report not found.');
  assertCanView(user, row);

  let payload;
  try { payload = JSON.parse(row.payload_json); }
  catch (_) { throw new Error('Saved report payload is invalid.'); }

  return {
    success:true,
    snapshot:{
      snapshotId:Number(row.snapshot_id),
      resourceType:'player-analysis',
      resourceKey:String(row.snapshot_id),
      ownerUserId:Number(row.owner_user_id),
      playerId:Number(row.target_player_id),
      playerName:row.target_player_name,
      createdAt:Number(row.created_at),
      visibility:String(row.visibility || 'private')
    },
    analysis:payload
  };
}

async function deleteSnapshot(db, user, factionId, snapshotId) {
  const row = await db.prepare(
    "SELECT snapshot_id, owner_user_id FROM analysis_snapshots WHERE faction_id = ? AND snapshot_id = ? AND report_type = 'player-analysis' LIMIT 1"
  ).bind(factionId, snapshotId).first();

  if (!row) throw httpError(404, 'Saved player report not found.');
  if (Number(user.is_admin) !== 1 && Number(row.owner_user_id) !== Number(user.user_id)) {
    throw httpError(403, 'Only the report owner or an RWEngine admin can delete this report.');
  }

  const now = unixNow();
  await db.prepare(
    "UPDATE share_links SET is_enabled = 0, updated_at = ? WHERE faction_id = ? AND resource_type = 'player-analysis' AND resource_key = ? AND is_enabled = 1"
  ).bind(now, factionId, String(snapshotId)).run();

  await db.prepare(
    "DELETE FROM resource_permissions WHERE faction_id = ? AND resource_type = 'player-analysis' AND resource_key = ?"
  ).bind(factionId, String(snapshotId)).run();

  await db.prepare(
    "DELETE FROM analysis_snapshots WHERE faction_id = ? AND snapshot_id = ?"
  ).bind(factionId, snapshotId).run();

  return { success:true, message:'Saved player report deleted.' };
}

function assertCanView(user, row) {
  if (Number(user.is_admin) === 1) return;
  if (Number(row.owner_user_id) === Number(user.user_id)) return;
  if (Number(row.permission_owner_user_id || 0) === Number(user.user_id)) return;
  if (['faction','public'].includes(String(row.visibility || 'private'))) return;
  throw httpError(403, 'This saved player report is private.');
}

function resolveFactionId(user, requestedFactionId) {
  const own = Number(user.faction_id || 0) || null;
  const requested = Number(requestedFactionId || 0) || null;
  const factionId = Number(user.is_admin) === 1 ? (requested || own) : own;

  if (!factionId) throw httpError(400, 'A faction context is required to save reports.');
  if (Number(user.is_admin) !== 1 && requested && requested !== own) {
    throw httpError(403, 'Admin access required for another faction.');
  }
  return factionId;
}

async function getCurrentUser(env, request) {
  const token = cookie(request, 'rwengine_session');
  if (!token) throw httpError(401, 'Not logged in.');

  const tokenHash = await sha256(token);
  const user = await env.DB.prepare(
    'SELECT u.user_id, u.player_id, u.player_name, u.faction_id, u.faction_name, u.api_key_encrypted, u.api_key_iv, u.is_admin, u.is_disabled FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1'
  ).bind(tokenHash, unixNow()).first();

  if (!user) throw httpError(401, 'Session expired or invalid.');
  if (Number(user.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  return user;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function cookie(request, name) {
  const source = request.headers.get('Cookie') || '';
  for (const part of source.split(';')) {
    const [key,...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw httpError(400, 'Invalid ' + name + '.');
  return number;
}

async function readJson(request) {
  try { return await request.json(); }
  catch (_) { throw httpError(400, 'Invalid JSON body.'); }
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
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
      'Cache-Control':'no-store, max-age=0'
    }
  });
}
