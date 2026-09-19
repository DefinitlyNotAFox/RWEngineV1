export async function ensureFactionLeadershipSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS faction_leadership (
      faction_id INTEGER PRIMARY KEY,
      leader_player_id INTEGER,
      co_leader_player_id INTEGER,
      verified_at INTEGER NOT NULL,
      FOREIGN KEY (faction_id) REFERENCES factions(faction_id) ON DELETE CASCADE
    )
  `).run();
}

export async function saveFactionLeadership(db, factionId, rawLeadership, verifiedAt) {
  await ensureFactionLeadershipSchema(db);
  const leadership = normalizeFactionLeadership(rawLeadership);

  if (!leadership.leaderPlayerId) {
    throw new Error('Faction leadership response did not include a leader ID.');
  }

  await db.prepare(`
    INSERT INTO faction_leadership (
      faction_id, leader_player_id, co_leader_player_id, verified_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(faction_id) DO UPDATE SET
      leader_player_id = excluded.leader_player_id,
      co_leader_player_id = excluded.co_leader_player_id,
      verified_at = excluded.verified_at
  `).bind(
    Number(factionId),
    leadership.leaderPlayerId,
    leadership.coLeaderPlayerId,
    Number(verifiedAt)
  ).run();

  return leadership;
}

export async function loadFactionLeadership(db, factionId) {
  await ensureFactionLeadershipSchema(db);
  const row = await db.prepare(`
    SELECT leader_player_id, co_leader_player_id, verified_at
    FROM faction_leadership
    WHERE faction_id = ?
    LIMIT 1
  `).bind(Number(factionId)).first();

  return {
    leaderPlayerId:positiveId(row?.leader_player_id),
    coLeaderPlayerId:positiveId(row?.co_leader_player_id),
    verifiedAt:positiveId(row?.verified_at)
  };
}

export async function ensureFactionUserRoleSchema(db) {
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

export function resolveFactionPermissions(leadership, playerId, stored = {}) {
  const leadershipRole = factionLeadershipRole(leadership, playerId);
  const adminRevoked = Number(stored.adminRevoked || 0) === 1 || stored.adminRevoked === true;
  const storedAdmin = Number(stored.isFactionAdmin || 0) === 1 || stored.isFactionAdmin === true;
  const isAssistant = Number(stored.isAssistant || 0) === 1 || stored.isAssistant === true;
  const isFactionAdmin = leadershipRole === 'leader' ||
    (leadershipRole === 'co_leader' && !adminRevoked) ||
    storedAdmin;

  return {
    leadershipRole,
    isFactionAdmin,
    isAssistant,
    role:isFactionAdmin ? 'faction_admin' : isAssistant ? 'assistant' : 'member'
  };
}

export async function loadFactionPermissions(db, user, factionId) {
  const userId = Number(user?.user_id || user?.userId || 0);
  const playerId = Number(user?.player_id || user?.playerId || 0);
  const accountFactionId = Number(user?.faction_id || user?.factionId || 0);
  const requestedFactionId = Number(factionId || 0);

  if (
    !Number.isSafeInteger(userId) || userId <= 0 ||
    !Number.isSafeInteger(playerId) || playerId <= 0 ||
    !Number.isSafeInteger(requestedFactionId) || requestedFactionId <= 0 ||
    accountFactionId !== requestedFactionId
  ) {
    return {
      leadershipRole:null,
      isFactionAdmin:false,
      isAssistant:false,
      role:'member'
    };
  }

  await ensureFactionUserRoleSchema(db);
  const [stored, leadership] = await Promise.all([
    db.prepare(`
      SELECT
        MAX(CASE WHEN role = 'faction_admin' THEN 1 ELSE 0 END) AS is_faction_admin,
        MAX(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS is_assistant,
        MAX(CASE WHEN role = 'faction_admin_revoked' THEN 1 ELSE 0 END) AS admin_revoked
      FROM faction_user_roles
      WHERE faction_id = ? AND user_id = ?
    `).bind(requestedFactionId, userId).first(),
    loadFactionLeadership(db, requestedFactionId)
  ]);

  return resolveFactionPermissions(leadership, playerId, {
    isFactionAdmin:stored?.is_faction_admin,
    isAssistant:stored?.is_assistant,
    adminRevoked:stored?.admin_revoked
  });
}

export function normalizeFactionLeadership(value) {
  return {
    leaderPlayerId:positiveId(
      value?.leader_id ??
      value?.leader_player_id ??
      value?.leaderId ??
      value?.leaderPlayerId
    ),
    coLeaderPlayerId:positiveId(
      value?.co_leader_id ??
      value?.coLeaderId ??
      value?.coleader_id ??
      value?.coLeaderPlayerId
    )
  };
}

export function factionLeadershipRole(leadership, playerId) {
  const target = positiveId(playerId);
  if (!target) return null;

  const normalized = normalizeFactionLeadership(leadership);
  if (target === normalized.leaderPlayerId) return 'leader';
  if (target === normalized.coLeaderPlayerId) return 'co_leader';
  return null;
}

function positiveId(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
