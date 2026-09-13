const MANAGED_KEY_CONFIG = 'admin_managed_api_key_v1';
const PAGE_LIMIT = 250;
const TIME_PADDING_SECONDS = 60;
const STATE_PREFIX = 'war_attack_accumulator_v1';
const CHAIN_MILESTONES = new Set([10,25,50,100,250,500,1000,2500,5000,10000,25000,50000,100000]);

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
    await ensureAccessSchema(env.DB);
    await ensureAggregateSchema(env.DB);

    const warId = String(body.warId || '').trim();
    if (!warId) throw httpError(400, 'Missing war ID.');

    const war = await env.DB.prepare(`
      SELECT war_id, report_id, faction_id, opponent_faction_id, start_timestamp, end_timestamp, imported_by_user_id
      FROM wars
      WHERE war_id = ? AND faction_id = ?
    `).bind(warId, factionId).first();

    if (!war) throw httpError(404, 'Imported war not found for this faction.');
    await assertWarAccess(env.DB, user, factionId, war);
    if (!war.start_timestamp || !war.end_timestamp) {
      throw httpError(400, 'Imported war is missing start/end timestamps.');
    }

    let state = await loadAccumulator(env.DB, factionId, warId);

    if (body.finalize === true) {
      if (!state) {
        const finalized = await readFinalizedTotals(env.DB, factionId, warId);
        if (finalized.complete) {
          return json({
            success:true,
            done:true,
            finalized:true,
            warId,
            fetchedThisPage:0,
            storedThisPage:0,
            processedThisPage:0,
            storedTotal:finalized.processedTotal,
            processedTotal:finalized.processedTotal,
            membersWithDetail:finalized.membersWithDetail,
            assists:finalized.assists,
            respectEarned:finalized.respectEarned,
            respectLost:finalized.respectLost,
            scoreAdjustment:finalized.scoreAdjustment,
            metricAdjustment:finalized.scoreAdjustment,
            nextUrl:null,
            source:'v2-faction-attacksfull-aggregate'
          });
        }

        throw httpError(
          409,
          'No attack-detail import is in progress. Start processing before finalizing.'
        );
      }

      const metricAdjustment = await finalizeAccumulator(env.DB, war, state);
      const totals = summarizeAccumulator(state);
      await deleteAccumulator(env.DB, factionId, warId);

      return json({
        success:true,
        done:true,
        finalized:true,
        warId,
        fetchedThisPage:0,
        storedThisPage:0,
        processedThisPage:0,
        storedTotal:totals.processedTotal,
        processedTotal:totals.processedTotal,
        membersWithDetail:totals.membersWithDetail,
        assists:totals.assists,
        respectEarned:totals.respectEarned,
        respectLost:totals.respectLost,
        scoreAdjustment:metricAdjustment,
        metricAdjustment,
        nextUrl:null,
        source:'v2-faction-attacksfull-aggregate'
      });
    }

    if (!state) {
      state = createAccumulator(war);
    }

    if (state.done) {
      const totals = summarizeAccumulator(state);
      return json({
        success:true,
        done:true,
        finalized:false,
        warId,
        fetchedThisPage:0,
        storedThisPage:0,
        processedThisPage:0,
        storedTotal:totals.processedTotal,
        processedTotal:totals.processedTotal,
        membersWithDetail:totals.membersWithDetail,
        assists:totals.assists,
        respectEarned:totals.respectEarned,
        respectLost:totals.respectLost,
        nextUrl:null,
        source:'v2-faction-attacksfull-aggregate'
      });
    }

    const apiKey = await requireFactionApiKey(env, factionId);
    const requestUrl = state.nextUrl
      ? sanitizeNextUrl(state.nextUrl)
      : buildInitialUrl(war);

    const payload = await fetchTornJson(requestUrl, apiKey);
    const rawAttacks = Array.isArray(payload?.attacks) ? payload.attacks : [];
    const exactStart = Number(war.start_timestamp);
    const exactEnd = Number(war.end_timestamp);
    const seen = new Set(state.seenAttackIds || []);
    let processedThisPage = 0;

    for (const attack of rawAttacks.map(normalizeAttack)) {
      if (!attack.attackId || seen.has(attack.attackId)) continue;
      seen.add(attack.attackId);
      if (!attackOverlapsWar(attack, exactStart, exactEnd)) continue;
      accumulateAttack(state, war, attack);
      processedThisPage += 1;
      state.processedTotal += 1;
    }

    state.seenAttackIds = [...seen];
    state.rawFetched = Number(state.rawFetched || 0) + rawAttacks.length;
    state.nextUrl = sanitizeOptionalNextUrl(payload?._metadata?.links?.next);
    state.done = !state.nextUrl;
    state.updatedAt = unixNow();
    await saveAccumulator(env.DB, factionId, warId, state);

    const totals = summarizeAccumulator(state);
    return json({
      success:true,
      done:state.done,
      finalized:false,
      warId,
      fetchedThisPage:rawAttacks.length,
      storedThisPage:processedThisPage,
      processedThisPage,
      storedTotal:totals.processedTotal,
      processedTotal:totals.processedTotal,
      membersWithDetail:totals.membersWithDetail,
      assists:totals.assists,
      respectEarned:totals.respectEarned,
      respectLost:totals.respectLost,
      nextUrl:state.done ? null : state.nextUrl,
      source:'v2-faction-attacksfull-aggregate'
    });
  } catch (error) {
    return json({
      success:false,
      message:error?.message || 'Unexpected attack-detail supplement error.'
    }, error?.status || 500);
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
    try {
      await db.prepare(sql).run();
    } catch (error) {
      if (!/duplicate column|already exists/i.test(String(error?.message || error || ''))) throw error;
    }
  }
}

async function assertWarAccess(db, user, factionId, war) {
  if (Number(user.is_admin) === 1) return;

  const permission = await db.prepare(
    'SELECT owner_user_id, visibility FROM resource_permissions WHERE faction_id = ? AND resource_type = ? AND resource_key = ? LIMIT 1'
  ).bind(factionId, 'war', String(war.war_id)).first();

  if ((permission?.visibility || 'faction') !== 'private') return;

  const permissionOwnerId = Number(permission?.owner_user_id || 0);
  const importOwnerId = Number(war.imported_by_user_id || 0);
  if (permissionOwnerId !== Number(user.user_id) && importOwnerId !== Number(user.user_id)) {
    throw httpError(403, 'This war report is private.');
  }
}

function buildInitialUrl(war) {
  const query = new URLSearchParams({
    limit:String(PAGE_LIMIT),
    sort:'ASC',
    from:String(Number(war.start_timestamp) - TIME_PADDING_SECONDS),
    to:String(Number(war.end_timestamp) + TIME_PADDING_SECONDS),
    comment:'RWEngineWarDetail'
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

async function fetchTornJson(url, apiKey) {
  const response = await fetch(url, {
    headers:{ Accept:'application/json', Authorization:`ApiKey ${apiKey}` }
  });

  let payload;
  try { payload = await response.json(); }
  catch (_) { throw httpError(502, `Torn returned HTTP ${response.status} without valid JSON.`); }

  if (payload?.error) {
    const code = Number(payload.error.code || 0);
    const message = payload.error.error || payload.error.message || 'Unknown Torn API error.';
    if (code === 7 || /incorrect id-entity relation/i.test(String(message))) {
      throw httpError(
        403,
        'Faction API permission is required for attack detail. The API key configured for this faction cannot access faction attack logs.'
      );
    }
    throw httpError(502, `Torn API error: ${message}`);
  }
  if (!response.ok) throw httpError(502, `Torn request failed with HTTP ${response.status}.`);
  return payload;
}

function normalizeAttack(attack) {
  const attacker = attack?.attacker || {};
  const defender = attack?.defender || {};
  return {
    attackId:String(attack?.id || attack?.attack_id || ''),
    attackerId:nullableNumber(attacker?.id ?? attack?.attacker_id),
    defenderId:nullableNumber(defender?.id ?? attack?.defender_id),
    attackerFactionId:factionIdFrom(
      attacker?.faction_id ?? attacker?.faction ?? attack?.attacker_faction_id ?? attack?.attacker_faction
    ),
    defenderFactionId:factionIdFrom(
      defender?.faction_id ?? defender?.faction ?? attack?.defender_faction_id ?? attack?.defender_faction
    ),
    result:String(attack?.result || ''),
    respectGain:finiteNumber(attack?.respect_gain),
    respectLoss:Math.abs(finiteNumber(attack?.respect_loss)),
    chain:nullableNumber(attack?.chain),
    chainModifier:finiteNumber(attack?.modifiers?.chain ?? attack?.modifier?.chain),
    isRankedWar:
      attack?.is_ranked_war === true ||
      attack?.isRankedWar === true ||
      Number(attack?.is_ranked_war || attack?.isRankedWar || 0) === 1,
    timestampStarted:nullableNumber(attack?.started ?? attack?.timestamp_started),
    timestampEnded:nullableNumber(attack?.ended ?? attack?.timestamp_ended)
  };
}

function attackOverlapsWar(attack, exactStart, exactEnd) {
  const started = Number(attack.timestampStarted || 0);
  const ended = Number(attack.timestampEnded || 0);
  if (!started && !ended) return true;
  const effectiveStart = started || ended;
  const effectiveEnd = ended || started;
  return effectiveStart <= exactEnd && effectiveEnd >= exactStart;
}

function createAccumulator(war) {
  return {
    version:1,
    warId:String(war.war_id),
    factionId:Number(war.faction_id),
    opponentFactionId:Number(war.opponent_faction_id || 0),
    processedTotal:0,
    rawFetched:0,
    seenAttackIds:[],
    players:{},
    nextUrl:null,
    done:false,
    verifiedOutgoingScore:0,
    createdAt:unixNow(),
    updatedAt:unixNow()
  };
}

function emptyPlayerMetric(playerId) {
  return {
    playerId:Number(playerId),
    assists:0,
    outsideHits:0,
    scoreDown:0,
    respectEarned:0,
    respectLost:0,
    attackRows:0,
    chainBonusHitsOut:0,
    chainBonusScoreOut:0,
    chainBonusHitsIn:0,
    chainBonusScoreIn:0,
    chainBonusRespectLostIn:0
  };
}

function playerMetric(state, playerId) {
  const id = Number(playerId || 0);
  if (!id) return null;
  const key = String(id);
  if (!state.players[key]) state.players[key] = emptyPlayerMetric(id);
  return state.players[key];
}

function accumulateAttack(state, war, attack) {
  const factionId = Number(war.faction_id);
  const opponentId = Number(war.opponent_faction_id || 0);
  const attackerFactionId = Number(attack.attackerFactionId || 0);
  const defenderFactionId = Number(attack.defenderFactionId || 0);
  const ownOutgoing = attackerFactionId === factionId;
  const ownIncoming = defenderFactionId === factionId;
  const betweenWarFactions = opponentId > 0 && (
    (attackerFactionId === factionId && defenderFactionId === opponentId) ||
    (attackerFactionId === opponentId && defenderFactionId === factionId)
  );
  const ranked = Boolean(attack.isRankedWar || betweenWarFactions);
  const assist = /assist/i.test(String(attack.result || ''));
  const milestone = ranked && !assist && isMilestoneAttack(attack);

  if (ownOutgoing) {
    const metric = playerMetric(state, attack.attackerId);
    if (metric) {
      // The existing war_log definition counts assists across the exact war
      // window, while respect verification is ranked-war only.
      if (assist) metric.assists += 1;

      if (ranked) {
        metric.attackRows += 1;
        if (!assist) {
          metric.respectEarned += Number(attack.respectGain || 0);
          state.verifiedOutgoingScore += Number(attack.respectGain || 0);
          if (milestone) {
            metric.chainBonusHitsOut += 1;
            metric.chainBonusScoreOut += Number(attack.respectGain || 0);
          }
        }
      }

      if (!assist && (opponentId === 0 || defenderFactionId !== opponentId)) {
        metric.outsideHits += 1;
      }
    }
  }

  if (ownIncoming && ranked) {
    const metric = playerMetric(state, attack.defenderId);
    if (metric) {
      metric.attackRows += 1;
      if (!assist) {
        metric.scoreDown += Number(attack.respectGain || 0);
        metric.respectLost += Math.abs(Number(attack.respectLoss || 0));
        if (milestone) {
          metric.chainBonusHitsIn += 1;
          metric.chainBonusScoreIn += Number(attack.respectGain || 0);
          metric.chainBonusRespectLostIn += Math.abs(Number(attack.respectLoss || 0));
        }
      }
    }
  }
}

function isMilestoneAttack(attack) {
  return CHAIN_MILESTONES.has(Number(attack.chain || 0)) || Number(attack.chainModifier || 0) >= 2;
}

function accumulatorKey(factionId, warId) {
  return `${STATE_PREFIX}:${factionId}:${warId}`;
}

async function loadAccumulator(db, factionId, warId) {
  const row = await db.prepare('SELECT value FROM app_meta WHERE key = ?')
    .bind(accumulatorKey(factionId, warId)).first();
  if (!row?.value) return null;
  try {
    const state = JSON.parse(row.value);
    if (!state || typeof state !== 'object') return null;
    state.players = state.players && typeof state.players === 'object' ? state.players : {};
    state.seenAttackIds = Array.isArray(state.seenAttackIds) ? state.seenAttackIds : [];
    state.processedTotal = Number(state.processedTotal || 0);
    state.rawFetched = Number(state.rawFetched || 0);
    state.verifiedOutgoingScore = Number(state.verifiedOutgoingScore || 0);
    return state;
  } catch (_) {
    return null;
  }
}

async function saveAccumulator(db, factionId, warId, state) {
  await db.prepare(`
    INSERT INTO app_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(accumulatorKey(factionId, warId), JSON.stringify(state), unixNow()).run();
}

async function deleteAccumulator(db, factionId, warId) {
  await db.prepare('DELETE FROM app_meta WHERE key = ?')
    .bind(accumulatorKey(factionId, warId)).run();
}

function summarizeAccumulator(state) {
  const metrics = Object.values(state.players || {});
  return {
    processedTotal:Number(state.processedTotal || 0),
    membersWithDetail:metrics.filter(metric => Number(metric.attackRows || 0) > 0).length,
    assists:metrics.reduce((sum, metric) => sum + Number(metric.assists || 0), 0),
    respectEarned:metrics.reduce((sum, metric) => sum + Number(metric.respectEarned || 0), 0),
    respectLost:metrics.reduce((sum, metric) => sum + Number(metric.respectLost || 0), 0)
  };
}

async function finalizeAccumulator(db, war, state) {
  const factionId = Number(war.faction_id);
  const warId = String(war.war_id);
  const rows = await db.prepare(`
    SELECT player_id, COALESCE(NULLIF(score_up_official, 0), score_up, 0) AS official_score_up
    FROM war_log
    WHERE faction_id = ? AND war_id = ?
  `).bind(factionId, warId).all();

  const update = db.prepare(`
    UPDATE war_log
    SET assists = ?,
        outside_hits = ?,
        score_up_official = ?,
        score_up_adjusted = ?,
        score_up = ?,
        score_down = ?,
        respect_earned = ?,
        respect_lost = ?,
        attack_detail_complete = 1,
        attack_detail_rows = ?,
        chain_bonus_hits = ?,
        chain_bonus_score = ?,
        chain_bonus_hits_in = ?,
        chain_bonus_score_in = ?,
        chain_bonus_respect_lost_in = ?,
        synced_at = ?
    WHERE war_id = ? AND faction_id = ? AND player_id = ?
  `);

  const now = unixNow();
  let scoreUp = 0;
  let scoreDown = 0;
  let assists = 0;
  let outsideHits = 0;

  const statements = (rows.results || []).map(row => {
    const playerId = Number(row.player_id);
    const metric = state.players?.[String(playerId)] || emptyPlayerMetric(playerId);
    const officialUp = Number(row.official_score_up || 0);

    scoreUp += officialUp;
    scoreDown += Number(metric.scoreDown || 0);
    assists += Number(metric.assists || 0);
    outsideHits += Number(metric.outsideHits || 0);

    return update.bind(
      Number(metric.assists || 0),
      Number(metric.outsideHits || 0),
      officialUp,
      officialUp,
      officialUp,
      Number(metric.scoreDown || 0),
      Number(metric.respectEarned || 0),
      Number(metric.respectLost || 0),
      Number(metric.attackRows || 0),
      Number(metric.chainBonusHitsOut || 0),
      Number(metric.chainBonusScoreOut || 0),
      Number(metric.chainBonusHitsIn || 0),
      Number(metric.chainBonusScoreIn || 0),
      Number(metric.chainBonusRespectLostIn || 0),
      now,
      warId,
      factionId,
      playerId
    );
  });

  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }

  const summary = {
    scoreUp,
    scoreDown,
    assists,
    outsideHits,
    verifiedOutgoingScore:Number(state.verifiedOutgoingScore || 0),
    outgoingDelta:scoreUp - Number(state.verifiedOutgoingScore || 0),
    chainBonusesIncluded:true,
    scoreSource:'official-report-plus-aggregated-attack-detail'
  };

  return summary;
}

async function readFinalizedTotals(db, factionId, warId) {
  const row = await db.prepare(`
    SELECT
      MIN(COALESCE(attack_detail_complete, 0)) AS all_complete,
      SUM(COALESCE(attack_detail_rows, 0)) AS processed_total,
      SUM(CASE WHEN COALESCE(attack_detail_rows, 0) > 0 THEN 1 ELSE 0 END) AS members_with_detail,
      SUM(COALESCE(assists, 0)) AS assists,
      SUM(COALESCE(respect_earned, 0)) AS respect_earned,
      SUM(COALESCE(respect_lost, 0)) AS respect_lost,
      SUM(COALESCE(score_up_official, score_up, 0)) AS score_up,
      SUM(COALESCE(score_down, 0)) AS score_down,
      SUM(COALESCE(outside_hits, 0)) AS outside_hits
    FROM war_log
    WHERE faction_id = ? AND war_id = ?
  `).bind(factionId, warId).first();

  const complete = Number(row?.all_complete || 0) === 1;
  const scoreAdjustment = complete ? {
    scoreUp:Number(row?.score_up || 0),
    scoreDown:Number(row?.score_down || 0),
    assists:Number(row?.assists || 0),
    outsideHits:Number(row?.outside_hits || 0),
    verifiedOutgoingScore:null,
    outgoingDelta:null,
    chainBonusesIncluded:true,
    scoreSource:'stored-aggregate'
  } : null;

  return {
    complete,
    processedTotal:Number(row?.processed_total || 0),
    membersWithDetail:Number(row?.members_with_detail || 0),
    assists:Number(row?.assists || 0),
    respectEarned:Number(row?.respect_earned || 0),
    respectLost:Number(row?.respect_lost || 0),
    scoreAdjustment
  };
}

function factionIdFrom(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') {
    return nullableNumber(value.id ?? value.faction_id ?? value.factionId);
  }
  return nullableNumber(value);
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
