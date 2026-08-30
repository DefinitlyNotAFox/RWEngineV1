const DAY_SECONDS = 86400;
const SEED_DAYS = [90, 30, 7, 0];
const TASK_BATCH_SIZE = 8;
const TORN_REQUEST_INTERVAL_MS = 1250;
const SYNC_LEASE_SECONDS = 180;
const MANAGED_KEY_CONFIG = 'admin_managed_api_key_v1';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') {
      return json({ success: false, message: 'Method not allowed. Use POST.' }, 405);
    }
    requireDb(env);

    const body = await readJson(request);
    const user = await getAdminUser(env, request);
    const action = String(body.action || 'listFactions');

    if (action === 'listFactions') return handleListFactions(env, user);
    if (action === 'setApiKey') return handleSetApiKey(env, user, body);
    if (action === 'clearApiKey') return handleClearApiKey(env, user, body);
    if (action === 'getImportedWars') return handleGetImportedWars(env, body);
    if (action === 'getRange') return handleGetRange(env, body);
    if (action === 'getMemberDetail') return handleGetMemberDetail(env, body);
    if (action === 'getSyncStatus') return handleGetSyncStatus(env, body);
    if (action === 'startSync') return handleStartSync(env, user, body);
    if (action === 'syncStep') return handleSyncStep(env, user, body);

    return json({ success: false, message: `Unknown admin action: ${action}` }, 400);
  } catch (error) {
    return json({
      success: false,
      message: error?.message || 'Unexpected admin workspace error.'
    }, error?.status || 500);
  }
}

async function handleListFactions(env, user) {
  const result = await env.DB.prepare(`
    SELECT
      f.faction_id,
      f.faction_name,
      f.enabled,
      f.created_at,
      f.updated_at,
      (SELECT COUNT(*) FROM faction_members fm WHERE fm.faction_id = f.faction_id AND fm.is_current = 1) AS current_members,
      (SELECT COUNT(*) FROM wars w WHERE w.faction_id = f.faction_id) AS war_count,
      (SELECT status FROM faction_sync_jobs sj WHERE sj.faction_id = f.faction_id ORDER BY sj.job_id DESC LIMIT 1) AS last_sync_status,
      (SELECT COALESCE(finished_at, updated_at) FROM faction_sync_jobs sj WHERE sj.faction_id = f.faction_id ORDER BY sj.job_id DESC LIMIT 1) AS last_sync_at,
      c.config_value AS managed_key_config
    FROM factions f
    LEFT JOIN faction_config c
      ON c.faction_id = f.faction_id
      AND c.config_key = ?
    WHERE f.enabled = 1
    ORDER BY f.faction_name COLLATE NOCASE, f.faction_id
  `).bind(MANAGED_KEY_CONFIG).all();

  const factions = [];
  for (const row of result.results || []) {
    const managed = parseManagedKey(row.managed_key_config);
    const fallbackOwner = managed ? null : await getFactionUserKeyOwner(env.DB, Number(row.faction_id));
    const isAccountFaction = Number(row.faction_id) === Number(user.faction_id);

    let keySource = 'missing';
    let keyOwnerName = null;
    let keyOwnerId = null;

    if (managed) {
      keySource = 'managed';
      keyOwnerName = managed.playerName || null;
      keyOwnerId = nullableNumber(managed.playerId);
    } else if (fallbackOwner) {
      keySource = isAccountFaction && Number(fallbackOwner.user_id) === Number(user.user_id)
        ? 'account'
        : 'member';
      keyOwnerName = fallbackOwner.player_name || null;
      keyOwnerId = nullableNumber(fallbackOwner.player_id);
    }

    factions.push({
      factionId: Number(row.faction_id),
      factionName: row.faction_name || `Faction ${row.faction_id}`,
      enabled: Number(row.enabled) === 1,
      currentMembers: Number(row.current_members || 0),
      warCount: Number(row.war_count || 0),
      lastSyncStatus: row.last_sync_status || null,
      lastSyncAt: nullableNumber(row.last_sync_at),
      hasApiKey: keySource !== 'missing',
      keySource,
      keyOwnerName,
      keyOwnerId,
      isAccountFaction
    });
  }

  return json({
    success: true,
    accountFactionId: nullableNumber(user.faction_id),
    accountFactionName: user.faction_name || null,
    factions
  });
}

async function handleSetApiKey(env, user, body) {
  requireSecret(env);
  const faction = await requireTrackedFaction(env.DB, body.factionId);
  const apiKey = String(body.apiKey || '').trim();
  if (!apiKey) throw httpError(400, 'Enter a Torn API key.');

  const profile = await verifyTornApiKey(apiKey);
  const profileFaction = normalizeFaction(profile);
  if (!profileFaction.factionId) {
    throw httpError(400, 'That API key is not linked to a Torn faction.');
  }
  if (Number(profileFaction.factionId) !== Number(faction.faction_id)) {
    throw httpError(
      400,
      `That key belongs to ${profileFaction.factionName || `faction ${profileFaction.factionId}`} [${profileFaction.factionId}], not ${faction.faction_name} [${faction.faction_id}].`
    );
  }

  const encrypted = await encryptText(env.APP_SECRET, apiKey);
  const now = unixNow();
  const playerId = Number(profile.player_id || profile.id || 0) || null;
  const playerName = String(profile.name || '').trim() || null;
  const configValue = JSON.stringify({
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    playerId,
    playerName,
    verifiedAt: now,
    setByUserId: Number(user.user_id)
  });

  await env.DB.prepare(`
    INSERT INTO faction_config (
      faction_id,
      config_key,
      config_value,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(faction_id, config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_at = excluded.updated_at
  `).bind(Number(faction.faction_id), MANAGED_KEY_CONFIG, configValue, now, now).run();

  if (profileFaction.factionName && profileFaction.factionName !== faction.faction_name) {
    await env.DB.prepare(`
      UPDATE factions SET faction_name = ?, updated_at = ? WHERE faction_id = ?
    `).bind(profileFaction.factionName, now, Number(faction.faction_id)).run();
  }

  return json({
    success: true,
    message: `API key saved for ${profileFaction.factionName || faction.faction_name}.`,
    factionId: Number(faction.faction_id),
    owner: { playerId, playerName }
  });
}

async function handleClearApiKey(env, user, body) {
  const faction = await requireTrackedFaction(env.DB, body.factionId);
  await env.DB.prepare(`
    DELETE FROM faction_config WHERE faction_id = ? AND config_key = ?
  `).bind(Number(faction.faction_id), MANAGED_KEY_CONFIG).run();

  return json({
    success: true,
    message: `Managed API key removed for ${faction.faction_name}. A registered faction member key may still be available as fallback.`,
    factionId: Number(faction.faction_id),
    clearedByUserId: Number(user.user_id)
  });
}

async function handleGetImportedWars(env, body) {
  const faction = await requireTrackedFaction(env.DB, body.factionId);
  const result = await env.DB.prepare(`
    SELECT
      war_id,
      report_id,
      faction_id,
      faction_name,
      opponent_faction_id,
      opponent_faction_name,
      start_timestamp,
      end_timestamp,
      imported_at,
      chain_adjusted_at,
      chain_adjustment_status,
      chain_adjustment_message
    FROM wars
    WHERE faction_id = ?
    ORDER BY COALESCE(end_timestamp, start_timestamp, imported_at, 0) DESC
    LIMIT 200
  `).bind(Number(faction.faction_id)).all();

  return json({ success: true, message: 'Imported wars loaded.', wars: result.results || [] });
}

async function handleGetRange(env, body) {
  const faction = await requireTrackedFaction(env.DB, body.factionId);
  return getRange(env.DB, Number(faction.faction_id), body);
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

async function handleGetMemberDetail(env, body) {
  const faction = await requireTrackedFaction(env.DB, body.factionId);
  const factionId = Number(faction.faction_id);
  const playerId = Number(body.playerId);
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw httpError(400, 'A valid member ID is required.');

  const now = unixNow();
  const trackingStartedAt = await getTrackingStartedAt(env.DB, factionId, now);
  const range = normalizeRange(body, trackingStartedAt, now);
  const member = await getRangeDataForMember(env.DB, factionId, playerId, range, trackingStartedAt);

  const warRows = await env.DB.prepare(`
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
      COALESCE((SELECT SUM(COALESCE(a.respect_gain, 0)) FROM attacks a WHERE a.war_id = w.war_id AND a.attacker_id = ?), 0) AS respect_earned,
      COALESCE((SELECT SUM(ABS(COALESCE(a.respect_loss, 0))) FROM attacks a WHERE a.war_id = w.war_id AND a.defender_id = ?), 0) AS respect_lost
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
    member,
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
  const member = await db.prepare(`SELECT * FROM faction_members WHERE faction_id = ? AND player_id = ?`).bind(factionId, playerId).first();
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

async function handleStartSync(env, user, body) {
  requireSecret(env);
  const faction = await requireTrackedFaction(env.DB, body.factionId);
  const factionId = Number(faction.faction_id);
  await requireFactionApiKey(env, factionId);

  const existing = await getActiveSync(env.DB, factionId);
  if (existing) return json({ success: true, message: 'Faction sync already active.', job: existing });

  const snapshotCount = await env.DB.prepare(`SELECT COUNT(*) AS count FROM member_snapshots WHERE faction_id = ?`).bind(factionId).first();
  const seedHistory = body.fullHistory === true || Number(snapshotCount?.count || 0) === 0;
  const now = unixNow();

  const result = await env.DB.prepare(`
    INSERT INTO faction_sync_jobs (
      faction_id, requested_by_user_id, trigger_type, status, phase, seed_history, created_at, updated_at
    ) VALUES (?, ?, ?, 'queued', 'initializing', ?, ?, ?)
  `).bind(
    factionId,
    Number(user.user_id),
    body.fullHistory === true ? 'admin-manual-full' : 'admin-manual',
    seedHistory ? 1 : 0,
    now,
    now
  ).run();

  return json({
    success: true,
    message: seedHistory ? 'Faction sync queued with history seed.' : 'Faction sync queued for current data.',
    job: await getSyncJob(env.DB, Number(result.meta?.last_row_id))
  });
}

async function handleGetSyncStatus(env, body) {
  const faction = await requireTrackedFaction(env.DB, body.factionId);
  const factionId = Number(faction.faction_id);
  const job = body.jobId
    ? await getSyncJob(env.DB, Number(body.jobId))
    : await getActiveSync(env.DB, factionId) || await getLatestSync(env.DB, factionId);
  if (job && Number(job.factionId) !== factionId) throw httpError(403, 'That sync job belongs to another faction.');
  return json({ success: true, job });
}

async function handleSyncStep(env, user, body) {
  requireSecret(env);
  const faction = await requireTrackedFaction(env.DB, body.factionId);
  const factionId = Number(faction.faction_id);
  const jobId = Number(body.jobId);
  if (!jobId) throw httpError(400, 'Missing sync job ID.');

  let job = await getSyncJob(env.DB, jobId);
  if (!job) throw httpError(404, 'Sync job not found.');
  if (Number(job.factionId) !== factionId) throw httpError(403, 'That sync job belongs to another faction.');
  if (['completed', 'failed'].includes(job.status)) return json({ success: true, job });

  const now = unixNow();
  const lease = await env.DB.prepare(`
    UPDATE faction_sync_jobs
    SET lease_until = ?, updated_at = ?
    WHERE job_id = ?
      AND status IN ('queued', 'running')
      AND (lease_until IS NULL OR lease_until < ?)
  `).bind(now + SYNC_LEASE_SECONDS, now, jobId, now).run();

  if (Number(lease.meta?.changes || 0) === 0) {
    job = await getSyncJob(env.DB, jobId);
    return json({ success: true, busy: true, message: 'Another sync step is already running.', job });
  }

  try {
    const apiKey = await requireFactionApiKey(env, factionId);
    const client = new TornClient(apiKey);

    if (job.phase === 'initializing' || job.status === 'queued') {
      await initializeSyncJob(env, job, client);
      job = await getSyncJob(env.DB, jobId);
    }

    const requestCountBeforeTasks = client.requestCount;
    const pending = await env.DB.prepare(`
      SELECT * FROM faction_sync_tasks
      WHERE job_id = ? AND status = 'pending'
      ORDER BY task_id
      LIMIT ?
    `).bind(jobId, TASK_BATCH_SIZE).all();

    for (const task of pending.results || []) {
      try {
        const warning = await runSnapshotTask(env, client, job, task);
        await finishTask(env.DB, Number(task.task_id), 'completed', warning || null);
      } catch (error) {
        await finishTask(env.DB, Number(task.task_id), 'failed', error?.message || String(error));
      }
    }

    const taskRequests = client.requestCount - requestCountBeforeTasks;
    if (taskRequests > 0) {
      await env.DB.prepare(`
        UPDATE faction_sync_jobs SET api_requests = api_requests + ?, updated_at = ? WHERE job_id = ?
      `).bind(taskRequests, unixNow(), jobId).run();
    }

    await refreshSyncCounts(env.DB, jobId);
    job = await getSyncJob(env.DB, jobId);
    return json({ success: true, job });
  } catch (error) {
    await env.DB.prepare(`
      UPDATE faction_sync_jobs
      SET status = 'failed', phase = 'failed', error_text = ?, finished_at = ?, updated_at = ?, lease_until = NULL
      WHERE job_id = ?
    `).bind(error?.message || String(error), unixNow(), unixNow(), jobId).run();
    throw error;
  } finally {
    await env.DB.prepare(`UPDATE faction_sync_jobs SET lease_until = NULL WHERE job_id = ?`).bind(jobId).run().catch(() => null);
  }
}

async function initializeSyncJob(env, job, client) {
  const factionId = Number(job.factionId);
  const now = unixNow();
  const beforeRequests = client.requestCount;
  const [membersPayload, basicPayload] = await Promise.all([
    client.factionMembers(factionId),
    client.factionBasic(factionId).catch(() => null)
  ]);

  const members = normalizeMembers(membersPayload);
  if (!members.length) throw new Error('Torn returned no faction members.');
  const factionName = extractFactionName(basicPayload || membersPayload, factionId);

  await env.DB.prepare(`
    INSERT INTO factions (faction_id, faction_name, enabled, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(faction_id) DO UPDATE SET faction_name = excluded.faction_name, enabled = 1, updated_at = excluded.updated_at
  `).bind(factionId, factionName, now, now).run();

  await upsertFactionMembers(env.DB, factionId, members, now);

  const days = job.seedHistory ? SEED_DAYS : [0];
  const insertTask = env.DB.prepare(`
    INSERT OR IGNORE INTO faction_sync_tasks (
      job_id, task_key, player_id, snapshot_date, snapshot_at, historical_timestamp, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

  const taskBindings = [];
  for (const member of members) {
    for (const offset of days) {
      const targetAt = offset ? now - offset * DAY_SECONDS : now;
      const snapshotDate = utcDate(targetAt);
      taskBindings.push(insertTask.bind(
        Number(job.jobId),
        `snapshot:${member.id}:${snapshotDate}`,
        member.id,
        snapshotDate,
        targetAt,
        offset ? targetAt : null,
        now
      ));
    }
  }

  for (let index = 0; index < taskBindings.length; index += 50) {
    await env.DB.batch(taskBindings.slice(index, index + 50));
  }

  const total = await env.DB.prepare(`SELECT COUNT(*) AS count FROM faction_sync_tasks WHERE job_id = ?`).bind(Number(job.jobId)).first();
  await env.DB.prepare(`
    UPDATE faction_sync_jobs
    SET status = 'running', phase = 'collecting', members_total = ?, tasks_total = ?, api_requests = api_requests + ?, error_text = NULL, updated_at = ?
    WHERE job_id = ?
  `).bind(
    members.length,
    Number(total?.count || 0),
    client.requestCount - beforeRequests,
    now,
    Number(job.jobId)
  ).run();
}

async function runSnapshotTask(env, client, job, task) {
  const member = await env.DB.prepare(`
    SELECT * FROM faction_members WHERE faction_id = ? AND player_id = ?
  `).bind(Number(job.factionId), Number(task.player_id)).first();
  if (!member) throw new Error(`Faction member ${task.player_id} is no longer known to RWE.`);

  const historicalTimestamp = task.historical_timestamp === null || task.historical_timestamp === undefined
    ? null
    : Number(task.historical_timestamp);
  const payload = await client.personalStats(Number(task.player_id), historicalTimestamp);
  const stats = extractPersonalStats(payload);
  const missing = [];
  if (!Number.isFinite(stats.activityTotalSeconds)) missing.push('time played');
  if (!Number.isFinite(stats.xanaxTakenTotal)) missing.push('Xanax taken');

  const status = safeJsonParse(member.status_json) || null;
  const currentObservation = historicalTimestamp === null;
  const lastAction = currentObservation ? normalizeLastAction(status?.last_action || status?.lastAction) : null;
  const memberStatus = currentObservation ? normalizeMemberStatus(status?.status || status) : null;
  const errorText = missing.length ? `STATS_UNAVAILABLE:${missing.join(',')}` : null;

  await env.DB.prepare(`
    INSERT INTO member_snapshots (
      faction_id, player_id, snapshot_date, snapshot_at, player_name, level, position_name,
      last_action_at, last_action_status, status_state, status_until,
      activity_total_seconds, xanax_taken_total, error_text, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(faction_id, player_id, snapshot_date) DO UPDATE SET
      snapshot_at = excluded.snapshot_at,
      player_name = excluded.player_name,
      level = excluded.level,
      position_name = excluded.position_name,
      last_action_at = COALESCE(excluded.last_action_at, member_snapshots.last_action_at),
      last_action_status = COALESCE(excluded.last_action_status, member_snapshots.last_action_status),
      status_state = COALESCE(excluded.status_state, member_snapshots.status_state),
      status_until = COALESCE(excluded.status_until, member_snapshots.status_until),
      activity_total_seconds = excluded.activity_total_seconds,
      xanax_taken_total = excluded.xanax_taken_total,
      error_text = excluded.error_text,
      raw_json = excluded.raw_json,
      created_at = excluded.created_at
  `).bind(
    Number(job.factionId),
    Number(task.player_id),
    String(task.snapshot_date),
    Number(task.snapshot_at),
    String(member.player_name || `Player ${task.player_id}`),
    nullableNumber(member.level),
    member.position_name || null,
    lastAction?.timestamp ?? null,
    lastAction?.status ?? null,
    memberStatus?.state ?? null,
    memberStatus?.until ?? null,
    Number.isFinite(stats.activityTotalSeconds) ? stats.activityTotalSeconds : null,
    Number.isFinite(stats.xanaxTakenTotal) ? stats.xanaxTakenTotal : null,
    errorText,
    JSON.stringify(payload),
    unixNow()
  ).run();

  return errorText;
}

async function upsertFactionMembers(db, factionId, members, now) {
  const statement = db.prepare(`
    INSERT INTO faction_members (
      faction_id, player_id, player_name, level, position_name, days_in_faction, status_json,
      is_current, first_seen_at, last_seen_at, left_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)
    ON CONFLICT(faction_id, player_id) DO UPDATE SET
      player_name = excluded.player_name,
      level = excluded.level,
      position_name = excluded.position_name,
      days_in_faction = excluded.days_in_faction,
      status_json = excluded.status_json,
      is_current = 1,
      last_seen_at = excluded.last_seen_at,
      left_at = NULL,
      updated_at = excluded.updated_at
  `);

  for (let index = 0; index < members.length; index += 50) {
    await db.batch(members.slice(index, index + 50).map(member => statement.bind(
      factionId,
      member.id,
      member.name,
      member.level,
      member.position,
      member.daysInFaction,
      JSON.stringify({ status: member.status, last_action: member.lastAction }),
      now,
      now,
      now
    )));
  }

  const currentIds = new Set(members.map(member => Number(member.id)));
  const existing = await db.prepare(`SELECT player_id FROM faction_members WHERE faction_id = ? AND is_current = 1`).bind(factionId).all();
  const departed = (existing.results || []).map(row => Number(row.player_id)).filter(playerId => !currentIds.has(playerId));

  if (departed.length) {
    const leave = db.prepare(`
      UPDATE faction_members
      SET is_current = 0, left_at = COALESCE(left_at, ?), updated_at = ?
      WHERE faction_id = ? AND player_id = ?
    `);
    for (let index = 0; index < departed.length; index += 50) {
      await db.batch(departed.slice(index, index + 50).map(playerId => leave.bind(now, now, factionId, playerId)));
    }
  }
}

async function refreshSyncCounts(db, jobId) {
  const counts = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM faction_sync_tasks
    WHERE job_id = ?
  `).bind(jobId).first();

  const pending = Number(counts?.pending || 0);
  const completed = Number(counts?.completed || 0);
  const failed = Number(counts?.failed || 0);
  const total = Number(counts?.total || 0);
  const finished = pending === 0;
  const now = unixNow();

  await db.prepare(`
    UPDATE faction_sync_jobs
    SET tasks_total = ?, tasks_completed = ?, tasks_failed = ?, status = ?, phase = ?, finished_at = ?, updated_at = ?
    WHERE job_id = ?
  `).bind(
    total,
    completed,
    failed,
    finished ? 'completed' : 'running',
    finished ? 'complete' : 'collecting',
    finished ? now : null,
    now,
    jobId
  ).run();
}

async function finishTask(db, taskId, status, errorText) {
  await db.prepare(`
    UPDATE faction_sync_tasks SET status = ?, attempts = attempts + 1, error_text = ?, updated_at = ? WHERE task_id = ?
  `).bind(status, errorText, unixNow(), taskId).run();
}

async function getActiveSync(db, factionId) {
  return outputJob(await db.prepare(`
    SELECT * FROM faction_sync_jobs WHERE faction_id = ? AND status IN ('queued', 'running') ORDER BY job_id DESC LIMIT 1
  `).bind(factionId).first());
}

async function getLatestSync(db, factionId) {
  return outputJob(await db.prepare(`
    SELECT * FROM faction_sync_jobs WHERE faction_id = ? ORDER BY job_id DESC LIMIT 1
  `).bind(factionId).first());
}

async function getSyncJob(db, jobId) {
  if (!jobId) return null;
  return outputJob(await db.prepare(`SELECT * FROM faction_sync_jobs WHERE job_id = ?`).bind(jobId).first());
}

function outputJob(row) {
  if (!row) return null;
  return {
    jobId: Number(row.job_id),
    factionId: Number(row.faction_id),
    requestedByUserId: Number(row.requested_by_user_id),
    triggerType: row.trigger_type,
    status: row.status,
    phase: row.phase,
    seedHistory: Number(row.seed_history) === 1,
    membersTotal: Number(row.members_total || 0),
    tasksTotal: Number(row.tasks_total || 0),
    tasksCompleted: Number(row.tasks_completed || 0),
    tasksFailed: Number(row.tasks_failed || 0),
    apiRequests: Number(row.api_requests || 0),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    finishedAt: Number(row.finished_at || 0) || null,
    error: row.error_text || null
  };
}

async function requireFactionApiKey(env, factionId) {
  const managedRow = await env.DB.prepare(`
    SELECT config_value FROM faction_config WHERE faction_id = ? AND config_key = ?
  `).bind(factionId, MANAGED_KEY_CONFIG).first();
  const managed = parseManagedKey(managedRow?.config_value);
  if (managed?.ciphertext && managed?.iv) {
    return decryptText(env.APP_SECRET, managed.ciphertext, managed.iv);
  }

  const owner = await getFactionUserKeyOwner(env.DB, factionId);
  if (owner?.api_key_encrypted && owner?.api_key_iv) {
    return decryptText(env.APP_SECRET, owner.api_key_encrypted, owner.api_key_iv);
  }

  throw httpError(400, 'No usable API key is configured for this faction. Add one in Admin faction control.');
}

async function getFactionUserKeyOwner(db, factionId) {
  return db.prepare(`
    SELECT user_id, player_id, player_name, api_key_encrypted, api_key_iv
    FROM users
    WHERE faction_id = ?
      AND is_disabled = 0
      AND api_key_encrypted IS NOT NULL
      AND api_key_iv IS NOT NULL
    ORDER BY is_admin DESC, last_login_at DESC, user_id ASC
    LIMIT 1
  `).bind(factionId).first();
}

async function requireTrackedFaction(db, factionIdValue) {
  const factionId = Number(factionIdValue);
  if (!Number.isSafeInteger(factionId) || factionId <= 0) throw httpError(400, 'A valid faction ID is required.');
  const row = await db.prepare(`SELECT faction_id, faction_name, enabled FROM factions WHERE faction_id = ?`).bind(factionId).first();
  if (!row || Number(row.enabled) !== 1) throw httpError(404, 'That faction is not currently tracked by RWE.');
  return row;
}

async function getAdminUser(env, request) {
  const token = getCookie(request, 'rwengine_session');
  if (!token) throw httpError(401, 'Not logged in.');
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`
    SELECT
      u.user_id, u.player_id, u.player_name, u.faction_id, u.faction_name,
      u.api_key_encrypted, u.api_key_iv, u.is_admin, u.is_disabled
    FROM sessions s
    JOIN users u ON u.user_id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, unixNow()).first();
  if (!row) throw httpError(401, 'Session expired or invalid.');
  if (Number(row.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  if (Number(row.is_admin) !== 1) throw httpError(403, 'Admin access required.');
  return row;
}

async function verifyTornApiKey(apiKey) {
  const response = await fetch(`https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}`, {
    headers: { Accept: 'application/json' }
  });
  let data;
  try { data = await response.json(); } catch (_) { throw httpError(502, 'Torn returned invalid JSON.'); }
  if (!response.ok) throw httpError(502, `Torn API request failed with status ${response.status}.`);
  if (data.error) {
    const message = data.error.error || data.error.message || 'Unknown Torn API error.';
    throw httpError(400, `Torn API error: ${message}`);
  }
  return data;
}

function normalizeFaction(profile) {
  const source = profile?.faction || {};
  return {
    factionId: Number(source.faction_id || source.id || profile?.faction_id || 0) || null,
    factionName: source.faction_name || source.name || profile?.faction_name || null
  };
}

function parseManagedKey(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
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

  const snapshotRow = await db.prepare(`SELECT MIN(snapshot_at) AS started_at FROM member_snapshots WHERE faction_id = ?`).bind(factionId).first();
  return Number(snapshotRow?.started_at || 0) || fallback;
}

function normalizeRange(body, trackingStartedAt, now) {
  const requestedFrom = parseDateStart(body.from);
  const requestedTo = parseDateEnd(body.to);
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
  for (const snapshot of snapshots) if (Number(snapshot.snapshot_at) <= to) latest = snapshot;
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

class TornClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.lastRequestAt = 0;
    this.requestCount = 0;
  }

  async request(path, attempt = 1) {
    const waitFor = TORN_REQUEST_INTERVAL_MS - (Date.now() - this.lastRequestAt);
    if (waitFor > 0) await sleep(waitFor);
    this.lastRequestAt = Date.now();
    this.requestCount++;

    let response;
    try {
      response = await fetch(`https://api.torn.com/v2${path}`, {
        headers: { Authorization: `ApiKey ${this.apiKey}`, Accept: 'application/json' }
      });
    } catch (error) {
      if (attempt <= 2) {
        await sleep(1500 * attempt);
        return this.request(path, attempt + 1);
      }
      throw new Error(`Torn API network error: ${error?.message || String(error)}`);
    }

    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    const apiError = payload?.error;
    const errorCode = Number(apiError?.code ?? apiError?.error_code ?? 0);
    if (response.ok && !apiError) return payload;

    if (errorCode === 5 && attempt <= 2) {
      await sleep(65000);
      return this.request(path, attempt + 1);
    }
    if ((response.status === 429 || response.status >= 500) && attempt <= 2) {
      await sleep(1500 * 2 ** (attempt - 1));
      return this.request(path, attempt + 1);
    }

    const message = apiError?.error || apiError?.message || `HTTP ${response.status}`;
    throw new Error(`Torn API${errorCode ? ` ${errorCode}` : ''}: ${message}`);
  }

  factionMembers(factionId) {
    return this.request(`/faction/${encodeURIComponent(factionId)}/members?comment=RWEngineAdminFactionIntel`);
  }

  factionBasic(factionId) {
    return this.request(`/faction/${encodeURIComponent(factionId)}/basic?comment=RWEngineAdminFactionIntel`);
  }

  personalStats(playerId, timestamp = null) {
    const query = new URLSearchParams({ stat: 'timeplayed,xantaken', comment: 'RWEngineAdminFactionIntel' });
    if (Number.isFinite(timestamp)) query.set('timestamp', String(timestamp));
    return this.request(`/user/${encodeURIComponent(playerId)}/personalstats?${query}`);
  }
}

function normalizeMembers(payload) {
  const source = payload?.members ?? payload?.faction?.members ?? [];
  const entries = Array.isArray(source)
    ? source.map(member => [member?.id ?? member?.user_id ?? member?.player_id, member])
    : Object.entries(source || {});

  return entries.map(([fallbackId, member]) => {
    const status = member?.status ?? null;
    const lastAction = member?.last_action ?? member?.lastAction ?? null;
    const position = member?.position?.name ?? member?.position_name ?? member?.position ?? '';
    return {
      id: Number(member?.id ?? member?.user_id ?? member?.player_id ?? fallbackId),
      name: String(member?.name ?? member?.player_name ?? 'Unknown'),
      level: nullableNumber(member?.level),
      position: String(position || ''),
      daysInFaction: nullableNumber(member?.days_in_faction),
      status,
      lastAction
    };
  }).filter(member => Number.isSafeInteger(member.id) && member.id > 0);
}

function extractFactionName(payload, fallbackId) {
  return String(payload?.name ?? payload?.faction_name ?? payload?.faction?.name ?? payload?.basic?.name ?? `Faction ${fallbackId}`);
}

function extractPersonalStats(payload) {
  const root = payload?.personalstats ?? payload;
  return {
    activityTotalSeconds: extractNumber(findNumericStat(root, ['timeplayed', 'time_played', 'useractivity', 'activitytime', 'time'])),
    xanaxTakenTotal: extractNumber(findNumericStat(root, ['xantaken', 'xanaxused', 'xanaxtaken', 'xanax']))
  };
}

function findNumericStat(value, aliases) {
  if (!value || typeof value !== 'object') return null;
  const normalizedAliases = aliases.map(normalizeKey);
  const named = normalizeKey(value.name ?? value.stat ?? value.key ?? value.label);
  if (normalizedAliases.includes(named)) {
    const parsed = extractNumber(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  for (const [key, child] of Object.entries(value)) {
    if (normalizedAliases.includes(normalizeKey(key))) {
      const parsed = extractNumber(child);
      if (Number.isFinite(parsed)) return parsed;
    }
    const nested = findNumericStat(child, normalizedAliases);
    if (Number.isFinite(nested)) return nested;
  }
  return null;
}

function extractNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value && typeof value === 'object') {
    for (const key of ['value', 'amount', 'total', 'current', 'time', 'count']) {
      const parsed = extractNumber(value[key]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function normalizeLastAction(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    timestamp: nullableNumber(value.timestamp ?? value.time ?? value.at),
    status: String(value.status ?? value.relative ?? value.text ?? '') || null
  };
}

function normalizeMemberStatus(value) {
  if (!value) return null;
  if (typeof value === 'string') return { state: value, until: null };
  return {
    state: String(value.state ?? value.status ?? value.description ?? '') || null,
    until: nullableNumber(value.until ?? value.until_timestamp ?? value.timestamp)
  };
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

function safeJsonParse(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function utcDate(timestamp = unixNow()) {
  return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
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

async function encryptText(secret, text) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({
    name: 'PBKDF2', salt: encoder.encode('rwengine-v2-api-key-encryption'), iterations: 100000, hash: 'SHA-256'
  }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(text));
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function decryptText(secret, ciphertextBase64, ivBase64) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({
    name: 'PBKDF2', salt: encoder.encode('rwengine-v2-api-key-encryption'), iterations: 100000, hash: 'SHA-256'
  }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(ivBase64) }, key, base64ToBytes(ciphertextBase64));
  return new TextDecoder().decode(plaintext);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function readJson(request) {
  try { return await request.json(); } catch (_) { return {}; }
}

function requireDb(env) {
  if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');
}

function requireSecret(env) {
  if (!env.APP_SECRET) throw new Error('Missing APP_SECRET secret.');
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
