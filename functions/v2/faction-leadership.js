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
