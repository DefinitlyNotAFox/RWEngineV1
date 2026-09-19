import { buildIntelInsights } from './intel-insights.js';

const DAY = 86400;
const SNAPSHOT_LOOKBACK_DAYS = 70;
const DETAIL_LOOKBACK_DAYS = 95;

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
    await ensureWarAggregateSchema(env.DB);
    const action = String(body.action || 'overview');

    if (action === 'overview') {
      return json(await buildOverview(env.DB, factionId, body));
    }

    if (action === 'member') {
      const playerId = positiveInt(body.playerId, 'playerId');
      return json(await buildMemberDetail(env.DB, factionId, playerId));
    }

    return json({ success:false, message:'Unknown Intel 2.0 action: ' + action }, 400);
  } catch (error) {
    return json(
      { success:false, message:error?.message || 'Unexpected Intel 2.0 error.' },
      error?.status || 500
    );
  }
}

async function buildOverview(db, factionId, body = {}) {
  const now = unixNow();
  const range = resolveAnalysisRange(body, now);
  const span = Math.max(DAY, range.to - range.from);
  const members = await loadMembers(db, factionId);
  const snapshotBounds = await loadSnapshotBounds(db, factionId);
  const snapshots = await loadSnapshots(
    db,
    factionId,
    Math.max(0, range.from - span - 7 * DAY),
    Math.min(now, range.to + DAY)
  );
  const wars = await loadRecentWars(db, factionId, 8);
  const warMetrics = await loadWarMetrics(db, factionId, wars.map(war => war.warId));

  const snapshotsByPlayer = groupBy(snapshots, row => Number(row.player_id));
  const warByPlayer = groupBy(warMetrics, row => Number(row.playerId));

  const built = members.map(row => buildMemberOverview({
    row,
    snapshots: snapshotsByPlayer.get(Number(row.player_id)) || [],
    warRows: warByPlayer.get(Number(row.player_id)) || [],
    wars,
    now,
    range
  }));

  const medianHits = median(
    built
      .map(member => numberOrNull(member.war.last4.hitsPerWar))
      .filter(Number.isFinite)
  );

  for (const member of built) {
    member.insights = buildIntelInsights(member, {
      factionMedianHitsPerWarLast4: medianHits
    }, now);
  }

  const current = built.filter(member => member.current);
  const knownStats = current.map(member => member.battleStats.value).filter(Number.isFinite);
  const activity = current.map(member => member.activity.perDay30d).filter(Number.isFinite);
  const xanax = current.map(member => member.xanax.perDay30d).filter(Number.isFinite);
  const participation = current.map(member => member.war.last4.participation).filter(Number.isFinite);

  return {
    success:true,
    generatedAt:now,
    faction:await loadFaction(db, factionId),
    freshness:buildFreshnessFromBounds(snapshotBounds, now),
    availability:{
      from:snapshotBounds.firstAt ? utcDate(snapshotBounds.firstAt) : null,
      to:snapshotBounds.lastAt ? utcDate(snapshotBounds.lastAt) : null
    },
    range:{
      from:range.from,
      to:range.to,
      fromDate:utcDate(range.from),
      toDate:utcDate(range.to),
      days:Math.max(1, Math.round((range.to - range.from) / DAY))
    },
    summary:{
      currentMembers:current.length,
      knownBattleStats:knownStats.length,
      medianBattleStats:median(knownStats),
      avgActivityPerDay30d:average(activity),
      avgXanaxPerDay30d:average(xanax),
      avgParticipationLast4:average(participation),
      membersNeedingAttention:current.filter(member =>
        member.insights.some(insight => insight.kind === 'attention')
      ).length
    },
    members:built
  };
}

async function buildMemberDetail(db, factionId, playerId) {
  const now = unixNow();
  const row = await db.prepare(
    'SELECT * FROM faction_members WHERE faction_id = ? AND player_id = ? LIMIT 1'
  ).bind(factionId, playerId).first();

  if (!row) throw httpError(404, 'Faction member not found.');

  const snapshots = await db.prepare(
    'SELECT * FROM member_snapshots WHERE faction_id = ? AND player_id = ? AND snapshot_at >= ? ORDER BY snapshot_at'
  ).bind(factionId, playerId, now - DETAIL_LOOKBACK_DAYS * DAY).all();

  const wars = await loadRecentWars(db, factionId, 8);
  const warMetrics = await loadWarMetrics(db, factionId, wars.map(war => war.warId), playerId);

  const member = buildMemberOverview({
    row,
    snapshots:snapshots.results || [],
    warRows:warMetrics,
    wars,
    now
  });

  const overview = await buildOverviewContextForInsights(db, factionId, now, member);
  member.insights = buildIntelInsights(member, overview, now);

  return {
    success:true,
    generatedAt:now,
    member,
    history:{
      snapshots:(snapshots.results || []).map(snapshotHistoryPoint),
      wars:buildMemberWarHistory(wars, warMetrics)
    },
    coverage:member.coverage
  };
}

async function buildOverviewContextForInsights(db, factionId, now, targetMember) {
  const wars = await loadRecentWars(db, factionId, 4);
  const rows = await loadWarMetrics(db, factionId, wars.map(war => war.warId));
  const grouped = groupBy(rows, row => Number(row.playerId));
  const values = [];

  for (const playerRows of grouped.values()) {
    const summary = summarizeWarWindow(playerRows, wars);
    if (Number.isFinite(summary.hitsPerWar)) values.push(summary.hitsPerWar);
  }

  return {
    factionMedianHitsPerWarLast4:median(values),
    targetPlayerId:targetMember.playerId,
    generatedAt:now
  };
}

function buildMemberOverview({ row, snapshots, warRows, wars, now, range = null }) {
  const effectiveTo = Number(range?.to || now);
  const effectiveFrom = Number(range?.from || (effectiveTo - 30 * DAY));
  const span = Math.max(DAY, effectiveTo - effectiveFrom);
  const previousFrom = Math.max(0, effectiveFrom - span);
  const previousTo = effectiveFrom;
  const requiredCoverage = Math.min(21, Math.max(1, (span / DAY) * 0.7));

  const latest = latestSnapshot(snapshots.filter(row => Number(row.snapshot_at || 0) <= effectiveTo + DAY));
  const currentWindow = buildCumulativeWindow(snapshots, effectiveFrom, effectiveTo);
  const previousWindow = buildCumulativeWindow(snapshots, previousFrom, previousTo);

  const last4Wars = wars.slice(0, 4);
  const previous4Wars = wars.slice(4, 8);
  const last4 = summarizeWarWindow(warRows, last4Wars);
  const previous4 = summarizeWarWindow(warRows, previous4Wars);

  const stats = buildBattleStats(snapshots, latest, effectiveTo, effectiveFrom);

  return {
    playerId:Number(row.player_id),
    playerName:row.player_name || 'Player ' + row.player_id,
    level:nullableNumber(row.level),
    position:row.position_name || 'Member',
    current:Number(row.is_current) === 1,
    daysInFaction:nullableNumber(row.days_in_faction),

    presence:{
      lastActionAt:nullableNumber(latest?.last_action_at) || extractMemberLastAction(row),
      lastActionStatus:latest?.last_action_status || extractMemberLastActionStatus(row),
      statusState:latest?.status_state || extractMemberStatusState(row),
      statusUntil:nullableNumber(latest?.status_until)
    },

    battleStats:stats,

    activity:{
      perDay30d:currentWindow.activityPerDay,
      perDayPrevious30d:previousWindow.activityPerDay,
      changePct:hasComparisonCoverage(currentWindow, previousWindow, requiredCoverage)
        ? percentChange(currentWindow.activityPerDay, previousWindow.activityPerDay)
        : null,
      coverageDays:currentWindow.coverageDays,
      previousCoverageDays:previousWindow.coverageDays
    },

    xanax:{
      perDay30d:currentWindow.xanaxPerDay,
      perDayPrevious30d:previousWindow.xanaxPerDay,
      changePct:hasComparisonCoverage(currentWindow, previousWindow, requiredCoverage)
        ? percentChange(currentWindow.xanaxPerDay, previousWindow.xanaxPerDay)
        : null,
      coverageDays:currentWindow.coverageDays,
      previousCoverageDays:previousWindow.coverageDays
    },

    ocs:{
      total:currentWindow.organizedCrimes,
      perDay:currentWindow.organizedCrimesPerDay,
      perDayPrevious:previousWindow.organizedCrimesPerDay,
      changePct:hasComparisonCoverage(currentWindow, previousWindow, requiredCoverage)
        ? percentChange(currentWindow.organizedCrimesPerDay, previousWindow.organizedCrimesPerDay)
        : null,
      coverageDays:currentWindow.coverageDays,
      previousCoverageDays:previousWindow.coverageDays
    },

    war:{
      last4,
      previous4
    },

    coverage:{
      snapshotDays60d:coverageAcross(snapshots, effectiveFrom, effectiveTo),
      battleStatsKnown:Number.isFinite(stats.value),
      warHistoryAvailable:wars.length
    },

    insights:[]
  };
}

function buildBattleStats(snapshots, latest, now, comparisonFrom = null) {
  const observations = snapshots
    .filter(row => Number.isFinite(numberOrNull(row.battle_stats_estimate)))
    .sort((a,b) => Number(a.snapshot_at) - Number(b.snapshot_at));

  const current = observations.length ? observations[observations.length - 1] : null;
  const currentValue = numberOrNull(current?.battle_stats_estimate);

  if (currentValue === null) {
    return {
      value:null, source:null, verified:false, observedAt:null,
      ageSeconds:null, change30d:null, changePct30d:null,
      previousValue30d:null, trendReliable:false
    };
  }

  const target = comparisonFrom || (Number(current.battle_stats_observed_at || current.snapshot_at || now) - 30 * DAY);
  const previous = nearestObservation(observations, target, current);
  const previousValue = numberOrNull(previous?.battle_stats_estimate);
  const sameSource = String(previous?.battle_stats_source || '') === String(current?.battle_stats_source || '');
  const verifiedCurrent = isVerifiedSource(current?.battle_stats_source);
  const verifiedPrevious = isVerifiedSource(previous?.battle_stats_source);
  const reliable = previousValue !== null && (sameSource || (verifiedCurrent && verifiedPrevious));
  const change = reliable ? currentValue - previousValue : null;

  return {
    value:currentValue,
    source:current?.battle_stats_source || null,
    verified:verifiedCurrent,
    observedAt:nullableNumber(current?.battle_stats_observed_at || current?.snapshot_at),
    ageSeconds:nullableNumber(current?.battle_stats_observed_at || current?.snapshot_at)
      ? Math.max(0, now - Number(current.battle_stats_observed_at || current.snapshot_at))
      : null,
    change30d:change,
    changePct30d:reliable && previousValue > 0 ? change / previousValue : null,
    previousValue30d:reliable ? previousValue : null,
    trendReliable:reliable
  };
}

export function buildCumulativeWindow(snapshots, from, to) {
  const usable = snapshots
    .filter(row => {
      const at = Number(row.snapshot_at || 0);
      return at >= from - 7 * DAY && at <= to + DAY;
    })
    .sort((a,b) => Number(a.snapshot_at) - Number(b.snapshot_at));

  if (usable.length < 2) {
    return {
      activityPerDay:null,
      xanaxPerDay:null,
      organizedCrimes:null,
      organizedCrimesPerDay:null,
      coverageDays:0
    };
  }

  // Cumulative counters need a baseline at (or immediately before) the
  // selected range and an observation inside its end boundary. Choosing both
  // points by absolute distance reverses the pair for a single-day range:
  // today's observation becomes the start and yesterday's becomes the end.
  const end = latestAtOrBefore(usable, to);
  const endAt = Number(end?.snapshot_at || 0);
  const candidates = usable.filter(row => Number(row.snapshot_at || 0) < endAt);
  const start = latestAtOrBefore(candidates, from) || earliestAtOrAfter(candidates, from);

  if (!start || !end) {
    return {
      activityPerDay:null,
      xanaxPerDay:null,
      organizedCrimes:null,
      organizedCrimesPerDay:null,
      coverageDays:0
    };
  }

  const elapsed = (Number(end.snapshot_at) - Number(start.snapshot_at)) / DAY;
  if (!(elapsed > 0)) {
    return {
      activityPerDay:null,
      xanaxPerDay:null,
      organizedCrimes:null,
      organizedCrimesPerDay:null,
      coverageDays:0
    };
  }

  const activityDelta = monotonicDelta(end.activity_total_seconds, start.activity_total_seconds);
  const xanaxDelta = monotonicDelta(end.xanax_taken_total, start.xanax_taken_total);
  const organizedCrimesDelta = monotonicDelta(
    snapshotOrganizedCrimes(end),
    snapshotOrganizedCrimes(start)
  );

  return {
    activityPerDay:activityDelta === null ? null : activityDelta / elapsed,
    xanaxPerDay:xanaxDelta === null ? null : xanaxDelta / elapsed,
    organizedCrimes:organizedCrimesDelta,
    organizedCrimesPerDay:organizedCrimesDelta === null ? null : organizedCrimesDelta / elapsed,
    coverageDays:elapsed
  };
}

function summarizeWarWindow(rows, wars) {
  const ids = new Set(wars.map(war => String(war.warId)));
  const selected = rows.filter(row => ids.has(String(row.warId)));
  const participated = selected.filter(row => Number(row.warHits || 0) > 0);

  const totals = selected.reduce((sum,row) => {
    sum.hits += Number(row.warHits || 0);
    sum.assists += Number(row.assists || 0);
    sum.respectEarned += numberOrZero(row.respectEarned);
    sum.respectLost += numberOrZero(row.respectLost);
    sum.scoreUp += Number(row.scoreUp || 0);
    sum.scoreDown += Number(row.scoreDown || 0);
    return sum;
  }, { hits:0, assists:0, respectEarned:0, respectLost:0, scoreUp:0, scoreDown:0 });

  return {
    warsAvailable:wars.length,
    warsParticipated:participated.length,
    participation:wars.length ? participated.length / wars.length : null,
    hits:totals.hits,
    hitsPerWar:participated.length ? totals.hits / participated.length : null,
    assists:totals.assists,
    respectEarned:selected.some(row => row.respectEarned !== null) ? totals.respectEarned : null,
    respectLost:selected.some(row => row.respectLost !== null) ? totals.respectLost : null,
    scoreUp:totals.scoreUp,
    scoreDown:totals.scoreDown,
    netScore:totals.scoreUp - totals.scoreDown
  };
}

async function loadMembers(db, factionId) {
  const result = await db.prepare(
    'SELECT * FROM faction_members WHERE faction_id = ? ORDER BY is_current DESC, player_name COLLATE NOCASE'
  ).bind(factionId).all();
  return result.results || [];
}

async function loadSnapshotBounds(db, factionId) {
  const row = await db.prepare(
    'SELECT MIN(snapshot_at) AS first_at, MAX(snapshot_at) AS last_at FROM member_snapshots WHERE faction_id = ?'
  ).bind(factionId).first();

  return {
    firstAt:nullableNumber(row?.first_at),
    lastAt:nullableNumber(row?.last_at)
  };
}

async function loadSnapshots(db, factionId, cutoff, upper = null) {
  const result = upper
    ? await db.prepare(
        'SELECT * FROM member_snapshots WHERE faction_id = ? AND snapshot_at >= ? AND snapshot_at <= ? ORDER BY player_id, snapshot_at'
      ).bind(factionId, cutoff, upper).all()
    : await db.prepare(
        'SELECT * FROM member_snapshots WHERE faction_id = ? AND snapshot_at >= ? ORDER BY player_id, snapshot_at'
      ).bind(factionId, cutoff).all();
  return result.results || [];
}

async function loadRecentWars(db, factionId, limit) {
  const result = await db.prepare(
    'SELECT war_id, opponent_faction_name, start_timestamp, end_timestamp, imported_at FROM wars WHERE faction_id = ? ORDER BY COALESCE(end_timestamp, start_timestamp, imported_at, 0) DESC LIMIT ?'
  ).bind(factionId, limit).all();

  return (result.results || []).map(row => ({
    warId:String(row.war_id),
    opponentFactionName:row.opponent_faction_name || 'Unknown opponent',
    startTimestamp:nullableNumber(row.start_timestamp),
    endTimestamp:nullableNumber(row.end_timestamp),
    importedAt:nullableNumber(row.imported_at)
  }));
}

async function loadWarMetrics(db, factionId, warIds, playerId = null) {
  if (!warIds.length) return [];
  const useReadModel = await tableExists(db, 'war_member_metrics');
  return useReadModel
    ? loadWarMetricsFromReadModel(db, factionId, warIds, playerId)
    : loadWarMetricsFromWarLog(db, factionId, warIds, playerId);
}

async function loadWarMetricsFromReadModel(db, factionId, warIds, playerId) {
  const placeholders = warIds.map(() => '?').join(',');
  const playerClause = playerId ? ' AND player_id = ?' : '';
  const params = [factionId, ...warIds, ...(playerId ? [playerId] : [])];

  const result = await db.prepare(
    'SELECT war_id, player_id, player_name, war_hits, outside_hits, assists, respect_earned, respect_lost, score_up_adjusted AS score_up, score_down FROM war_member_metrics WHERE faction_id = ? AND war_id IN (' + placeholders + ')' + playerClause
  ).bind(...params).all();

  return (result.results || []).map(row => normalizeWarMetricRow(row));
}

async function loadWarMetricsFromWarLog(db, factionId, warIds, playerId) {
  const placeholders = warIds.map(() => '?').join(',');
  const playerClause = playerId ? ' AND player_id = ?' : '';
  const params = [factionId, ...warIds, ...(playerId ? [playerId] : [])];

  const result = await db.prepare(
    'SELECT war_id, player_id, player_name, COALESCE(war_hits,0) AS war_hits, COALESCE(outside_hits,0) AS outside_hits, COALESCE(assists,0) AS assists, CASE WHEN COALESCE(attack_detail_complete,0)=1 THEN COALESCE(respect_earned,0) ELSE NULL END AS respect_earned, CASE WHEN COALESCE(attack_detail_complete,0)=1 THEN COALESCE(respect_lost,0) ELSE NULL END AS respect_lost, COALESCE(score_up_adjusted, score_up, 0) AS score_up, COALESCE(score_down,0) AS score_down FROM war_log WHERE faction_id = ? AND war_id IN (' + placeholders + ')' + playerClause
  ).bind(...params).all();

  return (result.results || []).map(row => normalizeWarMetricRow(row));
}

function normalizeWarMetricRow(row) {
  return {
    warId:String(row.war_id),
    playerId:Number(row.player_id),
    playerName:row.player_name || 'Player ' + row.player_id,
    warHits:Number(row.war_hits || 0),
    outsideHits:Number(row.outside_hits || 0),
    assists:Number(row.assists || 0),
    respectEarned:numberOrNull(row.respect_earned),
    respectLost:numberOrNull(row.respect_lost),
    scoreUp:Number(row.score_up || 0),
    scoreDown:Number(row.score_down || 0)
  };
}

function buildMemberWarHistory(wars, rows) {
  const byWar = new Map(rows.map(row => [String(row.warId), row]));
  return wars.map(war => {
    const row = byWar.get(String(war.warId));
    return {
      warId:war.warId,
      opponentFactionName:war.opponentFactionName,
      endedAt:war.endTimestamp || war.startTimestamp || war.importedAt,
      participated:Number(row?.warHits || 0) > 0,
      hits:Number(row?.warHits || 0),
      outsideHits:Number(row?.outsideHits || 0),
      assists:Number(row?.assists || 0),
      respectEarned:row?.respectEarned ?? null,
      respectLost:row?.respectLost ?? null,
      scoreUp:Number(row?.scoreUp || 0),
      scoreDown:Number(row?.scoreDown || 0),
      netScore:Number(row?.scoreUp || 0) - Number(row?.scoreDown || 0)
    };
  });
}

function snapshotHistoryPoint(row) {
  return {
    at:nullableNumber(row.snapshot_at),
    activityTotalSeconds:numberOrNull(row.activity_total_seconds),
    activityPerDaySeconds:numberOrNull(row.activity_per_day_seconds),
    xanaxTakenTotal:numberOrNull(row.xanax_taken_total),
    xanaxPerDay:numberOrNull(row.xanax_per_day),
    organizedCrimesTotal:snapshotOrganizedCrimes(row),
    battleStatsValue:numberOrNull(row.battle_stats_estimate),
    battleStatsSource:row.battle_stats_source || null,
    battleStatsObservedAt:nullableNumber(row.battle_stats_observed_at),
    lastActionAt:nullableNumber(row.last_action_at)
  };
}

async function ensureWarAggregateSchema(db) {
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

async function loadFaction(db, factionId) {
  const row = await db.prepare(
    'SELECT faction_id, faction_name FROM factions WHERE faction_id = ? LIMIT 1'
  ).bind(factionId).first();

  return {
    factionId,
    factionName:row?.faction_name || 'Faction ' + factionId
  };
}

function buildFreshnessFromBounds(bounds, now) {
  const observedAt = nullableNumber(bounds?.lastAt);
  const ageSeconds = observedAt ? Math.max(0, now - observedAt) : null;
  return {
    state:!observedAt ? 'empty' : ageSeconds > 36 * 3600 ? 'stale' : 'fresh',
    observedAt,
    ageSeconds
  };
}

function buildFreshness(snapshots, now) {
  const observedAt = snapshots.reduce((latest,row) =>
    Math.max(latest, Number(row.snapshot_at || 0)), 0
  ) || null;
  const ageSeconds = observedAt ? Math.max(0, now - observedAt) : null;

  return {
    state:!observedAt ? 'empty' : ageSeconds > 36 * 3600 ? 'stale' : 'fresh',
    observedAt,
    ageSeconds
  };
}

function latestSnapshot(rows) {
  return rows.length ? rows[rows.length - 1] : null;
}

function nearestSnapshot(rows, target, exclude = null) {
  let best = null;
  let distance = Infinity;
  for (const row of rows) {
    if (row === exclude) continue;
    const d = Math.abs(Number(row.snapshot_at || 0) - target);
    if (d < distance) {
      best = row;
      distance = d;
    }
  }
  return best;
}

function latestAtOrBefore(rows, target) {
  let match = null;
  for (const row of rows) {
    const at = Number(row.snapshot_at || 0);
    if (at > target) break;
    match = row;
  }
  return match;
}

function earliestAtOrAfter(rows, target) {
  for (const row of rows) {
    if (Number(row.snapshot_at || 0) >= target) return row;
  }
  return null;
}

function nearestObservation(rows, target, exclude = null) {
  return nearestSnapshot(rows, target, exclude);
}

function snapshotOrganizedCrimes(row) {
  return numberOrNull(row?.organized_crimes_total);
}

function monotonicDelta(current, previous) {
  const a = numberOrNull(current);
  const b = numberOrNull(previous);
  if (a === null || b === null || a < b) return null;
  return a - b;
}

function hasComparisonCoverage(current, previous, requiredDays = 21) {
  return Number(current?.coverageDays || 0) >= requiredDays &&
    Number(previous?.coverageDays || 0) >= requiredDays;
}

function resolveAnalysisRange(body, now) {
  const requestedFrom = parseDateStart(body?.from);
  const requestedTo = parseDateEnd(body?.to);
  const fallbackTo = now;
  const fallbackFrom = now - 30 * DAY;
  const from = requestedFrom || fallbackFrom;
  const to = Math.min(now, requestedTo || fallbackTo);

  if (from > to) throw httpError(400, 'The selected start date must not be after the end date.');
  return { from, to };
}

function parseDateStart(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value).slice(0, 10) + 'T00:00:00Z');
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function parseDateEnd(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value).slice(0, 10) + 'T23:59:59Z');
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function utcDate(timestamp) {
  return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
}

function percentChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return (current - previous) / previous;
}

function coverageAcross(rows, from, to) {
  const inRange = rows.filter(row => Number(row.snapshot_at || 0) >= from && Number(row.snapshot_at || 0) <= to);
  if (inRange.length < 2) return 0;
  return Math.max(0, (Number(inRange[inRange.length - 1].snapshot_at) - Number(inRange[0].snapshot_at)) / DAY);
}

function extractMemberJson(row) {
  try { return JSON.parse(row.status_json || '{}') || {}; }
  catch (_) { return {}; }
}

function extractMemberLastAction(row) {
  const json = extractMemberJson(row);
  return nullableNumber(json?.last_action?.timestamp || json?.lastAction?.timestamp);
}

function extractMemberLastActionStatus(row) {
  const json = extractMemberJson(row);
  return json?.last_action?.status || json?.lastAction?.status || null;
}

function extractMemberStatusState(row) {
  const json = extractMemberJson(row);
  return json?.status?.state || null;
}

function isVerifiedSource(source) {
  const value = String(source || '').toLowerCase();
  return value.includes('verified') || value.includes('own api') || value.includes('personal');
}

async function tableExists(db, name) {
  const row = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
  ).bind(name).first();
  return Boolean(row);
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum,value) => sum + value, 0) / valid.length : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableNumber(value) {
  return numberOrNull(value);
}

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw httpError(400, 'Invalid ' + name + '.');
  return number;
}

async function getCurrentUser(env, request) {
  const token = cookie(request, 'rwengine_session');
  if (!token) throw httpError(401, 'Not logged in.');

  const tokenHash = await sha256(token);
  const user = await env.DB.prepare(
    'SELECT u.user_id, u.player_id, u.player_name, u.faction_id, u.faction_name, u.is_admin, u.is_disabled FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1'
  ).bind(tokenHash, unixNow()).first();

  if (!user) throw httpError(401, 'Session expired or invalid.');
  if (Number(user.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  return user;
}

async function resolveFactionId(db, user, requestedFactionId) {
  const accountFactionId = Number(user.faction_id || 0);
  const requested = Number(requestedFactionId || 0);
  const factionId = requested || accountFactionId;

  if (!Number.isSafeInteger(factionId) || factionId <= 0) {
    throw httpError(400, 'A valid faction is required.');
  }

  if (Number(user.is_admin) !== 1 && factionId !== accountFactionId) {
    throw httpError(403, 'Admin access required for another faction.');
  }

  const tracked = await db.prepare(
    'SELECT faction_id FROM factions WHERE faction_id = ? AND enabled = 1 LIMIT 1'
  ).bind(factionId).first();

  if (!tracked) throw httpError(404, 'That faction is not tracked by RWEngine.');
  return factionId;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function cookie(request, name) {
  const source = request.headers.get('Cookie') || '';
  for (const part of source.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
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
