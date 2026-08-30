const DAY_SECONDS = 86400;

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') return json({ success: false, message: 'Method not allowed. Use POST.' }, 405);
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');

    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const factionId = requireFactionId(user.faction_id);
    const action = String(body.action || 'getRange');

    if (action === 'getRange') return getRange(env.DB, factionId, body);
    if (action === 'getMemberDetail') return getMemberDetail(env.DB, factionId, body);

    return json({ success: false, message: `Unknown range action: ${action}` }, 400);
  } catch (error) {
    return json({ success: false, message: error?.message || 'Unexpected range analytics error.' }, error?.status || 500);
  }
}

async function getRange(db, factionId, body) {
  const now = unixNow();
  const trackingStartedAt = await getTrackingStartedAt(db, factionId, now);
  const range = normalizeRange(body, trackingStartedAt, now);
  const includeInactive = body.includeInactive === true;

  const membersResult = await db.prepare(`
    SELECT *
    FROM faction_members
    WHERE faction_id = ?
      ${includeInactive ? '' : 'AND is_current = 1'}
    ORDER BY is_current DESC, player_name COLLATE NOCASE
  `).bind(factionId).all();

  const snapshotsResult = await db.prepare(`
    SELECT *
    FROM member_snapshots
    WHERE faction_id = ?
      AND snapshot_at >= ?
      AND snapshot_at <= ?
    ORDER BY player_id, snapshot_at
  `).bind(factionId, trackingStartedAt, range.to).all();

  const warResult = await db.prepare(`
    SELECT
      wl.player_id,
      COUNT(DISTINCT wl.war_id) AS wars,
      SUM(wl.war_hits) AS hits,
      SUM(wl.outside_hits) AS outside_hits,
      SUM(wl.assists) AS assists,
      SUM(wl.score_up) AS score_up,
      SUM(wl.score_down) AS score_down
    FROM war_log wl
    JOIN wars w ON w.war_id = wl.war_id
    WHERE wl.faction_id = ?
      AND COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) BETWEEN ? AND ?
    GROUP BY wl.player_id
  `).bind(factionId, range.from, range.to).all();

  const totalWarsRow = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM wars
    WHERE faction_id = ?
      AND COALESCE(end_timestamp, start_timestamp, imported_at, 0) BETWEEN ? AND ?
  `).bind(factionId, range.from, range.to).first();

  const respectEarnedResult = await db.prepare(`
    SELECT attacker_id AS player_id, SUM(COALESCE(respect_gain, 0)) AS respect_earned
    FROM attacks
    WHERE faction_id = ?
      AND war_id IS NOT NULL
      AND attacker_id IS NOT NULL
      AND COALESCE(timestamp_ended, timestamp_started, 0) BETWEEN ? AND ?
    GROUP BY attacker_id
  `).bind(factionId, range.from, range.to).all();

  const respectLostResult = await db.prepare(`
    SELECT defender_id AS player_id, SUM(ABS(COALESCE(respect_loss, 0))) AS respect_lost
    FROM attacks
    WHERE faction_id = ?
      AND war_id IS NOT NULL
      AND defender_id IS NOT NULL
      AND COALESCE(timestamp_ended, timestamp_started, 0) BETWEEN ? AND ?
    GROUP BY defender_id
  `).bind(factionId, range.from, range.to).all();

  const snapshotsByPlayer = groupBy(snapshotsResult.results || [], row => Number(row.player_id));
  const warsByPlayer = new Map((warResult.results || []).map(row => [Number(row.player_id), row]));
  const respectEarnedByPlayer = new Map((respectEarnedResult.results || []).map(row => [Number(row.player_id), Number(row.respect_earned || 0)]));
  const respectLostByPlayer = new Map((respectLostResult.results || []).map(row => [Number(row.player_id), Number(row.respect_lost || 0)]));
  const totalWars = Number(totalWarsRow?.count || 0);

  const members = (membersResult.results || []).map(member => {
    const playerId = Number(member.player_id);
    const snapshots = snapshotsByPlayer.get(playerId) || [];
    const latest = chooseLatest(snapshots, range.to);
    const baseline = chooseBaseline(snapshots, range.from, latest);
    const elapsedDays = latest && baseline
      ? Math.max(0, (Number(latest.snapshot_at) - Number(baseline.snapshot_at)) / DAY_SECONDS)
      : 0;

    const activityDelta = safeDelta(latest?.activity_total_seconds, baseline?.activity_total_seconds);
    const xanaxDelta = safeDelta(latest?.xanax_taken_total, baseline?.xanax_taken_total);
    const war = warsByPlayer.get(playerId) || {};
    const wars = Number(war.wars || 0);
    const hits = Number(war.hits || 0);
    const scoreUp = Number(war.score_up || 0);
    const scoreDown = Number(war.score_down || 0);
    const statsSource = latest?.battle_stats_source || null;
    const battleStatsValue = nullableNumber(latest?.battle_stats_estimate);

    return {
      playerId,
      playerName: member.player_name,
      level: nullableNumber(member.level),
      position: member.position_name || '',
      daysInFaction: nullableNumber(member.days_in_faction),
      current: Number(member.is_current) === 1,
      firstSeenAt: Number(member.first_seen_at || 0) || null,
      leftAt: Number(member.left_at || 0) || null,
      lastActionAt: Number(latest?.last_action_at || 0) || null,
      lastActionStatus: latest?.last_action_status || null,
      statusState: latest?.status_state || null,
      statusUntil: Number(latest?.status_until || 0) || null,
      battleStatsValue,
      battleStatsSource: statsSource,
      battleStatsVerified: statsSource === 'verified-api',
      battleStatsObservedAt: Number(latest?.battle_stats_observed_at || 0) || null,
      activitySeconds: activityDelta,
      activityPerDaySeconds: elapsedDays > 0 && activityDelta !== null ? activityDelta / elapsedDays : null,
      xanaxTaken: xanaxDelta,
      xanaxPerDay: elapsedDays > 0 && xanaxDelta !== null ? xanaxDelta / elapsedDays : null,
      ocCount: null,
      ocsPerMonth: null,
      coverageDays: elapsedDays || null,
      snapshotAt: Number(latest?.snapshot_at || 0) || null,
      wars,
      participation: totalWars > 0 ? wars / totalWars : null,
      warHits: hits,
      avgHitsPerWar: wars > 0 ? hits / wars : null,
      outsideHits: Number(war.outside_hits || 0),
      assists: Number(war.assists || 0),
      respectEarned: respectEarnedByPlayer.get(playerId) || 0,
      respectLost: respectLostByPlayer.get(playerId) || 0,
      scoreUp,
      scoreDown,
      netScore: scoreUp - scoreDown,
      avgScorePerHit: hits > 0 ? scoreUp / hits : null
    };
  });

  return json({
    success: true,
    generatedAt: now,
    trackingStartedAt,
    range,
    summary: {
      currentMembers: members.filter(member => member.current).length,
      trackedMembers: members.length,
      warsInPeriod: totalWars
    },
    members
  });
}

async function getMemberDetail(db, factionId, body) {
  const playerId = Number(body.playerId);
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw httpError(400, 'A valid member ID is required.');

  const now = unixNow();
  const trackingStartedAt = await getTrackingStartedAt(db, factionId, now);
  const range = normalizeRange(body, trackingStartedAt, now);
  const rangeData = await getRangeDataForMember(db, factionId, playerId, range, trackingStartedAt);

  const warRows = await db.prepare(`
    SELECT
      w.war_id,
      w.opponent_faction_id,
      w.opponent_faction_name,
      w.start_timestamp,
      w.end_timestamp,
      wl.war_hits,
      wl.outside_hits,
      wl.assists,
      wl.score_up,
      wl.score_down,
      COALESCE((
        SELECT SUM(COALESCE(a.respect_gain, 0))
        FROM attacks a
        WHERE a.war_id = w.war_id AND a.attacker_id = ?
      ), 0) AS respect_earned,
      COALESCE((
        SELECT SUM(ABS(COALESCE(a.respect_loss, 0)))
        FROM attacks a
        WHERE a.war_id = w.war_id AND a.defender_id = ?
      ), 0) AS respect_lost
    FROM war_log wl
    JOIN wars w ON w.war_id = wl.war_id
    WHERE wl.faction_id = ?
      AND wl.player_id = ?
      AND COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) BETWEEN ? AND ?
    ORDER BY COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) DESC
  `).bind(playerId, playerId, factionId, playerId, range.from, range.to).all();

  return json({
    success: true,
    trackingStartedAt,
    range,
    member: rangeData,
    wars: (warRows.results || []).map(row => ({
      warId: row.war_id,
      opponentFactionId: nullableNumber(row.opponent_faction_id),
      opponentFactionName: row.opponent_faction_name || 'Unknown opponent',
      startTimestamp: nullableNumber(row.start_timestamp),
      endTimestamp: nullableNumber(row.end_timestamp),
      hits: Number(row.war_hits || 0),
      outsideHits: Number(row.outside_hits || 0),
      assists: Number(row.assists || 0),
      respectEarned: Number(row.respect_earned || 0),
      respectLost: Number(row.respect_lost || 0),
      scoreUp: Number(row.score_up || 0),
      scoreDown: Number(row.score_down || 0),
      netScore: Number(row.score_up || 0) - Number(row.score_down || 0)
    }))
  });
}

async function getRangeDataForMember(db, factionId, playerId, range, trackingStartedAt) {
  const member = await db.prepare(`
    SELECT * FROM faction_members WHERE faction_id = ? AND player_id = ?
  `).bind(factionId, playerId).first();
  if (!member) throw httpError(404, 'Faction member not found.');

  const snapshotsResult = await db.prepare(`
    SELECT * FROM member_snapshots
    WHERE faction_id = ? AND player_id = ? AND snapshot_at BETWEEN ? AND ?
    ORDER BY snapshot_at
  `).bind(factionId, playerId, trackingStartedAt, range.to).all();
  const snapshots = snapshotsResult.results || [];
  const latest = chooseLatest(snapshots, range.to);
  const baseline = chooseBaseline(snapshots, range.from, latest);
  const elapsedDays = latest && baseline
    ? Math.max(0, (Number(latest.snapshot_at) - Number(baseline.snapshot_at)) / DAY_SECONDS)
    : 0;
  const activityDelta = safeDelta(latest?.activity_total_seconds, baseline?.activity_total_seconds);
  const xanaxDelta = safeDelta(latest?.xanax_taken_total, baseline?.xanax_taken_total);

  const war = await db.prepare(`
    SELECT
      COUNT(DISTINCT wl.war_id) AS wars,
      SUM(wl.war_hits) AS hits,
      SUM(wl.outside_hits) AS outside_hits,
      SUM(wl.assists) AS assists,
      SUM(wl.score_up) AS score_up,
      SUM(wl.score_down) AS score_down
    FROM war_log wl
    JOIN wars w ON w.war_id = wl.war_id
    WHERE wl.faction_id = ? AND wl.player_id = ?
      AND COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) BETWEEN ? AND ?
  `).bind(factionId, playerId, range.from, range.to).first();

  const totalWarsRow = await db.prepare(`
    SELECT COUNT(*) AS count FROM wars
    WHERE faction_id = ? AND COALESCE(end_timestamp, start_timestamp, imported_at, 0) BETWEEN ? AND ?
  `).bind(factionId, range.from, range.to).first();

  const respectEarned = await db.prepare(`
    SELECT SUM(COALESCE(respect_gain, 0)) AS value FROM attacks
    WHERE faction_id = ? AND war_id IS NOT NULL AND attacker_id = ?
      AND COALESCE(timestamp_ended, timestamp_started, 0) BETWEEN ? AND ?
  `).bind(factionId, playerId, range.from, range.to).first();

  const respectLost = await db.prepare(`
    SELECT SUM(ABS(COALESCE(respect_loss, 0))) AS value FROM attacks
    WHERE faction_id = ? AND war_id IS NOT NULL AND defender_id = ?
      AND COALESCE(timestamp_ended, timestamp_started, 0) BETWEEN ? AND ?
  `).bind(factionId, playerId, range.from, range.to).first();

  const wars = Number(war?.wars || 0);
  const hits = Number(war?.hits || 0);
  const totalWars = Number(totalWarsRow?.count || 0);
  const scoreUp = Number(war?.score_up || 0);
  const scoreDown = Number(war?.score_down || 0);
  const statsSource = latest?.battle_stats_source || null;

  return {
    playerId,
    playerName: member.player_name,
    level: nullableNumber(member.level),
    position: member.position_name || '',
    daysInFaction: nullableNumber(member.days_in_faction),
    current: Number(member.is_current) === 1,
    firstSeenAt: nullableNumber(member.first_seen_at),
    leftAt: nullableNumber(member.left_at),
    lastActionAt: nullableNumber(latest?.last_action_at),
    battleStatsValue: nullableNumber(latest?.battle_stats_estimate),
    battleStatsSource: statsSource,
    battleStatsVerified: statsSource === 'verified-api',
    activitySeconds: activityDelta,
    activityPerDaySeconds: elapsedDays > 0 && activityDelta !== null ? activityDelta / elapsedDays : null,
    xanaxTaken: xanaxDelta,
    xanaxPerDay: elapsedDays > 0 && xanaxDelta !== null ? xanaxDelta / elapsedDays : null,
    ocCount: null,
    ocsPerMonth: null,
    coverageDays: elapsedDays || null,
    wars,
    participation: totalWars > 0 ? wars / totalWars : null,
    warHits: hits,
    avgHitsPerWar: wars > 0 ? hits / wars : null,
    outsideHits: Number(war?.outside_hits || 0),
    assists: Number(war?.assists || 0),
    respectEarned: Number(respectEarned?.value || 0),
    respectLost: Number(respectLost?.value || 0),
    scoreUp,
    scoreDown,
    netScore: scoreUp - scoreDown
  };
}

async function getTrackingStartedAt(db, factionId, fallback) {
  const taskRow = await db.prepare(`
    SELECT MIN(t.snapshot_at) AS started_at
    FROM faction_sync_tasks t
    JOIN faction_sync_jobs j ON j.job_id = t.job_id
    WHERE j.faction_id = ?
      AND t.historical_timestamp IS NULL
      AND t.status = 'completed'
  `).bind(factionId).first();

  const taskTime = Number(taskRow?.started_at || 0);
  if (taskTime > 0) return taskTime;

  const snapshotRow = await db.prepare(`
    SELECT MIN(snapshot_at) AS started_at FROM member_snapshots WHERE faction_id = ?
  `).bind(factionId).first();
  return Number(snapshotRow?.started_at || 0) || fallback;
}

function normalizeRange(body, trackingStartedAt, now) {
  const requestedFrom = parseDateStart(body.from);
  const requestedTo = parseDateEnd(body.to);

  // War reports may legitimately predate RWE faction tracking. Keep the
  // default range anchored at tracking start, but honor an explicitly chosen
  // earlier date. Snapshot-derived metrics will simply have no coverage before
  // trackingStartedAt because snapshots are queried from that point onward.
  const from = requestedFrom || trackingStartedAt;
  const to = Math.min(now, requestedTo || now);

  if (from > to) throw httpError(400, 'The selected start date must not be after the end date.');
  return { from, to, fromDate: utcDate(from), toDate: utcDate(to) };
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

function chooseLatest(snapshots, to) {
  let latest = null;
  for (const snapshot of snapshots) {
    if (Number(snapshot.snapshot_at) <= to) latest = snapshot;
  }
  return latest;
}

function chooseBaseline(snapshots, from, latest) {
  if (!latest || snapshots.length < 2) return null;
  let baseline = null;
  for (const snapshot of snapshots) {
    if (snapshot === latest) continue;
    if (Number(snapshot.snapshot_at) <= from) baseline = snapshot;
    if (Number(snapshot.snapshot_at) > from) break;
  }
  if (baseline) return baseline;
  return snapshots.find(snapshot => snapshot !== latest) || null;
}

function safeDelta(currentValue, baselineValue) {
  const current = Number(currentValue);
  const baseline = Number(baselineValue);
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || current < baseline) return null;
  return current - baseline;
}

async function getCurrentUser(env, request) {
  const sessionToken = getCookie(request, 'rwengine_session');
  if (!sessionToken) throw httpError(401, 'Not logged in.');
  const tokenHash = await sha256Hex(sessionToken);
  const row = await env.DB.prepare(`
    SELECT users.user_id, users.player_id, users.faction_id, users.is_disabled
    FROM sessions
    JOIN users ON users.user_id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).bind(tokenHash, unixNow()).first();
  if (!row) throw httpError(401, 'Session expired or invalid.');
  if (Number(row.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  return row;
}

function requireFactionId(value) {
  const factionId = Number(value);
  if (!Number.isSafeInteger(factionId) || factionId <= 0) throw httpError(400, 'Account is not linked to a valid faction.');
  return factionId;
}

function groupBy(values, keyFn) {
  const map = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function utcDate(timestamp = unixNow()) {
  return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
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
