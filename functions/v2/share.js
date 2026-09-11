export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');

    await ensureShareSchema(env.DB);

    if (request.method === 'GET') {
      return handlePublicShare(context);
    }

    if (request.method !== 'POST') {
      return json({ success: false, message: 'Method not allowed.' }, 405);
    }

    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const factionId = await resolveFactionId(env.DB, user, body.factionId);
    const action = String(body.action || 'status');

    if (action === 'create') return createShare(env.DB, request, user, factionId, body);
    if (action === 'status') return shareStatus(env.DB, user, factionId, body);
    if (action === 'revoke') return revokeShare(env.DB, user, factionId, body);

    return json({ success: false, message: `Unknown share action: ${action}` }, 400);
  } catch (error) {
    return json(
      { success: false, message: error?.message || 'Unexpected share-link error.' },
      error?.status || 500
    );
  }
}

async function createShare(db, request, user, factionId, body) {
  const resource = normalizeResource(body);
  await assertResourceExists(db, factionId, resource);

  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = unixNow();

  await db.prepare(`
    INSERT INTO share_links (
      owner_user_id, faction_id, resource_type, resource_key,
      token_hash, is_enabled, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(owner_user_id, faction_id, resource_type, resource_key)
    DO UPDATE SET
      token_hash = excluded.token_hash,
      is_enabled = 1,
      updated_at = excluded.updated_at,
      last_accessed_at = NULL
  `).bind(
    Number(user.user_id),
    factionId,
    resource.type,
    resource.key,
    tokenHash,
    now,
    now
  ).run();

  const row = await findOwnedShare(db, user.user_id, factionId, resource);
  const shareUrl = new URL('/share/', request.url);
  shareUrl.searchParams.set('token', token);

  return json({
    success: true,
    share: publicShareMeta(row),
    shareUrl: shareUrl.toString()
  });
}

async function shareStatus(db, user, factionId, body) {
  const resource = normalizeResource(body);
  await assertResourceExists(db, factionId, resource);

  const row = await findOwnedShare(db, user.user_id, factionId, resource);
  return json({
    success: true,
    share: row ? publicShareMeta(row) : null
  });
}

async function revokeShare(db, user, factionId, body) {
  const resource = normalizeResource(body);
  const now = unixNow();

  await db.prepare(`
    UPDATE share_links
    SET is_enabled = 0, updated_at = ?
    WHERE owner_user_id = ?
      AND faction_id = ?
      AND resource_type = ?
      AND resource_key = ?
  `).bind(
    now,
    Number(user.user_id),
    factionId,
    resource.type,
    resource.key
  ).run();

  const row = await findOwnedShare(db, user.user_id, factionId, resource);
  return json({
    success: true,
    share: row ? publicShareMeta(row) : null,
    message: 'Public link revoked.'
  });
}

async function handlePublicShare(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = String(url.searchParams.get('token') || '').trim();
  if (!token) throw httpError(400, 'Missing share token.');
  if (token.length < 24 || token.length > 200) throw httpError(400, 'Invalid share token.');

  const tokenHash = await sha256(token);
  const link = await env.DB.prepare(`
    SELECT share_id, faction_id, resource_type, resource_key, created_at, updated_at
    FROM share_links
    WHERE token_hash = ? AND is_enabled = 1
    LIMIT 1
  `).bind(tokenHash).first();

  if (!link) throw httpError(404, 'This share link is invalid or has been revoked.');

  let payload;
  if (link.resource_type === 'war') {
    payload = await buildPublicWar(env.DB, Number(link.faction_id), String(link.resource_key));
  } else {
    throw httpError(404, 'This shared resource type is no longer available.');
  }

  const now = unixNow();
  if (typeof context.waitUntil === 'function') {
    context.waitUntil(
      env.DB.prepare('UPDATE share_links SET last_accessed_at = ? WHERE share_id = ?')
        .bind(now, Number(link.share_id))
        .run()
        .catch(() => null)
    );
  }

  return json({
    success: true,
    resourceType: link.resource_type,
    sharedAt: Number(link.updated_at || link.created_at || 0) || null,
    ...payload
  }, 200, {
    'Cache-Control': 'no-store, max-age=0',
    'X-Robots-Tag': 'noindex, nofollow'
  });
}

async function buildPublicWar(db, factionId, warId) {
  const war = await db.prepare(`
    SELECT
      war_id, report_id, faction_id, faction_name,
      opponent_faction_id, opponent_faction_name,
      start_timestamp, end_timestamp, imported_at
    FROM wars
    WHERE faction_id = ? AND war_id = ?
    LIMIT 1
  `).bind(factionId, warId).first();

  if (!war) throw httpError(404, 'The shared war report no longer exists.');

  const result = await db.prepare(`
    SELECT
      wl.player_id,
      wl.player_name,
      CASE WHEN fm.is_current = 1 THEN 1 ELSE 0 END AS is_current,
      COALESCE(wl.war_hits, 0) AS hits,
      COALESCE(wl.outside_hits, 0) AS outside_hits,
      COALESCE(wl.assists, 0) AS assists,
      COALESCE(wl.score_up, 0) AS score_up,
      COALESCE(wl.score_down, 0) AS score_down
    FROM war_log wl
    LEFT JOIN faction_members fm
      ON fm.faction_id = wl.faction_id
      AND fm.player_id = wl.player_id
    WHERE wl.faction_id = ? AND wl.war_id = ?
    ORDER BY wl.player_name COLLATE NOCASE
  `).bind(factionId, warId).all();

  let hits = 0;
  let assists = 0;
  let scoreUp = 0;
  let scoreDown = 0;

  const members = (result.results || []).map(row => {
    const memberHits = Number(row.hits || 0);
    const memberAssists = Number(row.assists || 0);
    const memberScoreUp = Number(row.score_up || 0);
    const memberScoreDown = Number(row.score_down || 0);

    hits += memberHits;
    assists += memberAssists;
    scoreUp += memberScoreUp;
    scoreDown += memberScoreDown;

    return {
      playerId: Number(row.player_id),
      playerName: row.player_name || `Player ${row.player_id}`,
      current: Number(row.is_current) === 1,
      hits: memberHits,
      assists: memberAssists,
      outsideHits: Number(row.outside_hits || 0),
      scoreUp: memberScoreUp,
      scoreDown: memberScoreDown,
      netScore: memberScoreUp - memberScoreDown
    };
  }).sort((a, b) =>
    b.netScore - a.netScore ||
    b.hits - a.hits ||
    a.playerName.localeCompare(b.playerName)
  );

  return {
    war: {
      warId: String(war.war_id),
      reportId: String(war.report_id || war.war_id),
      factionName: war.faction_name || `Faction ${factionId}`,
      opponentFactionId: Number(war.opponent_faction_id || 0) || null,
      opponentFactionName: war.opponent_faction_name || 'Unknown opponent',
      startTimestamp: Number(war.start_timestamp || 0) || null,
      endTimestamp: Number(war.end_timestamp || 0) || null
    },
    summary: {
      members: members.length,
      hits,
      assists,
      scoreUp,
      scoreDown,
      netScore: scoreUp - scoreDown
    },
    members
  };
}

async function assertResourceExists(db, factionId, resource) {
  if (resource.type !== 'war') throw httpError(400, 'Only war reports can be shared right now.');

  const row = await db.prepare(
    'SELECT war_id FROM wars WHERE faction_id = ? AND war_id = ? LIMIT 1'
  ).bind(factionId, resource.key).first();

  if (!row) throw httpError(404, 'Imported war not found for this faction.');
}

function normalizeResource(body) {
  const type = String(body.resourceType || 'war').trim().toLowerCase();
  const key = String(body.resourceKey || body.warId || '').trim();

  if (!key) throw httpError(400, 'Missing resource ID.');
  if (type !== 'war') throw httpError(400, 'Unsupported shared resource type.');

  return { type, key };
}

async function findOwnedShare(db, userId, factionId, resource) {
  return db.prepare(`
    SELECT share_id, resource_type, resource_key, is_enabled, created_at, updated_at, last_accessed_at
    FROM share_links
    WHERE owner_user_id = ?
      AND faction_id = ?
      AND resource_type = ?
      AND resource_key = ?
    LIMIT 1
  `).bind(Number(userId), factionId, resource.type, resource.key).first();
}

function publicShareMeta(row) {
  return {
    shareId: Number(row.share_id),
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    enabled: Number(row.is_enabled) === 1,
    createdAt: Number(row.created_at || 0) || null,
    updatedAt: Number(row.updated_at || 0) || null,
    lastAccessedAt: Number(row.last_accessed_at || 0) || null
  };
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

async function ensureShareSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS share_links (
      share_id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id INTEGER NOT NULL,
      faction_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER,
      UNIQUE(owner_user_id, faction_id, resource_type, resource_key),
      FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (faction_id) REFERENCES factions(faction_id)
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_share_links_token
    ON share_links(token_hash, is_enabled)
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_share_links_owner
    ON share_links(owner_user_id, faction_id, resource_type, updated_at DESC)
  `).run();
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
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

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}
