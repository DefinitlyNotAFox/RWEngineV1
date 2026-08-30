const MANAGED_KEY_CONFIG = 'admin_managed_api_key_v1';
const ATTACK_PAGE_SOFT_LIMIT = 100;
const ATTACK_FETCH_MAX_WINDOWS = 800;
const ATTACK_FETCH_WINDOWS_PER_STEP = 5;
const ATTACK_TIME_PADDING_SECONDS = 60;
const ATTACK_MIN_SPLIT_SECONDS = 1;
const CHAIN_REPORT_OVERLAP_PADDING_SECONDS = 3600;

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') return json({ success: false, message: 'Method not allowed. Use POST.' }, 405);
    requireDb(env);
    requireSecret(env);

    const body = await readJson(request);
    const user = await getAdminUser(env, request);
    const faction = await requireTrackedFaction(env.DB, body.factionId);
    const factionId = Number(faction.faction_id);
    const action = String(body.action || 'getImportedWars');

    if (action === 'getImportedWars') return handleGetImportedWars(env.DB, factionId);
    if (action === 'checkImportStatus') return handleCheckImportStatus(env.DB, factionId, body);
    if (action === 'importRankedWarReport') return handleImportRankedWarReport(env, user, faction, body);
    if (action === 'applyAttackSummary') return handleApplyAttackSummary(env, faction, body);
    if (action === 'applyChainBonusAdjustment') return handleApplyChainBonusAdjustment(env, faction, body);

    return json({ success: false, message: `Unknown historical import action: ${action}` }, 400);
  } catch (error) {
    return json({ success: false, message: error?.message || 'Unexpected historical import error.' }, error?.status || 500);
  }
}

async function handleGetImportedWars(db, factionId) {
  const result = await db.prepare(`
    SELECT war_id, report_id, faction_id, faction_name, opponent_faction_id,
           opponent_faction_name, start_timestamp, end_timestamp, imported_at,
           chain_adjusted_at, chain_adjustment_status, chain_adjustment_message
    FROM wars
    WHERE faction_id = ?
    ORDER BY COALESCE(end_timestamp, start_timestamp, imported_at, 0) DESC
    LIMIT 200
  `).bind(factionId).all();
  return json({ success: true, message: 'Imported wars loaded.', wars: result.results || [] });
}

async function handleCheckImportStatus(db, factionId, body) {
  const rankId = String(body.rankId || '').trim();
  if (!rankId) throw httpError(400, 'Missing ranked war report ID.');
  const existing = await getExistingImportedWar(db, factionId, rankId);
  return json({ success: true, exists: Boolean(existing), war: existing });
}

async function handleImportRankedWarReport(env, user, faction, body) {
  const factionId = Number(faction.faction_id);
  const rankId = String(body.rankId || '').trim();
  const overwrite = body.overwrite === true;
  if (!rankId) throw httpError(400, 'Missing ranked war report ID.');

  const existingBefore = await getExistingImportedWar(env.DB, factionId, rankId);
  if (existingBefore && !overwrite) {
    return json({ success: true, skipped: true, message: 'War already imported. Skipped.', war: existingBefore });
  }

  const apiKey = await requireFactionApiKey(env, factionId);
  const rawReport = await fetchRankedWarReport(rankId, apiKey);
  const normalized = normalizeRankedWarReport(rawReport, rankId, factionId);
  const existingAfter = await getExistingImportedWar(env.DB, factionId, normalized.warId);

  if (existingAfter && !overwrite) {
    return json({ success: true, skipped: true, message: 'War already imported. Skipped.', war: existingAfter });
  }

  await deleteAttackSummaryState(env.DB, factionId, normalized.warId);
  const now = unixNow();

  await env.DB.prepare(`
    INSERT INTO wars (
      war_id, faction_id, faction_name, opponent_faction_id, opponent_faction_name,
      start_timestamp, end_timestamp, report_id, war_type, imported_by_user_id,
      imported_at, updated_at, chain_adjusted_at, chain_adjustment_status,
      chain_adjustment_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ranked', ?, ?, ?, NULL, NULL, NULL)
    ON CONFLICT(war_id) DO UPDATE SET
      faction_id = excluded.faction_id,
      faction_name = excluded.faction_name,
      opponent_faction_id = excluded.opponent_faction_id,
      opponent_faction_name = excluded.opponent_faction_name,
      start_timestamp = excluded.start_timestamp,
      end_timestamp = excluded.end_timestamp,
      report_id = excluded.report_id,
      imported_by_user_id = excluded.imported_by_user_id,
      imported_at = excluded.imported_at,
      updated_at = excluded.updated_at,
      chain_adjusted_at = NULL,
      chain_adjustment_status = NULL,
      chain_adjustment_message = NULL
  `).bind(
    normalized.warId, factionId, normalized.factionName,
    normalized.opponentFactionId, normalized.opponentFactionName,
    normalized.startTimestamp, normalized.endTimestamp, normalized.reportId,
    Number(user.user_id), now, now
  ).run();

  await env.DB.prepare(`DELETE FROM war_log WHERE war_id = ? AND faction_id = ?`)
    .bind(normalized.warId, factionId).run();
  await env.DB.prepare(`DELETE FROM attacks WHERE war_id = ? AND faction_id = ?`)
    .bind(normalized.warId, factionId).run();

  const insert = env.DB.prepare(`
    INSERT INTO war_log (
      war_id, faction_id, player_id, player_name, is_member, termed,
      war_hits, outside_hits, assists, score_up, score_up_official,
      score_up_adjusted, chain_bonus_score, chain_bonus_hits, score_down, synced_at
    ) VALUES (?, ?, ?, ?, 1, 0, ?, 0, 0, ?, ?, ?, 0, 0, 0, ?)
  `);

  for (let index = 0; index < normalized.members.length; index += 50) {
    await env.DB.batch(normalized.members.slice(index, index + 50).map(member => insert.bind(
      normalized.warId, factionId, member.playerId, member.playerName,
      member.warHits, member.scoreUp, member.scoreUp, member.scoreUp, now
    )));
  }

  const chainAdjustment = await applyChainBonusAdjustment(env, apiKey, normalized);

  return json({
    success: true,
    skipped: false,
    overwritten: Boolean(existingBefore || existingAfter),
    message: `War imported for ${faction.faction_name}. Members added: ${normalized.members.length}.`,
    chainAdjustment,
    war: {
      warId: normalized.warId,
      reportId: normalized.reportId,
      factionId,
      factionName: normalized.factionName,
      opponentFactionId: normalized.opponentFactionId,
      opponentFactionName: normalized.opponentFactionName,
      startTimestamp: normalized.startTimestamp,
      endTimestamp: normalized.endTimestamp,
      membersAdded: normalized.members.length
    }
  });
}

async function handleApplyAttackSummary(env, faction, body) {
  const factionId = Number(faction.faction_id);
  const warId = String(body.warId || '').trim();
  const reset = body.reset === true;
  if (!warId) throw httpError(400, 'Missing war ID.');

  const war = await env.DB.prepare(`
    SELECT war_id, faction_id, faction_name, opponent_faction_id,
           opponent_faction_name, start_timestamp, end_timestamp
    FROM wars WHERE war_id = ? AND faction_id = ?
  `).bind(warId, factionId).first();
  if (!war) throw httpError(404, `War not found for ${faction.faction_name}.`);
  if (!war.start_timestamp || !war.end_timestamp) throw httpError(400, 'War is missing start/end timestamps.');

  const apiKey = await requireFactionApiKey(env, factionId);
  let state;

  if (reset) {
    await deleteAttackSummaryState(env.DB, factionId, warId);
    await env.DB.prepare(`DELETE FROM attacks WHERE war_id = ? AND faction_id = ?`).bind(warId, factionId).run();
    await env.DB.prepare(`
      UPDATE war_log SET outside_hits = 0, assists = 0, score_down = 0, synced_at = ?
      WHERE war_id = ? AND faction_id = ?
    `).bind(unixNow(), warId, factionId).run();
    state = createAttackSummaryState(war);
  } else {
    state = await loadAttackSummaryState(env.DB, factionId, warId) || createAttackSummaryState(war);
  }

  state = normalizeAttackSummaryState(state, war);
  const callsThisStep = await processAttackSummaryStep(env.DB, apiKey, war, state);
  const done = state.pendingWindows.length === 0;

  if (!done) {
    await saveAttackSummaryState(env.DB, factionId, warId, state);
    return json({
      success: true, message: 'Attack summary partially processed.', done: false,
      warId, callsThisStep, pendingWindows: state.pendingWindows.length,
      summary: publicAttackSummary(state)
    });
  }

  await applyAttackSummaryToWarLog(env.DB, war, Object.values(state.players));
  await deleteAttackSummaryState(env.DB, factionId, warId);
  return json({
    success: true, message: 'Attack summary applied.', done: true,
    warId, callsThisStep, pendingWindows: 0, summary: publicAttackSummary(state)
  });
}

async function handleApplyChainBonusAdjustment(env, faction, body) {
  const factionId = Number(faction.faction_id);
  const warId = String(body.warId || '').trim();
  if (!warId) throw httpError(400, 'Missing war ID.');
  const war = await env.DB.prepare(`
    SELECT war_id, report_id, faction_id, faction_name, opponent_faction_id,
           opponent_faction_name, start_timestamp, end_timestamp
    FROM wars WHERE war_id = ? AND faction_id = ?
  `).bind(warId, factionId).first();
  if (!war) throw httpError(404, `War not found for ${faction.faction_name}.`);
  const apiKey = await requireFactionApiKey(env, factionId);
  const result = await applyChainBonusAdjustment(env, apiKey, {
    warId: String(war.war_id), reportId: String(war.report_id || war.war_id),
    factionId, factionName: war.faction_name,
    opponentFactionId: Number(war.opponent_faction_id || 0),
    opponentFactionName: war.opponent_faction_name,
    startTimestamp: Number(war.start_timestamp), endTimestamp: Number(war.end_timestamp)
  });
  return json({ success: true, message: 'Chain bonus adjustment checked.', chainAdjustment: result });
}

async function processAttackSummaryStep(db, apiKey, war, state) {
  const seen = new Set(state.seenAttackIds || []);
  let calls = 0;

  while (state.pendingWindows.length && calls < ATTACK_FETCH_WINDOWS_PER_STEP) {
    if (state.stats.windowsFetched >= ATTACK_FETCH_MAX_WINDOWS) {
      throw new Error(`Attack summary stopped after ${ATTACK_FETCH_MAX_WINDOWS} windows.`);
    }

    const window = state.pendingWindows.shift();
    const page = await fetchFactionAttacksPage(apiKey, window.from, window.to);
    calls += 1;
    state.stats.windowsFetched += 1;
    state.stats.rawAttackRowsReturned += page.attacks.length;

    const windowSize = Number(window.to) - Number(window.from);
    const capped = page.attacks.length >= ATTACK_PAGE_SOFT_LIMIT;
    if (capped && windowSize > ATTACK_MIN_SPLIT_SECONDS) {
      state.stats.splitWindows += 1;
      const mid = Math.floor(Number(window.from) + windowSize / 2);
      state.pendingWindows.unshift({ from: mid + 1, to: Number(window.to) });
      state.pendingWindows.unshift({ from: Number(window.from), to: mid });
      continue;
    }
    if (capped) state.stats.saturatedLeafWindows += 1;

    for (const attack of page.attacks) {
      if (!attack.attackId || seen.has(attack.attackId)) continue;
      seen.add(attack.attackId);
      const timestamp = Number(attack.timestampEnded || attack.timestampStarted || 0);
      if (timestamp && (timestamp < state.exactStartTimestamp || timestamp > state.exactEndTimestamp)) {
        state.stats.ignoredOutsideExactWarWindow += 1;
        continue;
      }

      state.stats.checked += 1;
      state.stats.uniqueAttacksFetched += 1;
      summarizeAttackIntoState(state, attack, war);
      await storeAttack(db, war, attack);
    }
  }

  state.seenAttackIds = [...seen];
  state.updatedAt = unixNow();
  return calls;
}

async function storeAttack(db, war, attack) {
  const factionId = Number(war.faction_id);
  const opponentId = Number(war.opponent_faction_id || 0);
  const outgoing = Number(attack.attackerFactionId || 0) === factionId;
  const incoming = Number(attack.defenderFactionId || 0) === factionId;
  const fromOpponent = opponentId && Number(attack.attackerFactionId || 0) === opponentId;
  const respectGain = outgoing && !attack.isAssist ? Number(attack.scoreGain || 0) : 0;
  const respectLoss = incoming && fromOpponent && !attack.isAssist ? Number(attack.scoreGain || 0) : 0;

  await db.prepare(`
    INSERT INTO attacks (
      attack_id, war_id, faction_id, attacker_id, attacker_name, defender_id,
      defender_name, attacker_faction_id, defender_faction_id, result,
      respect_gain, respect_loss, chain, is_ranked_war, timestamp_started,
      timestamp_ended, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(attack_id) DO UPDATE SET
      war_id = excluded.war_id, faction_id = excluded.faction_id,
      attacker_id = excluded.attacker_id, attacker_name = excluded.attacker_name,
      defender_id = excluded.defender_id, defender_name = excluded.defender_name,
      attacker_faction_id = excluded.attacker_faction_id,
      defender_faction_id = excluded.defender_faction_id, result = excluded.result,
      respect_gain = excluded.respect_gain, respect_loss = excluded.respect_loss,
      is_ranked_war = excluded.is_ranked_war,
      timestamp_started = excluded.timestamp_started,
      timestamp_ended = excluded.timestamp_ended, raw_json = excluded.raw_json
  `).bind(
    attack.attackId, String(war.war_id), factionId,
    nullableNumber(attack.attackerId), attack.attackerName || null,
    nullableNumber(attack.defenderId), attack.defenderName || null,
    nullableNumber(attack.attackerFactionId), nullableNumber(attack.defenderFactionId),
    attack.result || '', respectGain, respectLoss, attack.isRankedWar ? 1 : 0,
    nullableNumber(attack.timestampStarted), nullableNumber(attack.timestampEnded),
    JSON.stringify(attack.raw || {}), unixNow()
  ).run();
}

function summarizeAttackIntoState(state, attack, war) {
  const factionId = Number(war.faction_id);
  const opponentId = Number(war.opponent_faction_id || 0);
  const attackerFactionId = Number(attack.attackerFactionId || 0);
  const defenderFactionId = Number(attack.defenderFactionId || 0);
  const ourOutgoing = attackerFactionId === factionId;
  const incoming = defenderFactionId === factionId;
  const againstOpponent = opponentId && defenderFactionId === opponentId;
  const fromOpponent = opponentId && attackerFactionId === opponentId;
  const score = Number(attack.scoreGain || 0);

  if (ourOutgoing && attack.isAssist) {
    getAttackPlayerSummary(state.players, attack.attackerId, attack.attackerName).assists += 1;
    state.stats.assists += 1;
    return;
  }
  if (ourOutgoing && !attack.isAssist && !againstOpponent) {
    getAttackPlayerSummary(state.players, attack.attackerId, attack.attackerName).outsideHits += 1;
    state.stats.outsideHits += 1;
    return;
  }
  if (incoming && fromOpponent && !attack.isAssist) {
    getAttackPlayerSummary(state.players, attack.defenderId, attack.defenderName).scoreDown += score;
    state.stats.scoreDown += score;
    if (attack.isRankedWar) {
      state.stats.scoreDownRankedWarOnly += score;
      state.stats.scoreDownRankedWarOnlyCount += 1;
    } else {
      state.stats.scoreDownNonRankedWar += score;
      state.stats.scoreDownNonRankedWarCount += 1;
    }
  }
}

function createAttackSummaryState(war) {
  const exactStartTimestamp = Number(war.start_timestamp);
  const exactEndTimestamp = Number(war.end_timestamp);
  const fetchStartTimestamp = exactStartTimestamp - ATTACK_TIME_PADDING_SECONDS;
  const fetchEndTimestamp = exactEndTimestamp + ATTACK_TIME_PADDING_SECONDS;
  return {
    warId: String(war.war_id), factionId: Number(war.faction_id),
    exactStartTimestamp, exactEndTimestamp, fetchStartTimestamp, fetchEndTimestamp,
    pendingWindows: [{ from: fetchStartTimestamp, to: fetchEndTimestamp }],
    seenAttackIds: [],
    stats: {
      checked: 0, ignoredOutsideExactWarWindow: 0, rawAttackRowsReturned: 0,
      uniqueAttacksFetched: 0, windowsFetched: 0, splitWindows: 0,
      saturatedLeafWindows: 0, outsideHits: 0, assists: 0, scoreDown: 0,
      scoreDownRankedWarOnly: 0, scoreDownNonRankedWar: 0,
      scoreDownRankedWarOnlyCount: 0, scoreDownNonRankedWarCount: 0
    },
    players: {}, createdAt: unixNow(), updatedAt: unixNow()
  };
}

function normalizeAttackSummaryState(state, war) {
  const fresh = createAttackSummaryState(war);
  state.warId = fresh.warId;
  state.factionId = fresh.factionId;
  state.exactStartTimestamp = Number(state.exactStartTimestamp || fresh.exactStartTimestamp);
  state.exactEndTimestamp = Number(state.exactEndTimestamp || fresh.exactEndTimestamp);
  state.fetchStartTimestamp = Number(state.fetchStartTimestamp || fresh.fetchStartTimestamp);
  state.fetchEndTimestamp = Number(state.fetchEndTimestamp || fresh.fetchEndTimestamp);
  if (!Array.isArray(state.pendingWindows)) state.pendingWindows = fresh.pendingWindows;
  if (!Array.isArray(state.seenAttackIds)) state.seenAttackIds = [];
  state.stats = { ...fresh.stats, ...(state.stats || {}) };
  if (!state.players || typeof state.players !== 'object') state.players = {};
  state.updatedAt = unixNow();
  return state;
}

function getAttackPlayerSummary(players, playerId, playerName) {
  const id = String(Number(playerId));
  if (!players[id]) players[id] = {
    playerId: Number(playerId), playerName: playerName || `Player ${playerId}`,
    outsideHits: 0, assists: 0, scoreDown: 0
  };
  return players[id];
}

function publicAttackSummary(state) {
  return { ...state.stats, playersUpdated: Object.keys(state.players || {}).length };
}

async function applyAttackSummaryToWarLog(db, war, rows) {
  const now = unixNow();
  await db.prepare(`
    UPDATE war_log SET outside_hits = 0, assists = 0, score_down = 0, synced_at = ?
    WHERE war_id = ? AND faction_id = ?
  `).bind(now, war.war_id, war.faction_id).run();

  const upsert = db.prepare(`
    INSERT INTO war_log (
      war_id, faction_id, player_id, player_name, is_member, termed,
      war_hits, outside_hits, assists, score_up, score_up_official,
      score_up_adjusted, chain_bonus_score, chain_bonus_hits, score_down, synced_at
    ) VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, 0, 0, 0, 0, 0, ?, ?)
    ON CONFLICT(war_id, player_id) DO UPDATE SET
      player_name = excluded.player_name, outside_hits = excluded.outside_hits,
      assists = excluded.assists, score_down = excluded.score_down,
      synced_at = excluded.synced_at
  `);
  for (let index = 0; index < rows.length; index += 50) {
    await db.batch(rows.slice(index, index + 50).map(row => upsert.bind(
      war.war_id, war.faction_id, row.playerId, row.playerName,
      row.outsideHits, row.assists, row.scoreDown, now
    )));
  }
}

function attackSummaryStateKey(factionId, warId) {
  return `attack_summary:${factionId}:${warId}`;
}
async function loadAttackSummaryState(db, factionId, warId) {
  const row = await db.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(attackSummaryStateKey(factionId, warId)).first();
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch (_) { return null; }
}
async function saveAttackSummaryState(db, factionId, warId, state) {
  await db.prepare(`
    INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(attackSummaryStateKey(factionId, warId), JSON.stringify(state), unixNow()).run();
}
async function deleteAttackSummaryState(db, factionId, warId) {
  await db.prepare(`DELETE FROM app_meta WHERE key = ?`).bind(attackSummaryStateKey(factionId, warId)).run();
}

async function applyChainBonusAdjustment(env, apiKey, war) {
  const startedAt = unixNow();
  try {
    await env.DB.prepare(`
      UPDATE war_log SET
        score_up_official = CASE WHEN score_up_official > 0 THEN score_up_official ELSE score_up END,
        score_up_adjusted = CASE WHEN score_up_official > 0 THEN score_up_official ELSE score_up END,
        score_up = CASE WHEN score_up_official > 0 THEN score_up_official ELSE score_up END,
        chain_bonus_score = 0, chain_bonus_hits = 0, synced_at = ?
      WHERE war_id = ? AND faction_id = ?
    `).bind(startedAt, war.warId, war.factionId).run();

    const chainsResult = await fetchFactionChains(apiKey, war);
    if (!chainsResult.success) {
      await saveChainStatus(env.DB, war, 'skipped', chainsResult.message, startedAt);
      return { applied: false, status: 'skipped', message: chainsResult.message, bonusHits: 0, bonusScore: 0 };
    }

    const overlapping = normalizeFactionChains(chainsResult.data).filter(chain => chainOverlapsWar(chain, war));
    if (!overlapping.length) {
      const message = 'No completed faction chains overlapped this war window.';
      await saveChainStatus(env.DB, war, 'skipped', message, startedAt);
      return { applied: false, status: 'skipped', message, bonusHits: 0, bonusScore: 0 };
    }

    const bonusByAttacker = new Map();
    for (const chain of overlapping) {
      const report = await fetchChainReportById(apiKey, chain.chainId);
      if (!report.success) continue;
      for (const bonus of normalizeChainReport(report.data).bonuses) {
        const current = bonusByAttacker.get(bonus.attackerId) || { playerId: bonus.attackerId, hits: 0, score: 0 };
        current.hits += 1;
        current.score += Number(bonus.respect || 0);
        bonusByAttacker.set(bonus.attackerId, current);
      }
    }

    let appliedRows = 0;
    let bonusHits = 0;
    let bonusScore = 0;
    for (const bonus of bonusByAttacker.values()) {
      const result = await env.DB.prepare(`
        UPDATE war_log SET chain_bonus_score = ?, chain_bonus_hits = ?,
          score_up_adjusted = MAX(0, score_up_official - ?),
          score_up = MAX(0, score_up_official - ?), synced_at = ?
        WHERE war_id = ? AND faction_id = ? AND player_id = ?
      `).bind(bonus.score, bonus.hits, bonus.score, bonus.score, startedAt,
        war.warId, war.factionId, bonus.playerId).run();
      if (Number(result.meta?.changes || 0) > 0) {
        appliedRows += Number(result.meta.changes || 0);
        bonusHits += bonus.hits;
        bonusScore += bonus.score;
      }
    }

    const status = appliedRows ? 'applied' : 'skipped';
    const message = appliedRows ? `Applied chain bonus adjustment to ${appliedRows} member rows.` : 'No chain bonus attackers matched imported members.';
    await saveChainStatus(env.DB, war, status, message, startedAt);
    return { applied: Boolean(appliedRows), status, message, bonusHits, bonusScore, matchedPlayers: appliedRows };
  } catch (error) {
    const message = error?.message || 'Chain adjustment failed.';
    await saveChainStatus(env.DB, war, 'error', message, startedAt);
    return { applied: false, status: 'error', message, bonusHits: 0, bonusScore: 0 };
  }
}

async function saveChainStatus(db, war, status, message, timestamp) {
  await db.prepare(`
    UPDATE wars SET chain_adjusted_at = ?, chain_adjustment_status = ?,
      chain_adjustment_message = ?, updated_at = ?
    WHERE war_id = ? AND faction_id = ?
  `).bind(timestamp, status, message, timestamp, war.warId, war.factionId).run();
}

async function fetchRankedWarReport(rankId, apiKey) {
  const v2 = await fetchTornJson(`https://api.torn.com/v2/faction/${encodeURIComponent(rankId)}/rankedwarreport?key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}`);
  if (v2.success) return v2.data;
  const v1 = await fetchTornJson(`https://api.torn.com/torn/${encodeURIComponent(rankId)}?selections=rankedwarreport&key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}`);
  if (v1.success) return v1.data;
  throw new Error(v2.message || v1.message || 'Failed to fetch ranked war report.');
}

async function fetchFactionAttacksPage(apiKey, from, to) {
  const result = await fetchTornJson(`https://api.torn.com/faction/?selections=attacks&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}`);
  if (!result.success) throw new Error(result.message || 'Failed to fetch faction attacks.');
  const raw = result.data.attacks || result.data.faction_attacks || {};
  return { attacks: normalizeAttackEntries(raw).map(([id, attack]) => normalizeAttack(id, attack)).filter(row => row.attackId) };
}

async function fetchFactionChains(apiKey, war) {
  const from = Number(war.startTimestamp) - CHAIN_REPORT_OVERLAP_PADDING_SECONDS;
  const to = Number(war.endTimestamp) + CHAIN_REPORT_OVERLAP_PADDING_SECONDS;
  const urls = [
    `https://api.torn.com/faction/?selections=chains&from=${from}&to=${to}&key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}`,
    `https://api.torn.com/v2/faction/chains?from=${from}&to=${to}&key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}`
  ];
  const sources = [];
  for (const url of urls) {
    const result = await fetchTornJson(url);
    if (result.success) sources.push({ data: result.data });
  }
  return sources.length ? { success: true, data: { chain_sources: sources } } : { success: false, message: 'Faction chains could not be fetched.' };
}

async function fetchChainReportById(apiKey, chainId) {
  return fetchTornJson(`https://api.torn.com/v2/faction/${encodeURIComponent(chainId)}/chainreport?key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}`);
}

async function fetchTornJson(url) {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    let data;
    try { data = await response.json(); } catch (_) { return { success: false, message: 'Torn returned invalid JSON.' }; }
    if (data?.error) return { success: false, message: `Torn API error: ${data.error.error || data.error.message || 'Unknown error.'}` };
    if (!response.ok) return { success: false, message: `Torn API request failed with status ${response.status}.` };
    return { success: true, data };
  } catch (error) {
    return { success: false, message: error?.message || 'Torn API request failed.' };
  }
}

function normalizeRankedWarReport(rawData, rankId, ownFactionId) {
  const report = rawData.rankedwarreport || rawData.ranked_war_report || rawData.rankedWarReport || rawData.report || rawData;
  const entries = normalizeFactionEntries(report.factions || report.faction || rawData.factions || {});
  if (!entries.length) throw new Error('Ranked war report did not contain faction data.');
  const ownEntry = entries.find(([id, f]) => factionEntryId(id, f) === ownFactionId);
  if (!ownEntry) throw new Error(`This report does not contain selected faction ID (${ownFactionId}).`);
  const opponentEntry = entries.find(([id, f]) => factionEntryId(id, f) !== ownFactionId) || [null, {}];
  const [ownId, own] = ownEntry;
  const [opponentId, opponent] = opponentEntry;
  const factionId = factionEntryId(ownId, own) || ownFactionId;
  const opponentFactionId = factionEntryId(opponentId, opponent) || null;
  const warInfo = report.war || report.ranked_war || report.rankedWar || {};
  const startTimestamp = pickNumber(warInfo, ['start','started','start_timestamp','startTimestamp']) || pickNumber(report, ['start','started','start_timestamp','startTimestamp']) || null;
  const endTimestamp = pickNumber(warInfo, ['end','ended','end_timestamp','endTimestamp']) || pickNumber(report, ['end','ended','end_timestamp','endTimestamp']) || null;
  const members = normalizeMemberEntries(own.members || own.member || {}).map(([id, member]) => {
    const playerId = Number(id) || Number(member.id) || Number(member.user_id) || Number(member.player_id) || Number(member.playerId);
    return {
      playerId,
      playerName: pickString(member, ['name','player_name','playerName']) || `Player ${playerId}`,
      warHits: pickNumber(member, ['attacks','hits','war_hits','warHits','attacks_made']),
      scoreUp: pickNumber(member, ['score','score_gain','scoreGain','points','points_gained','respect','respect_gain','respectGain','respect_gained'])
    };
  }).filter(member => member.playerId);
  if (!members.length) throw new Error('No member rows found in the ranked war report.');
  return {
    warId: String(rankId), reportId: String(rankId), factionId,
    factionName: pickString(own, ['name','faction_name','factionName']) || 'Unknown faction',
    opponentFactionId,
    opponentFactionName: pickString(opponent, ['name','faction_name','factionName']) || 'Unknown opponent',
    startTimestamp, endTimestamp, members
  };
}

function normalizeAttack(attackId, attack) {
  const attackerId = pickNumber(attack, ['attacker_id','attackerId']) || pickNumber(attack.attacker || {}, ['id','user_id','player_id']);
  const defenderId = pickNumber(attack, ['defender_id','defenderId']) || pickNumber(attack.defender || {}, ['id','user_id','player_id']);
  const result = pickString(attack, ['result','attack_result','attackResult']) || '';
  const assistValue = Number(attack.modifiers?.assist);
  const isAssist = result.toLowerCase().includes('assist') || attack.is_assist === true || Number(attack.is_assist || 0) === 1 || attack.assist === true || Number(attack.assist || 0) === 1 || attack.modifiers?.assist === true || (attack.modifiers && Object.prototype.hasOwnProperty.call(attack.modifiers, 'assist') && attack.modifiers.assist !== false && (!Number.isFinite(assistValue) || assistValue !== 0));
  const isRankedWar = attack.is_ranked_war === true || attack.isRankedWar === true || attack.ranked_war === true || attack.rankedWar === true || Number(attack.is_ranked_war || attack.isRankedWar || attack.ranked_war || attack.rankedWar || 0) === 1 || attack.modifiers?.ranked_war === true || attack.modifiers?.rankedWar === true || Number(attack.modifiers?.ranked_war || attack.modifiers?.rankedWar || 0) === 1;
  return {
    attackId: String(attackId || attack.id || attack.attack_id || ''),
    attackerId,
    attackerName: pickString(attack, ['attacker_name','attackerName']) || pickString(attack.attacker || {}, ['name']) || `Player ${attackerId}`,
    defenderId,
    defenderName: pickString(attack, ['defender_name','defenderName']) || pickString(attack.defender || {}, ['name']) || `Player ${defenderId}`,
    attackerFactionId: parseFactionId(attack.attacker_faction_id ?? attack.attackerFactionId ?? attack.attacker_faction ?? attack.attackerFaction ?? attack.attacker?.faction),
    defenderFactionId: parseFactionId(attack.defender_faction_id ?? attack.defenderFactionId ?? attack.defender_faction ?? attack.defenderFaction ?? attack.defender?.faction),
    result, isAssist, isRankedWar,
    scoreGain: pickNumber(attack, ['score','score_gain','scoreGain','points','points_gained','respect_gain','respectGain','respect','respect_gained']),
    timestampStarted: pickNumber(attack, ['timestamp_started','timestampStarted','started','start']),
    timestampEnded: pickNumber(attack, ['timestamp_ended','timestampEnded','ended','end']),
    raw: attack
  };
}

function normalizeFactionChains(rawData) {
  const sources = Array.isArray(rawData.chain_sources) ? rawData.chain_sources : [{ data: rawData }];
  const map = new Map();
  for (const source of sources) {
    const chains = source.data?.chains || source.data?.faction_chains || source.data?.chain || [];
    for (const [id, chain] of normalizeGenericEntries(chains)) {
      const chainId = pickNumber(chain, ['chain','id','chain_id','chainId']) || Number(id);
      const startTimestamp = pickTimestamp(chain, ['start','started','start_at','started_at','start_timestamp','timestamp_started','startTimestamp']);
      const endTimestamp = pickTimestamp(chain, ['end','ended','end_at','ended_at','end_timestamp','timestamp_ended','endTimestamp','finish','finished','finished_at']);
      if (chainId && startTimestamp && endTimestamp) map.set(String(chainId), { chainId, startTimestamp, endTimestamp });
    }
  }
  return [...map.values()];
}

function normalizeChainReport(rawData) {
  const report = rawData.chainreport || rawData.chain_report || rawData.chainReport || rawData.report || rawData;
  const rawBonuses = report.bonuses || report.bonus_hits || report.bonusHits || report.bonus || [];
  const bonuses = normalizeGenericEntries(rawBonuses).map(([, bonus]) => ({
    attackerId: pickNumber(bonus, ['attacker','attacker_id','attackerId']) || pickNumber(bonus.attacker || {}, ['id','user_id','player_id']),
    respect: pickNumber(bonus, ['respect','score','score_gain','respect_gain'])
  })).filter(row => row.attackerId && row.respect);
  return { bonuses };
}

function chainOverlapsWar(chain, war) {
  return Number(chain.startTimestamp) - CHAIN_REPORT_OVERLAP_PADDING_SECONDS <= Number(war.endTimestamp) &&
    Number(chain.endTimestamp) + CHAIN_REPORT_OVERLAP_PADDING_SECONDS >= Number(war.startTimestamp);
}

function normalizeFactionEntries(value) { return normalizeGenericEntries(value); }
function normalizeMemberEntries(value) { return normalizeGenericEntries(value); }
function normalizeAttackEntries(value) { return normalizeGenericEntries(value); }
function normalizeGenericEntries(value) {
  if (Array.isArray(value)) return value.map((item, index) => [String(item?.id || item?.faction_id || item?.player_id || item?.attack_id || index), item]);
  if (value && typeof value === 'object') return Object.entries(value);
  return [];
}
function factionEntryId(id, faction) {
  return Number(id) || Number(faction?.id) || Number(faction?.faction_id) || Number(faction?.factionId) || 0;
}
function parseFactionId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || typeof value === 'string') {
    const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (typeof value === 'object') {
    const n = Number(value.id) || Number(value.faction_id) || Number(value.factionId);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

async function getExistingImportedWar(db, factionId, rankId) {
  return db.prepare(`
    SELECT war_id, report_id, faction_id, faction_name, opponent_faction_id,
           opponent_faction_name, start_timestamp, end_timestamp, imported_at
    FROM wars WHERE faction_id = ? AND (war_id = ? OR report_id = ?) LIMIT 1
  `).bind(factionId, rankId, rankId).first();
}

async function getAdminUser(env, request) {
  const token = getCookie(request, 'rwengine_session');
  if (!token) throw httpError(401, 'Not logged in.');
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`
    SELECT users.user_id, users.player_id, users.player_name, users.faction_id,
           users.faction_name, users.is_admin, users.is_disabled
    FROM sessions JOIN users ON users.user_id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).bind(tokenHash, unixNow()).first();
  if (!row) throw httpError(401, 'Session expired or invalid.');
  if (Number(row.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  if (Number(row.is_admin) !== 1) throw httpError(403, 'Administrator access required.');
  return row;
}

async function requireTrackedFaction(db, factionIdValue) {
  const factionId = Number(factionIdValue || 0);
  if (!Number.isSafeInteger(factionId) || factionId <= 0) throw httpError(400, 'A valid faction ID is required.');
  const row = await db.prepare(`SELECT faction_id, faction_name FROM factions WHERE faction_id = ? AND enabled = 1`).bind(factionId).first();
  if (!row) throw httpError(404, 'That faction is not currently tracked by RWE.');
  return row;
}

async function requireFactionApiKey(env, factionId) {
  const managedRow = await env.DB.prepare(`SELECT config_value FROM faction_config WHERE faction_id = ? AND config_key = ?`)
    .bind(factionId, MANAGED_KEY_CONFIG).first();
  const managed = parseManagedKey(managedRow?.config_value);
  if (managed?.ciphertext && managed?.iv) return decryptText(env.APP_SECRET, managed.ciphertext, managed.iv);

  const owner = await env.DB.prepare(`
    SELECT api_key_encrypted, api_key_iv FROM users
    WHERE faction_id = ? AND is_disabled = 0 AND api_key_encrypted IS NOT NULL AND api_key_iv IS NOT NULL
    ORDER BY is_admin DESC, last_login_at DESC, user_id ASC LIMIT 1
  `).bind(factionId).first();
  if (owner?.api_key_encrypted && owner?.api_key_iv) return decryptText(env.APP_SECRET, owner.api_key_encrypted, owner.api_key_iv);
  throw httpError(400, 'No usable API key is configured for this faction.');
}

function parseManagedKey(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

async function decryptText(secret, ciphertextBase64, ivBase64) {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({
    name: 'PBKDF2', salt: encoder.encode('rwengine-v2-api-key-encryption'),
    iterations: 100000, hash: 'SHA-256'
  }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(ivBase64) }, key, base64ToBytes(ciphertextBase64));
  return new TextDecoder().decode(plaintext);
}

function base64ToBytes(value) {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function sha256Hex(value) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function getCookie(request, name) {
  for (const cookie of String(request.headers.get('Cookie') || '').split(';').map(v => v.trim())) {
    const index = cookie.indexOf('=');
    if (index > -1 && cookie.slice(0, index) === name) return decodeURIComponent(cookie.slice(index + 1));
  }
  return null;
}
function pickString(object, keys) {
  for (const key of keys) { const value = object?.[key]; if (value !== undefined && value !== null && String(value).trim()) return String(value).trim(); }
  return null;
}
function pickNumber(object, keys) {
  for (const key of keys) { const n = Number(object?.[key]); if (Number.isFinite(n)) return n; }
  return 0;
}
function pickTimestamp(object, keys) {
  for (const key of keys) {
    let value = object?.[key];
    if (value && typeof value === 'object') value = value.timestamp ?? value.time ?? value.epoch ?? value.unix ?? value.seconds ?? value.value;
    let n = Number(value); if (!Number.isFinite(n) || n <= 0) continue; if (n > 1e12) n = Math.floor(n / 1000); return Math.floor(n);
  }
  return 0;
}
function nullableNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function unixNow() { return Math.floor(Date.now() / 1000); }
function requireDb(env) { if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.'); }
function requireSecret(env) { if (!env.APP_SECRET) throw new Error('Missing APP_SECRET secret.'); }
async function readJson(request) { try { return await request.json(); } catch (_) { return {}; } }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
