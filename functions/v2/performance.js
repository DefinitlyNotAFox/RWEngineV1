import {
  factionLeadershipRole,
  loadFactionLeadership
} from './faction-leadership.js';

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
    await ensureAggregateSchema(env.DB);
    const now = unixNow();
    const selection = await resolveWarSelection(env.DB, factionId, body, now);
    const range = selection.range;
    const warFilter = selection.warIds.length
      ? `CAST(w.war_id AS TEXT) IN (${selection.warIds.map(() => '?').join(',')})`
      : 'COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) BETWEEN ? AND ?';
    const warFilterParams = selection.warIds.length
      ? selection.warIds
      : [range.from, range.to];

    const totalWarsRow = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM wars w
      WHERE w.faction_id = ?
        AND ${warFilter}
    `).bind(factionId, ...warFilterParams).first();

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
        SUM(COALESCE(wl.score_down, 0)) AS score_down,
        SUM(CASE WHEN COALESCE(wl.attack_detail_complete,0) = 1 THEN 1 ELSE 0 END) AS detail_wars,
        SUM(COALESCE(wl.attack_detail_rows, 0)) AS attack_rows,
        SUM(CASE WHEN COALESCE(wl.attack_detail_complete,0) = 1 THEN COALESCE(wl.respect_earned,0) ELSE 0 END) AS respect_earned,
        SUM(CASE WHEN COALESCE(wl.attack_detail_complete,0) = 1 THEN COALESCE(wl.respect_lost,0) ELSE 0 END) AS respect_lost,
        SUM(COALESCE(wl.chain_bonus_hits,0)) AS chain_bonus_hits_out,
        SUM(COALESCE(wl.chain_bonus_score,0)) AS chain_bonus_score_out,
        SUM(COALESCE(wl.chain_bonus_hits_in,0)) AS chain_bonus_hits_in,
        SUM(COALESCE(wl.chain_bonus_score_in,0)) AS chain_bonus_score_in,
        SUM(COALESCE(wl.chain_bonus_respect_lost_in,0)) AS chain_bonus_respect_lost_in
      FROM war_log wl
      JOIN wars w ON w.war_id = wl.war_id
      LEFT JOIN faction_members fm
        ON fm.faction_id = wl.faction_id
        AND fm.player_id = wl.player_id
      WHERE wl.faction_id = ?
        AND ${warFilter}
      GROUP BY wl.player_id
      ORDER BY MAX(wl.player_name) COLLATE NOCASE
    `).bind(factionId, ...warFilterParams).all();

    const totalWars = Number(totalWarsRow?.count || 0);
    const leadership = await loadFactionLeadership(env.DB, factionId);

    const members = (performanceResult.results || []).map(row => {
      const playerId = Number(row.player_id);
      const wars = Number(row.wars || 0);
      const hits = Number(row.hits || 0);
      const scoreUp = Number(row.score_up || 0);
      const scoreDown = Number(row.score_down || 0);
      const detailWars = Number(row.detail_wars || 0);
      const hasAttackDetails = detailWars > 0;

      return {
        playerId,
        playerName: row.player_name || `Player ${playerId}`,
        leadershipRole:factionLeadershipRole(leadership, playerId),
        current: Number(row.is_current) === 1,
        wars,
        participation: totalWars > 0 ? wars / totalWars : null,
        warHits: hits,
        avgHitsPerWar: wars > 0 ? hits / wars : null,
        outsideHits: Number(row.outside_hits || 0),
        assists: Number(row.stored_assists || 0),
        respectEarned: hasAttackDetails ? Number(row.respect_earned || 0) : null,
        respectLost: hasAttackDetails ? Number(row.respect_lost || 0) : null,
        attackDetailsAvailable: hasAttackDetails,
        attackDetailWars: detailWars,
        attackRows: Number(row.attack_rows || 0),
        chainBonusHitsOut: Number(row.chain_bonus_hits_out || 0),
        chainBonusScoreOut: Number(row.chain_bonus_score_out || 0),
        chainBonusHitsIn: Number(row.chain_bonus_hits_in || 0),
        chainBonusScoreIn: Number(row.chain_bonus_score_in || 0),
        chainBonusRespectLostIn: Number(row.chain_bonus_respect_lost_in || 0),
        scoreUp,
        scoreDown,
        netScore: scoreUp - scoreDown
      };
    });

    const playersWithAttackDetails = members.filter(member => member.attackDetailsAvailable).length;
    const chainBonusHitsDetected = members.reduce(
      (sum, member) => sum + Number(member.chainBonusHitsOut || 0) + Number(member.chainBonusHitsIn || 0),
      0
    );

    return json({
      success: true,
      generatedAt: now,
      factionId,
      range,
      selectedWarIds:selection.warIds,
      totalWars,
      playersWithAttackDetails,
      chainBonusHitsDetected,
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

async function ensureAggregateSchema(db) {
  const columns = await db.prepare("PRAGMA table_info(war_log)").all();
  const found = new Set((columns.results || []).map(row => String(row.name)));
  const additions = [
    ['respect_earned', 'ALTER TABLE war_log ADD COLUMN respect_earned REAL'],
    ['respect_lost', 'ALTER TABLE war_log ADD COLUMN respect_lost REAL'],
    ['attack_detail_complete', 'ALTER TABLE war_log ADD COLUMN attack_detail_complete INTEGER NOT NULL DEFAULT 0'],
    ['attack_detail_rows', 'ALTER TABLE war_log ADD COLUMN attack_detail_rows INTEGER NOT NULL DEFAULT 0'],
    ['chain_bonus_hits_in', 'ALTER TABLE war_log ADD COLUMN chain_bonus_hits_in INTEGER NOT NULL DEFAULT 0'],
    ['chain_bonus_score_in', 'ALTER TABLE war_log ADD COLUMN chain_bonus_score_in REAL NOT NULL DEFAULT 0'],
    ['chain_bonus_respect_lost_in', 'ALTER TABLE war_log ADD COLUMN chain_bonus_respect_lost_in REAL NOT NULL DEFAULT 0']
  ];

  for (const [name, sql] of additions) {
    if (found.has(name)) continue;
    try { await db.prepare(sql).run(); }
    catch (error) {
      if (!/duplicate column|already exists/i.test(String(error?.message || error || ''))) throw error;
    }
  }
}

async function resolveWarSelection(db, factionId, body, now) {
  const explicit = Array.isArray(body?.warIds);
  const warIds = explicit
    ? [...new Set(
        body.warIds
          .map(value => String(value ?? '').trim())
          .filter(value => value.length > 0 && value.length <= 128)
      )].slice(0, 100)
    : [];

  if (explicit && !warIds.length) {
    throw httpError(400, 'Select at least one ranked war.');
  }

  if (warIds.length) {
    const placeholders = warIds.map(() => '?').join(',');
    const rows = await db.prepare(`
      SELECT
        CAST(war_id AS TEXT) AS war_id,
        start_timestamp,
        end_timestamp,
        imported_at
      FROM wars
      WHERE faction_id = ?
        AND CAST(war_id AS TEXT) IN (${placeholders})
    `).bind(factionId, ...warIds).all();

    const available = rows.results || [];
    const found = new Set(available.map(row => String(row.war_id)));
    const missing = warIds.filter(id => !found.has(id));

    if (missing.length) {
      throw httpError(
        400,
        `Selected ranked war${missing.length === 1 ? '' : 's'} no longer available: ${missing.join(', ')}.`
      );
    }

    const starts = available
      .map(row => Number(row.start_timestamp || row.end_timestamp || row.imported_at || 0))
      .filter(value => value > 0);
    const ends = available
      .map(row => Number(row.end_timestamp || row.start_timestamp || row.imported_at || 0))
      .filter(value => value > 0);

    const from = starts.length ? Math.min(...starts) : now;
    const to = Math.min(now, ends.length ? Math.max(...ends) : now);

    return {
      warIds,
      range:{ from, to, fromDate:utcDate(from), toDate:utcDate(to) }
    };
  }

  const range = await resolveWarRange(db, factionId, body, now);
  return { warIds:[], range };
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
