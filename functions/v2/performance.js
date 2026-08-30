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
        SUM(COALESCE(wl.assists, 0)) AS stored_assists,
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

    // The imported war roster is the authoritative source for which player is
    // ours. Do not depend on attacker_faction_id/defender_faction_id being
    // present in Torn's attack payload; older v1 rows can omit those fields.
    // Likewise, assists are often represented by modifiers rather than a
    // literal result="Assist" value, so inspect the stored raw attack JSON.
    const attackMetricsResult = await env.DB.prepare(`
      SELECT
        own.player_id,
        SUM(CASE
          WHEN a.attacker_id = own.player_id AND (
            LOWER(TRIM(COALESCE(a.result, ''))) LIKE '%assist%'
            OR COALESCE(CAST(json_extract(a.raw_json, '$.is_assist') AS INTEGER), 0) = 1
            OR COALESCE(CAST(json_extract(a.raw_json, '$.assist') AS INTEGER), 0) = 1
            OR COALESCE(CAST(json_extract(a.raw_json, '$.modifiers.assist') AS REAL), 0) != 0
          ) THEN 1 ELSE 0 END
        ) AS assists,
        SUM(CASE
          WHEN a.attacker_id = own.player_id AND NOT (
            LOWER(TRIM(COALESCE(a.result, ''))) LIKE '%assist%'
            OR COALESCE(CAST(json_extract(a.raw_json, '$.is_assist') AS INTEGER), 0) = 1
            OR COALESCE(CAST(json_extract(a.raw_json, '$.assist') AS INTEGER), 0) = 1
            OR COALESCE(CAST(json_extract(a.raw_json, '$.modifiers.assist') AS REAL), 0) != 0
          ) THEN COALESCE(
            CASE WHEN json_valid(a.raw_json) THEN CAST(json_extract(a.raw_json, '$.respect_gain') AS REAL) END,
            CASE WHEN json_valid(a.raw_json) THEN CAST(json_extract(a.raw_json, '$.respect') AS REAL) END,
            NULLIF(a.respect_gain, 0),
            0
          ) ELSE 0 END
        ) AS respect_earned,
        SUM(CASE
          WHEN a.defender_id = own.player_id AND NOT (
            LOWER(TRIM(COALESCE(a.result, ''))) LIKE '%assist%'
            OR COALESCE(CAST(json_extract(a.raw_json, '$.is_assist') AS INTEGER), 0) = 1
            OR COALESCE(CAST(json_extract(a.raw_json, '$.assist') AS INTEGER), 0) = 1
            OR COALESCE(CAST(json_extract(a.raw_json, '$.modifiers.assist') AS REAL), 0) != 0
          ) THEN ABS(COALESCE(
            CASE WHEN json_valid(a.raw_json) THEN CAST(json_extract(a.raw_json, '$.respect_loss') AS REAL) END,
            NULLIF(a.respect_loss, 0),
            0
          )) ELSE 0 END
        ) AS respect_lost,
        SUM(CASE
          WHEN a.attacker_id = own.player_id OR a.defender_id = own.player_id
          THEN 1 ELSE 0 END
        ) AS attack_rows
      FROM war_log own
      JOIN wars w
        ON w.war_id = own.war_id
        AND w.faction_id = own.faction_id
      LEFT JOIN attacks a
        ON a.war_id = own.war_id
        AND a.faction_id = own.faction_id
        AND (a.attacker_id = own.player_id OR a.defender_id = own.player_id)
      WHERE own.faction_id = ?
        AND COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) BETWEEN ? AND ?
      GROUP BY own.player_id
    `).bind(factionId, range.from, range.to).all();

    const attackMetricsByPlayer = new Map((attackMetricsResult.results || []).map(row => [
      Number(row.player_id),
      {
        assists: Number(row.assists || 0),
        respectEarned: Number(row.respect_earned || 0),
        respectLost: Number(row.respect_lost || 0),
        attackRows: Number(row.attack_rows || 0)
      }
    ]));
    const totalWars = Number(totalWarsRow?.count || 0);

    const members = (performanceResult.results || []).map(row => {
      const playerId = Number(row.player_id);
      const wars = Number(row.wars || 0);
      const hits = Number(row.hits || 0);
      const scoreUp = Number(row.score_up || 0);
      const scoreDown = Number(row.score_down || 0);
      const attackMetrics = attackMetricsByPlayer.get(playerId);
      const hasAttackDetails = Number(attackMetrics?.attackRows || 0) > 0;

      return {
        playerId,
        playerName: row.player_name || `Player ${playerId}`,
        current: Number(row.is_current) === 1,
        wars,
        participation: totalWars > 0 ? wars / totalWars : null,
        warHits: hits,
        avgHitsPerWar: wars > 0 ? hits / wars : null,
        outsideHits: Number(row.outside_hits || 0),
        assists: hasAttackDetails
          ? attackMetrics.assists
          : Number(row.stored_assists || 0),
        respectEarned: hasAttackDetails ? attackMetrics.respectEarned : null,
        respectLost: hasAttackDetails ? attackMetrics.respectLost : null,
        attackDetailsAvailable: hasAttackDetails,
        scoreUp,
        scoreDown,
        netScore: scoreUp - scoreDown
      };
    });

    const playersWithAttackDetails = members.filter(member => member.attackDetailsAvailable).length;

    return json({
      success: true,
      generatedAt: now,
      factionId,
      range,
      totalWars,
      playersWithAttackDetails,
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
