const MANAGED_KEY_CONFIG = 'admin_managed_api_key_v1';
const CACHE_PREFIX = 'performance_chain_bonus_v1';
const CHAIN_PADDING_SECONDS = 3600;

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') return json({ success: false, message: 'Method not allowed. Use POST.' }, 405);
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');
    if (!env.APP_SECRET) throw new Error('Missing APP_SECRET secret.');

    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const factionId = await resolveFactionId(env.DB, user, body.factionId);
    const range = resolveRange(body);
    const apiKey = await requireFactionApiKey(env, factionId);

    const warsResult = await env.DB.prepare(`
      SELECT war_id, faction_id, opponent_faction_id, start_timestamp, end_timestamp
      FROM wars
      WHERE faction_id = ?
        AND COALESCE(end_timestamp, start_timestamp, imported_at, 0) BETWEEN ? AND ?
      ORDER BY COALESCE(end_timestamp, start_timestamp, imported_at, 0) ASC
    `).bind(factionId, range.from, range.to).all();

    const totals = new Map();
    let outgoingHits = 0;
    let incomingHits = 0;
    let cachedWars = 0;
    let refreshedWars = 0;
    const warnings = [];

    for (const war of warsResult.results || []) {
      let annotation = null;
      const cacheKey = `${CACHE_PREFIX}:${factionId}:${war.war_id}`;
      if (body.force !== true) annotation = await readCachedAnnotation(env.DB, cacheKey);

      if (annotation) {
        cachedWars += 1;
      } else {
        try {
          annotation = await buildWarAnnotation(env.DB, apiKey, war);
          await writeCachedAnnotation(env.DB, cacheKey, annotation);
          refreshedWars += 1;
        } catch (error) {
          warnings.push(`#${war.war_id}: ${error?.message || 'chain bonus lookup failed'}`);
          annotation = { members: {} };
        }
      }

      for (const [playerIdText, metric] of Object.entries(annotation.members || {})) {
        const playerId = Number(playerIdText);
        const current = totals.get(playerId) || emptyMetric(playerId);
        current.chainBonusHitsOut += Number(metric.chainBonusHitsOut || 0);
        current.chainBonusScoreOut += Number(metric.chainBonusScoreOut || 0);
        current.chainBonusHitsIn += Number(metric.chainBonusHitsIn || 0);
        current.chainBonusScoreIn += Number(metric.chainBonusScoreIn || 0);
        current.chainBonusRespectLostIn += Number(metric.chainBonusRespectLostIn || 0);
        totals.set(playerId, current);
      }

      outgoingHits += Number(annotation.outgoingHits || 0);
      incomingHits += Number(annotation.incomingHits || 0);
    }

    return json({
      success: true,
      factionId,
      range,
      wars: (warsResult.results || []).length,
      cachedWars,
      refreshedWars,
      outgoingHits,
      incomingHits,
      warnings,
      members: [...totals.values()]
    });
  } catch (error) {
    return json({ success: false, message: error?.message || 'Unexpected chain bonus lookup error.' }, error?.status || 500);
  }
}

async function buildWarAnnotation(db, apiKey, war) {
  const factionId = Number(war.faction_id);
  const opponentId = Number(war.opponent_faction_id || 0);
  const start = Number(war.start_timestamp || 0);
  const end = Number(war.end_timestamp || 0);
  if (!start || !end) return { members: {}, outgoingHits: 0, incomingHits: 0 };

  const attacksResult = await db.prepare(`
    SELECT attack_id, attacker_id, defender_id, respect_gain, respect_loss, chain
    FROM attacks
    WHERE faction_id = ? AND war_id = ? AND is_ranked_war = 1
  `).bind(factionId, String(war.war_id)).all();

  const attacks = (attacksResult.results || []).map(row => ({
    attackId: String(row.attack_id || ''),
    attackerId: nullableNumber(row.attacker_id),
    defenderId: nullableNumber(row.defender_id),
    respectGain: finiteNumber(row.respect_gain),
    respectLoss: Math.abs(finiteNumber(row.respect_loss)),
    chain: nullableNumber(row.chain)
  }));

  const members = {};
  const usedAttackIds = new Set();
  let outgoingHits = 0;
  let incomingHits = 0;

  const ownBonuses = await fetchFactionBonuses(apiKey, factionId, start, end);
  for (const bonus of ownBonuses) {
    const match = matchBonusAttack(attacks, bonus, 'outgoing', usedAttackIds);
    if (!match) continue;
    const metric = ensureMetric(members, bonus.attackerId);
    metric.chainBonusHitsOut += 1;
    metric.chainBonusScoreOut += finiteNumber(match.respectGain || bonus.respect);
    outgoingHits += 1;
    usedAttackIds.add(match.attackId);
  }

  if (opponentId > 0) {
    const opponentBonuses = await fetchFactionBonuses(apiKey, opponentId, start, end);
    for (const bonus of opponentBonuses) {
      const match = matchBonusAttack(attacks, bonus, 'incoming', usedAttackIds);
      if (!match || !bonus.defenderId) continue;
      const metric = ensureMetric(members, bonus.defenderId);
      metric.chainBonusHitsIn += 1;
      metric.chainBonusScoreIn += finiteNumber(match.respectGain || bonus.respect);
      metric.chainBonusRespectLostIn += finiteNumber(match.respectLoss);
      incomingHits += 1;
      usedAttackIds.add(match.attackId);
    }
  }

  return { members, outgoingHits, incomingHits };
}

async function fetchFactionBonuses(apiKey, factionId, warStart, warEnd) {
  const from = Math.max(0, warStart - CHAIN_PADDING_SECONDS);
  const to = warEnd + CHAIN_PADDING_SECONDS;
  const chainsUrl = `https://api.torn.com/v2/faction/${encodeURIComponent(factionId)}/chains?from=${from}&to=${to}&limit=100&comment=RWEngineChainBonus`;
  const chainsPayload = await fetchTornJson(chainsUrl, apiKey);
  const chains = normalizeChains(chainsPayload).filter(chain => chain.start <= warEnd && chain.end >= warStart);
  const bonuses = [];

  for (const chain of chains) {
    const reportUrl = `https://api.torn.com/v2/faction/${encodeURIComponent(chain.id)}/chainreport?comment=RWEngineChainBonus`;
    const reportPayload = await fetchTornJson(reportUrl, apiKey);
    for (const bonus of normalizeBonuses(reportPayload)) bonuses.push(bonus);
  }
  return bonuses;
}

function normalizeChains(payload) {
  const source = payload?.chains || payload?.chain || {};
  const entries = Array.isArray(source)
    ? source.map(item => [String(item?.id ?? item?.chain_id ?? item?.chain ?? ''), item])
    : Object.entries(source || {});

  return entries.map(([key, value]) => ({
    id: Number(value?.id ?? value?.chain_id ?? key),
    start: Number(value?.start ?? value?.started ?? value?.start_timestamp ?? 0),
    end: Number(value?.end ?? value?.ended ?? value?.end_timestamp ?? 0)
  })).filter(item => item.id > 0 && item.start > 0 && item.end > 0);
}

function normalizeBonuses(payload) {
  const report = payload?.chainreport || payload?.chain_report || payload?.report || payload || {};
  const source = report?.bonuses || report?.bonus_hits || report?.bonusHits || [];
  const values = Array.isArray(source) ? source : Object.values(source || {});
  return values.map(value => ({
    attackerId: nullableNumber(typeof value?.attacker === 'object' ? value.attacker?.id : value?.attacker ?? value?.attacker_id),
    defenderId: nullableNumber(typeof value?.defender === 'object' ? value.defender?.id : value?.defender ?? value?.defender_id),
    chain: nullableNumber(value?.chain ?? value?.chain_number),
    respect: finiteNumber(value?.respect ?? value?.score ?? value?.respect_gain)
  })).filter(item => item.attackerId && item.defenderId && item.respect > 0);
}

function matchBonusAttack(attacks, bonus, direction, used) {
  let candidates = attacks.filter(attack => !used.has(attack.attackId));
  if (direction === 'outgoing') {
    candidates = candidates.filter(attack => attack.attackerId === bonus.attackerId && attack.defenderId === bonus.defenderId);
  } else {
    candidates = candidates.filter(attack => attack.defenderId === bonus.defenderId && (!attack.attackerId || attack.attackerId === bonus.attackerId));
  }

  const exactChain = bonus.chain
    ? candidates.find(attack => attack.chain === bonus.chain)
    : null;
  if (exactChain) return exactChain;

  const exactRespect = candidates.find(attack => Math.abs(attack.respectGain - bonus.respect) < 0.01);
  if (exactRespect) return exactRespect;

  return null;
}

function ensureMetric(target, playerId) {
  const key = String(playerId);
  if (!target[key]) target[key] = emptyMetric(Number(playerId));
  return target[key];
}

function emptyMetric(playerId) {
  return {
    playerId,
    chainBonusHitsOut: 0,
    chainBonusScoreOut: 0,
    chainBonusHitsIn: 0,
    chainBonusScoreIn: 0,
    chainBonusRespectLostIn: 0
  };
}

async function readCachedAnnotation(db, key) {
  const row = await db.prepare('SELECT value FROM app_meta WHERE key = ?').bind(key).first();
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch (_) { return null; }
}

async function writeCachedAnnotation(db, key, annotation) {
  await db.prepare(`
    INSERT INTO app_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, JSON.stringify(annotation), unixNow()).run();
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

function resolveRange(body) {
  const now = unixNow();
  const from = parseDateStart(body.from) || 0;
  const to = Math.min(now, parseDateEnd(body.to) || now);
  if (from > to) throw httpError(400, 'The selected start date must not be after the end date.');
  return { from, to };
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

function parseDateStart(value) {
  if (!value) return null;
  const timestamp = Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function parseDateEnd(value) {
  if (!value) return null;
  const timestamp = Date.parse(`${String(value).slice(0, 10)}T23:59:59Z`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
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
