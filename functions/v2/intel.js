const DAY_SECONDS = 86400;
const SEED_DAYS = [90, 30, 7, 0];
const TASK_BATCH_SIZE = 8;
const TORN_REQUEST_INTERVAL_MS = 1250;
const SYNC_LEASE_SECONDS = 180;

export async function onRequest(context) {
  try {
    const { request, env } = context;

    if (request.method !== 'POST') {
      return json({ success: false, message: 'Method not allowed. Use POST.' }, 405);
    }

    requireDb(env);
    const body = await readJson(request);
    const action = String(body.action || 'getIntel');

    if (action === 'getIntel') return handleGetIntel(env, request, body);
    if (action === 'startSync') return handleStartSync(env, request, body);
    if (action === 'getSyncStatus') return handleGetSyncStatus(env, request, body);
    if (action === 'syncStep') return handleSyncStep(env, request, body);

    return json({ success: false, message: `Unknown intel action: ${action}` }, 400);
  } catch (error) {
    return json({
      success: false,
      message: error?.message || 'Unexpected faction-intel error.'
    }, error?.status || 500);
  }
}

async function handleStartSync(env, request, body) {
  requireSecret(env);
  const user = await getCurrentUserPrivate(env, request);
  const factionId = requireFactionId(user.faction_id);

  const existing = await getActiveSync(env.DB, factionId);
  if (existing) {
    return json({ success: true, message: 'Faction sync already active.', job: existing });
  }

  const snapshotCount = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM member_snapshots
    WHERE faction_id = ?
  `).bind(factionId).first();

  const seedHistory = body.fullHistory === true || Number(snapshotCount?.count || 0) === 0;
  const now = unixNow();

  const result = await env.DB.prepare(`
    INSERT INTO faction_sync_jobs (
      faction_id,
      requested_by_user_id,
      trigger_type,
      status,
      phase,
      seed_history,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 'queued', 'initializing', ?, ?, ?)
  `).bind(
    factionId,
    Number(user.user_id),
    body.fullHistory === true ? 'manual-full' : 'manual',
    seedHistory ? 1 : 0,
    now,
    now
  ).run();

  const job = await getSyncJob(env.DB, Number(result.meta?.last_row_id));
  return json({
    success: true,
    message: seedHistory
      ? 'Faction sync queued with 90/30/7/current history seed.'
      : 'Faction sync queued for current data.',
    job
  });
}

async function handleGetSyncStatus(env, request, body) {
  const user = await getCurrentUserPrivate(env, request, false);
  const factionId = requireFactionId(user.faction_id);

  const job = body.jobId
    ? await getSyncJob(env.DB, Number(body.jobId))
    : await getActiveSync(env.DB, factionId) || await getLatestSync(env.DB, factionId);

  if (job && Number(job.factionId) !== factionId) {
    throw httpError(403, 'That sync job belongs to another faction.');
  }

  return json({ success: true, job });
}

async function handleSyncStep(env, request, body) {
  requireSecret(env);
  const currentUser = await getCurrentUserPrivate(env, request);
  const factionId = requireFactionId(currentUser.faction_id);
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
    const apiOwner = await getApiOwner(env.DB, Number(job.requestedByUserId));
    if (!apiOwner?.api_key_encrypted || !apiOwner?.api_key_iv) {
      throw new Error('The account that started this sync has no stored Torn API key.');
    }

    const apiKey = await decryptText(env.APP_SECRET, apiOwner.api_key_encrypted, apiOwner.api_key_iv);
    const client = new TornClient(apiKey);

    if (job.phase === 'initializing' || job.status === 'queued') {
      await initializeSyncJob(env, job, client);
      job = await getSyncJob(env.DB, jobId);
    }

    const requestCountBeforeTasks = client.requestCount;
    const pending = await env.DB.prepare(`
      SELECT *
      FROM faction_sync_tasks
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
        UPDATE faction_sync_jobs
        SET api_requests = api_requests + ?, updated_at = ?
        WHERE job_id = ?
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
    await env.DB.prepare(`
      UPDATE faction_sync_jobs
      SET lease_until = NULL
      WHERE job_id = ?
    `).bind(jobId).run().catch(() => null);
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
    ON CONFLICT(faction_id) DO UPDATE SET
      faction_name = excluded.faction_name,
      enabled = 1,
      updated_at = excluded.updated_at
  `).bind(factionId, factionName, now, now).run();

  await upsertFactionMembers(env.DB, factionId, members, now);

  const days = job.seedHistory ? SEED_DAYS : [0];
  const insertTask = env.DB.prepare(`
    INSERT OR IGNORE INTO faction_sync_tasks (
      job_id,
      task_key,
      player_id,
      snapshot_date,
      snapshot_at,
      historical_timestamp,
      status,
      updated_at
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

  const total = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM faction_sync_tasks WHERE job_id = ?
  `).bind(Number(job.jobId)).first();

  await env.DB.prepare(`
    UPDATE faction_sync_jobs
    SET
      status = 'running',
      phase = 'collecting',
      members_total = ?,
      tasks_total = ?,
      api_requests = api_requests + ?,
      error_text = NULL,
      updated_at = ?
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
    SELECT *
    FROM faction_members
    WHERE faction_id = ? AND player_id = ?
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
      faction_id,
      player_id,
      snapshot_date,
      snapshot_at,
      player_name,
      level,
      position_name,
      last_action_at,
      last_action_status,
      status_state,
      status_until,
      activity_total_seconds,
      xanax_taken_total,
      error_text,
      raw_json,
      created_at
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
      faction_id,
      player_id,
      player_name,
      level,
      position_name,
      days_in_faction,
      status_json,
      is_current,
      first_seen_at,
      last_seen_at,
      left_at,
      updated_at
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
  const existing = await db.prepare(`
    SELECT player_id
    FROM faction_members
    WHERE faction_id = ? AND is_current = 1
  `).bind(factionId).all();

  const departed = (existing.results || [])
    .map(row => Number(row.player_id))
    .filter(playerId => !currentIds.has(playerId));

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

async function handleGetIntel(env, request, body) {
  const user = await getCurrentUserPrivate(env, request, false);
  const factionId = requireFactionId(user.faction_id);
  const days = normalizeDays(body.days);
  const includeInactive = body.includeInactive === true;
  const now = unixNow();
  const cutoff = now - days * DAY_SECONDS;
  const snapshotWindowStart = cutoff - 7 * DAY_SECONDS;

  const membersResult = await env.DB.prepare(`
    SELECT *
    FROM faction_members
    WHERE faction_id = ?
      ${includeInactive ? '' : 'AND is_current = 1'}
    ORDER BY is_current DESC, player_name COLLATE NOCASE
  `).bind(factionId).all();

  const snapshotsResult = await env.DB.prepare(`
    SELECT *
    FROM member_snapshots
    WHERE faction_id = ? AND snapshot_at >= ?
    ORDER BY player_id, snapshot_at
  `).bind(factionId, snapshotWindowStart).all();

  const warResult = await env.DB.prepare(`
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
      AND COALESCE(w.end_timestamp, w.start_timestamp, w.imported_at, 0) >= ?
    GROUP BY wl.player_id
  `).bind(factionId, cutoff).all();

  const warCountRow = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM wars
    WHERE faction_id = ?
      AND COALESCE(end_timestamp, start_timestamp, imported_at, 0) >= ?
  `).bind(factionId, cutoff).first();

  const snapshotsByPlayer = groupBy(snapshotsResult.results || [], row => Number(row.player_id));
  const warsByPlayer = new Map((warResult.results || []).map(row => [Number(row.player_id), row]));
  const totalWars = Number(warCountRow?.count || 0);

  const members = (membersResult.results || []).map(member => {
    const playerId = Number(member.player_id);
    const snapshots = snapshotsByPlayer.get(playerId) || [];
    const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
    const baseline = chooseBaseline(snapshots, cutoff, latest);
    const elapsedDays = latest && baseline
      ? Math.max(0, (Number(latest.snapshot_at) - Number(baseline.snapshot_at)) / DAY_SECONDS)
      : 0;

    const activityDelta = safeDelta(latest?.activity_total_seconds, baseline?.activity_total_seconds);
    const xanaxDelta = safeDelta(latest?.xanax_taken_total, baseline?.xanax_taken_total);
    const war = warsByPlayer.get(playerId) || {};
    const scoreUp = Number(war.score_up || 0);
    const scoreDown = Number(war.score_down || 0);
    const hits = Number(war.hits || 0);
    const wars = Number(war.wars || 0);

    return {
      playerId,
      playerName: member.player_name,
      level: nullableNumber(member.level),
      position: member.position_name || '',
      daysInFaction: nullableNumber(member.days_in_faction),
      current: Number(member.is_current) === 1,
      firstSeenAt: Number(member.first_seen_at || 0) || null,
      lastSeenAt: Number(member.last_seen_at || 0) || null,
      leftAt: Number(member.left_at || 0) || null,

      lastActionAt: Number(latest?.last_action_at || 0) || null,
      lastActionStatus: latest?.last_action_status || null,
      statusState: latest?.status_state || null,
      statusUntil: Number(latest?.status_until || 0) || null,

      battleStatsEstimate: nullableNumber(latest?.battle_stats_estimate),
      battleStatsSource: latest?.battle_stats_source || null,
      battleStatsObservedAt: Number(latest?.battle_stats_observed_at || 0) || null,

      activitySeconds: activityDelta,
      activityPerDaySeconds: elapsedDays > 0 && activityDelta !== null ? activityDelta / elapsedDays : null,
      xanaxTaken: xanaxDelta,
      xanaxPerDay: elapsedDays > 0 && xanaxDelta !== null ? xanaxDelta / elapsedDays : null,
      coverageDays: elapsedDays || null,
      snapshotAt: Number(latest?.snapshot_at || 0) || null,
      snapshotError: latest?.error_text || null,

      wars,
      participation: totalWars > 0 ? wars / totalWars : null,
      warHits: hits,
      outsideHits: Number(war.outside_hits || 0),
      assists: Number(war.assists || 0),
      scoreUp,
      scoreDown,
      netScore: scoreUp - scoreDown,
      avgScorePerHit: hits > 0 ? scoreUp / hits : null
    };
  });

  const currentMembers = members.filter(member => member.current).length;
  const withActivity = members.filter(member => member.activityPerDaySeconds !== null).length;
  const withXanax = members.filter(member => member.xanaxPerDay !== null).length;
  const activeSync = await getActiveSync(env.DB, factionId);
  const latestSync = activeSync || await getLatestSync(env.DB, factionId);

  return json({
    success: true,
    days,
    generatedAt: now,
    summary: {
      currentMembers,
      trackedMembers: members.length,
      warsInPeriod: totalWars,
      activityCoverage: withActivity,
      xanaxCoverage: withXanax
    },
    sync: latestSync,
    members
  });
}

function chooseBaseline(snapshots, cutoff, latest) {
  if (!latest || snapshots.length < 2) return null;

  let best = null;
  let bestDistance = Infinity;

  for (const snapshot of snapshots) {
    if (snapshot === latest) continue;
    const distance = Math.abs(Number(snapshot.snapshot_at) - cutoff);
    if (distance < bestDistance) {
      best = snapshot;
      bestDistance = distance;
    }
  }

  return best;
}

function safeDelta(currentValue, baselineValue) {
  const current = Number(currentValue);
  const baseline = Number(baselineValue);
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null;
  if (current < baseline) return null;
  return current - baseline;
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
    SET
      tasks_total = ?,
      tasks_completed = ?,
      tasks_failed = ?,
      status = ?,
      phase = ?,
      finished_at = ?,
      updated_at = ?
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
    UPDATE faction_sync_tasks
    SET status = ?, attempts = attempts + 1, error_text = ?, updated_at = ?
    WHERE task_id = ?
  `).bind(status, errorText, unixNow(), taskId).run();
}

async function getActiveSync(db, factionId) {
  const row = await db.prepare(`
    SELECT * FROM faction_sync_jobs
    WHERE faction_id = ? AND status IN ('queued', 'running')
    ORDER BY job_id DESC
    LIMIT 1
  `).bind(factionId).first();
  return outputJob(row);
}

async function getLatestSync(db, factionId) {
  const row = await db.prepare(`
    SELECT * FROM faction_sync_jobs
    WHERE faction_id = ?
    ORDER BY job_id DESC
    LIMIT 1
  `).bind(factionId).first();
  return outputJob(row);
}

async function getSyncJob(db, jobId) {
  if (!jobId) return null;
  const row = await db.prepare(`SELECT * FROM faction_sync_jobs WHERE job_id = ?`).bind(jobId).first();
  return outputJob(row);
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

async function getApiOwner(db, userId) {
  return db.prepare(`
    SELECT user_id, faction_id, api_key_encrypted, api_key_iv, is_disabled
    FROM users
    WHERE user_id = ?
  `).bind(userId).first();
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
        headers: {
          Authorization: `ApiKey ${this.apiKey}`,
          Accept: 'application/json'
        }
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
    return this.request(`/faction/${encodeURIComponent(factionId)}/members?comment=RWEngineFactionIntel`);
  }

  factionBasic(factionId) {
    return this.request(`/faction/${encodeURIComponent(factionId)}/basic?comment=RWEngineFactionIntel`);
  }

  personalStats(playerId, timestamp = null) {
    const query = new URLSearchParams({
      stat: 'timeplayed,xantaken',
      comment: 'RWEngineFactionIntel'
    });
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
  return String(
    payload?.name ?? payload?.faction_name ?? payload?.faction?.name ?? payload?.basic?.name ?? `Faction ${fallbackId}`
  );
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

async function getCurrentUserPrivate(env, request, requireApiKey = true) {
  const sessionToken = getCookie(request, 'rwengine_session');
  if (!sessionToken) throw httpError(401, 'Not logged in.');

  const tokenHash = await sha256Hex(sessionToken);
  const now = unixNow();

  const row = await env.DB.prepare(`
    SELECT
      users.user_id,
      users.player_id,
      users.player_name,
      users.faction_id,
      users.faction_name,
      users.api_key_encrypted,
      users.api_key_iv,
      users.is_admin,
      users.is_disabled,
      sessions.expires_at
    FROM sessions
    JOIN users ON users.user_id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).bind(tokenHash, now).first();

  if (!row) throw httpError(401, 'Session expired or invalid.');
  if (Number(row.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  if (requireApiKey && (!row.api_key_encrypted || !row.api_key_iv)) {
    throw httpError(400, 'No stored Torn API key found for this account.');
  }
  return row;
}

async function decryptText(secret, ciphertextBase64, ivBase64) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode('rwengine-v2-api-key-encryption'),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivBase64) },
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

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
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

function normalizeDays(value) {
  const days = Number(value || 30);
  if (![7, 30, 90].includes(days)) throw httpError(400, 'days must be 7, 30 or 90.');
  return days;
}

function requireFactionId(value) {
  const factionId = Number(value);
  if (!Number.isSafeInteger(factionId) || factionId <= 0) throw httpError(400, 'Account is not linked to a valid faction.');
  return factionId;
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
