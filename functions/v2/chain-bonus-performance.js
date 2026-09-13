export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') {
      return json({ success: false, message: 'Method not allowed. Use POST.' }, 405);
    }
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');

    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const factionId = await resolveFactionId(env.DB, user, body.factionId);
    const range = resolveRange(body);

    const warsRow = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM wars
      WHERE faction_id = ?
        AND COALESCE(end_timestamp, start_timestamp, imported_at, 0) BETWEEN ? AND ?
    `).bind(factionId, range.from, range.to).first();

    const result = await env.DB.prepare(`
      SELECT
        wl.player_id,
        SUM(COALESCE(wl.chain_bonus_hits, 0)) AS chain_bonus_hits_out,
        SUM(COALESCE(wl.chain_bonus_score, 0)) AS chain_bonus_score_out,
        SUM(COALESCE(wl.chain_bonus_hits_in, 0)) AS chain_bonus_hits_in,
        SUM(COALESCE(wl.chain_bonus_score_in, 0)) AS chain_bonus_score_in,
        SUM(COALESCE(wl.chain_bonus_respect_lost_in, 0)) AS chain_bonus_respect_lost_in
      FROM war_log wl
      JOIN wars w ON w.war_id = wl.war_id
      WHERE wl.faction_id = ?
        AND COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) BETWEEN ? AND ?
      GROUP BY wl.player_id
      ORDER BY wl.player_id
    `).bind(factionId, range.from, range.to).all();

    const members = (result.results || []).map(row => ({
      playerId:Number(row.player_id),
      chainBonusHitsOut:Number(row.chain_bonus_hits_out || 0),
      chainBonusScoreOut:Number(row.chain_bonus_score_out || 0),
      chainBonusHitsIn:Number(row.chain_bonus_hits_in || 0),
      chainBonusScoreIn:Number(row.chain_bonus_score_in || 0),
      chainBonusRespectLostIn:Number(row.chain_bonus_respect_lost_in || 0)
    }));

    const wars = Number(warsRow?.count || 0);
    return json({
      success:true,
      factionId,
      range,
      wars,
      cachedWars:wars,
      refreshedWars:0,
      outgoingHits:members.reduce((sum, member) => sum + member.chainBonusHitsOut, 0),
      incomingHits:members.reduce((sum, member) => sum + member.chainBonusHitsIn, 0),
      warnings:[],
      source:'stored-aggregate',
      members
    });
  } catch (error) {
    return json(
      { success:false, message:error?.message || 'Unexpected chain bonus lookup error.' },
      error?.status || 500
    );
  }
}

function resolveRange(body) {
  const now = unixNow();
  const from = parseDateStart(body.from) || 0;
  const to = Math.min(now, parseDateEnd(body.to) || now);
  if (from > to) {
    throw httpError(400, 'The selected start date must not be after the end date.');
  }
  return { from, to };
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
    'SELECT faction_id, enabled FROM factions WHERE faction_id = ?'
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
    SELECT u.user_id, u.faction_id, u.is_admin, u.is_disabled
    FROM sessions s
    JOIN users u ON u.user_id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, unixNow()).first();
  if (!row) throw httpError(401, 'Session expired or invalid.');
  if (Number(row.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  return row;
}

function parseDateStart(value) {
  if (!value) return null;
  const timestamp = Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function parseDateEnd(value) {
  if (!value) return null;
  const timestamp = Date.parse(`${String(value).slice(0, 10)}T23:59:59Z`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return {};
  }
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
