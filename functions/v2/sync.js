const TASK_BATCH_SIZE = 6;
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
    requireSecret(env);

    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const factionId = await resolveFactionId(env.DB, user, body.factionId);
    const action = String(body.action || 'getSyncStatus');

    if (action === 'startSync') return startSync(env, user, factionId);
    if (action === 'getSyncStatus') return getSyncStatus(env.DB, factionId, body.jobId);
    if (action === 'syncStep') return syncStep(env, user, factionId, body.jobId);

    return json({ success: false, message: `Unknown sync action: ${action}` }, 400);
  } catch (error) {
    return json({
      success: false,
      message: error?.message || 'Unexpected faction sync error.'
    }, error?.status || 500);
  }
}

async function startSync(env, user, factionId) {
  let existing = await getActiveSync(env.DB, factionId);
  if (existing) {
    await normalizeCurrentOnlyJob(env.DB, existing.jobId);
    existing = await getSyncJob(env.DB, existing.jobId);
    return json({
      success: true,
      message: 'Existing faction sync resumed using current-only snapshots.',
      job: existing
    });
  }

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
    ) VALUES (?, ?, 'manual', 'queued', 'initializing', 0, ?, ?)
  `).bind(factionId, Number(user.user_id), now, now).run();

  return json({
    success: true,
    message: 'Faction sync queued for the current roster and member baseline.',
    job: await getSyncJob(env.DB, Number(result.meta?.last_row_id))
  });
}

async function getSyncStatus(db, factionId, jobIdValue) {
  const jobId = Number(jobIdValue || 0);
  const job = jobId
    ? await getSyncJob(db, jobId)
    : await getActiveSync(db, factionId) || await getLatestSync(db, factionId);

  if (job && Number(job.factionId) !== Number(factionId)) {
    throw httpError(403, 'That sync job belongs to another faction.');
  }

  return json({ success: true, job });
}

async function syncStep(env, user, factionId, jobIdValue) {
  const jobId = Number(jobIdValue || 0);
  if (!jobId) throw httpError(400, 'Missing sync job ID.');

  let job = await getSyncJob(env.DB, jobId);
  if (!job) throw httpError(404, 'Sync job not found.');
  if (Number(job.factionId) !== Number(factionId)) {
    throw httpError(403, 'That sync job belongs to another faction.');
  }
  if (['completed', 'failed'].includes(job.status)) return json({ success: true, job });

  await normalizeCurrentOnlyJob(env.DB, jobId);
  job = await getSyncJob(env.DB, jobId);

  const now = unixNow();
  const lease = await env.DB.prepare(`
    UPDATE faction_sync_jobs
    SET lease_until = ?, updated_at = ?
    WHERE job_id = ?
      AND status IN ('queued', 'running')
      AND (lease_until IS NULL OR lease_until < ?)
  `).bind(now + SYNC_LEASE_SECONDS, now, jobId, now).run();

  if (Number(lease.meta?.changes || 0) === 0) {
    return json({
      success: true,
      busy: true,
      message: 'Another sync step is already running.',
      job: await getSyncJob(env.DB, jobId)
    });
  }

  try {
    const factionKey = await requireFactionApiKey(env, factionId, user);
    const client = new TornClient(factionKey);

    if (job.phase === 'initializing' || job.status === 'queued') {
      await initializeJob(env, job, client);
      job = await getSyncJob(env.DB, jobId);
    }

    const pending = await env.DB.prepare(`
      SELECT *
      FROM faction_sync_tasks
      WHERE job_id = ? AND status = 'pending'
      ORDER BY task_id
      LIMIT ?
    `).bind(jobId, TASK_BATCH_SIZE).all();

    const requestsBefore = client.requestCount;
    for (const task of pending.results || []) {
      try {
        const warning = await collectMemberSnapshot(env, client, job, task);
        await finishTask(env.DB, Number(task.task_id), 'completed', warning || null);
      } catch (error) {
        await finishTask(env.DB, Number(task.task_id), 'failed', error?.message || String(error));
      }
    }

    const used = client.requestCount - requestsBefore;
    if (used > 0) {
      await env.DB.prepare(`
        UPDATE faction_sync_jobs
        SET api_requests = api_requests + ?, updated_at = ?
        WHERE job_id = ?
      `).bind(used, unixNow(), jobId).run();
    }

    await refreshSyncCounts(env.DB, jobId);
    return json({ success: true, job: await getSyncJob(env.DB, jobId) });
  } catch (error) {
    const failedAt = unixNow();
    await env.DB.prepare(`
      UPDATE faction_sync_jobs
      SET status = 'failed', phase = 'failed', error_text = ?, finished_at = ?, updated_at = ?, lease_until = NULL
      WHERE job_id = ?
    `).bind(error?.message || String(error), failedAt, failedAt, jobId).run();
    throw error;
  } finally {
    await env.DB.prepare(`UPDATE faction_sync_jobs SET lease_until = NULL WHERE job_id = ?`)
      .bind(jobId).run().catch(() => null);
  }
}

async function normalizeCurrentOnlyJob(db, jobId) {
  await db.prepare(`
    DELETE FROM faction_sync_tasks
    WHERE job_id = ? AND historical_timestamp IS NOT NULL
  `).bind(jobId).run();

  await db.prepare(`
    UPDATE faction_sync_tasks
    SET status = 'pending', error_text = NULL, updated_at = ?
    WHERE job_id = ? AND historical_timestamp IS NULL AND status = 'failed'
  `).bind(unixNow(), jobId).run();

  await db.prepare(`
    UPDATE faction_sync_jobs
    SET seed_history = 0, trigger_type = 'manual', updated_at = ?
    WHERE job_id = ?
  `).bind(unixNow(), jobId).run();

  await refreshSyncCounts(db, jobId, false);
}

async function initializeJob(env, job, client) {
  const factionId = Number(job.factionId);
  const now = unixNow();
  const before = client.requestCount;

  const membersPayload = await client.factionMembers(factionId);
  const basicPayload = await client.factionBasic(factionId).catch(() => null);
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

  const snapshotDate = utcDate(now);
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
    ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?)
  `);

  for (let index = 0; index < members.length; index += 50) {
    await env.DB.batch(members.slice(index, index + 50).map(member => insertTask.bind(
      Number(job.jobId),
      `snapshot:${member.id}:${snapshotDate}`,
      member.id,
      snapshotDate,
      now,
      now
    )));
  }

  const count = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM faction_sync_tasks WHERE job_id = ?
  `).bind(Number(job.jobId)).first();

  await env.DB.prepare(`
    UPDATE faction_sync_jobs
    SET
      status = 'running',
      phase = 'collecting',
      seed_history = 0,
      members_total = ?,
      tasks_total = ?,
      api_requests = api_requests + ?,
      error_text = NULL,
      updated_at = ?
    WHERE job_id = ?
  `).bind(
    members.length,
    Number(count?.count || 0),
    client.requestCount - before,
    now,
    Number(job.jobId)
  ).run();
}

async function collectMemberSnapshot(env, client, job, task) {
  const factionId = Number(job.factionId);
  const playerId = Number(task.player_id);
  const member = await env.DB.prepare(`
    SELECT * FROM faction_members WHERE faction_id = ? AND player_id = ?
  `).bind(factionId, playerId).first();
  if (!member) throw new Error(`Faction member ${playerId} is no longer known to RWE.`);

  const payload = await client.personalStats(playerId);
  let stats = extractPersonalStats(payload);

  // Torn no longer exposes selected live personal stats through `stat=`. If the
  // compact request does not contain the values, fall back to their live categories.
  if (!Number.isFinite(stats.activityTotalSeconds) || !Number.isFinite(stats.xanaxTakenTotal)) {
    const other = !Number.isFinite(stats.activityTotalSeconds)
      ? await client.personalStatsCategory(playerId, 'other').catch(() => null)
      : null;
    const drugs = !Number.isFinite(stats.xanaxTakenTotal)
      ? await client.personalStatsCategory(playerId, 'drugs').catch(() => null)
      : null;
    stats = mergePersonalStats(stats, extractPersonalStats(other), extractPersonalStats(drugs));
  }

  const warnings = [];
  if (!Number.isFinite(stats.activityTotalSeconds)) warnings.push('time played');
  if (!Number.isFinite(stats.xanaxTakenTotal)) warnings.push('Xanax taken');

  const status = safeJsonParse(member.status_json) || null;
  const lastAction = normalizeLastAction(status?.last_action || status?.lastAction);
  const memberStatus = normalizeMemberStatus(status?.status || status);

  let battleStats = null;
  try {
    const ownKey = await getMemberOwnApiKey(env, factionId, playerId);
    if (ownKey) {
      const battlePayload = await fetchTornWithKey('/user/battlestats?comment=RWEngineVerifiedStats', ownKey);
      battleStats = extractBattleStatsTotal(battlePayload);
    }
  } catch (_) {
    // Exact stats are optional; failure must not invalidate the faction snapshot.
  }

  const rawPayload = {
    personalstats: payload,
    rwe: {
      organizedCrimesTotal: Number.isFinite(stats.organizedCrimesTotal) ? stats.organizedCrimesTotal : null
    }
  };

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
      battle_stats_estimate,
      battle_stats_source,
      battle_stats_observed_at,
      error_text,
      raw_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(faction_id, player_id, snapshot_date) DO UPDATE SET
      snapshot_at = excluded.snapshot_at,
      player_name = excluded.player_name,
      level = excluded.level,
      position_name = excluded.position_name,
      last_action_at = COALESCE(excluded.last_action_at, member_snapshots.last_action_at),
      last_action_status = COALESCE(excluded.last_action_status, member_snapshots.last_action_status),
      status_state = COALESCE(excluded.status_state, member_snapshots.status_state),
      status_until = COALESCE(excluded.status_until, member_snapshots.status_until),
      activity_total_seconds = COALESCE(excluded.activity_total_seconds, member_snapshots.activity_total_seconds),
      xanax_taken_total = COALESCE(excluded.xanax_taken_total, member_snapshots.xanax_taken_total),
      battle_stats_estimate = COALESCE(excluded.battle_stats_estimate, member_snapshots.battle_stats_estimate),
      battle_stats_source = COALESCE(excluded.battle_stats_source, member_snapshots.battle_stats_source),
      battle_stats_observed_at = COALESCE(excluded.battle_stats_observed_at, member_snapshots.battle_stats_observed_at),
      error_text = excluded.error_text,
      raw_json = excluded.raw_json,
      created_at = excluded.created_at
  `).bind(
    factionId,
    playerId,
    String(task.snapshot_date),
    Number(task.snapshot_at),
    String(member.player_name || `Player ${playerId}`),
    nullableNumber(member.level),
    member.position_name || null,
    lastAction?.timestamp ?? null,
    lastAction?.status ?? null,
    memberStatus?.state ?? null,
    memberStatus?.until ?? null,
    Number.isFinite(stats.activityTotalSeconds) ? stats.activityTotalSeconds : null,
    Number.isFinite(stats.xanaxTakenTotal) ? stats.xanaxTakenTotal : null,
    Number.isFinite(battleStats) ? battleStats : null,
    Number.isFinite(battleStats) ? 'verified-api' : null,
    Number.isFinite(battleStats) ? unixNow() : null,
    warnings.length ? `STATS_UNAVAILABLE:${warnings.join(',')}` : null,
    JSON.stringify(rawPayload),
    unixNow()
  ).run();

  return warnings.length ? `STATS_UNAVAILABLE:${warnings.join(',')}` : null;
}

async function getMemberOwnApiKey(env, factionId, playerId) {
  const user = await env.DB.prepare(`
    SELECT api_key_encrypted, api_key_iv
    FROM users
    WHERE player_id = ?
      AND is_disabled = 0
      AND api_key_encrypted IS NOT NULL
      AND api_key_iv IS NOT NULL
    LIMIT 1
  `).bind(playerId).first();

  if (user?.api_key_encrypted && user?.api_key_iv) {
    return decryptText(env.APP_SECRET, user.api_key_encrypted, user.api_key_iv);
  }

  const row = await env.DB.prepare(`
    SELECT config_value
    FROM faction_config
    WHERE faction_id = ? AND config_key = ?
  `).bind(factionId, MANAGED_KEY_CONFIG).first();
  const managed = parseManagedKey(row?.config_value);

  if (managed && Number(managed.playerId) === Number(playerId) && managed.ciphertext && managed.iv) {
    return decryptText(env.APP_SECRET, managed.ciphertext, managed.iv);
  }

  return null;
}

async function requireFactionApiKey(env, factionId, currentUser) {
  const managedRow = await env.DB.prepare(`
    SELECT config_value
    FROM faction_config
    WHERE faction_id = ? AND config_key = ?
  `).bind(factionId, MANAGED_KEY_CONFIG).first();
  const managed = parseManagedKey(managedRow?.config_value);
  if (managed?.ciphertext && managed?.iv) {
    return decryptText(env.APP_SECRET, managed.ciphertext, managed.iv);
  }

  if (
    Number(currentUser.faction_id) === Number(factionId) &&
    currentUser.api_key_encrypted &&
    currentUser.api_key_iv
  ) {
    return decryptText(env.APP_SECRET, currentUser.api_key_encrypted, currentUser.api_key_iv);
  }

  const owner = await env.DB.prepare(`
    SELECT api_key_encrypted, api_key_iv
    FROM users
    WHERE faction_id = ?
      AND is_disabled = 0
      AND api_key_encrypted IS NOT NULL
      AND api_key_iv IS NOT NULL
    ORDER BY is_admin DESC, last_login_at DESC, user_id ASC
    LIMIT 1
  `).bind(factionId).first();

  if (owner?.api_key_encrypted && owner?.api_key_iv) {
    return decryptText(env.APP_SECRET, owner.api_key_encrypted, owner.api_key_iv);
  }

  throw httpError(400, 'No usable API key is configured for this faction.');
}

async function resolveFactionId(db, user, requestedFactionId) {
  let factionId = Number(requestedFactionId || 0);
  if (!factionId) factionId = Number(user.faction_id || 0);
  if (!Number.isSafeInteger(factionId) || factionId <= 0) {
    throw httpError(400, 'A valid faction is required.');
  }

  if (Number(user.is_admin) !== 1 && factionId !== Number(user.faction_id)) {
    throw httpError(403, 'Only administrators can sync another tracked faction.');
  }

  const faction = await db.prepare(`
    SELECT faction_id FROM factions WHERE faction_id = ? AND enabled = 1
  `).bind(factionId).first();
  if (!faction) throw httpError(404, 'That faction is not currently tracked by RWE.');
  return factionId;
}

async function normalizeCurrentOnlyJob(db, jobId) {
  await db.prepare(`
    DELETE FROM faction_sync_tasks
    WHERE job_id = ? AND historical_timestamp IS NOT NULL
  `).bind(jobId).run();

  await db.prepare(`
    UPDATE faction_sync_tasks
    SET status = 'pending', error_text = NULL, updated_at = ?
    WHERE job_id = ? AND historical_timestamp IS NULL AND status = 'failed'
  `).bind(unixNow(), jobId).run();

  await db.prepare(`
    UPDATE faction_sync_jobs
    SET seed_history = 0, trigger_type = 'manual', updated_at = ?
    WHERE job_id = ?
  `).bind(unixNow(), jobId).run();

  await refreshSyncCounts(db, jobId, false);
}

async function refreshSyncCounts(db, jobId, finishWhenEmpty = true) {
  const counts = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM faction_sync_tasks
    WHERE job_id = ?
  `).bind(jobId).first();

  const total = Number(counts?.total || 0);
  const completed = Number(counts?.completed || 0);
  const failed = Number(counts?.failed || 0);
  const pending = Number(counts?.pending || 0);
  const shouldFinish = finishWhenEmpty && total > 0 && pending === 0;
  const now = unixNow();

  await db.prepare(`
    UPDATE faction_sync_jobs
    SET
      tasks_total = ?,
      tasks_completed = ?,
      tasks_failed = ?,
      status = CASE WHEN ? THEN 'completed' ELSE status END,
      phase = CASE WHEN ? THEN 'complete' ELSE phase END,
      finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
      updated_at = ?
    WHERE job_id = ?
  `).bind(
    total,
    completed,
    failed,
    shouldFinish ? 1 : 0,
    shouldFinish ? 1 : 0,
    shouldFinish ? 1 : 0,
    now,
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
  return outputJob(await db.prepare(`
    SELECT * FROM faction_sync_jobs
    WHERE faction_id = ? AND status IN ('queued', 'running')
    ORDER BY job_id DESC LIMIT 1
  `).bind(factionId).first());
}

async function getLatestSync(db, factionId) {
  return outputJob(await db.prepare(`
    SELECT * FROM faction_sync_jobs
    WHERE faction_id = ?
    ORDER BY job_id DESC LIMIT 1
  `).bind(factionId).first());
}

async function getSyncJob(db, jobId) {
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
    seedHistory: false,
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

async function upsertFactionMembers(db, factionId, members, now) {
  const statement = db.prepare(`
    INSERT INTO faction_members (
      faction_id, player_id, player_name, level, position_name, days_in_faction,
      status_json, is_current, first_seen_at, last_seen_at, left_at, updated_at
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
    SELECT player_id FROM faction_members WHERE faction_id = ? AND is_current = 1
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
    return this.request(`/faction/${encodeURIComponent(factionId)}/members?comment=RWEngineFactionSync`);
  }

  factionBasic(factionId) {
    return this.request(`/faction/${encodeURIComponent(factionId)}/basic?comment=RWEngineFactionSync`);
  }

  personalStats(playerId) {
    const query = new URLSearchParams({
      stat: 'timeplayed,xantaken,organizedcrimes',
      comment: 'RWEngineFactionSync'
    });
    return this.request(`/user/${encodeURIComponent(playerId)}/personalstats?${query}`);
  }

  personalStatsCategory(playerId, category) {
    const query = new URLSearchParams({ cat: category, comment: 'RWEngineFactionSync' });
    return this.request(`/user/${encodeURIComponent(playerId)}/personalstats?${query}`);
  }
}

async function fetchTornWithKey(path, apiKey) {
  const response = await fetch(`https://api.torn.com/v2${path}`, {
    headers: { Authorization: `ApiKey ${apiKey}`, Accept: 'application/json' }
  });
  let payload = null;
  try { payload = await response.json(); } catch (_) {}
  if (!response.ok || payload?.error) {
    const message = payload?.error?.error || payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Torn API: ${message}`);
  }
  return payload;
}

function normalizeMembers(payload) {
  const source = payload?.members ?? payload?.faction?.members ?? [];
  const entries = Array.isArray(source)
    ? source.map(member => [member?.id ?? member?.user_id ?? member?.player_id, member])
    : Object.entries(source || {});

  return entries.map(([fallbackId, member]) => ({
    id: Number(member?.id ?? member?.user_id ?? member?.player_id ?? fallbackId),
    name: String(member?.name ?? member?.player_name ?? 'Unknown'),
    level: nullableNumber(member?.level),
    position: String(member?.position?.name ?? member?.position_name ?? member?.position ?? ''),
    daysInFaction: nullableNumber(member?.days_in_faction),
    status: member?.status ?? null,
    lastAction: member?.last_action ?? member?.lastAction ?? null
  })).filter(member => Number.isSafeInteger(member.id) && member.id > 0);
}

function extractFactionName(payload, fallbackId) {
  return String(payload?.name ?? payload?.faction_name ?? payload?.faction?.name ?? payload?.basic?.name ?? `Faction ${fallbackId}`);
}

function extractPersonalStats(payload) {
  const root = payload?.personalstats ?? payload;
  return {
    activityTotalSeconds: extractNumber(findNumericStat(root, ['timeplayed', 'time_played', 'useractivity', 'playing_time'])),
    xanaxTakenTotal: extractNumber(findNumericStat(root, ['xantaken', 'xanax_taken', 'xanaxused', 'xanaxtaken', 'xanax'])),
    organizedCrimesTotal: extractNumber(findNumericStat(root, ['organizedcrimes', 'organized_crimes', 'organisedcrimes', 'organised_crimes']))
  };
}

function mergePersonalStats(...values) {
  const merged = {
    activityTotalSeconds: null,
    xanaxTakenTotal: null,
    organizedCrimesTotal: null
  };
  for (const value of values) {
    if (!value) continue;
    for (const key of Object.keys(merged)) {
      if (!Number.isFinite(merged[key]) && Number.isFinite(value[key])) merged[key] = value[key];
    }
  }
  return merged;
}

function findNumericStat(value, aliases) {
  if (!value || typeof value !== 'object') return null;
  const normalized = aliases.map(normalizeKey);
  const named = normalizeKey(value.name ?? value.stat ?? value.key ?? value.label);
  if (normalized.includes(named)) {
    const parsed = extractNumber(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  for (const [key, child] of Object.entries(value)) {
    if (normalized.includes(normalizeKey(key))) {
      const parsed = extractNumber(child);
      if (Number.isFinite(parsed)) return parsed;
    }
    const nested = findNumericStat(child, normalized);
    if (Number.isFinite(nested)) return nested;
  }
  return null;
}

function extractBattleStatsTotal(payload) {
  const root = payload?.battlestats ?? payload?.battle_stats ?? payload;
  const aliases = ['strength', 'defense', 'speed', 'dexterity'];
  const values = aliases.map(name => extractNumber(root?.[name] ?? findNamedValue(root, name)));
  if (values.some(value => !Number.isFinite(value))) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function findNamedValue(value, name) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (normalizeKey(key) === normalizeKey(name)) return child;
    const nested = findNamedValue(child, name);
    if (nested !== null && nested !== undefined) return nested;
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

async function getCurrentUser(env, request) {
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
  return row;
}

function parseManagedKey(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

async function decryptText(secret, ciphertextBase64, ivBase64) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({
    name: 'PBKDF2',
    salt: encoder.encode('rwengine-v2-api-key-encryption'),
    iterations: 100000,
    hash: 'SHA-256'
  }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
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

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function sha256Hex(value) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
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
