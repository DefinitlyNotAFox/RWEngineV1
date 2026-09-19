import {
  factionLeadershipRole,
  loadFactionLeadership,
  resolveFactionPermissions
} from './faction-leadership.js';

const ASSIGNABLE_ROLES = new Set(['member', 'assistant', 'faction_admin']);

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') {
      return json({ success:false, message:'Method not allowed. Use POST.' }, 405);
    }
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');

    await ensureRoleSchema(env.DB);
    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const factionId = await resolveFactionId(env.DB, user, body.factionId);
    const leadership = await loadFactionLeadership(env.DB, factionId);
    const permissions = roleGrantCapabilities(user, leadership, factionId);

    if (!permissions.canGrantAssistant && !permissions.canGrantAdmin) {
      throw httpError(403, 'Only the faction leader or co-leader can manage faction roles.');
    }

    const action = String(body.action || 'list');
    if (action === 'list') {
      return json(await buildRoleList(env.DB, factionId, leadership, permissions));
    }
    if (action === 'setRole') {
      return json(await setFactionRole(
        env.DB,
        factionId,
        leadership,
        permissions,
        body
      ));
    }

    throw httpError(400, 'Unknown faction-role action: ' + action);
  } catch (error) {
    return json(
      { success:false, message:error?.message || 'Unexpected faction-role error.' },
      error?.status || 500
    );
  }
}

export function roleGrantCapabilities(user, leadership, factionId) {
  const platformAdmin = Number(user?.is_admin) === 1 || user?.isAdmin === true;
  const accountFactionId = Number(user?.faction_id || user?.factionId || 0);
  const requestedFactionId = Number(factionId || 0);
  const leadershipRole = accountFactionId === requestedFactionId
    ? factionLeadershipRole(leadership, user?.player_id ?? user?.playerId)
    : null;

  return {
    leadershipRole,
    canGrantAdmin:platformAdmin || leadershipRole === 'leader',
    canGrantAssistant:platformAdmin ||
      leadershipRole === 'leader' ||
      leadershipRole === 'co_leader'
  };
}

export function canSetFactionRole(permissions, target, requestedRole) {
  const role = String(requestedRole || '');
  if (!ASSIGNABLE_ROLES.has(role)) return false;
  if (target?.protected) return false;

  if (role === 'faction_admin') {
    return permissions?.canGrantAdmin === true;
  }

  if (target?.role === 'faction_admin') {
    return permissions?.canGrantAdmin === true;
  }

  return permissions?.canGrantAssistant === true;
}

async function buildRoleList(db, factionId, leadership, permissions) {
  return {
    success:true,
    factionId,
    permissions,
    accounts:await loadFactionAccounts(db, factionId, leadership)
  };
}

async function setFactionRole(db, factionId, leadership, permissions, body) {
  const targetUserId = Number(body.userId || 0);
  const requestedRole = String(body.role || '').trim().toLowerCase();
  if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
    throw httpError(400, 'A valid account is required.');
  }
  if (!ASSIGNABLE_ROLES.has(requestedRole)) {
    throw httpError(400, 'Role must be member, assistant, or faction admin.');
  }

  const accounts = await loadFactionAccounts(db, factionId, leadership);
  const target = accounts.find(account => Number(account.userId) === targetUserId);
  if (!target) throw httpError(404, 'That registered account is not in this faction.');
  if (target.leadershipRole === 'leader') {
    throw httpError(403, 'The official faction leader must always retain faction-admin status.');
  }
  if (target.platformAdmin) {
    throw httpError(403, 'Platform-administrator accounts cannot be changed here.');
  }
  if (!canSetFactionRole(permissions, target, requestedRole)) {
    throw httpError(
      403,
      target.role === 'faction_admin' || requestedRole === 'faction_admin'
        ? 'Only the faction leader can grant or revoke faction-admin status.'
        : 'Only the faction leader or co-leader can manage Assistants.'
    );
  }

  const now = unixNow();
  await db.prepare(`
    DELETE FROM faction_user_roles
    WHERE faction_id = ?
      AND user_id = ?
      AND role IN ('faction_admin', 'assistant', 'faction_admin_revoked')
  `).bind(factionId, targetUserId).run();

  if (requestedRole === 'faction_admin') {
    await insertRole(db, factionId, targetUserId, 'faction_admin', now);
  } else {
    if (target.leadershipRole === 'co_leader') {
      await insertRole(db, factionId, targetUserId, 'faction_admin_revoked', now);
    }
    if (requestedRole === 'assistant') {
      await insertRole(db, factionId, targetUserId, 'assistant', now);
    }
  }

  const updated = (await loadFactionAccounts(db, factionId, leadership))
    .find(account => Number(account.userId) === targetUserId);

  return {
    success:true,
    message:`${target.playerName} is now ${roleLabel(updated?.role || requestedRole)}.`,
    account:updated || null
  };
}

async function insertRole(db, factionId, userId, role, now) {
  await db.prepare(`
    INSERT INTO faction_user_roles (
      faction_id, user_id, role, source, verified_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'manual', NULL, ?, ?)
    ON CONFLICT(faction_id, user_id, role) DO UPDATE SET
      source = 'manual',
      verified_at = NULL,
      updated_at = excluded.updated_at
  `).bind(factionId, userId, role, now, now).run();
}

async function loadFactionAccounts(db, factionId, leadership) {
  const result = await db.prepare(`
    SELECT
      u.user_id,
      u.player_id,
      u.player_name,
      u.is_admin,
      MAX(CASE WHEN r.role = 'faction_admin' THEN 1 ELSE 0 END) AS faction_admin,
      MAX(CASE WHEN r.role = 'assistant' THEN 1 ELSE 0 END) AS assistant,
      MAX(CASE WHEN r.role = 'faction_admin_revoked' THEN 1 ELSE 0 END) AS admin_revoked
    FROM users u
    LEFT JOIN faction_user_roles r
      ON r.user_id = u.user_id
      AND r.faction_id = u.faction_id
    WHERE u.faction_id = ?
      AND u.is_disabled = 0
    GROUP BY u.user_id, u.player_id, u.player_name, u.is_admin
    ORDER BY u.player_name COLLATE NOCASE, u.player_id
  `).bind(factionId).all();

  return (result.results || []).map(row => {
    const platformAdmin = Number(row.is_admin) === 1;
    const permissions = resolveFactionPermissions(leadership, row.player_id, {
      isFactionAdmin:row.faction_admin,
      isAssistant:row.assistant,
      adminRevoked:row.admin_revoked
    });
    const role = platformAdmin
      ? 'platform_admin'
      : permissions.role;

    return {
      userId:Number(row.user_id),
      playerId:Number(row.player_id),
      playerName:row.player_name || `Player ${row.player_id}`,
      role,
      leadershipRole:permissions.leadershipRole,
      platformAdmin,
      protected:platformAdmin || permissions.leadershipRole === 'leader'
    };
  });
}

async function ensureRoleSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS faction_user_roles (
      faction_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      verified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (faction_id, user_id, role),
      FOREIGN KEY (faction_id) REFERENCES factions(faction_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_faction_user_roles_user
    ON faction_user_roles(user_id, faction_id, role)
  `).run();
}

async function resolveFactionId(db, user, requestedValue) {
  const accountFactionId = Number(user.faction_id || 0);
  const requestedFactionId = Number(requestedValue || accountFactionId);
  if (!Number.isSafeInteger(requestedFactionId) || requestedFactionId <= 0) {
    throw httpError(400, 'A valid faction is required.');
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

function roleLabel(role) {
  if (role === 'faction_admin') return 'a faction admin';
  if (role === 'assistant') return 'an Assistant';
  return 'a Member';
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
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readJson(request) {
  try { return await request.json(); } catch (_) { return {}; }
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
    headers:{ 'Content-Type':'application/json' }
  });
}
