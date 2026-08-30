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
    const now = unixNow();
    const range = await resolveWarRange(env.DB, factionId, body, now);

    const totalWarsRow = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM wars
      WHERE faction_id = ?
        AND COALESCE(end_timestamp, start_timestamp, imported_at, 0) BETWEEN ? AND ?
    `).bind(factionId, range.from, range.to).first();

    const performanceResult = await env.DB.prepare(`
      SELECT
        wl.player_id,
        MAX(wl.player_name) AS player_name,
        MAX(CASE WHEN fm.is_current = 1 THEN 1 ELSE 0 END) AS is_current,
        COUNT(DISTINCT wl.war_id) AS wars,
        SUM(COALESCE(wl.war_hits, 0)) AS hits,
        SUM(COALESCE(wl.outside_hits, 0)) AS outside_hits,
        SUM(COALESCE(wl.assists, 0)) AS assists,
        SUM(COALESCE(wl.score_up, 0)) AS score_up,
        SUM(COALESCE(wl.score_down, 0)) AS score_down
      FROM war_log wl
      JOIN wars w ON w.war_id = wl.war_id
      LEFT JOIN faction_members fm
        ON fm.faction_id = wl.faction_id
        AND fm.player_id = wl.player_id
      WHERE wl.faction_id = ?
        AND COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) BETWEEN ? AND ?
      GROUP BY wl.player_id
      ORDER BY MAX(wl.player_name) COLLATE NOCASE
    `).bind(factionId, range.from, range.to).all();

    // Attack details are authoritative for assists and respect. Filter by the
    // selected wars rather than the individual attack timestamps so a war that
    // crosses a date boundary is still counted consistently as one report.
    const attackCoverageRow = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM attacks a
      JOIN wars w ON w.war_id = a.war_id AND w.faction_id = a.faction_id
      WHERE a.faction_id = ?
        AND COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) BETWEEN ? AND ?
    `).bind(factionId, range.from, range.to).first();

    const assistResult = await env.DB.prepare(`
      SELECT
        a.attacker_id AS player_id,
        COUNT(*) AS assists
      FROM attacks a
      JOIN wars w ON w.war_id = a.war_id AND w.faction_id = a.faction_id
      WHERE a.faction_id = ?
        AND a.attacker_id IS NOT NULL
        AND (a.attacker_faction_id = ? OR a.attacker_faction_id IS NULL)
        AND LOWER(TRIM(COALESCE(a.result, ''))) = 'assist'
        AND COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) BETWEEN ? AND ?
      GROUP BY a.attacker_id
    `).bind(factionId, factionId, range.from, range.to).all();

    const respectEarnedResult = await env.DB.prepare(`
      SELECT
        a.attacker_id AS player_id,
        SUM(
          CASE
            WHEN COALESCE(a.respect_gain, 0) != 0 THEN a.respect_gain
            WHEN json_valid(a.raw_json) THEN COALESCE(
              CAST(json_extract(a.raw_json, '$.respect_gain') AS REAL),
              CAST(json_extract(a.raw_json, '$.respect') AS REAL),
              0
            )
            ELSE 0
          END
        ) AS respect_earned
      FROM attacks a
      JOIN wars w ON w.war_id = a.war_id AND w.faction_id = a.faction_id
      WHERE a.faction_id = ?
        AND a.attacker_id IS NOT NULL
        AND (a.attacker_faction_id = ? OR a.attacker_faction_id IS NULL)
        AND LOWER(TRIM(COALESCE(a.result, ''))) != 'assist'
        AND COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) BETWEEN ? AND ?
      GROUP BY a.attacker_id
    `).bind(factionId, factionId, range.from, range.to).all();

    const respectLostResult = await env.DB.prepare(`
      SELECT
        a.defender_id AS player_id,
        SUM(
          CASE
            WHEN json_valid(a.raw_json) THEN COALESCE(
              CAST(json_extract(a.raw_json, '$.respect_loss') AS REAL),
              CASE WHEN COALESCE(a.respect_loss, 0) != 0 THEN a.respect_loss ELSE NULL END,
              0
            )
            ELSE COALESCE(a.respect_loss, 0)
          END
        ) AS respect_lost
      FROM attacks a
      JOIN wars w ON w.war_id = a.war_id AND w.faction_id = a.faction_id
      WHERE a.faction_id = ?
        AND a.defender_id IS NOT NULL
        AND LOWER(TRIM(COALESCE(a.result, ''))) != 'assist'
        AND (
          a.attacker_faction_id = w.opponent_faction_id
          OR (a.attacker_faction_id IS NULL AND a.is_ranked_war = 1)
        )
        AND COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) BETWEEN ? AND ?
      GROUP BY a.defender_id
    `).bind(factionId, range.from, range.to).all();

    const attackCoverage = Number(attackCoverageRow?.count || 0);
    const assistsByPlayer = new Map((assistResult.results || []).map(row => [
      Number(row.player_id),
      Number(row.assists || 0)
    ]));
    const respectEarned = new Map((respectEarnedResult.results || []).map(row => [
      Number(row.player_id),
      Number(row.respect_earned || 0)
    ]));
    const respectLost = new Map((respectLostResult.results || []).map(row => [
      Number(row.player_id),
      Number(row.respect_lost || 0)
    ]));
    const totalWars = Number(totalWarsRow?.count || 0);

    const members = (performanceResult.results || []).map(row => {
      const playerId = Number(row.player_id);
      const wars = Number(row.wars || 0);
      const hits = Number(row.hits || 0);
      const scoreUp = Number(row.score_up || 0);
      const scoreDown = Number(row.score_down || 0);

      return {
        playerId,
        playerName: row.player_name || `Player ${playerId}`,
        current: Number(row.is_current) === 1,
        wars,
        participation: totalWars > 0 ? wars / totalWars : null,
        warHits: hits,
        avgHitsPerWar: wars > 0 ? hits / wars : null,
        outsideHits: Number(row.outside_hits || 0),
        assists: attackCoverage > 0
          ? (assistsByPlayer.get(playerId) || 0)
          : Number(row.assists || 0),
        respectEarned: attackCoverage > 0
          ? (respectEarned.get(playerId) || 0)
          : null,
        respectLost: attackCoverage > 0
          ? (respectLost.get(playerId) || 0)
          : null,
        scoreUp,
        scoreDown,
        netScore: scoreUp - scoreDown
      };
    });

    return json({
      success: true,
      generatedAt: now,
      factionId,
      range,
      totalWars,
      attackCoverage,
      source: 'imported-war-reports',
      members
    });
  } catch (error) {
    return json({
      success: false,
      message: error?.message || 'Unexpected performance analytics error.'
    }, error?.status || 500);
  }
}

async function resolveWarRange(db, factionId, body, now) {
  const bounds = await db.prepare(`
    SELECT
      MIN(COALESCE(end_timestamp, start_timestamp, imported_at, 0)) AS earliest,
      MAX(COALESCE(end_timestamp, start_timestamp, imported_at, 0)) AS latest
    FROM wars
    WHERE faction_id = ?
  `).bind(factionId).first();

  const earliest = Number(bounds?.earliest || 0) || now;
  const requestedFrom = parseDateStart(body.from);
  const requestedTo = parseDateEnd(body.to);
  const from = requestedFrom || earliest;
  const to = Math.min(now, requestedTo || now);

  if (from > to) throw httpError(400, 'The selected start date must not be after the end date.');
  return { from, to, fromDate: utcDate(from), toDate: utcDate(to) };
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

  const faction = await db.prepare(`
    SELECT faction_id, enabled FROM factions WHERE faction_id = ?
  `).bind(requestedFactionId).first();
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
      u.faction_id,
      u.is_admin,
      u.is_disabled
    FROM sessions s
    JOIN users u ON u.user_id = s.user_id
    WHERE s.token_hash = ?
      AND s.expires_at > ?
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

function utcDate(timestamp) {
  return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
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
  try { return await request.json(); } catch (_) { return {}; }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
