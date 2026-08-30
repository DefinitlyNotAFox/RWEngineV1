const TASK_BATCH_SIZE = 6;
const REQUEST_INTERVAL_MS = 1250;
const LEASE_SECONDS = 180;
const MANAGED_KEY_CONFIG = 'admin_managed_api_key_v1';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') return respond({ success: false, message: 'POST required.' }, 405);
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');
    if (!env.APP_SECRET) throw new Error('Missing APP_SECRET secret.');

    const body = await readJson(request);
    const user = await currentUser(env, request);
    const factionId = await resolveFaction(env.DB, user, body.factionId);
    const action = String(body.action || 'getSyncStatus');

    if (action === 'startSync') return startSync(env, user, factionId);
    if (action === 'getSyncStatus') return syncStatus(env.DB, factionId, body.jobId);
    if (action === 'syncStep') return syncStep(env, user, factionId, body.jobId);
    return respond({ success: false, message: `Unknown sync action: ${action}` }, 400);
  } catch (error) {
    return respond({ success: false, message: error?.message || 'Faction sync failed.' }, error?.status || 500);
  }
}

async function startSync(env, user, factionId) {
  let job = await activeJob(env.DB, factionId);
  if (job) {
    await convertLegacyJob(env.DB, job.jobId);
    return respond({ success: true, message: 'Existing sync converted to current-only collection.', job: await jobById(env.DB, job.jobId) });
  }

  const now = unixNow();
  const result = await env.DB.prepare(`
    INSERT INTO faction_sync_jobs (
      faction_id, requested_by_user_id, trigger_type, status, phase, seed_history, created_at, updated_at
    ) VALUES (?, ?, 'manual', 'queued', 'initializing', 0, ?, ?)
  `).bind(factionId, Number(user.user_id), now, now).run();

  return respond({
    success: true,
    message: 'Current faction baseline queued.',
    job: await jobById(env.DB, Number(result.meta?.last_row_id))
  });
}

async function syncStatus(db, factionId, requestedJobId) {
  const jobId = Number(requestedJobId || 0);
  const job = jobId ? await jobById(db, jobId) : await activeJob(db, factionId) || await latestJob(db, factionId);
  if (job && Number(job.factionId) !== factionId) throw httpError(403, 'That sync job belongs to another faction.');
  return respond({ success: true, job });
}

async function syncStep(env, user, factionId, requestedJobId) {
  const jobId = Number(requestedJobId || 0);
  if (!jobId) throw httpError(400, 'Missing sync job ID.');

  let job = await jobById(env.DB, jobId);
  if (!job) throw httpError(404, 'Sync job not found.');
  if (Number(job.factionId) !== factionId) throw httpError(403, 'That sync job belongs to another faction.');
  if (['completed', 'failed'].includes(job.status)) return respond({ success: true, job });

  await convertLegacyJob(env.DB, jobId);
  job = await jobById(env.DB, jobId);

  const now = unixNow();
  const lease = await env.DB.prepare(`
    UPDATE faction_sync_jobs
    SET lease_until = ?, updated_at = ?
    WHERE job_id = ? AND status IN ('queued','running') AND (lease_until IS NULL OR lease_until < ?)
  `).bind(now + LEASE_SECONDS, now, jobId, now).run();

  if (Number(lease.meta?.changes || 0) === 0) {
    return respond({ success: true, busy: true, job: await jobById(env.DB, jobId) });
  }

  try {
    const factionApiKey = await factionKey(env, factionId, user);
    const client = new TornClient(factionApiKey);

    if (job.phase === 'initializing' || job.status === 'queued') {
      await initializeJob(env, job, client);
      job = await jobById(env.DB, jobId);
    }

    const pending = await env.DB.prepare(`
      SELECT * FROM faction_sync_tasks
      WHERE job_id = ? AND status = 'pending'
      ORDER BY task_id LIMIT ?
    `).bind(jobId, TASK_BATCH_SIZE).all();

    const requestStart = client.requestCount;
    for (const task of pending.results || []) {
      try {
        const warning = await collectSnapshot(env, client, job, task);
        await finishTask(env.DB, Number(task.task_id), 'completed', warning);
      } catch (error) {
        await finishTask(env.DB, Number(task.task_id), 'failed', error?.message || String(error));
      }
    }

    const requests = client.requestCount - requestStart;
    if (requests) {
      await env.DB.prepare(`UPDATE faction_sync_jobs SET api_requests = api_requests + ?, updated_at = ? WHERE job_id = ?`)
        .bind(requests, unixNow(), jobId).run();
    }

    await refreshCounts(env.DB, jobId, true);
    return respond({ success: true, job: await jobById(env.DB, jobId) });
  } catch (error) {
    const failedAt = unixNow();
    await env.DB.prepare(`
      UPDATE faction_sync_jobs
      SET status='failed', phase='failed', error_text=?, finished_at=?, updated_at=?, lease_until=NULL
      WHERE job_id=?
    `).bind(error?.message || String(error), failedAt, failedAt, jobId).run();
    throw error;
  } finally {
    await env.DB.prepare(`UPDATE faction_sync_jobs SET lease_until=NULL WHERE job_id=?`).bind(jobId).run().catch(() => null);
  }
}

async function convertLegacyJob(db, jobId) {
  // Old first-run jobs created 90/30/7/current tasks. RWE now tracks forward only.
  await db.prepare(`DELETE FROM faction_sync_tasks WHERE job_id=? AND historical_timestamp IS NOT NULL`).bind(jobId).run();
  await db.prepare(`
    UPDATE faction_sync_tasks SET status='pending', error_text=NULL, updated_at=?
    WHERE job_id=? AND historical_timestamp IS NULL AND status='failed'
  `).bind(unixNow(), jobId).run();
  await db.prepare(`UPDATE faction_sync_jobs SET seed_history=0, trigger_type='manual', updated_at=? WHERE job_id=?`)
    .bind(unixNow(), jobId).run();
  await refreshCounts(db, jobId, false);
}

async function initializeJob(env, job, client) {
  const factionId = Number(job.factionId);
  const now = unixNow();
  const before = client.requestCount;

  const membersPayload = await client.request(`/faction/${encodeURIComponent(factionId)}/members?comment=RWEngineFactionSync`);
  const basicPayload = await client.request(`/faction/${encodeURIComponent(factionId)}/basic?comment=RWEngineFactionSync`).catch(() => null);
  const members = normalizeMembers(membersPayload);
  if (!members.length) throw new Error('Torn returned no faction members.');

  const factionName = String(basicPayload?.name ?? basicPayload?.faction_name ?? membersPayload?.name ?? `Faction ${factionId}`);
  await env.DB.prepare(`
    INSERT INTO factions (faction_id,faction_name,enabled,created_at,updated_at)
    VALUES (?,?,1,?,?)
    ON CONFLICT(faction_id) DO UPDATE SET faction_name=excluded.faction_name,enabled=1,updated_at=excluded.updated_at
  `).bind(factionId, factionName, now, now).run();

  await upsertMembers(env.DB, factionId, members, now);

  const date = utcDate(now);
  const statement = env.DB.prepare(`
    INSERT OR IGNORE INTO faction_sync_tasks (
      job_id,task_key,player_id,snapshot_date,snapshot_at,historical_timestamp,status,updated_at
    ) VALUES (?,?,?,?,?,NULL,'pending',?)
  `);

  for (let i = 0; i < members.length; i += 50) {
    await env.DB.batch(members.slice(i, i + 50).map(member => statement.bind(
      Number(job.jobId), `snapshot:${member.id}:${date}`, member.id, date, now, now
    )));
  }

  const total = await env.DB.prepare(`SELECT COUNT(*) AS count FROM faction_sync_tasks WHERE job_id=?`)
    .bind(Number(job.jobId)).first();
  await env.DB.prepare(`
    UPDATE faction_sync_jobs
    SET status='running',phase='collecting',seed_history=0,members_total=?,tasks_total=?,
        api_requests=api_requests+?,error_text=NULL,updated_at=?
    WHERE job_id=?
  `).bind(members.length, Number(total?.count || 0), client.requestCount - before, now, Number(job.jobId)).run();
}

async function collectSnapshot(env, client, job, task) {
  const factionId = Number(job.factionId);
  const playerId = Number(task.player_id);
  const member = await env.DB.prepare(`SELECT * FROM faction_members WHERE faction_id=? AND player_id=?`)
    .bind(factionId, playerId).first();
  if (!member) throw new Error(`Unknown faction member ${playerId}.`);

  let payload = await client.personalStats(playerId).catch(() => null);
  let stats = extractPersonalStats(payload);

  if (!Number.isFinite(stats.activityTotalSeconds)) {
    const other = await client.personalStatsCategory(playerId, 'other').catch(() => null);
    stats = mergeStats(stats, extractPersonalStats(other));
    if (!payload && other) payload = other;
  }
  if (!Number.isFinite(stats.xanaxTakenTotal)) {
    const drugs = await client.personalStatsCategory(playerId, 'drugs').catch(() => null);
    stats = mergeStats(stats, extractPersonalStats(drugs));
    if (!payload && drugs) payload = drugs;
  }

  const warnings = [];
  if (!Number.isFinite(stats.activityTotalSeconds)) warnings.push('time played');
  if (!Number.isFinite(stats.xanaxTakenTotal)) warnings.push('Xanax taken');

  const storedStatus = parseJson(member.status_json) || {};
  const lastAction = normalizeLastAction(storedStatus.last_action || storedStatus.lastAction);
  const status = normalizeStatus(storedStatus.status || storedStatus);

  let exactStats = null;
  try {
    const ownKey = await memberOwnKey(env, factionId, playerId);
    if (ownKey) exactStats = extractBattleStats(await fetchWithKey('/user/battlestats?comment=RWEngineVerifiedStats', ownKey));
  } catch (_) {}

  const raw = JSON.stringify({
    personalstats: payload,
    rwe: { organizedCrimesTotal: Number.isFinite(stats.organizedCrimesTotal) ? stats.organizedCrimesTotal : null }
  });

  await env.DB.prepare(`
    INSERT INTO member_snapshots (
      faction_id,player_id,snapshot_date,snapshot_at,player_name,level,position_name,
      last_action_at,last_action_status,status_state,status_until,
      activity_total_seconds,xanax_taken_total,
      battle_stats_estimate,battle_stats_source,battle_stats_observed_at,
      error_text,raw_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(faction_id,player_id,snapshot_date) DO UPDATE SET
      snapshot_at=excluded.snapshot_at,
      player_name=excluded.player_name,
      level=excluded.level,
      position_name=excluded.position_name,
      last_action_at=COALESCE(excluded.last_action_at,member_snapshots.last_action_at),
      last_action_status=COALESCE(excluded.last_action_status,member_snapshots.last_action_status),
      status_state=COALESCE(excluded.status_state,member_snapshots.status_state),
      status_until=COALESCE(excluded.status_until,member_snapshots.status_until),
      activity_total_seconds=COALESCE(excluded.activity_total_seconds,member_snapshots.activity_total_seconds),
      xanax_taken_total=COALESCE(excluded.xanax_taken_total,member_snapshots.xanax_taken_total),
      battle_stats_estimate=COALESCE(excluded.battle_stats_estimate,member_snapshots.battle_stats_estimate),
      battle_stats_source=COALESCE(excluded.battle_stats_source,member_snapshots.battle_stats_source),
      battle_stats_observed_at=COALESCE(excluded.battle_stats_observed_at,member_snapshots.battle_stats_observed_at),
      error_text=excluded.error_text,raw_json=excluded.raw_json,created_at=excluded.created_at
  `).bind(
    factionId, playerId, String(task.snapshot_date), Number(task.snapshot_at),
    String(member.player_name || `Player ${playerId}`), nullableNumber(member.level), member.position_name || null,
    lastAction?.timestamp ?? null, lastAction?.status ?? null, status?.state ?? null, status?.until ?? null,
    Number.isFinite(stats.activityTotalSeconds) ? stats.activityTotalSeconds : null,
    Number.isFinite(stats.xanaxTakenTotal) ? stats.xanaxTakenTotal : null,
    Number.isFinite(exactStats) ? exactStats : null,
    Number.isFinite(exactStats) ? 'verified-api' : null,
    Number.isFinite(exactStats) ? unixNow() : null,
    warnings.length ? `STATS_UNAVAILABLE:${warnings.join(',')}` : null,
    raw, unixNow()
  ).run();

  return warnings.length ? `STATS_UNAVAILABLE:${warnings.join(',')}` : null;
}

class TornClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.lastRequestAt = 0;
    this.requestCount = 0;
  }

  async request(path, attempt = 1) {
    const wait = REQUEST_INTERVAL_MS - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
    this.requestCount++;

    let response;
    try {
      response = await fetch(`https://api.torn.com/v2${path}`, {
        headers: { Authorization: `ApiKey ${this.apiKey}`, Accept: 'application/json' }
      });
    } catch (error) {
      if (attempt <= 2) { await sleep(1500 * attempt); return this.request(path, attempt + 1); }
      throw error;
    }

    let data = null;
    try { data = await response.json(); } catch (_) {}
    const code = Number(data?.error?.code ?? data?.error?.error_code ?? 0);
    if (response.ok && !data?.error) return data;
    if (code === 5 && attempt <= 2) { await sleep(65000); return this.request(path, attempt + 1); }
    if ((response.status === 429 || response.status >= 500) && attempt <= 2) {
      await sleep(1500 * 2 ** (attempt - 1));
      return this.request(path, attempt + 1);
    }
    throw new Error(`Torn API${code ? ` ${code}` : ''}: ${data?.error?.error || data?.error?.message || `HTTP ${response.status}`}`);
  }

  personalStats(playerId) {
    const q = new URLSearchParams({ stat: 'timeplayed,xantaken,organizedcrimes', comment: 'RWEngineFactionSync' });
    return this.request(`/user/${encodeURIComponent(playerId)}/personalstats?${q}`);
  }

  personalStatsCategory(playerId, cat) {
    const q = new URLSearchParams({ cat, comment: 'RWEngineFactionSync' });
    return this.request(`/user/${encodeURIComponent(playerId)}/personalstats?${q}`);
  }
}

async function factionKey(env, factionId, user) {
  const managedRow = await env.DB.prepare(`SELECT config_value FROM faction_config WHERE faction_id=? AND config_key=?`)
    .bind(factionId, MANAGED_KEY_CONFIG).first();
  const managed = parseJson(managedRow?.config_value);
  if (managed?.ciphertext && managed?.iv) return decrypt(env.APP_SECRET, managed.ciphertext, managed.iv);

  if (Number(user.faction_id) === factionId && user.api_key_encrypted && user.api_key_iv) {
    return decrypt(env.APP_SECRET, user.api_key_encrypted, user.api_key_iv);
  }

  const owner = await env.DB.prepare(`
    SELECT api_key_encrypted,api_key_iv FROM users
    WHERE faction_id=? AND is_disabled=0 AND api_key_encrypted IS NOT NULL AND api_key_iv IS NOT NULL
    ORDER BY is_admin DESC,last_login_at DESC,user_id ASC LIMIT 1
  `).bind(factionId).first();
  if (owner?.api_key_encrypted && owner?.api_key_iv) return decrypt(env.APP_SECRET, owner.api_key_encrypted, owner.api_key_iv);
  throw httpError(400, 'No usable API key is configured for this faction.');
}

async function memberOwnKey(env, factionId, playerId) {
  const user = await env.DB.prepare(`
    SELECT api_key_encrypted,api_key_iv FROM users
    WHERE player_id=? AND is_disabled=0 AND api_key_encrypted IS NOT NULL AND api_key_iv IS NOT NULL LIMIT 1
  `).bind(playerId).first();
  if (user?.api_key_encrypted && user?.api_key_iv) return decrypt(env.APP_SECRET, user.api_key_encrypted, user.api_key_iv);

  const row = await env.DB.prepare(`SELECT config_value FROM faction_config WHERE faction_id=? AND config_key=?`)
    .bind(factionId, MANAGED_KEY_CONFIG).first();
  const managed = parseJson(row?.config_value);
  if (Number(managed?.playerId) === playerId && managed?.ciphertext && managed?.iv) {
    return decrypt(env.APP_SECRET, managed.ciphertext, managed.iv);
  }
  return null;
}

async function fetchWithKey(path, apiKey) {
  const response = await fetch(`https://api.torn.com/v2${path}`, {
    headers: { Authorization: `ApiKey ${apiKey}`, Accept: 'application/json' }
  });
  let data = null;
  try { data = await response.json(); } catch (_) {}
  if (!response.ok || data?.error) throw new Error(data?.error?.error || data?.error?.message || `HTTP ${response.status}`);
  return data;
}

async function resolveFaction(db, user, requested) {
  let id = Number(requested || 0) || Number(user.faction_id || 0);
  if (!Number.isSafeInteger(id) || id <= 0) throw httpError(400, 'A valid faction is required.');
  if (Number(user.is_admin) !== 1 && id !== Number(user.faction_id)) throw httpError(403, 'Admin access required for another faction.');
  const row = await db.prepare(`SELECT faction_id FROM factions WHERE faction_id=? AND enabled=1`).bind(id).first();
  if (!row) throw httpError(404, 'That faction is not tracked by RWE.');
  return id;
}

async function currentUser(env, request) {
  const token = cookie(request, 'rwengine_session');
  if (!token) throw httpError(401, 'Not logged in.');
  const hash = await sha256(token);
  const user = await env.DB.prepare(`
    SELECT u.user_id,u.player_id,u.player_name,u.faction_id,u.faction_name,u.api_key_encrypted,u.api_key_iv,u.is_admin,u.is_disabled
    FROM sessions s JOIN users u ON u.user_id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?
  `).bind(hash, unixNow()).first();
  if (!user) throw httpError(401, 'Session expired or invalid.');
  if (Number(user.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  return user;
}

async function upsertMembers(db, factionId, members, now) {
  const statement = db.prepare(`
    INSERT INTO faction_members (
      faction_id,player_id,player_name,level,position_name,days_in_faction,status_json,
      is_current,first_seen_at,last_seen_at,left_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,1,?,?,NULL,?)
    ON CONFLICT(faction_id,player_id) DO UPDATE SET
      player_name=excluded.player_name,level=excluded.level,position_name=excluded.position_name,
      days_in_faction=excluded.days_in_faction,status_json=excluded.status_json,is_current=1,
      last_seen_at=excluded.last_seen_at,left_at=NULL,updated_at=excluded.updated_at
  `);
  for (let i = 0; i < members.length; i += 50) {
    await db.batch(members.slice(i, i + 50).map(m => statement.bind(
      factionId,m.id,m.name,m.level,m.position,m.daysInFaction,
      JSON.stringify({ status: m.status, last_action: m.lastAction }),now,now,now
    )));
  }

  const ids = new Set(members.map(m => Number(m.id)));
  const existing = await db.prepare(`SELECT player_id FROM faction_members WHERE faction_id=? AND is_current=1`).bind(factionId).all();
  const left = (existing.results || []).map(r => Number(r.player_id)).filter(id => !ids.has(id));
  if (left.length) {
    const leave = db.prepare(`UPDATE faction_members SET is_current=0,left_at=COALESCE(left_at,?),updated_at=? WHERE faction_id=? AND player_id=?`);
    for (let i = 0; i < left.length; i += 50) {
      await db.batch(left.slice(i, i + 50).map(id => leave.bind(now,now,factionId,id)));
    }
  }
}

async function refreshCounts(db, jobId, finish) {
  const c = await db.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending
    FROM faction_sync_tasks WHERE job_id=?
  `).bind(jobId).first();
  const total = Number(c?.total || 0), completed = Number(c?.completed || 0), failed = Number(c?.failed || 0), pending = Number(c?.pending || 0);
  const done = Boolean(finish && total > 0 && pending === 0);
  const now = unixNow();
  await db.prepare(`
    UPDATE faction_sync_jobs SET tasks_total=?,tasks_completed=?,tasks_failed=?,
      status=CASE WHEN ? THEN 'completed' ELSE status END,
      phase=CASE WHEN ? THEN 'complete' ELSE phase END,
      finished_at=CASE WHEN ? THEN ? ELSE finished_at END,updated_at=?
    WHERE job_id=?
  `).bind(total,completed,failed,done?1:0,done?1:0,done?1:0,now,now,jobId).run();
}

async function finishTask(db, id, status, error) {
  await db.prepare(`UPDATE faction_sync_tasks SET status=?,attempts=attempts+1,error_text=?,updated_at=? WHERE task_id=?`)
    .bind(status,error || null,unixNow(),id).run();
}

async function activeJob(db, factionId) {
  return formatJob(await db.prepare(`SELECT * FROM faction_sync_jobs WHERE faction_id=? AND status IN ('queued','running') ORDER BY job_id DESC LIMIT 1`).bind(factionId).first());
}
async function latestJob(db, factionId) {
  return formatJob(await db.prepare(`SELECT * FROM faction_sync_jobs WHERE faction_id=? ORDER BY job_id DESC LIMIT 1`).bind(factionId).first());
}
async function jobById(db, id) {
  return formatJob(await db.prepare(`SELECT * FROM faction_sync_jobs WHERE job_id=?`).bind(id).first());
}
function formatJob(row) {
  if (!row) return null;
  return {
    jobId:Number(row.job_id),factionId:Number(row.faction_id),requestedByUserId:Number(row.requested_by_user_id),
    triggerType:row.trigger_type,status:row.status,phase:row.phase,seedHistory:false,
    membersTotal:Number(row.members_total||0),tasksTotal:Number(row.tasks_total||0),
    tasksCompleted:Number(row.tasks_completed||0),tasksFailed:Number(row.tasks_failed||0),apiRequests:Number(row.api_requests||0),
    createdAt:Number(row.created_at||0),updatedAt:Number(row.updated_at||0),finishedAt:Number(row.finished_at||0)||null,error:row.error_text||null
  };
}

function normalizeMembers(payload) {
  const source = payload?.members ?? payload?.faction?.members ?? [];
  const entries = Array.isArray(source) ? source.map(m => [m?.id ?? m?.user_id ?? m?.player_id,m]) : Object.entries(source || {});
  return entries.map(([fallback,m]) => ({
    id:Number(m?.id ?? m?.user_id ?? m?.player_id ?? fallback),name:String(m?.name ?? m?.player_name ?? 'Unknown'),
    level:nullableNumber(m?.level),position:String(m?.position?.name ?? m?.position_name ?? m?.position ?? ''),
    daysInFaction:nullableNumber(m?.days_in_faction),status:m?.status ?? null,lastAction:m?.last_action ?? m?.lastAction ?? null
  })).filter(m => Number.isSafeInteger(m.id) && m.id > 0);
}

function extractPersonalStats(payload) {
  const root = payload?.personalstats ?? payload;
  return {
    activityTotalSeconds: numberFrom(findStat(root,['timeplayed','time_played','useractivity','playing_time'])),
    xanaxTakenTotal: numberFrom(findStat(root,['xantaken','xanax_taken','xanaxused','xanaxtaken','xanax'])),
    organizedCrimesTotal: numberFrom(findStat(root,['organizedcrimes','organized_crimes','organisedcrimes','organised_crimes']))
  };
}
function mergeStats(a,b) {
  return {
    activityTotalSeconds:Number.isFinite(a.activityTotalSeconds)?a.activityTotalSeconds:b.activityTotalSeconds,
    xanaxTakenTotal:Number.isFinite(a.xanaxTakenTotal)?a.xanaxTakenTotal:b.xanaxTakenTotal,
    organizedCrimesTotal:Number.isFinite(a.organizedCrimesTotal)?a.organizedCrimesTotal:b.organizedCrimesTotal
  };
}
function findStat(value, aliases) {
  if (!value || typeof value !== 'object') return null;
  const wanted = aliases.map(norm);
  for (const [key,child] of Object.entries(value)) {
    if (wanted.includes(norm(key))) return child;
    const nested = findStat(child,wanted);
    if (nested !== null && nested !== undefined) return nested;
  }
  return null;
}
function extractBattleStats(payload) {
  const root = payload?.battlestats ?? payload?.battle_stats ?? payload;
  const values = ['strength','defense','speed','dexterity'].map(name => numberFrom(root?.[name] ?? findStat(root,[name])));
  return values.every(Number.isFinite) ? values.reduce((sum,v) => sum + v,0) : null;
}
function numberFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') { const n=Number(value.replace(/,/g,'')); return Number.isFinite(n)?n:null; }
  if (value && typeof value === 'object') {
    for (const key of ['value','amount','total','current','time','count']) {
      const n=numberFrom(value[key]); if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
function normalizeLastAction(value) {
  if (!value || typeof value !== 'object') return null;
  return { timestamp:nullableNumber(value.timestamp ?? value.time ?? value.at), status:String(value.status ?? value.relative ?? value.text ?? '') || null };
}
function normalizeStatus(value) {
  if (!value) return null;
  if (typeof value === 'string') return { state:value,until:null };
  return { state:String(value.state ?? value.status ?? value.description ?? '') || null, until:nullableNumber(value.until ?? value.until_timestamp ?? value.timestamp) };
}

async function decrypt(secret,ciphertextBase64,ivBase64) {
  const enc=new TextEncoder();
  const material=await crypto.subtle.importKey('raw',enc.encode(secret),'PBKDF2',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt:enc.encode('rwengine-v2-api-key-encryption'),iterations:100000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['decrypt']);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:base64Bytes(ivBase64)},key,base64Bytes(ciphertextBase64));
  return new TextDecoder().decode(plain);
}
function base64Bytes(value) { const s=atob(String(value||'')); const out=new Uint8Array(s.length); for(let i=0;i<s.length;i++)out[i]=s.charCodeAt(i); return out; }
function cookie(request,name) { for(const part of (request.headers.get('Cookie')||'').split(';')) { const [k,...rest]=part.trim().split('='); if(k===name)return decodeURIComponent(rest.join('=')); } return null; }
async function sha256(value) { const h=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value)))); return [...h].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function parseJson(value) { if(!value)return null; try{return typeof value==='string'?JSON.parse(value):value;}catch(_){return null;} }
function norm(value) { return String(value||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function nullableNumber(value) { if(value===null||value===undefined||value==='')return null; const n=Number(value); return Number.isFinite(n)?n:null; }
function utcDate(timestamp) { return new Date(Number(timestamp)*1000).toISOString().slice(0,10); }
function unixNow() { return Math.floor(Date.now()/1000); }
function sleep(ms) { return new Promise(resolve=>setTimeout(resolve,ms)); }
async function readJson(request) { try{return await request.json();}catch(_){return {};} }
function httpError(status,message) { const error=new Error(message); error.status=status; return error; }
function respond(data,status=200) { return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}}); }
