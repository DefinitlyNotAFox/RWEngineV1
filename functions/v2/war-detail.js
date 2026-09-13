const MANAGED_KEY_CONFIG = 'admin_managed_api_key_v1';
const CHAIN_CACHE_PREFIX = 'performance_chain_bonus_v1';
const CHAIN_PADDING_SECONDS = 3600;

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') return json({ success: false, message: 'Method not allowed. Use POST.' }, 405);
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');

    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const factionId = await resolveFactionId(env.DB, user, body.factionId);
    await ensureAccessSchema(env.DB);
    await ensureAggregateSchema(env.DB);
    await backfillLegacyAttackAggregates(env.DB, factionId);
    const warId = String(body.warId || '').trim();
    if (!warId) throw httpError(400, 'Missing war ID.');

    const war = await env.DB.prepare(`
      SELECT war_id, report_id, faction_id, faction_name, opponent_faction_id,
             opponent_faction_name, start_timestamp, end_timestamp, imported_at,
             imported_by_user_id
      FROM wars
      WHERE faction_id = ? AND war_id = ?
      LIMIT 1
    `).bind(factionId, warId).first();
    if (!war) throw httpError(404, 'Imported war not found for this faction.');
    await assertWarAccess(env.DB, user, factionId, war);

    const performanceResult = await env.DB.prepare(`
      SELECT
        wl.player_id,
        wl.player_name,
        CASE WHEN fm.is_current = 1 THEN 1 ELSE 0 END AS is_current,
        COALESCE(wl.war_hits, 0) AS hits,
        COALESCE(wl.outside_hits, 0) AS outside_hits,
        COALESCE(wl.assists, 0) AS stored_assists,
        COALESCE(wl.score_up, 0) AS score_up,
        COALESCE(wl.score_down, 0) AS score_down,
        COALESCE(wl.attack_detail_complete, 0) AS attack_detail_complete,
        COALESCE(wl.attack_detail_rows, 0) AS attack_rows,
        wl.respect_earned AS respect_earned,
        wl.respect_lost AS respect_lost,
        COALESCE(wl.chain_bonus_hits, 0) AS chain_bonus_hits_out,
        COALESCE(wl.chain_bonus_score, 0) AS chain_bonus_score_out,
        COALESCE(wl.chain_bonus_hits_in, 0) AS chain_bonus_hits_in,
        COALESCE(wl.chain_bonus_score_in, 0) AS chain_bonus_score_in,
        COALESCE(wl.chain_bonus_respect_lost_in, 0) AS chain_bonus_respect_lost_in
      FROM war_log wl
      LEFT JOIN faction_members fm
        ON fm.faction_id = wl.faction_id
        AND fm.player_id = wl.player_id
      WHERE wl.faction_id = ? AND wl.war_id = ?
      ORDER BY wl.player_name COLLATE NOCASE
    `).bind(factionId, warId).all();

    const excludeMilestones = body.excludeChainBonuses === true;
    const chainSource = excludeMilestones ? 'stored-aggregate' : 'not-requested';

    let officialScoreUp = 0;
    let officialScoreDown = 0;
    let officialHits = 0;
    let filteredScoreUp = 0;
    let filteredScoreDown = 0;
    let filteredHits = 0;
    let assistsTotal = 0;

    const members = (performanceResult.results || []).map(row => {
      const playerId = Number(row.player_id);
      const hasAttackDetails = Number(row.attack_detail_complete || 0) === 1;
      const baseHits = Number(row.hits || 0);
      const baseScoreUp = Number(row.score_up || 0);
      const baseScoreDown = Number(row.score_down || 0);
      const baseRespectEarned = hasAttackDetails ? Number(row.respect_earned || 0) : null;
      const baseRespectLost = hasAttackDetails ? Number(row.respect_lost || 0) : null;
      const assists = Number(row.stored_assists || 0);

      const chainBonusHitsOut = Number(row.chain_bonus_hits_out || 0);
      const chainBonusScoreOut = Number(row.chain_bonus_score_out || 0);
      const chainBonusHitsIn = Number(row.chain_bonus_hits_in || 0);
      const chainBonusScoreIn = Number(row.chain_bonus_score_in || 0);
      const chainBonusRespectLostIn = Number(row.chain_bonus_respect_lost_in || 0);

      const hits = excludeMilestones
        ? Math.max(0, baseHits - chainBonusHitsOut)
        : baseHits;
      const scoreUp = excludeMilestones
        ? Math.max(0, baseScoreUp - chainBonusScoreOut)
        : baseScoreUp;
      const scoreDown = excludeMilestones
        ? Math.max(0, baseScoreDown - chainBonusScoreIn)
        : baseScoreDown;
      const respectEarned = baseRespectEarned === null
        ? null
        : excludeMilestones
          ? Math.max(0, baseRespectEarned - chainBonusScoreOut)
          : baseRespectEarned;
      const respectLost = baseRespectLost === null
        ? null
        : excludeMilestones
          ? Math.max(0, baseRespectLost - chainBonusRespectLostIn)
          : baseRespectLost;

      officialScoreUp += baseScoreUp;
      officialScoreDown += baseScoreDown;
      officialHits += baseHits;
      filteredScoreUp += scoreUp;
      filteredScoreDown += scoreDown;
      filteredHits += hits;
      assistsTotal += assists;

      return {
        playerId,
        playerName: row.player_name || `Player ${playerId}`,
        current: Number(row.is_current) === 1,
        hits,
        assists,
        outsideHits: Number(row.outside_hits || 0),
        respectEarned,
        respectLost,
        scoreUp,
        scoreDown,
        netScore: scoreUp - scoreDown,
        attackDetailsAvailable: hasAttackDetails,
        chainBonusHitsOut,
        chainBonusScoreOut,
        chainBonusHitsIn,
        chainBonusScoreIn,
        chainBonusRespectLostIn
      };
    });

    return json({
      success: true,
      factionId,
      war: {
        warId: String(war.war_id),
        reportId: String(war.report_id || war.war_id),
        factionName: war.faction_name || `Faction ${factionId}`,
        opponentFactionId: Number(war.opponent_faction_id || 0) || null,
        opponentFactionName: war.opponent_faction_name || 'Unknown opponent',
        startTimestamp: Number(war.start_timestamp || 0) || null,
        endTimestamp: Number(war.end_timestamp || 0) || null,
        importedAt: Number(war.imported_at || 0) || null
      },
      excludedChainBonuses: excludeMilestones,
      chainSource,
      chainBonusSummary: {
        outgoingHits: members.reduce((sum, member) => sum + Number(member.chainBonusHitsOut || 0), 0),
        incomingHits: members.reduce((sum, member) => sum + Number(member.chainBonusHitsIn || 0), 0)
      },
      summary: {
        members: members.length,
        officialHits,
        displayHits: filteredHits,
        assists: assistsTotal,
        officialScoreUp,
        officialScoreDown,
        officialNetScore: officialScoreUp - officialScoreDown,
        displayScoreUp: filteredScoreUp,
        displayScoreDown: filteredScoreDown,
        displayNetScore: filteredScoreUp - filteredScoreDown
      },
      members
    });
  } catch (error) {
    return json({ success: false, message: error?.message || 'Unexpected war detail error.' }, error?.status || 500);
  }
}

async function ensureAccessSchema(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS resource_permissions (permission_id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, faction_id INTEGER NOT NULL, resource_type TEXT NOT NULL, resource_key TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'faction' CHECK (visibility IN ('private', 'faction', 'public')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(faction_id, resource_type, resource_key), FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE CASCADE, FOREIGN KEY (faction_id) REFERENCES factions(faction_id))"
  ).run();
}

async function ensureAggregateSchema(db) {
  const columns = await db.prepare("PRAGMA table_info(war_log)").all();
  const found = new Set((columns.results || []).map(row => String(row.name)));
  const additions = [
    ['respect_earned', 'ALTER TABLE war_log ADD COLUMN respect_earned REAL'],
    ['respect_lost', 'ALTER TABLE war_log ADD COLUMN respect_lost REAL'],
    ['attack_detail_complete', 'ALTER TABLE war_log ADD COLUMN attack_detail_complete INTEGER NOT NULL DEFAULT 0'],
    ['attack_detail_rows', 'ALTER TABLE war_log ADD COLUMN attack_detail_rows INTEGER NOT NULL DEFAULT 0'],
    ['chain_bonus_hits_in', 'ALTER TABLE war_log ADD COLUMN chain_bonus_hits_in INTEGER NOT NULL DEFAULT 0'],
    ['chain_bonus_score_in', 'ALTER TABLE war_log ADD COLUMN chain_bonus_score_in REAL NOT NULL DEFAULT 0'],
    ['chain_bonus_respect_lost_in', 'ALTER TABLE war_log ADD COLUMN chain_bonus_respect_lost_in REAL NOT NULL DEFAULT 0']
  ];

  for (const [name, sql] of additions) {
    if (found.has(name)) continue;
    try { await db.prepare(sql).run(); }
    catch (error) {
      if (!/duplicate column|already exists/i.test(String(error?.message || error || ''))) throw error;
    }
  }
}

async function backfillLegacyAttackAggregates(db, factionId) {
  await db.prepare(`
    UPDATE war_log
    SET
      respect_earned = COALESCE((
        SELECT SUM(CASE WHEN a.is_ranked_war = 1 AND LOWER(TRIM(COALESCE(a.result,''))) NOT LIKE '%assist%'
          THEN COALESCE(a.respect_gain,0) ELSE 0 END)
        FROM attacks a
        WHERE a.faction_id = war_log.faction_id AND a.war_id = war_log.war_id AND a.attacker_id = war_log.player_id
      ),0),
      respect_lost = COALESCE((
        SELECT SUM(CASE WHEN a.is_ranked_war = 1 AND LOWER(TRIM(COALESCE(a.result,''))) NOT LIKE '%assist%'
          THEN ABS(COALESCE(a.respect_loss,0)) ELSE 0 END)
        FROM attacks a
        WHERE a.faction_id = war_log.faction_id AND a.war_id = war_log.war_id AND a.defender_id = war_log.player_id
      ),0),
      attack_detail_rows = COALESCE((
        SELECT COUNT(*) FROM attacks a
        WHERE a.faction_id = war_log.faction_id AND a.war_id = war_log.war_id
          AND a.is_ranked_war = 1
          AND (a.attacker_id = war_log.player_id OR a.defender_id = war_log.player_id)
      ),0),
      chain_bonus_hits = COALESCE((
        SELECT SUM(CASE WHEN a.is_ranked_war = 1
          AND LOWER(TRIM(COALESCE(a.result,''))) NOT LIKE '%assist%'
          AND (a.chain IN (10,25,50,100,250,500,1000,2500,5000,10000,25000,50000,100000)
            OR COALESCE(CAST(json_extract(a.raw_json,'$.modifiers.chain') AS REAL),0) >= 2)
          THEN 1 ELSE 0 END)
        FROM attacks a
        WHERE a.faction_id = war_log.faction_id AND a.war_id = war_log.war_id AND a.attacker_id = war_log.player_id
      ),0),
      chain_bonus_score = COALESCE((
        SELECT SUM(CASE WHEN a.is_ranked_war = 1
          AND LOWER(TRIM(COALESCE(a.result,''))) NOT LIKE '%assist%'
          AND (a.chain IN (10,25,50,100,250,500,1000,2500,5000,10000,25000,50000,100000)
            OR COALESCE(CAST(json_extract(a.raw_json,'$.modifiers.chain') AS REAL),0) >= 2)
          THEN COALESCE(a.respect_gain,0) ELSE 0 END)
        FROM attacks a
        WHERE a.faction_id = war_log.faction_id AND a.war_id = war_log.war_id AND a.attacker_id = war_log.player_id
      ),0),
      chain_bonus_hits_in = COALESCE((
        SELECT SUM(CASE WHEN a.is_ranked_war = 1
          AND LOWER(TRIM(COALESCE(a.result,''))) NOT LIKE '%assist%'
          AND (a.chain IN (10,25,50,100,250,500,1000,2500,5000,10000,25000,50000,100000)
            OR COALESCE(CAST(json_extract(a.raw_json,'$.modifiers.chain') AS REAL),0) >= 2)
          THEN 1 ELSE 0 END)
        FROM attacks a
        WHERE a.faction_id = war_log.faction_id AND a.war_id = war_log.war_id AND a.defender_id = war_log.player_id
      ),0),
      chain_bonus_score_in = COALESCE((
        SELECT SUM(CASE WHEN a.is_ranked_war = 1
          AND LOWER(TRIM(COALESCE(a.result,''))) NOT LIKE '%assist%'
          AND (a.chain IN (10,25,50,100,250,500,1000,2500,5000,10000,25000,50000,100000)
            OR COALESCE(CAST(json_extract(a.raw_json,'$.modifiers.chain') AS REAL),0) >= 2)
          THEN COALESCE(a.respect_gain,0) ELSE 0 END)
        FROM attacks a
        WHERE a.faction_id = war_log.faction_id AND a.war_id = war_log.war_id AND a.defender_id = war_log.player_id
      ),0),
      chain_bonus_respect_lost_in = COALESCE((
        SELECT SUM(CASE WHEN a.is_ranked_war = 1
          AND LOWER(TRIM(COALESCE(a.result,''))) NOT LIKE '%assist%'
          AND (a.chain IN (10,25,50,100,250,500,1000,2500,5000,10000,25000,50000,100000)
            OR COALESCE(CAST(json_extract(a.raw_json,'$.modifiers.chain') AS REAL),0) >= 2)
          THEN ABS(COALESCE(a.respect_loss,0)) ELSE 0 END)
        FROM attacks a
        WHERE a.faction_id = war_log.faction_id AND a.war_id = war_log.war_id AND a.defender_id = war_log.player_id
      ),0),
      attack_detail_complete = 1
    WHERE faction_id = ?
      AND COALESCE(attack_detail_complete,0) = 0
      AND EXISTS (
        SELECT 1 FROM attacks a
        WHERE a.faction_id = war_log.faction_id AND a.war_id = war_log.war_id
      )
  `).bind(factionId).run();
}

async function assertWarAccess(db, user, factionId, war) {
  if (Number(user.is_admin) === 1) return;

  const permission = await db.prepare(
    'SELECT owner_user_id, visibility FROM resource_permissions WHERE faction_id = ? AND resource_type = ? AND resource_key = ? LIMIT 1'
  ).bind(factionId, 'war', String(war.war_id)).first();

  const visibility = permission?.visibility || 'faction';
  if (visibility !== 'private') return;

  const permissionOwnerId = Number(permission?.owner_user_id || 0);
  const importOwnerId = Number(war.imported_by_user_id || 0);
  if (
    permissionOwnerId !== Number(user.user_id) &&
    importOwnerId !== Number(user.user_id)
  ) {
    throw httpError(403, 'This war report is private.');
  }
}

async function fetchTornJson(url, apiKey) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `ApiKey ${apiKey}` }
  });
  let payload;
  try { payload = await response.json(); }
  catch (_) { throw httpError(502, `Torn returned HTTP ${response.status} without JSON.`); }
  if (payload?.error) throw httpError(502, `Torn API error: ${payload.error.error || payload.error.message || 'Unknown error'}`);
  if (!response.ok) throw httpError(502, `Torn request failed with HTTP ${response.status}.`);
  return payload;
}

async function resolveFactionId(db, user, requestedValue) {
  const accountFactionId = Number(user.faction_id || 0);
  const requestedFactionId = Number(requestedValue || accountFactionId);
  if (!Number.isSafeInteger(requestedFactionId) || requestedFactionId <= 0) throw httpError(400, 'A valid faction ID is required.');
  if (requestedFactionId !== accountFactionId && Number(user.is_admin) !== 1) throw httpError(403, 'Admin access is required to view another faction.');
  const faction = await db.prepare('SELECT faction_id, enabled FROM factions WHERE faction_id = ?').bind(requestedFactionId).first();
  if (!faction || Number(faction.enabled) !== 1) throw httpError(404, 'That faction is not currently tracked by RWE.');
  return requestedFactionId;
}

async function requireFactionApiKey(env, factionId) {
  const managedRow = await env.DB.prepare(`
    SELECT config_value FROM faction_config WHERE faction_id = ? AND config_key = ?
  `).bind(factionId, MANAGED_KEY_CONFIG).first();
  const managed = parseManagedKey(managedRow?.config_value);
  if (managed?.ciphertext && managed?.iv) return decryptText(env.APP_SECRET, managed.ciphertext, managed.iv);

  const owner = await env.DB.prepare(`
    SELECT api_key_encrypted, api_key_iv
    FROM users
    WHERE faction_id = ? AND is_disabled = 0
      AND api_key_encrypted IS NOT NULL AND api_key_iv IS NOT NULL
    ORDER BY is_admin DESC, last_login_at DESC, user_id ASC LIMIT 1
  `).bind(factionId).first();
  if (owner?.api_key_encrypted && owner?.api_key_iv) return decryptText(env.APP_SECRET, owner.api_key_encrypted, owner.api_key_iv);
  throw httpError(400, 'No usable API key is configured for this faction.');
}

function parseManagedKey(value) {
  if (!value) return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : null; }
  catch (_) { return null; }
}

async function getCurrentUser(env, request) {
  const token = getCookie(request, 'rwengine_session');
  if (!token) throw httpError(401, 'Not logged in.');
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`
    SELECT u.user_id, u.faction_id, u.is_admin, u.is_disabled
    FROM sessions s JOIN users u ON u.user_id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, unixNow()).first();
  if (!row) throw httpError(401, 'Session expired or invalid.');
  if (Number(row.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  return row;
}

async function decryptText(secret, ciphertextBase64, ivBase64) {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({
    name: 'PBKDF2', salt: encoder.encode('rwengine-v2-api-key-encryption'), iterations: 100000, hash: 'SHA-256'
  }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(ivBase64) }, key, base64ToBytes(ciphertextBase64));
  return new TextDecoder().decode(plaintext);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
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

function unixNow() { return Math.floor(Date.now() / 1000); }
async function readJson(request) { try { return await request.json(); } catch (_) { return {}; } }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
