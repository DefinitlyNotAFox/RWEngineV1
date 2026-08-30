const MANAGED_KEY_CONFIG = 'admin_managed_api_key_v1';
const PAGE_LIMIT = 1000;
const TIME_PADDING_SECONDS = 60;

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') {
      return json({ success: false, message: 'Method not allowed. Use POST.' }, 405);
    }
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');
    if (!env.APP_SECRET) throw new Error('Missing APP_SECRET secret.');

    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const factionId = await resolveFactionId(env.DB, user, body.factionId);
    const warId = String(body.warId || '').trim();
    if (!warId) throw httpError(400, 'Missing war ID.');

    const war = await env.DB.prepare(`
      SELECT war_id, faction_id, opponent_faction_id, start_timestamp, end_timestamp
      FROM wars
      WHERE war_id = ? AND faction_id = ?
    `).bind(warId, factionId).first();

    if (!war) throw httpError(404, 'Imported war not found for this faction.');
    if (!war.start_timestamp || !war.end_timestamp) {
      throw httpError(400, 'Imported war is missing start/end timestamps.');
    }

    const apiKey = await requireFactionApiKey(env, factionId);
    const requestUrl = body.nextUrl
      ? sanitizeNextUrl(body.nextUrl)
      : buildInitialUrl(war);

    const payload = await fetchTornAttacksFull(requestUrl, apiKey);
    const rawAttacks = Array.isArray(payload?.attacks) ? payload.attacks : [];
    const exactStart = Number(war.start_timestamp);
    const exactEnd = Number(war.end_timestamp);
    const normalized = rawAttacks
      .map(normalizeAttack)
      .filter(attack => attack.attackId)
      .filter(attack => {
        const at = Number(attack.timestampEnded || attack.timestampStarted || 0);
        return !at || (at >= exactStart && at <= exactEnd);
      });

    if (normalized.length) {
      await storeAttackBatch(env.DB, war, normalized);
    }

    const nextUrl = sanitizeOptionalNextUrl(payload?._metadata?.links?.next);
    const done = !nextUrl;
    const totals = await getStoredTotals(env.DB, factionId, warId);

    return json({
      success: true,
      done,
      warId,
      fetchedThisPage: rawAttacks.length,
      storedThisPage: normalized.length,
      storedTotal: totals.attackRows,
      membersWithDetail: totals.membersWithDetail,
      assists: totals.assists,
      respectEarned: totals.respectEarned,
      respectLost: totals.respectLost,
      nextUrl: done ? null : nextUrl,
      source: 'v2-faction-attacksfull'
    });
  } catch (error) {
    return json({
      success: false,
      message: error?.message || 'Unexpected attack-detail supplement error.'
    }, error?.status || 500);
  }
}

function buildInitialUrl(war) {
  const query = new URLSearchParams({
    limit: String(PAGE_LIMIT),
    sort: 'ASC',
    from: String(Number(war.start_timestamp) - TIME_PADDING_SECONDS),
    to: String(Number(war.end_timestamp) + TIME_PADDING_SECONDS),
    comment: 'RWEngineWarDetail'
  });
  return `https://api.torn.com/v2/faction/attacksfull?${query}`;
}

function sanitizeOptionalNextUrl(value) {
  if (!value) return null;
  return sanitizeNextUrl(value);
}

function sanitizeNextUrl(value) {
  let url;
  try {
    url = new URL(String(value), 'https://api.torn.com');
  } catch (_) {
    throw httpError(400, 'Torn returned an invalid attack pagination URL.');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'api.torn.com') {
    throw httpError(400, 'Rejected invalid Torn attack pagination host.');
  }
  if (!url.pathname.startsWith('/v2/faction/attacksfull')) {
    throw httpError(400, 'Rejected invalid Torn attack pagination path.');
  }
  return url.toString();
}

async function fetchTornAttacksFull(url, apiKey) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `ApiKey ${apiKey}`
    }
  });

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    throw httpError(502, `Torn returned HTTP ${response.status} without valid JSON.`);
  }

  if (payload?.error) {
    const message = payload.error.error || payload.error.message || 'Unknown Torn API error.';
    throw httpError(502, `Torn API error: ${message}`);
  }
  if (!response.ok) {
    throw httpError(502, `Torn attack-detail request failed with HTTP ${response.status}.`);
  }
  return payload;
}

function normalizeAttack(attack) {
  const attacker = attack?.attacker || {};
  const defender = attack?.defender || {};
  return {
    attackId: String(attack?.id || attack?.attack_id || ''),
    attackerId: nullableNumber(attacker?.id ?? attack?.attacker_id),
    defenderId: nullableNumber(defender?.id ?? attack?.defender_id),
    attackerFactionId: nullableNumber(attacker?.faction_id ?? attack?.attacker_faction_id),
    defenderFactionId: nullableNumber(defender?.faction_id ?? attack?.defender_faction_id),
    result: String(attack?.result || ''),
    respectGain: finiteNumber(attack?.respect_gain),
    respectLoss: finiteNumber(attack?.respect_loss),
    timestampStarted: nullableNumber(attack?.started ?? attack?.timestamp_started),
    timestampEnded: nullableNumber(attack?.ended ?? attack?.timestamp_ended),
    raw: attack || {}
  };
}

async function storeAttackBatch(db, war, attacks) {
  const factionId = Number(war.faction_id);
  const opponentId = Number(war.opponent_faction_id || 0);
  const statement = db.prepare(`
    INSERT INTO attacks (
      attack_id, war_id, faction_id,
      attacker_id, attacker_name, defender_id, defender_name,
      attacker_faction_id, defender_faction_id, result,
      respect_gain, respect_loss, chain, is_ranked_war,
      timestamp_started, timestamp_ended, raw_json, created_at
    ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(attack_id) DO UPDATE SET
      war_id = excluded.war_id,
      faction_id = excluded.faction_id,
      attacker_id = COALESCE(excluded.attacker_id, attacks.attacker_id),
      defender_id = COALESCE(excluded.defender_id, attacks.defender_id),
      attacker_faction_id = COALESCE(excluded.attacker_faction_id, attacks.attacker_faction_id),
      defender_faction_id = COALESCE(excluded.defender_faction_id, attacks.defender_faction_id),
      result = CASE WHEN excluded.result != '' THEN excluded.result ELSE attacks.result END,
      respect_gain = excluded.respect_gain,
      respect_loss = excluded.respect_loss,
      is_ranked_war = MAX(attacks.is_ranked_war, excluded.is_ranked_war),
      timestamp_started = COALESCE(excluded.timestamp_started, attacks.timestamp_started),
      timestamp_ended = COALESCE(excluded.timestamp_ended, attacks.timestamp_ended),
      raw_json = CASE
        WHEN attacks.raw_json IS NOT NULL AND attacks.raw_json != '' AND attacks.raw_json != '{}'
          THEN attacks.raw_json
        ELSE excluded.raw_json
      END
  `);

  for (let index = 0; index < attacks.length; index += 75) {
    const chunk = attacks.slice(index, index + 75).map(attack => {
      const betweenWarFactions = opponentId > 0 && (
        (Number(attack.attackerFactionId || 0) === factionId && Number(attack.defenderFactionId || 0) === opponentId) ||
        (Number(attack.attackerFactionId || 0) === opponentId && Number(attack.defenderFactionId || 0) === factionId)
      );

      return statement.bind(
        attack.attackId,
        String(war.war_id),
        factionId,
        attack.attackerId,
        attack.defenderId,
        attack.attackerFactionId,
        attack.defenderFactionId,
        attack.result,
        attack.respectGain,
        attack.respectLoss,
        betweenWarFactions ? 1 : 0,
        attack.timestampStarted,
        attack.timestampEnded,
        JSON.stringify(attack.raw || {}),
        unixNow()
      );
    });
    await db.batch(chunk);
  }
}

async function getStoredTotals(db, factionId, warId) {
  const row = await db.prepare(`
    SELECT
      COUNT(*) AS attack_rows,
      COUNT(DISTINCT CASE
        WHEN EXISTS (
          SELECT 1 FROM war_log wl
          WHERE wl.war_id = attacks.war_id
            AND wl.faction_id = attacks.faction_id
            AND (wl.player_id = attacks.attacker_id OR wl.player_id = attacks.defender_id)
        ) THEN COALESCE(attacker_id, defender_id) END
      ) AS members_with_detail,
      SUM(CASE
        WHEN LOWER(TRIM(COALESCE(result, ''))) LIKE '%assist%'
          AND EXISTS (
            SELECT 1 FROM war_log wl
            WHERE wl.war_id = attacks.war_id
              AND wl.faction_id = attacks.faction_id
              AND wl.player_id = attacks.attacker_id
          )
        THEN 1 ELSE 0 END
      ) AS assists,
      SUM(CASE
        WHEN EXISTS (
          SELECT 1 FROM war_log wl
          WHERE wl.war_id = attacks.war_id
            AND wl.faction_id = attacks.faction_id
            AND wl.player_id = attacks.attacker_id
        )
        THEN COALESCE(respect_gain, 0) ELSE 0 END
      ) AS respect_earned,
      SUM(CASE
        WHEN EXISTS (
          SELECT 1 FROM war_log wl
          WHERE wl.war_id = attacks.war_id
            AND wl.faction_id = attacks.faction_id
            AND wl.player_id = attacks.defender_id
        )
        THEN ABS(COALESCE(respect_loss, 0)) ELSE 0 END
      ) AS respect_lost
    FROM attacks
    WHERE faction_id = ? AND war_id = ?
  `).bind(factionId, warId).first();

  return {
    attackRows: Number(row?.attack_rows || 0),
    membersWithDetail: Number(row?.members_with_detail || 0),
    assists: Number(row?.assists || 0),
    respectEarned: Number(row?.respect_earned || 0),
    respectLost: Number(row?.respect_lost || 0)
  };
}

async function resolveFactionId(db, user, requestedValue) {
  const accountFactionId = Number(user.faction_id || 0);
  const requestedFactionId = Number(requestedValue || accountFactionId);

  if (!Number.isSafeInteger(requestedFactionId) || requestedFactionId <= 0) {
    throw httpError(400, 'A valid faction ID is required.');
  }
  if (requestedFactionId !== accountFactionId && Number(user.is_admin) !== 1) {
    throw httpError(403, 'Admin access is required to rebuild another faction.');
  }

  const faction = await db.prepare(`
    SELECT faction_id, enabled FROM factions WHERE faction_id = ?
  `).bind(requestedFactionId).first();
  if (!faction || Number(faction.enabled) !== 1) {
    throw httpError(404, 'That faction is not currently tracked by RWE.');
  }
  return requestedFactionId;
}

async function requireFactionApiKey(env, factionId) {
  const managedRow = await env.DB.prepare(`
    SELECT config_value FROM faction_config
    WHERE faction_id = ? AND config_key = ?
  `).bind(factionId, MANAGED_KEY_CONFIG).first();

  const managed = parseManagedKey(managedRow?.config_value);
  if (managed?.ciphertext && managed?.iv) {
    return decryptText(env.APP_SECRET, managed.ciphertext, managed.iv);
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

function parseManagedKey(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function getCurrentUser(env, request) {
  const token = getCookie(request, 'rwengine_session');
  if (!token) throw httpError(401, 'Not logged in.');

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`
    SELECT u.user_id, u.faction_id, u.is_admin, u.is_disabled
    FROM sessions s
    JOIN users u ON u.user_id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, unixNow()).first();

  if (!row) throw httpError(401, 'Session expired or invalid.');
  if (Number(row.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  return row;
}

async function decryptText(secret, ciphertextBase64, ivBase64) {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey({
    name: 'PBKDF2',
    salt: encoder.encode('rwengine-v2-api-key-encryption'),
    iterations: 100000,
    hash: 'SHA-256'
  }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);

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
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
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
  const bytes = new TextEncoder().encode(String(value));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
