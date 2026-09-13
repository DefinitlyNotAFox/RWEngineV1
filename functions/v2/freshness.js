const INTEL_STALE_AFTER = 36 * 60 * 60;

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

    const roster = await env.DB.prepare(
      'SELECT MAX(updated_at) AS observed_at, COUNT(*) AS member_count FROM faction_members WHERE faction_id = ? AND is_current = 1'
    ).bind(factionId).first();

    const snapshots = await env.DB.prepare(
      'SELECT MIN(snapshot_at) AS first_at, MAX(snapshot_at) AS observed_at FROM member_snapshots WHERE faction_id = ?'
    ).bind(factionId).first();

    const completedSync = await env.DB.prepare(
      "SELECT job_id, status, phase, finished_at, updated_at FROM faction_sync_jobs WHERE faction_id = ? AND status = 'completed' ORDER BY COALESCE(finished_at, updated_at, created_at) DESC LIMIT 1"
    ).bind(factionId).first();

    const activeSync = await env.DB.prepare(
      "SELECT job_id, status, phase, tasks_total, tasks_completed, tasks_failed, updated_at FROM faction_sync_jobs WHERE faction_id = ? AND status IN ('queued', 'running') ORDER BY job_id DESC LIMIT 1"
    ).bind(factionId).first();

    const wars = await env.DB.prepare(
      'SELECT COUNT(*) AS war_count, MAX(updated_at) AS observed_at, MAX(COALESCE(end_timestamp, start_timestamp, imported_at, 0)) AS latest_war_at FROM wars WHERE faction_id = ?'
    ).bind(factionId).first();

    const attackDetails = await env.DB.prepare(
      'SELECT MAX(synced_at) AS observed_at FROM war_log WHERE faction_id = ? AND attack_detail_complete = 1'
    ).bind(factionId).first();

    const rosterAt = nullableNumber(roster?.observed_at);
    const snapshotAt = nullableNumber(snapshots?.observed_at);
    const lastSuccessfulSyncAt = nullableNumber(completedSync?.finished_at || completedSync?.updated_at);
    const intelObservedAt = maxTimestamp(rosterAt, snapshotAt, lastSuccessfulSyncAt);
    const intelAge = intelObservedAt ? Math.max(0, now - intelObservedAt) : null;

    const archiveObservedAt = nullableNumber(wars?.observed_at);
    const attackObservedAt = nullableNumber(attackDetails?.observed_at);

    return json({
      success: true,
      generatedAt: now,
      factionId,
      datasets: {
        intel: {
          state: activeSync
            ? 'syncing'
            : !intelObservedAt
              ? 'empty'
              : intelAge > INTEL_STALE_AFTER
                ? 'stale'
                : 'fresh',
          observedAt: intelObservedAt,
          ageSeconds: intelAge,
          staleAfterSeconds: INTEL_STALE_AFTER,
          rosterObservedAt: rosterAt,
          snapshotFirstAt: nullableNumber(snapshots?.first_at),
          snapshotObservedAt: snapshotAt,
          lastSuccessfulSyncAt,
          memberCount: Number(roster?.member_count || 0),
          activeSync: activeSync ? {
            jobId: Number(activeSync.job_id),
            status: activeSync.status,
            phase: activeSync.phase,
            tasksTotal: Number(activeSync.tasks_total || 0),
            tasksCompleted: Number(activeSync.tasks_completed || 0),
            tasksFailed: Number(activeSync.tasks_failed || 0),
            updatedAt: nullableNumber(activeSync.updated_at)
          } : null
        },
        wars: {
          state: Number(wars?.war_count || 0) > 0 ? 'current' : 'empty',
          observedAt: archiveObservedAt,
          ageSeconds: archiveObservedAt ? Math.max(0, now - archiveObservedAt) : null,
          attackObservedAt,
          warCount: Number(wars?.war_count || 0),
          latestWarAt: nullableNumber(wars?.latest_war_at)
        }
      }
    });
  } catch (error) {
    return json(
      { success: false, message: error?.message || 'Unexpected freshness error.' },
      error?.status || 500
    );
  }
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

function maxTimestamp(...values) {
  const valid = values.filter(value => Number.isFinite(value) && value > 0);
  return valid.length ? Math.max(...valid) : null;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  try {
    return await request.json();
  } catch (_) {
    throw httpError(400, 'Invalid JSON body.');
  }
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
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0'
    }
  });
}
