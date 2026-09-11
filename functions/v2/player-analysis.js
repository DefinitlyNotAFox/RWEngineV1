const DAY = 86400;

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') {
      return json({ success:false, message:'Method not allowed. Use POST.' }, 405);
    }
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');

    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const scopeFactionId = resolveHistoryScope(user, body.factionId);
    const action = String(body.action || 'search');

    if (action === 'search') {
      return json(await searchPlayers(env, user, scopeFactionId, body));
    }

    if (action === 'analyze') {
      const playerId = positiveInt(body.playerId, 'playerId');
      return json(await analyzePlayer(env, user, scopeFactionId, playerId));
    }

    return json({ success:false, message:'Unknown Player Analysis action: ' + action }, 400);
  } catch (error) {
    return json(
      { success:false, message:error?.message || 'Unexpected Player Analysis error.' },
      error?.status || 500
    );
  }
}

async function searchPlayers(env, user, scopeFactionId, body) {
  const query = String(body.query || '').trim();
  if (query.length < 2) throw httpError(400, 'Enter at least two characters or a player ID.');

  const numericId = /^\d+$/.test(query) ? Number(query) : null;
  const local = await searchLocal(env.DB, scopeFactionId, query, numericId);
  const candidates = new Map(local.map(item => [item.playerId, item]));

  const apiKey = await getUserApiKey(env, user).catch(() => null);

  if (apiKey) {
    try {
      if (numericId) {
        const profile = await tornGet(apiKey, '/user/' + encodeURIComponent(numericId) + '/basic?comment=RWEnginePlayerAnalysis');
        const basic = normalizeBasic(profile?.profile || profile);
        if (basic?.playerId) mergeCandidate(candidates, { ...basic, source:'Torn' });
      } else {
        const params = new URLSearchParams({
          name:query,
          comment:'RWEnginePlayerAnalysis'
        });
        const payload = await tornGet(apiKey, '/user/search?' + params.toString());
        for (const row of payload?.search || []) {
          const candidate = normalizeSearch(row);
          if (candidate?.playerId) mergeCandidate(candidates, candidate);
        }
      }
    } catch (error) {
      if (!local.length && numericId) {
        throw error;
      }
    }
  }

  return {
    success:true,
    query,
    results:[...candidates.values()]
      .sort((a,b) =>
        Number(b.localHistoryAvailable) - Number(a.localHistoryAvailable) ||
        String(a.playerName).localeCompare(String(b.playerName))
      )
      .slice(0,25)
  };
}

async function analyzePlayer(env, user, scopeFactionId, playerId) {
  const now = unixNow();
  const localMember = scopeFactionId
    ? await env.DB.prepare(
        'SELECT * FROM faction_members WHERE faction_id = ? AND player_id = ? LIMIT 1'
      ).bind(scopeFactionId, playerId).first()
    : null;

  const snapshots = localMember
    ? (await env.DB.prepare(
        'SELECT * FROM member_snapshots WHERE faction_id = ? AND player_id = ? AND snapshot_at >= ? ORDER BY snapshot_at'
      ).bind(scopeFactionId, playerId, now - 95 * DAY).all()).results || []
    : [];

  const apiKey = await getUserApiKey(env, user).catch(() => null);
  let profile = null;
  let profileError = null;

  if (apiKey) {
    try {
      const payload = await tornGet(
        apiKey,
        '/user/' + encodeURIComponent(playerId) + '/profile?comment=RWEnginePlayerAnalysis'
      );
      profile = normalizeProfile(payload?.profile || payload);
    } catch (error) {
      profileError = error;
    }
  }

  if (!profile && !localMember) {
    if (!apiKey) throw httpError(400, 'A stored Torn API key is required to analyze an external player.');
    throw profileError || httpError(404, 'Player not found.');
  }

  const localIdentity = localMember ? identityFromMember(localMember, snapshots) : null;
  const player = mergeIdentity(profile, localIdentity, playerId);
  const metrics = buildSnapshotMetrics(snapshots, now);
  const wars = localMember ? await loadWarHistory(env.DB, scopeFactionId, playerId) : [];
  const last4 = localMember ? summarizeLastFour(wars.slice(0,4)) : null;
  const faction = localMember
    ? await env.DB.prepare('SELECT faction_id, faction_name FROM factions WHERE faction_id = ? LIMIT 1')
        .bind(scopeFactionId).first()
    : null;

  const sources = [];
  if (profile) sources.push({ label:'Torn', detail:'Current public profile and status' });
  if (localMember) sources.push({ label:'RWEngine', detail:'Permitted faction snapshots and war history' });
  if (metrics.battleStats.source) {
    sources.push({
      label:metrics.battleStats.source,
      detail:'Battle-stat estimate'
    });
  }

  return {
    success:true,
    generatedAt:now,
    player,
    context:{
      localHistoryAvailable:Boolean(localMember),
      localFactionId:localMember ? scopeFactionId : null,
      localFactionName:faction?.faction_name || null,
      currentFactionMember:Boolean(localMember && Number(localMember.is_current) === 1),
      observedAt:metrics.observedAt
    },
    battleStats:metrics.battleStats,
    activity:metrics.activity,
    xanax:metrics.xanax,
    war:{
      last4,
      history:wars
    },
    history:{
      snapshots:snapshots.map(normalizeSnapshot)
    },
    sources
  };
}

async function searchLocal(db, factionId, query, numericId) {
  if (!factionId) return [];

  const result = numericId
    ? await db.prepare(
        'SELECT player_id, player_name, level, faction_id, is_current FROM faction_members WHERE faction_id = ? AND player_id = ? LIMIT 1'
      ).bind(factionId, numericId).all()
    : await db.prepare(
        'SELECT player_id, player_name, level, faction_id, is_current FROM faction_members WHERE faction_id = ? AND player_name LIKE ? COLLATE NOCASE ORDER BY is_current DESC, player_name COLLATE NOCASE LIMIT 25'
      ).bind(factionId, '%' + escapeLike(query) + '%').all();

  return (result.results || []).map(row => ({
    playerId:Number(row.player_id),
    playerName:row.player_name || 'Player ' + row.player_id,
    level:nullableNumber(row.level),
    factionId:Number(row.faction_id) || null,
    source:'RWEngine',
    localHistoryAvailable:true,
    currentFactionMember:Number(row.is_current) === 1
  }));
}

function mergeCandidate(map, candidate) {
  const existing = map.get(candidate.playerId);
  if (!existing) {
    map.set(candidate.playerId, candidate);
    return;
  }

  map.set(candidate.playerId, {
    ...candidate,
    ...existing,
    source:existing.localHistoryAvailable ? 'RWEngine + Torn' : (candidate.source || existing.source),
    localHistoryAvailable:Boolean(existing.localHistoryAvailable || candidate.localHistoryAvailable)
  });
}

async function loadWarHistory(db, factionId, playerId) {
  const result = await db.prepare(
    'SELECT w.war_id, w.opponent_faction_name, w.start_timestamp, w.end_timestamp, w.imported_at, COALESCE(wl.war_hits,0) AS hits, COALESCE(wl.outside_hits,0) AS outside_hits, COALESCE(wl.assists,0) AS assists, COALESCE(wl.score_up_adjusted, wl.score_up,0) AS score_up, COALESCE(wl.score_down,0) AS score_down FROM wars w LEFT JOIN war_log wl ON wl.faction_id = w.faction_id AND wl.war_id = w.war_id AND wl.player_id = ? WHERE w.faction_id = ? ORDER BY COALESCE(w.end_timestamp,w.start_timestamp,w.imported_at,0) DESC LIMIT 8'
  ).bind(playerId, factionId).all();

  return (result.results || []).map(row => ({
    warId:String(row.war_id),
    opponentFactionName:row.opponent_faction_name || 'Unknown opponent',
    endedAt:nullableNumber(row.end_timestamp || row.start_timestamp || row.imported_at),
    hits:Number(row.hits || 0),
    outsideHits:Number(row.outside_hits || 0),
    assists:Number(row.assists || 0),
    scoreUp:Number(row.score_up || 0),
    scoreDown:Number(row.score_down || 0),
    netScore:Number(row.score_up || 0) - Number(row.score_down || 0),
    participated:Number(row.hits || 0) > 0
  }));
}

function summarizeLastFour(wars) {
  const participated = wars.filter(war => war.participated);
  const totals = wars.reduce((sum,war) => {
    sum.hits += war.hits;
    sum.assists += war.assists;
    sum.scoreUp += war.scoreUp;
    sum.scoreDown += war.scoreDown;
    return sum;
  }, { hits:0, assists:0, scoreUp:0, scoreDown:0 });

  return {
    warsAvailable:wars.length,
    warsParticipated:participated.length,
    participation:wars.length ? participated.length / wars.length : null,
    hits:totals.hits,
    hitsPerWar:participated.length ? totals.hits / participated.length : null,
    assists:totals.assists,
    scoreUp:totals.scoreUp,
    scoreDown:totals.scoreDown,
    netScore:totals.scoreUp - totals.scoreDown
  };
}

function buildSnapshotMetrics(snapshots, now) {
  const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const current = cumulativeWindow(snapshots, now - 30 * DAY, now);
  const previous = cumulativeWindow(snapshots, now - 60 * DAY, now - 30 * DAY);

  const statsRows = snapshots.filter(row => numberOrNull(row.battle_stats_estimate) !== null);
  const statsLatest = statsRows.length ? statsRows[statsRows.length - 1] : null;
  const previousStats = statsLatest
    ? nearest(statsRows, Number(statsLatest.battle_stats_observed_at || statsLatest.snapshot_at) - 30 * DAY, statsLatest)
    : null;

  const value = numberOrNull(statsLatest?.battle_stats_estimate);
  const previousValue = numberOrNull(previousStats?.battle_stats_estimate);
  const sameSource = String(statsLatest?.battle_stats_source || '') === String(previousStats?.battle_stats_source || '');
  const reliable = value !== null && previousValue !== null && sameSource;

  return {
    observedAt:nullableNumber(latest?.snapshot_at),
    battleStats:{
      value,
      source:statsLatest?.battle_stats_source || null,
      verified:isVerified(statsLatest?.battle_stats_source),
      observedAt:nullableNumber(statsLatest?.battle_stats_observed_at || statsLatest?.snapshot_at),
      change30d:reliable ? value - previousValue : null,
      changePct30d:reliable && previousValue > 0 ? (value - previousValue) / previousValue : null
    },
    activity:{
      perDay30d:current.activityPerDay,
      perDayPrevious30d:previous.activityPerDay,
      changePct:percentChange(current.activityPerDay, previous.activityPerDay),
      coverageDays:current.coverageDays
    },
    xanax:{
      perDay30d:current.xanaxPerDay,
      perDayPrevious30d:previous.xanaxPerDay,
      changePct:percentChange(current.xanaxPerDay, previous.xanaxPerDay),
      coverageDays:current.coverageDays
    }
  };
}

function cumulativeWindow(rows, from, to) {
  const candidates = rows.filter(row => {
    const at = Number(row.snapshot_at || 0);
    return at >= from - 7 * DAY && at <= to + DAY;
  });

  if (candidates.length < 2) {
    return { activityPerDay:null, xanaxPerDay:null, coverageDays:0 };
  }

  const start = nearest(candidates, from);
  const end = nearest(candidates, to, start);
  if (!start || !end) return { activityPerDay:null, xanaxPerDay:null, coverageDays:0 };

  const elapsed = (Number(end.snapshot_at) - Number(start.snapshot_at)) / DAY;
  if (!(elapsed > 0)) return { activityPerDay:null, xanaxPerDay:null, coverageDays:0 };

  const activity = monotonicDelta(end.activity_total_seconds, start.activity_total_seconds);
  const xanax = monotonicDelta(end.xanax_taken_total, start.xanax_taken_total);

  return {
    activityPerDay:activity === null ? null : activity / elapsed,
    xanaxPerDay:xanax === null ? null : xanax / elapsed,
    coverageDays:elapsed
  };
}

function normalizeSnapshot(row) {
  return {
    at:nullableNumber(row.snapshot_at),
    battleStatsValue:numberOrNull(row.battle_stats_estimate),
    battleStatsSource:row.battle_stats_source || null,
    battleStatsObservedAt:nullableNumber(row.battle_stats_observed_at),
    activityTotalSeconds:numberOrNull(row.activity_total_seconds),
    xanaxTakenTotal:numberOrNull(row.xanax_taken_total),
    lastActionAt:nullableNumber(row.last_action_at)
  };
}

function normalizeSearch(row) {
  const playerId = Number(row?.id || row?.player_id || 0);
  if (!playerId) return null;
  return {
    playerId,
    playerName:String(row?.name || 'Player ' + playerId),
    level:nullableNumber(row?.level),
    factionId:Number(row?.faction_id || 0) || null,
    lastActionStatus:row?.online || null,
    source:'Torn',
    localHistoryAvailable:false
  };
}

function normalizeBasic(row) {
  const playerId = Number(row?.id || row?.player_id || 0);
  if (!playerId) return null;
  return {
    playerId,
    playerName:String(row?.name || 'Player ' + playerId),
    level:nullableNumber(row?.level),
    factionId:null,
    lastActionStatus:row?.status?.state || row?.status?.description || null,
    source:'Torn',
    localHistoryAvailable:false
  };
}

function normalizeProfile(row) {
  if (!row || typeof row !== 'object') return null;
  const playerId = Number(row.id || row.player_id || 0);
  if (!playerId) return null;

  return {
    playerId,
    playerName:String(row.name || 'Player ' + playerId),
    level:nullableNumber(row.level),
    rank:row.rank || null,
    title:row.title || null,
    ageDays:nullableNumber(row.age),
    signedUpAt:nullableNumber(row.signed_up),
    gender:row.gender || null,
    factionId:Number(row.faction_id || 0) || null,
    lastActionAt:nullableNumber(row.last_action?.timestamp || row.lastAction?.timestamp),
    lastActionStatus:row.last_action?.status || row.lastAction?.status || null,
    statusState:row.status?.state || null,
    statusUntil:nullableNumber(row.status?.until),
    revivable:typeof row.revivable === 'boolean' ? row.revivable : null
  };
}

function identityFromMember(row, snapshots) {
  const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const status = safeJson(row.status_json);

  return {
    playerId:Number(row.player_id),
    playerName:row.player_name || 'Player ' + row.player_id,
    level:nullableNumber(row.level),
    rank:null,
    title:null,
    ageDays:null,
    signedUpAt:null,
    gender:null,
    factionId:Number(row.faction_id || 0) || null,
    lastActionAt:nullableNumber(latest?.last_action_at || status?.last_action?.timestamp),
    lastActionStatus:latest?.last_action_status || status?.last_action?.status || null,
    statusState:latest?.status_state || status?.status?.state || null,
    statusUntil:nullableNumber(latest?.status_until || status?.status?.until),
    revivable:null
  };
}

function mergeIdentity(profile, local, playerId) {
  const source = profile || local || {};
  return {
    playerId:Number(source.playerId || playerId),
    playerName:profile?.playerName || local?.playerName || 'Player ' + playerId,
    level:profile?.level ?? local?.level ?? null,
    rank:profile?.rank ?? null,
    title:profile?.title ?? null,
    ageDays:profile?.ageDays ?? null,
    signedUpAt:profile?.signedUpAt ?? null,
    gender:profile?.gender ?? null,
    factionId:profile?.factionId ?? local?.factionId ?? null,
    lastActionAt:profile?.lastActionAt ?? local?.lastActionAt ?? null,
    lastActionStatus:profile?.lastActionStatus ?? local?.lastActionStatus ?? null,
    statusState:profile?.statusState ?? local?.statusState ?? null,
    statusUntil:profile?.statusUntil ?? local?.statusUntil ?? null,
    revivable:profile?.revivable ?? null
  };
}

function resolveHistoryScope(user, requestedFactionId) {
  const ownFactionId = Number(user.faction_id || 0) || null;
  const requested = Number(requestedFactionId || 0) || null;

  if (Number(user.is_admin) === 1) return requested || ownFactionId;
  if (requested && requested !== ownFactionId) {
    throw httpError(403, 'Historical Player Analysis is limited to your faction.');
  }
  return ownFactionId;
}

async function getUserApiKey(env, user) {
  if (!user.api_key_encrypted || !user.api_key_iv) return null;
  if (!env.APP_SECRET) throw new Error('Missing APP_SECRET secret.');
  return decryptText(env.APP_SECRET, user.api_key_encrypted, user.api_key_iv);
}

async function tornGet(apiKey, path) {
  const response = await fetch('https://api.torn.com/v2' + path, {
    headers:{
      Authorization:'ApiKey ' + apiKey,
      Accept:'application/json'
    }
  });

  let payload = null;
  try { payload = await response.json(); } catch (_) {}

  if (response.ok && !payload?.error) return payload;

  const code = payload?.error?.code ?? payload?.error?.error_code;
  const message = payload?.error?.error || payload?.error?.message || 'HTTP ' + response.status;
  const error = new Error('Torn API' + (code ? ' ' + code : '') + ': ' + message);
  error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
  throw error;
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

async function decryptText(secret, ciphertextBase64, ivBase64) {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey({
    name:'PBKDF2',
    salt:encoder.encode('rwengine-v2-api-key-encryption'),
    iterations:100000,
    hash:'SHA-256'
  }, material, { name:'AES-GCM', length:256 }, false, ['decrypt']);

  const plaintext = await crypto.subtle.decrypt(
    { name:'AES-GCM', iv:base64ToBytes(ivBase64) },
    key,
    base64ToBytes(ciphertextBase64)
  );
  return new TextDecoder().decode(plaintext);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
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

function nearest(rows, target, exclude = null) {
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

function monotonicDelta(current, previous) {
  const a = numberOrNull(current);
  const b = numberOrNull(previous);
  if (a === null || b === null || a < b) return null;
  return a - b;
}

function percentChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return (current - previous) / previous;
}

function isVerified(source) {
  const value = String(source || '').toLowerCase();
  return value.includes('verified') || value.includes('own api') || value.includes('personal');
}

function escapeLike(value) {
  return String(value).replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_');
}

function safeJson(value) {
  try { return JSON.parse(value || '{}') || {}; }
  catch (_) { return {}; }
}

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw httpError(400, 'Invalid ' + name + '.');
  return number;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableNumber(value) {
  return numberOrNull(value);
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
