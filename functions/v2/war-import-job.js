import { onRequest as onLegacyApiRequest } from '../api.js';
import { onRequest as onAdminImportRequest } from './war-import-admin.js';
import { onRequest as onAttackDetailRequest } from './war-attack-detail.js';

const JOB_PREFIX = 'war_import_job_v1';
const ACTIVE_STALE_SECONDS = 300;
const ATTACK_PAGE_LIMIT = 40;

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') {
      return json({ success:false, message:'Method not allowed. Use POST.' }, 405);
    }
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');
    if (!env.APP_SECRET) throw new Error('Missing APP_SECRET secret.');

    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const factionId = await resolveFactionId(env.DB, user, body.factionId);
    const action = String(body.action || 'status');
    const cookieHeader = String(request.headers.get('Cookie') || '');
    const requestUrl = request.url;

    if (action === 'startBatch') {
      const rankIds = uniqueIds(body.rankIds);
      if (!rankIds.length) throw httpError(400, 'Enter at least one ranked war report ID.');
      if (rankIds.length > 10) throw httpError(400, 'Import up to 10 reports at a time.');

      const overwrite = body.overwrite === true;
      const jobs = [];
      const runnable = [];

      for (const rankId of rankIds) {
        const existing = await loadJob(env.DB, factionId, rankId);
        if (isActive(existing)) {
          jobs.push(publicJob(existing));
          continue;
        }

        const job = {
          version:1,
          factionId,
          rankId,
          overwrite,
          requestedByUserId:Number(user.user_id),
          requestedByPlayerId:Number(user.player_id || 0) || null,
          status:'queued',
          phase:'queued',
          message:'Queued for background import.',
          warId:null,
          processedTotal:0,
          assists:0,
          chainStatus:null,
          createdAt:unixNow(),
          startedAt:null,
          finishedAt:null,
          updatedAt:unixNow()
        };
        await saveJob(env.DB, job);
        jobs.push(publicJob(job));
        runnable.push(job);
      }

      if (runnable.length) {
        const task = runBatch({
          env,
          user,
          factionId,
          jobs:runnable,
          cookieHeader,
          requestUrl
        });
        if (typeof context.waitUntil === 'function') context.waitUntil(task);
        else void task;
      }

      return json({
        success:true,
        background:true,
        message:runnable.length
          ? 'Import started in the background.'
          : 'Those reports are already being imported.',
        jobs
      });
    }

    if (action === 'status') {
      const rankIds = uniqueIds(body.rankIds);
      const jobs = rankIds.length
        ? await Promise.all(rankIds.map(rankId => loadJob(env.DB, factionId, rankId)))
        : await listRecentJobs(env.DB, factionId);

      return json({
        success:true,
        jobs:jobs.filter(Boolean).map(publicJob)
      });
    }

    throw httpError(400, 'Unknown import job action: ' + action);
  } catch (error) {
    return json(
      { success:false, message:error?.message || 'Unexpected background import error.' },
      error?.status || 500
    );
  }
}

async function runBatch({ env, user, factionId, jobs, cookieHeader, requestUrl }) {
  for (const job of jobs) {
    try {
      await runImportJob({ env, user, factionId, job, cookieHeader, requestUrl });
    } catch (error) {
      job.status = 'failed';
      job.phase = job.phase || 'import';
      job.message = error?.message || 'Background import failed.';
      job.finishedAt = unixNow();
      job.updatedAt = unixNow();
      await saveJob(env.DB, job).catch(() => {});
    }
  }
}

async function runImportJob({ env, user, factionId, job, cookieHeader, requestUrl }) {
  job.status = 'running';
  job.phase = 'checking';
  job.message = 'Checking existing import.';
  job.startedAt = job.startedAt || unixNow();
  job.updatedAt = unixNow();
  await saveJob(env.DB, job);

  const adminPath = Number(user.is_admin) === 1;
  const status = await invokeImportAction({
    env, adminPath, cookieHeader, requestUrl, factionId,
    action:'checkImportStatus',
    payload:{ rankId:job.rankId }
  });

  let warId = null;
  let chainStatus = null;

  if (status.exists && !job.overwrite) {
    const existingWar = status.war || {};
    warId = String(existingWar.war_id || existingWar.warId || job.rankId);
    job.warId = warId;

    if (Number(existingWar.attack_detail_complete ?? existingWar.attackDetailComplete ?? 0) === 1) {
      job.status = 'completed';
      job.phase = 'complete';
      job.message = 'Already imported and verified.';
      job.finishedAt = unixNow();
      job.updatedAt = unixNow();
      await saveJob(env.DB, job);
      return;
    }

    job.phase = 'verification';
    job.message = 'Resuming attack verification.';
    job.updatedAt = unixNow();
    await saveJob(env.DB, job);
  } else {
    job.phase = 'report';
    job.message = 'Importing ranked-war report.';
    job.updatedAt = unixNow();
    await saveJob(env.DB, job);

    const imported = await invokeImportAction({
      env, adminPath, cookieHeader, requestUrl, factionId,
      action:'importRankedWarReport',
      payload:{ rankId:job.rankId, overwrite:job.overwrite }
    });

    const importedWar = imported.war || {};
    warId = String(importedWar.warId || importedWar.war_id || job.rankId);
    job.warId = warId;
    chainStatus = String(imported.chainAdjustment?.status || '').toLowerCase() || null;
    job.chainStatus = chainStatus;

    if (imported.skipped) {
      const refreshed = await invokeImportAction({
        env, adminPath, cookieHeader, requestUrl, factionId,
        action:'checkImportStatus',
        payload:{ rankId:job.rankId }
      });
      if (Number(refreshed.war?.attack_detail_complete ?? refreshed.war?.attackDetailComplete ?? 0) === 1) {
        job.status = 'completed';
        job.phase = 'complete';
        job.message = 'Already imported and verified.';
        job.finishedAt = unixNow();
        job.updatedAt = unixNow();
        await saveJob(env.DB, job);
        return;
      }
    }

    job.phase = 'verification';
    job.message = 'Verifying attack detail.';
    job.updatedAt = unixNow();
    await saveJob(env.DB, job);
  }

  const verified = await runAttackVerification({
    env,
    factionId,
    warId,
    cookieHeader,
    requestUrl,
    onProgress:async result => {
      job.processedTotal = Number(result.processedTotal ?? result.storedTotal ?? job.processedTotal ?? 0);
      job.assists = Number(result.assists ?? job.assists ?? 0);
      job.phase = 'verification';
      job.message = job.processedTotal
        ? `${job.processedTotal} attacks processed.`
        : 'Verifying attack detail.';
      job.updatedAt = unixNow();
      await saveJob(env.DB, job);
    }
  });

  job.processedTotal = Number(verified.processedTotal ?? verified.storedTotal ?? job.processedTotal ?? 0);
  job.assists = Number(verified.assists ?? job.assists ?? 0);

  let warState = await readWarProcessingState(env.DB, factionId, warId);
  const needsChainCheck =
    !warState?.chain_adjusted_at ||
    ['error','failed'].includes(String(warState?.chain_adjustment_status || '').toLowerCase());

  if (needsChainCheck) {
    job.phase = 'chain';
    job.message = 'Checking chain report.';
    job.updatedAt = unixNow();
    await saveJob(env.DB, job);

    const chainResult = await invokeImportAction({
      env, adminPath, cookieHeader, requestUrl, factionId,
      action:'applyChainBonusAdjustment',
      payload:{ warId }
    });
    chainStatus = String(chainResult.chainAdjustment?.status || '').toLowerCase() || null;
    job.chainStatus = chainStatus;
    warState = await readWarProcessingState(env.DB, factionId, warId);
  }

  const finalChainStatus = String(
    warState?.chain_adjustment_status || chainStatus || ''
  ).toLowerCase();
  const chainFinished = Boolean(
    warState?.chain_adjusted_at ||
    ['applied','skipped','complete','completed','done'].includes(finalChainStatus)
  );

  if (!chainFinished || ['error','failed'].includes(finalChainStatus)) {
    job.status = 'failed';
    job.phase = 'chain';
    job.message = warState?.chain_adjustment_message ||
      'Attack verification finished, but chain processing did not complete.';
  } else {
    job.status = 'completed';
    job.phase = 'complete';
    job.message = `${job.processedTotal} attacks verified. Import complete.`;
  }

  job.finishedAt = unixNow();
  job.updatedAt = unixNow();
  await saveJob(env.DB, job);
}

async function readWarProcessingState(db, factionId, warId) {
  return db.prepare(`
    SELECT chain_adjusted_at, chain_adjustment_status, chain_adjustment_message
    FROM wars
    WHERE faction_id = ? AND war_id = ?
    LIMIT 1
  `).bind(factionId, warId).first();
}

async function runAttackVerification({ env, factionId, warId, cookieHeader, requestUrl, onProgress }) {
  let latest = null;

  for (let page = 0; page < ATTACK_PAGE_LIMIT; page += 1) {
    const result = await invokeAttackDetail({
      env, factionId, warId, cookieHeader, requestUrl, finalize:false
    });
    latest = result;
    await onProgress?.(result);

    if (result.done) {
      const finalized = await invokeAttackDetail({
        env, factionId, warId, cookieHeader, requestUrl, finalize:true
      });
      await onProgress?.(finalized);
      return finalized;
    }
  }

  throw new Error(`Attack verification exceeded ${ATTACK_PAGE_LIMIT} pages.`);
}

async function invokeImportAction({
  env, adminPath, cookieHeader, requestUrl, factionId, action, payload
}) {
  const handler = adminPath ? onAdminImportRequest : onLegacyApiRequest;
  const body = adminPath
    ? { action, factionId, ...payload }
    : { action, ...payload };

  return invokeHandler(handler, {
    env,
    requestUrl,
    cookieHeader,
    body
  });
}

async function invokeAttackDetail({
  env, factionId, warId, cookieHeader, requestUrl, finalize
}) {
  const headers = { 'Content-Type':'application/json' };
  if (env.CRON_SECRET) headers['X-RWE-Cron-Secret'] = String(env.CRON_SECRET);
  else if (cookieHeader) headers.Cookie = cookieHeader;

  return invokeHandler(onAttackDetailRequest, {
    env,
    requestUrl,
    headers,
    body:{
      factionId,
      warId,
      ...(finalize ? { finalize:true } : {})
    }
  });
}

async function invokeHandler(handler, {
  env, requestUrl, cookieHeader = '', headers = null, body
}) {
  const url = new URL(requestUrl);
  const requestHeaders = headers || {
    'Content-Type':'application/json',
    ...(cookieHeader ? { Cookie:cookieHeader } : {})
  };

  const response = await handler({
    request:new Request(url.origin + '/internal-background-import', {
      method:'POST',
      headers:requestHeaders,
      body:JSON.stringify(body)
    }),
    env,
    waitUntil:() => {}
  });

  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error(`Background import returned HTTP ${response.status} without JSON.`); }

  if (!response.ok || data?.success === false) {
    const error = new Error(data?.message || `Background import failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function jobKey(factionId, rankId) {
  return `${JOB_PREFIX}:${factionId}:${rankId}`;
}

async function loadJob(db, factionId, rankId) {
  const row = await db.prepare(
    'SELECT value, updated_at FROM app_meta WHERE key = ? LIMIT 1'
  ).bind(jobKey(factionId, rankId)).first();
  if (!row?.value) return null;
  try {
    const job = JSON.parse(String(row.value));
    if (!job || typeof job !== 'object') return null;
    job.updatedAt = Number(job.updatedAt || row.updated_at || 0);
    return job;
  } catch (_) {
    return null;
  }
}

async function listRecentJobs(db, factionId) {
  const result = await db.prepare(`
    SELECT value, updated_at
    FROM app_meta
    WHERE key LIKE ?
    ORDER BY updated_at DESC
    LIMIT 20
  `).bind(`${JOB_PREFIX}:${factionId}:%`).all();

  return (result.results || []).map(row => {
    try {
      const job = JSON.parse(String(row.value || ''));
      if (!job || typeof job !== 'object') return null;
      job.updatedAt = Number(job.updatedAt || row.updated_at || 0);
      return job;
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

async function saveJob(db, job) {
  job.updatedAt = Number(job.updatedAt || unixNow());
  await db.prepare(`
    INSERT INTO app_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).bind(
    jobKey(job.factionId, job.rankId),
    JSON.stringify(job),
    job.updatedAt
  ).run();
}

function publicJob(job) {
  const stale = isStaleActive(job);
  return {
    factionId:Number(job.factionId),
    rankId:String(job.rankId),
    warId:job.warId ? String(job.warId) : null,
    status:stale ? 'stalled' : String(job.status || 'queued'),
    phase:stale ? 'incomplete' : String(job.phase || 'queued'),
    message:stale
      ? 'Import did not finish. Start it again to resume.'
      : String(job.message || ''),
    processedTotal:Number(job.processedTotal || 0),
    assists:Number(job.assists || 0),
    chainStatus:job.chainStatus || null,
    createdAt:Number(job.createdAt || 0) || null,
    startedAt:Number(job.startedAt || 0) || null,
    finishedAt:Number(job.finishedAt || 0) || null,
    updatedAt:Number(job.updatedAt || 0) || null
  };
}

function isActive(job) {
  return Boolean(
    job &&
    ['queued','running'].includes(String(job.status || '')) &&
    !isStaleActive(job)
  );
}

function isStaleActive(job) {
  if (!job || !['queued','running'].includes(String(job.status || ''))) return false;
  const updatedAt = Number(job.updatedAt || 0);
  return updatedAt > 0 && unixNow() - updatedAt > ACTIVE_STALE_SECONDS;
}

function uniqueIds(values) {
  const source = Array.isArray(values) ? values : [];
  return [...new Set(
    source
      .map(value => String(value ?? '').trim())
      .filter(value => value && value.length <= 128)
  )];
}

async function resolveFactionId(db, user, requestedValue) {
  const accountFactionId = Number(user.faction_id || 0);
  const requestedFactionId = Number(requestedValue || accountFactionId);

  if (!Number.isSafeInteger(requestedFactionId) || requestedFactionId <= 0) {
    throw httpError(400, 'A valid faction ID is required.');
  }
  if (requestedFactionId !== accountFactionId && Number(user.is_admin) !== 1) {
    throw httpError(403, 'Platform-admin access is required for another faction.');
  }

  const faction = await db.prepare(
    'SELECT faction_id FROM factions WHERE faction_id = ? AND enabled = 1 LIMIT 1'
  ).bind(requestedFactionId).first();
  if (!faction) throw httpError(404, 'That faction is not tracked by RWEngine.');
  return requestedFactionId;
}

async function getCurrentUser(env, request) {
  const token = cookie(request, 'rwengine_session');
  if (!token) throw httpError(401, 'Not logged in.');
  const tokenHash = await sha256(token);
  const user = await env.DB.prepare(`
    SELECT
      u.user_id, u.player_id, u.player_name, u.faction_id, u.faction_name,
      u.is_admin, u.is_disabled
    FROM sessions s
    JOIN users u ON u.user_id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, unixNow()).first();

  if (!user) throw httpError(401, 'Session expired or invalid.');
  if (Number(user.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  return user;
}

function cookie(request, name) {
  const source = request.headers.get('Cookie') || '';
  for (const part of source.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}

async function sha256(value) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)))
  );
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
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
    headers:{
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store'
    }
  });
}
