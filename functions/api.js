const SESSION_DAYS = 14;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;

const ATTACK_PAGE_SOFT_LIMIT = 100;
const ATTACK_FETCH_MAX_WINDOWS = 800;
const ATTACK_FETCH_WINDOWS_PER_STEP = 5;
const ATTACK_TIME_PADDING_SECONDS = 60;
const ATTACK_MIN_SPLIT_SECONDS = 1;

const CHAIN_REPORT_OVERLAP_PADDING_SECONDS = 3600;

export async function onRequest(context) {
  try {
    const { request, env } = context;

    if (request.method !== "POST") {
      return json(
        {
          success: false,
          message: "Method not allowed. Use POST."
        },
        405
      );
    }

    const body = await readJson(request);
    const action = body.action || "ping";

    if (action === "ping") {
      return json({
        success: true,
        message: "RWEngine API is working."
      });
    }

    if (action === "dbTest") {
      return await handleDbTest(env);
    }

    if (action === "register") {
      return await handleRegister(env, body);
    }

    if (action === "login") {
      return await handleLogin(env, body);
    }

    if (action === "me") {
      return await handleMe(env, request);
    }

    if (action === "logout") {
      return await handleLogout(env, request);
    }

    if (action === "getDashboardData") {
      return await handleGetDashboardData(env, request, body);
    }

    if (action === "getImportedWars") {
      return await handleGetImportedWars(env, request);
    }

    if (action === "checkImportStatus") {
      return await handleCheckImportStatus(env, request, body);
    }

    if (action === "importRankedWarReport") {
      return await handleImportRankedWarReport(env, request, body);
    }

    if (action === "applyAttackSummary") {
      return await handleApplyAttackSummary(env, request, body);
    }

    if (action === "applyChainBonusAdjustment") {
      return await handleApplyChainBonusAdjustment(env, request, body);
    }

    if (action === "getCurrentWarIntel") {
      return await handleGetCurrentWarIntel(env, request);
    }

    return json(
      {
        success: false,
        message: `Unknown action: ${action}`
      },
      400
    );
  } catch (error) {
    return json(
      {
        success: false,
        message: error.message || "Unexpected server error."
      },
      500
    );
  }
}

/* =========================
   TEST ACTION
========================= */

async function handleDbTest(env) {
  requireDb(env);

  const now = nowUnix();

  await env.DB.prepare(
    `
    INSERT INTO app_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
    `
  )
    .bind("db_test", "D1 connection works", now)
    .run();

  const row = await env.DB.prepare(
    `
    SELECT key, value, updated_at
    FROM app_meta
    WHERE key = ?
    `
  )
    .bind("db_test")
    .first();

  return json({
    success: true,
    message: "D1 database read/write test successful.",
    row
  });
}

/* =========================
   AUTH ACTIONS
========================= */

async function handleRegister(env, body) {
  requireDb(env);
  requireSecret(env);

  const apiKey = String(body.apiKey || "").trim();
  const password = String(body.password || "");
  const confirmPassword = String(body.confirmPassword || "");

  if (!apiKey) {
    return json({ success: false, message: "Missing Torn API key." }, 400);
  }

  if (!password || password.length < 8) {
    return json({ success: false, message: "Password must be at least 8 characters." }, 400);
  }

  if (password !== confirmPassword) {
    return json({ success: false, message: "Passwords do not match." }, 400);
  }

  const tornProfile = await verifyTornApiKey(apiKey);

  const playerId = Number(tornProfile.player_id || tornProfile.id);
  const playerName = String(tornProfile.name || "").trim();

  if (!playerId || !playerName) {
    return json(
      {
        success: false,
        message: "Torn API key worked, but profile response did not include player ID/name."
      },
      400
    );
  }

  const faction = normalizeFaction(tornProfile);

  const existingUser = await env.DB.prepare(
    `
    SELECT user_id, player_id, player_name
    FROM users
    WHERE player_id = ?
    `
  )
    .bind(playerId)
    .first();

  if (existingUser) {
    return json(
      {
        success: false,
        message: "Account already exists. Use login instead."
      },
      409
    );
  }

  const now = nowUnix();

  if (faction.factionId) {
    await env.DB.prepare(
      `
      INSERT INTO factions (
        faction_id,
        faction_name,
        enabled,
        created_at,
        updated_at
      )
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(faction_id) DO UPDATE SET
        faction_name = excluded.faction_name,
        updated_at = excluded.updated_at
      `
    )
      .bind(
        faction.factionId,
        faction.factionName || "Unknown faction",
        now,
        now
      )
      .run();
  }

  const passwordSalt = randomBase64Url(24);
  const passwordHash = await hashPassword(password, passwordSalt);
  const encryptedApiKey = await encryptText(env.APP_SECRET, apiKey);

  await env.DB.prepare(
    `
    INSERT INTO users (
      player_id,
      player_name,
      faction_id,
      faction_name,
      password_salt,
      password_hash,
      api_key_encrypted,
      api_key_iv,
      is_admin,
      is_disabled,
      created_at,
      updated_at,
      last_login_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    `
  )
    .bind(
      playerId,
      playerName,
      faction.factionId,
      faction.factionName,
      passwordSalt,
      passwordHash,
      encryptedApiKey.ciphertext,
      encryptedApiKey.iv,
      now,
      now,
      now
    )
    .run();

  const createdUser = await env.DB.prepare(
    `
    SELECT
      user_id,
      player_id,
      player_name,
      faction_id,
      faction_name,
      is_admin,
      is_disabled
    FROM users
    WHERE player_id = ?
    `
  )
    .bind(playerId)
    .first();

  const session = await createSession(env, createdUser.user_id);

  return json(
    {
      success: true,
      message: "Account created.",
      user: rowToPublicUser(createdUser)
    },
    200,
    {
      "Set-Cookie": buildSessionCookie(session.token)
    }
  );
}

async function refreshUserFactionFromStoredApiKey(env, userRow, options = {}) {
  const strict = options.strict === true;

  try {
    if (!userRow.api_key_encrypted || !userRow.api_key_iv) {
      if (strict) {
        throw new Error("No stored API key found for this account.");
      }

      return userRow;
    }

    const apiKey = await decryptText(
      env.APP_SECRET,
      userRow.api_key_encrypted,
      userRow.api_key_iv
    );

    const tornProfile = await verifyTornApiKey(apiKey);

    const playerName =
      String(tornProfile.name || userRow.player_name || "").trim() ||
      userRow.player_name;

    const faction = normalizeFaction(tornProfile);
    const now = nowUnix();

    if (faction.factionId) {
      await env.DB.prepare(
        `
        INSERT INTO factions (
          faction_id,
          faction_name,
          enabled,
          created_at,
          updated_at
        )
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(faction_id) DO UPDATE SET
          faction_name = excluded.faction_name,
          enabled = 1,
          updated_at = excluded.updated_at
        `
      )
        .bind(
          faction.factionId,
          faction.factionName || "Unknown faction",
          now,
          now
        )
        .run();
    }

    await env.DB.prepare(
      `
      UPDATE users
      SET
        player_name = ?,
        faction_id = ?,
        faction_name = ?,
        updated_at = ?
      WHERE user_id = ?
      `
    )
      .bind(
        playerName,
        faction.factionId || null,
        faction.factionName || null,
        now,
        userRow.user_id
      )
      .run();

    return {
      ...userRow,
      player_name: playerName,
      faction_id: faction.factionId || null,
      faction_name: faction.factionName || null
    };
  } catch (error) {
    if (strict) {
      throw error;
    }

    return userRow;
  }
}

async function handleLogin(env, body) {
  requireDb(env);

  const playerId = Number(body.playerId);
  const password = String(body.password || "");

  if (!playerId) {
    return json({ success: false, message: "Missing Torn player ID." }, 400);
  }

  if (!password) {
    return json({ success: false, message: "Missing password." }, 400);
  }

  const userRow = await env.DB.prepare(
    `
    SELECT
      user_id,
      player_id,
      player_name,
      faction_id,
      faction_name,
      password_salt,
      password_hash,
      is_admin,
      is_disabled
    FROM users
    WHERE player_id = ?
    `
  )
    .bind(playerId)
    .first();

  if (!userRow) {
    return json({ success: false, message: "Invalid player ID or password." }, 401);
  }

  if (Number(userRow.is_disabled) === 1) {
    return json({ success: false, message: "This account is disabled." }, 403);
  }

  const attemptedHash = await hashPassword(password, userRow.password_salt);

  if (attemptedHash !== userRow.password_hash) {
    return json({ success: false, message: "Invalid player ID or password." }, 401);
  }

  const syncedUserRow = await refreshUserFactionFromStoredApiKey(env, userRow);

  const now = nowUnix();

  await env.DB.prepare(
    `
    UPDATE users
    SET last_login_at = ?, updated_at = ?
    WHERE user_id = ?
    `
  )
    .bind(now, now, userRow.user_id)
    .run();

  const session = await createSession(env, userRow.user_id);

  return json(
    {
      success: true,
      message: "Logged in.",
      user: rowToPublicUser(syncedUserRow)
    },
    200,
    {
      "Set-Cookie": buildSessionCookie(session.token)
    }
  );
}

async function handleMe(env, request) {
  requireDb(env);

  const sessionToken = getCookie(request, "rwengine_session");

  if (!sessionToken) {
    return json({ success: false, message: "Not logged in." }, 401);
  }

  const tokenHash = await sha256Hex(sessionToken);
  const now = nowUnix();

  const row = await env.DB.prepare(
    `
    SELECT
      users.user_id,
      users.player_id,
      users.player_name,
      users.faction_id,
      users.faction_name,
      users.api_key_encrypted,
      users.api_key_iv,
      users.is_admin,
      users.is_disabled,
      sessions.expires_at
    FROM sessions
    JOIN users ON users.user_id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.expires_at > ?
    `
  )
    .bind(tokenHash, now)
    .first();

  if (!row) {
    return json(
      {
        success: false,
        message: "Session expired or invalid."
      },
      401,
      {
        "Set-Cookie": clearSessionCookie()
      }
    );
  }

  if (Number(row.is_disabled) === 1) {
    return json(
      {
        success: false,
        message: "This account is disabled."
      },
      403,
      {
        "Set-Cookie": clearSessionCookie()
      }
    );
  }

  const syncedRow = await refreshUserFactionFromStoredApiKey(env, row);
  
  return json({
    success: true,
    message: "Session restored.",
    user: rowToPublicUser(syncedRow)
  });
}

async function handleLogout(env, request) {
  requireDb(env);

  const sessionToken = getCookie(request, "rwengine_session");

  if (sessionToken) {
    const tokenHash = await sha256Hex(sessionToken);

    await env.DB.prepare(
      `
      DELETE FROM sessions
      WHERE token_hash = ?
      `
    )
      .bind(tokenHash)
      .run();
  }

  return json(
    {
      success: true,
      message: "Logged out."
    },
    200,
    {
      "Set-Cookie": clearSessionCookie()
    }
  );
}

/* =========================
   DASHBOARD ACTIONS
========================= */

async function handleGetDashboardData(env, request, body) {
  requireDb(env);

  const currentUser = await getCurrentUser(env, request);
  const factionId = Number(currentUser.factionId);

  if (!factionId) {
    return json(
      {
        success: false,
        message: "Your account is not linked to a faction."
      },
      400
    );
  }

  const filters = body.filters || {};

  const termedFilter = String(filters.termedFilter || "ALL");
  const memberFilter = String(filters.memberFilter || "ALL");
  const search = String(filters.search || "").trim().toLowerCase();

  const queryResult = await env.DB.prepare(
    `
    SELECT
      player_id,
      MAX(player_name) AS player_name,
      MAX(is_member) AS is_member,
      MAX(termed) AS termed,
      COUNT(DISTINCT war_id) AS wars,
      SUM(war_hits) AS hits,
      SUM(outside_hits) AS outside_hits,
      SUM(assists) AS assists,
      SUM(score_up) AS score_up,
      SUM(score_down) AS score_down,
      SUM(score_up_official) AS score_up_official,
      SUM(score_up_adjusted) AS score_up_adjusted,
      SUM(chain_bonus_score) AS chain_bonus_score,
      SUM(chain_bonus_hits) AS chain_bonus_hits
    FROM war_log
    WHERE faction_id = ?
    GROUP BY player_id
    `
  )
    .bind(factionId)
    .all();

  let data = queryResult.results || [];

  if (termedFilter === "HIDE_TERMED") {
    data = data.filter(row => Number(row.termed || 0) !== 1);
  }

  if (termedFilter === "ONLY_TERMED") {
    data = data.filter(row => Number(row.termed || 0) === 1);
  }

  if (memberFilter === "ACTIVE") {
    data = data.filter(row => Number(row.is_member || 0) === 1);
  }

  if (memberFilter === "LEFT") {
    data = data.filter(row => Number(row.is_member || 0) !== 1);
  }

  if (search) {
    data = data.filter(row => {
      const name = String(row.player_name || "").toLowerCase();
      const id = String(row.player_id || "");

      return name.includes(search) || id.includes(search);
    });
  }

  const mappedRows = data.map(row => {
    const hits = Number(row.hits || 0);
    const outsideHits = Number(row.outside_hits || 0);
    const assists = Number(row.assists || 0);
    const scoreUp = Number(row.score_up || 0);
    const scoreDown = Number(row.score_down || 0);

    const netScore = scoreUp - scoreDown;
    const avgRespect = hits > 0 ? scoreUp / hits : 0;

    const impactScore =
      hits +
      outsideHits +
      assists * 0.5 +
      netScore;

    return {
      "Members": row.player_name,
      "Player_ID": row.player_id,
      "Is Member": Number(row.is_member || 0) === 1 ? "ACTIVE" : "LEFT",
      "Wars": Number(row.wars || 0),
      "Hits": hits,
      "Outside Hits": outsideHits,
      "Assists": assists,
      "Sum Score up": scoreUp,
      "Official Score up": Number(row.score_up_official || 0),
      "Chain Bonus Score": Number(row.chain_bonus_score || 0),
      "Chain Bonus Hits": Number(row.chain_bonus_hits || 0),
      "Sum Score down": scoreDown,
      "Net Score": netScore,
      "ImpactScore": impactScore,
      "Avg R/hit": avgRespect
    };
  });

  const sortBy = String(body.sortBy || "ImpactScore");
  const sortDirection = String(body.sortDirection || "DESC").toUpperCase();

  const allowedSorts = new Set([
    "Members",
    "Is Member",
    "Wars",
    "Hits",
    "Outside Hits",
    "Assists",
    "Sum Score up",
    "Official Score up",
    "Chain Bonus Score",
    "Chain Bonus Hits",
    "Sum Score down",
    "Net Score",
    "ImpactScore",
    "Avg R/hit"
  ]);

  const safeSortBy = allowedSorts.has(sortBy) ? sortBy : "ImpactScore";
  const direction = sortDirection === "ASC" ? 1 : -1;

  mappedRows.sort((a, b) => {
    const aValue = a[safeSortBy];
    const bValue = b[safeSortBy];

    if (typeof aValue === "string" || typeof bValue === "string") {
      return String(aValue).localeCompare(String(bValue)) * direction;
    }

    return (Number(aValue || 0) - Number(bValue || 0)) * direction;
  });

  const totalHits = mappedRows.reduce((sum, row) => sum + row["Hits"], 0);
  const totalScoreUp = mappedRows.reduce((sum, row) => sum + row["Sum Score up"], 0);
  const totalNetScore = mappedRows.reduce((sum, row) => sum + row["Net Score"], 0);

  const summary = {
    membersShown: mappedRows.length,
    totalHits,
    avgRespect: totalHits > 0 ? totalScoreUp / totalHits : 0,
    totalNetScore
  };

  return json({
    success: true,
    message: "Dashboard data loaded.",
    rows: mappedRows,
    summary
  });
}

async function getCurrentUser(env, request) {
  const sessionToken = getCookie(request, "rwengine_session");

  if (!sessionToken) {
    throw new Error("Not logged in.");
  }

  const tokenHash = await sha256Hex(sessionToken);
  const now = nowUnix();

  const row = await env.DB.prepare(
    `
    SELECT
      users.user_id,
      users.player_id,
      users.player_name,
      users.faction_id,
      users.faction_name,
      users.is_admin,
      users.is_disabled
    FROM sessions
    JOIN users ON users.user_id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.expires_at > ?
    `
  )
    .bind(tokenHash, now)
    .first();

  if (!row) {
    throw new Error("Session expired or invalid.");
  }

  if (Number(row.is_disabled) === 1) {
    throw new Error("This account is disabled.");
  }

  return rowToPublicUser(row);
}

/* =========================
   IMPORT ACTIONS
========================= */

async function handleGetImportedWars(env, request) {
  requireDb(env);

  const currentUser = await getCurrentUser(env, request);
  const factionId = Number(currentUser.factionId);

  if (!factionId) {
    return json(
      {
        success: false,
        message: "Your account is not linked to a faction."
      },
      400
    );
  }

  const result = await env.DB.prepare(
    `
    SELECT
      war_id,
      report_id,
      faction_id,
      faction_name,
      opponent_faction_id,
      opponent_faction_name,
      start_timestamp,
      end_timestamp,
      imported_at,
      chain_adjusted_at,
      chain_adjustment_status,
      chain_adjustment_message
    FROM wars
    WHERE faction_id = ?
    ORDER BY imported_at DESC
    LIMIT 50
    `
  )
    .bind(factionId)
    .all();

  return json({
    success: true,
    message: "Imported wars loaded.",
    wars: result.results || []
  });
}

async function handleCheckImportStatus(env, request, body) {
  requireDb(env);

  const currentUser = await getCurrentUser(env, request);
  const rankId = String(body.rankId || "").trim();

  if (!rankId) {
    return json(
      {
        success: false,
        message: "Missing ranked war report ID."
      },
      400
    );
  }

  const existingWar = await getExistingImportedWar(
    env,
    Number(currentUser.factionId),
    rankId
  );

  return json({
    success: true,
    exists: Boolean(existingWar),
    war: existingWar
  });
}

async function handleImportRankedWarReport(env, request, body) {
  requireDb(env);
  requireSecret(env);

  let currentUser = await getCurrentUserPrivate(env, request);

  currentUser = await refreshUserFactionFromStoredApiKey(
    env,
    currentUser,
    { strict: true }
  );

  const rankId = String(body.rankId || "").trim();
  const overwrite = body.overwrite === true;

  if (!rankId) {
    return json(
      {
        success: false,
        message: "Missing ranked war report ID."
      },
      400
    );
  }

  const existingWarBeforeFetch = await getExistingImportedWar(
    env,
    Number(currentUser.faction_id),
    rankId
  );

  if (existingWarBeforeFetch && !overwrite) {
    return json({
      success: true,
      skipped: true,
      message: "War already imported. Skipped.",
      war: existingWarBeforeFetch
    });
  }

  if (!currentUser.api_key_encrypted || !currentUser.api_key_iv) {
    return json(
      {
        success: false,
        message: "No stored API key found for this account."
      },
      400
    );
  }

  const apiKey = await decryptText(
    env.APP_SECRET,
    currentUser.api_key_encrypted,
    currentUser.api_key_iv
  );

  const rawReport = await fetchRankedWarReport(rankId, apiKey);

  const normalized = normalizeRankedWarReport(
    rawReport,
    rankId,
    Number(currentUser.faction_id)
  );

  const existingWarAfterFetch = await getExistingImportedWar(
    env,
    Number(currentUser.faction_id),
    normalized.warId
  );

  if (existingWarAfterFetch && !overwrite) {
    return json({
      success: true,
      skipped: true,
      message: "War already imported. Skipped.",
      war: existingWarAfterFetch
    });
  }

  await deleteAttackSummaryState(env, normalized.factionId, normalized.warId);

  const now = nowUnix();

  await env.DB.prepare(
    `
    INSERT INTO wars (
      war_id,
      faction_id,
      faction_name,
      opponent_faction_id,
      opponent_faction_name,
      start_timestamp,
      end_timestamp,
      report_id,
      war_type,
      imported_by_user_id,
      imported_at,
      updated_at,
      chain_adjusted_at,
      chain_adjustment_status,
      chain_adjustment_message
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ranked', ?, ?, ?, NULL, NULL, NULL)
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
    `
  )
    .bind(
      normalized.warId,
      normalized.factionId,
      normalized.factionName,
      normalized.opponentFactionId,
      normalized.opponentFactionName,
      normalized.startTimestamp,
      normalized.endTimestamp,
      normalized.reportId,
      currentUser.user_id,
      now,
      now
    )
    .run();

  await env.DB.prepare(
    `
    DELETE FROM war_log
    WHERE war_id = ?
      AND faction_id = ?
    `
  )
    .bind(normalized.warId, normalized.factionId)
    .run();

  for (const member of normalized.members) {
    await env.DB.prepare(
      `
      INSERT INTO war_log (
        war_id,
        faction_id,
        player_id,
        player_name,
        is_member,
        termed,
        war_hits,
        outside_hits,
        assists,
        score_up,
        score_up_official,
        score_up_adjusted,
        chain_bonus_score,
        chain_bonus_hits,
        score_down,
        synced_at
      )
      VALUES (?, ?, ?, ?, 1, 0, ?, 0, 0, ?, ?, ?, 0, 0, 0, ?)
      `
    )
      .bind(
        normalized.warId,
        normalized.factionId,
        member.playerId,
        member.playerName,
        member.warHits,
        member.scoreUp,
        member.scoreUp,
        member.scoreUp,
        now
      )
      .run();
  }

  const chainAdjustment = await applyChainBonusAdjustment(
    env,
    apiKey,
    normalized
  );

  return json({
    success: true,
    skipped: false,
    overwritten: Boolean(existingWarBeforeFetch || existingWarAfterFetch),
    message: `War imported. Members added: ${normalized.members.length}.`,
    chainAdjustment,
    war: {
      warId: normalized.warId,
      reportId: normalized.reportId,
      factionId: normalized.factionId,
      factionName: normalized.factionName,
      opponentFactionId: normalized.opponentFactionId,
      opponentFactionName: normalized.opponentFactionName,
      startTimestamp: normalized.startTimestamp,
      endTimestamp: normalized.endTimestamp,
      membersAdded: normalized.members.length
    }
  });
}

async function handleApplyChainBonusAdjustment(env, request, body) {
  requireDb(env);
  requireSecret(env);

  const currentUser = await getCurrentUserPrivate(env, request);

  const warId = String(body.warId || "").trim();

  if (!warId) {
    return json(
      {
        success: false,
        message: "Missing war ID."
      },
      400
    );
  }

  

  const war = await env.DB.prepare(
    `
    SELECT
      war_id,
      report_id,
      faction_id,
      faction_name,
      opponent_faction_id,
      opponent_faction_name,
      start_timestamp,
      end_timestamp
    FROM wars
    WHERE war_id = ?
      AND faction_id = ?
    `
  )
    .bind(warId, currentUser.faction_id)
    .first();

  if (!war) {
    return json(
      {
        success: false,
        message: "War not found for your faction."
      },
      404
    );
  }

  if (!currentUser.api_key_encrypted || !currentUser.api_key_iv) {
    return json(
      {
        success: false,
        message: "No stored API key found for this account."
      },
      400
    );
  }

  const apiKey = await decryptText(
    env.APP_SECRET,
    currentUser.api_key_encrypted,
    currentUser.api_key_iv
  );

  const result = await applyChainBonusAdjustment(env, apiKey, {
    warId: String(war.war_id),
    reportId: String(war.report_id || war.war_id),
    factionId: Number(war.faction_id),
    factionName: war.faction_name,
    opponentFactionId: Number(war.opponent_faction_id || 0),
    opponentFactionName: war.opponent_faction_name,
    startTimestamp: Number(war.start_timestamp),
    endTimestamp: Number(war.end_timestamp)
  });

  return json({
    success: true,
    message: "Chain bonus adjustment checked.",
    chainAdjustment: result
  });
}

/* =========================
   CURRENT WAR LIVE INTEL
========================= */

async function handleGetCurrentWarIntel(env, request) {
  requireSecret(env);

  const currentUser = await getCurrentUserPrivate(env, request);

  if (!currentUser.faction_id) {
    return json(
      {
        success: false,
        message: "Your account is not linked to a faction."
      },
      400
    );
  }

  if (!currentUser.api_key_encrypted || !currentUser.api_key_iv) {
    return json(
      {
        success: false,
        message: "No stored API key found for this account."
      },
      400
    );
  }

  const apiKey = await decryptText(
    env.APP_SECRET,
    currentUser.api_key_encrypted,
    currentUser.api_key_iv
  );

  const ownFactionId = Number(currentUser.faction_id);

  const result = await fetchTornJson(
    "https://api.torn.com/faction/?selections=rankedwars" +
      "&key=" +
      encodeURIComponent(apiKey) +
      "&timestamp=" +
      Date.now()
  );

  if (!result.success) {
    return json(
      {
        success: false,
        message: result.message || "Failed to fetch ranked wars."
      },
      400
    );
  }

  const rankedWars = result.data.rankedwars || {};
  const currentTimestamp = nowUnix();

  const wars = Object.entries(rankedWars)
    .map(([warId, war]) => {
      const factions = war.factions || {};
      const factionEntries = Object.entries(factions);

      const ownFaction = factions[String(ownFactionId)];

      const opponentEntry = factionEntries.find(([id]) => {
        return Number(id) !== ownFactionId;
      });

      if (!ownFaction || !opponentEntry) {
        return null;
      }

      const [opponentFactionIdRaw, opponentFaction] = opponentEntry;

      const startTimestamp = Number(war.war?.start || 0);
      const endTimestamp = Number(war.war?.end || 0);

      return {
        warId: String(warId),
        ownFactionId,
        ownFactionName: ownFaction.name || currentUser.faction_name || "Your faction",
        ownScore: Number(ownFaction.score || 0),
        opponentFactionId: Number(opponentFactionIdRaw),
        opponentFactionName: opponentFaction.name || "Unknown opponent",
        opponentScore: Number(opponentFaction.score || 0),
        startTimestamp,
        endTimestamp,
        target: Number(war.war?.target || 0),
        winner: Number(war.war?.winner || 0),
        isActive:
          startTimestamp > 0 &&
          startTimestamp <= currentTimestamp &&
          (
            !endTimestamp ||
            endTimestamp >= currentTimestamp
          )
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      return Number(b.startTimestamp || 0) - Number(a.startTimestamp || 0);
    });

  const war = wars[0] || null;

  if (!war) {
    return json({
      success: true,
      message: "No ranked war found for your faction.",
      war: null,
      rows: []
    });
  }
  const memberResult = await fetchTornJson(
    "https://api.torn.com/faction/" +
      encodeURIComponent(war.opponentFactionId) +
      "?selections=basic" +
      "&key=" +
      encodeURIComponent(apiKey) +
      "&timestamp=" +
      Date.now()
  );
  
  const rows = [];
  
  if (memberResult.success) {
    const members = memberResult.data.members || {};
  
    for (const [playerId, member] of Object.entries(members)) {
      const lastAction = member.last_action || {};
  
      rows.push({
        playerId: Number(playerId),
        playerName: member.name || `Player ${playerId}`,
        level: Number(member.level || 0),
        hits: 0,
        score: 0,
        avgScorePerHit: 0,
        activity:
          lastAction.relative ||
          member.status ||
          "-",
        wantedScore: 0,
        tag: "Unscouted"
      });
    }
  
    rows.sort((a, b) => {
      return Number(b.level || 0) - Number(a.level || 0);
    });
  }
  
  return json({
    success: true,
    message: war.isActive
      ? "Current war loaded."
      : "No active war found. Showing latest ranked war.",
    war,
    memberFetch: {
      success: memberResult.success,
      message: memberResult.message || null,
      count: rows.length
    },
    rows
  });
}

async function getExistingImportedWar(env, factionId, rankId) {
  return await env.DB.prepare(
    `
    SELECT
      war_id,
      report_id,
      faction_id,
      faction_name,
      opponent_faction_id,
      opponent_faction_name,
      start_timestamp,
      end_timestamp,
      imported_at
    FROM wars
    WHERE faction_id = ?
      AND (war_id = ? OR report_id = ?)
    LIMIT 1
    `
  )
    .bind(factionId, rankId, rankId)
    .first();
}

async function getCurrentUserPrivate(env, request) {
  const sessionToken = getCookie(request, "rwengine_session");

  if (!sessionToken) {
    throw new Error("Not logged in.");
  }

  const tokenHash = await sha256Hex(sessionToken);
  const now = nowUnix();

  const row = await env.DB.prepare(
    `
    SELECT
      users.user_id,
      users.player_id,
      users.player_name,
      users.faction_id,
      users.faction_name,
      users.is_admin,
      users.is_disabled,
      users.api_key_encrypted,
      users.api_key_iv
    FROM sessions
    JOIN users ON users.user_id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.expires_at > ?
    `
  )
    .bind(tokenHash, now)
    .first();

  if (!row) {
    throw new Error("Session expired or invalid.");
  }

  if (Number(row.is_disabled) === 1) {
    throw new Error("This account is disabled.");
  }

  return row;
}

/* =========================
   CHAIN BONUS ADJUSTMENT
========================= */

async function applyChainBonusAdjustment(env, apiKey, war) {
  const startedAt = nowUnix();

  try {
    await env.DB.prepare(
      `
      UPDATE war_log
      SET
        score_up_official = CASE
          WHEN score_up_official > 0 THEN score_up_official
          ELSE score_up
        END,
        score_up_adjusted = CASE
          WHEN score_up_official > 0 THEN score_up_official
          ELSE score_up
        END,
        score_up = CASE
          WHEN score_up_official > 0 THEN score_up_official
          ELSE score_up
        END,
        chain_bonus_score = 0,
        chain_bonus_hits = 0,
        synced_at = ?
      WHERE war_id = ?
        AND faction_id = ?
      `
    )
      .bind(startedAt, war.warId, war.factionId)
      .run();

    const chainsResult = await fetchFactionChains(apiKey, war);

    if (!chainsResult.success) {
      await saveChainAdjustmentStatus(
        env,
        war,
        "skipped",
        chainsResult.message || "Faction chains could not be fetched.",
        startedAt
      );

      return {
        applied: false,
        status: "skipped",
        message: chainsResult.message || "Faction chains could not be fetched.",
        bonusHits: 0,
        bonusScore: 0,
        unmatchedBonusAttackers: []
      };
    }

    const chains = normalizeFactionChains(chainsResult.data);

    const overlappingChains = chains.filter(chain =>
      chainOverlapsWar(chain, war)
    );

    if (!overlappingChains.length) {
      const chainWindowDebug = chains.slice(0, 25).map(chain => ({
        chainId: chain.chainId,
        source: chain.source,
        startTimestamp: chain.startTimestamp,
        endTimestamp: chain.endTimestamp,
        overlaps: chainOverlapsWar(chain, war)
      }));

      await saveChainAdjustmentStatus(
        env,
        war,
        "skipped",
        "No completed faction chains overlapped this war window.",
        startedAt
      );

      return {
        applied: false,
        status: "skipped",
        message: "No completed faction chains overlapped this war window.",
        warWindow: {
          startTimestamp: Number(war.startTimestamp),
          endTimestamp: Number(war.endTimestamp),
          paddedStartTimestamp:
            Number(war.startTimestamp) - CHAIN_REPORT_OVERLAP_PADDING_SECONDS,
          paddedEndTimestamp:
            Number(war.endTimestamp) + CHAIN_REPORT_OVERLAP_PADDING_SECONDS
        },
        chainsChecked: chains.length,
        chainsMatched: 0,
        chainWindowDebug,
        bonusHits: 0,
        bonusScore: 0,
        unmatchedBonusAttackers: []
      };
    }

    const bonusByAttacker = new Map();

    let chainReportsFetched = 0;
    let chainReportsWithBonuses = 0;
    let totalBonusHitsFound = 0;
    let totalBonusScoreFound = 0;

    for (const chain of overlappingChains) {
      const reportResult = await fetchChainReportById(apiKey, chain.chainId);

      if (!reportResult.success) {
        continue;
      }

      chainReportsFetched += 1;

      const chainReport = normalizeChainReport(reportResult.data);

      if (!chainReport.bonuses.length) {
        continue;
      }

      chainReportsWithBonuses += 1;

      for (const bonus of chainReport.bonuses) {
        if (!bonus.attackerId || !bonus.respect) {
          continue;
        }

        totalBonusHitsFound += 1;
        totalBonusScoreFound += Number(bonus.respect || 0);

        const current = bonusByAttacker.get(bonus.attackerId) || {
          playerId: bonus.attackerId,
          hits: 0,
          score: 0,
          chains: []
        };

        current.hits += 1;
        current.score += Number(bonus.respect || 0);

        if (bonus.chain) {
          current.chains.push(bonus.chain);
        }

        bonusByAttacker.set(bonus.attackerId, current);
      }
    }

    if (!bonusByAttacker.size) {
      const message =
        "Matching chain reports were found, but no usable bonus hits were found.";

      await saveChainAdjustmentStatus(
        env,
        war,
        "skipped",
        message,
        startedAt
      );

      return {
        applied: false,
        status: "skipped",
        message,
        chainsChecked: chains.length,
        chainsMatched: overlappingChains.length,
        chainReportsFetched,
        chainReportsWithBonuses,
        totalBonusHitsFound,
        totalBonusScoreFound,
        bonusHits: 0,
        bonusScore: 0,
        unmatchedBonusAttackers: []
      };
    }

    let appliedRows = 0;
    let appliedBonusHits = 0;
    let appliedBonusScore = 0;

    const unmatchedBonusAttackers = [];

    for (const bonus of bonusByAttacker.values()) {
      const result = await env.DB.prepare(
        `
        UPDATE war_log
        SET
          chain_bonus_score = ?,
          chain_bonus_hits = ?,
          score_up_adjusted = MAX(0, score_up_official - ?),
          score_up = MAX(0, score_up_official - ?),
          synced_at = ?
        WHERE war_id = ?
          AND faction_id = ?
          AND player_id = ?
        `
      )
        .bind(
          bonus.score,
          bonus.hits,
          bonus.score,
          bonus.score,
          startedAt,
          war.warId,
          war.factionId,
          bonus.playerId
        )
        .run();

      if (result.meta && result.meta.changes > 0) {
        appliedRows += result.meta.changes;
        appliedBonusHits += bonus.hits;
        appliedBonusScore += bonus.score;
      } else {
        unmatchedBonusAttackers.push({
          playerId: bonus.playerId,
          hits: bonus.hits,
          score: bonus.score,
          chains: [...new Set(bonus.chains || [])]
        });
      }
    }

    let message =
      appliedRows > 0
        ? `Applied chain bonus adjustment to ${appliedRows} member rows.`
        : "Chain reports overlapped the war, but no bonus attackers matched imported members.";

    if (unmatchedBonusAttackers.length) {
      message += ` ${unmatchedBonusAttackers.length} bonus attacker(s) did not match imported war members.`;
    }

    await saveChainAdjustmentStatus(
      env,
      war,
      appliedRows > 0 ? "applied" : "skipped",
      message,
      startedAt
    );

    return {
      applied: appliedRows > 0,
      status: appliedRows > 0 ? "applied" : "skipped",
      message,
      chainsChecked: chains.length,
      chainsMatched: overlappingChains.length,
      chainReportsFetched,
      chainReportsWithBonuses,
      totalBonusHitsFound,
      totalBonusScoreFound,
      bonusHits: appliedBonusHits,
      bonusScore: appliedBonusScore,
      matchedPlayers: appliedRows,
      unmatchedBonusAttackers
    };
  } catch (error) {
    await saveChainAdjustmentStatus(
      env,
      war,
      "error",
      error.message || "Chain adjustment failed.",
      startedAt
    );

    return {
      applied: false,
      status: "error",
      message: error.message || "Chain adjustment failed.",
      bonusHits: 0,
      bonusScore: 0,
      unmatchedBonusAttackers: []
    };
  }
}

async function saveChainAdjustmentStatus(env, war, status, message, timestamp) {
  await env.DB.prepare(
    `
    UPDATE wars
    SET
      chain_adjusted_at = ?,
      chain_adjustment_status = ?,
      chain_adjustment_message = ?,
      updated_at = ?
    WHERE war_id = ?
      AND faction_id = ?
    `
  )
    .bind(
      timestamp,
      status,
      message,
      timestamp,
      war.warId,
      war.factionId
    )
    .run();
}

async function fetchFactionChains(apiKey, war = null) {
  const timestamp = Date.now();

  const urls = [];

  if (war && war.startTimestamp && war.endTimestamp) {
    const from =
      Number(war.startTimestamp) -
      CHAIN_REPORT_OVERLAP_PADDING_SECONDS;

    const to =
      Number(war.endTimestamp) +
      CHAIN_REPORT_OVERLAP_PADDING_SECONDS;

    urls.push({
      source: "v1 bounded chains",
      url:
        "https://api.torn.com/faction/?selections=chains" +
        "&from=" +
        encodeURIComponent(from) +
        "&to=" +
        encodeURIComponent(to) +
        "&key=" +
        encodeURIComponent(apiKey) +
        "&timestamp=" +
        timestamp
    });

    urls.push({
      source: "v2 bounded chains",
      url:
        "https://api.torn.com/v2/faction/chains" +
        "?from=" +
        encodeURIComponent(from) +
        "&to=" +
        encodeURIComponent(to) +
        "&key=" +
        encodeURIComponent(apiKey) +
        "&timestamp=" +
        timestamp
    });
  }

  urls.push({
    source: "v1 default chains",
    url:
      "https://api.torn.com/faction/?selections=chains" +
      "&key=" +
      encodeURIComponent(apiKey) +
      "&timestamp=" +
      timestamp
  });

  urls.push({
    source: "v2 default chains",
    url:
      "https://api.torn.com/v2/faction/chains" +
      "?key=" +
      encodeURIComponent(apiKey) +
      "&timestamp=" +
      timestamp
  });

  const successfulResults = [];
  const errors = [];

  for (const request of urls) {
    const result = await fetchTornJson(request.url);

    if (result.success) {
      successfulResults.push({
        source: request.source,
        data: result.data
      });
    } else {
      errors.push({
        source: request.source,
        message: result.message
      });
    }
  }

  if (!successfulResults.length) {
    return {
      success: false,
      message:
        errors.map(error => `${error.source}: ${error.message}`).join(" | ") ||
        "Failed to fetch faction chains."
    };
  }

  return {
    success: true,
    data: {
      chain_sources: successfulResults
    }
  };
}

async function fetchChainReportById(apiKey, chainId) {
  const v2Url =
    "https://api.torn.com/v2/faction/" +
    encodeURIComponent(chainId) +
    "/chainreport?key=" +
    encodeURIComponent(apiKey) +
    "&timestamp=" +
    Date.now();

  const v2Result = await fetchTornJson(v2Url);

  if (v2Result.success) {
    return v2Result;
  }

  return {
    success: false,
    message:
      v2Result.message ||
      `Failed to fetch historical chain report for chain ${chainId}.`
  };
}

function normalizeFactionChains(rawData) {
  const sources = Array.isArray(rawData.chain_sources)
    ? rawData.chain_sources
    : [
        {
          source: "single payload",
          data: rawData
        }
      ];

  const chainsById = new Map();

  for (const sourceEntry of sources) {
    const sourceName = sourceEntry.source || "unknown source";
    const sourceData = sourceEntry.data || {};

    const chainsRaw =
      sourceData.chains ||
      sourceData.faction_chains ||
      sourceData.chain ||
      [];

    for (const [id, chain] of normalizeChainEntries(chainsRaw)) {
      const chainId =
        pickNumber(chain, ["chain", "id", "chain_id", "chainId"]) ||
        Number(id);

      const startTimestamp = pickTimestamp(chain, [
        "start",
        "started",
        "start_at",
        "started_at",
        "start_time",
        "start_timestamp",
        "timestamp_started",
        "startTimestamp",
        "timestampStarted"
      ]);

      const endTimestamp = pickTimestamp(chain, [
        "end",
        "ended",
        "end_at",
        "ended_at",
        "end_time",
        "end_timestamp",
        "timestamp_ended",
        "endTimestamp",
        "timestampEnded",
        "finish",
        "finished",
        "finish_at",
        "finished_at"
      ]);

      if (!chainId || !startTimestamp || !endTimestamp) {
        continue;
      }

      chainsById.set(String(chainId), {
        chainId,
        startTimestamp,
        endTimestamp,
        source: sourceName
      });
    }
  }

  return [...chainsById.values()]
    .sort((a, b) => Number(a.startTimestamp) - Number(b.startTimestamp));
}

function normalizeChainEntries(chains) {
  if (Array.isArray(chains)) {
    return chains.map(chain => {
      const id =
        chain.chain ||
        chain.id ||
        chain.chain_id ||
        chain.chainId ||
        null;

      return [String(id || ""), chain];
    });
  }

  if (chains && typeof chains === "object") {
    return Object.entries(chains);
  }

  return [];
}

function normalizeChainReport(rawData) {
  const report =
    rawData.chainreport ||
    rawData.chain_report ||
    rawData.chainReport ||
    rawData.report ||
    rawData;

  const startTimestamp = pickTimestamp(report, [
    "start",
    "started",
    "start_at",
    "started_at",
    "start_time",
    "start_timestamp",
    "timestamp_started",
    "startTimestamp",
    "timestampStarted"
  ]);

  const endTimestamp = pickTimestamp(report, [
    "end",
    "ended",
    "end_at",
    "ended_at",
    "end_time",
    "end_timestamp",
    "timestamp_ended",
    "endTimestamp",
    "timestampEnded",
    "finish",
    "finished",
    "finish_at",
    "finished_at"
  ]);

  const rawBonuses =
    report.bonuses ||
    report.bonus_hits ||
    report.bonusHits ||
    report.bonus ||
    [];

  const bonuses = normalizeChainBonusEntries(rawBonuses)
    .map(([id, bonus]) => {
      const attackerId =
        pickNumber(bonus, ["attacker", "attacker_id", "attackerId"]) ||
        pickNumber(bonus.attacker || {}, ["id", "user_id", "player_id"]);

      const defenderId =
        pickNumber(bonus, ["defender", "defender_id", "defenderId"]) ||
        pickNumber(bonus.defender || {}, ["id", "user_id", "player_id"]);

      const chain =
        pickNumber(bonus, ["chain", "chain_number", "chainNumber"]);

      const respect =
        pickNumber(bonus, ["respect", "score", "score_gain", "respect_gain"]);

      return {
        id: String(id || ""),
        attackerId,
        defenderId,
        chain,
        respect
      };
    })
    .filter(bonus => bonus.attackerId && bonus.respect);

  return {
    startTimestamp,
    endTimestamp,
    bonuses
  };
}

function normalizeChainBonusEntries(bonuses) {
  if (Array.isArray(bonuses)) {
    return bonuses.map((bonus, index) => [String(index), bonus]);
  }

  if (bonuses && typeof bonuses === "object") {
    return Object.entries(bonuses);
  }

  return [];
}

function chainOverlapsWar(chain, war) {
  const chainStart =
    Number(chain.startTimestamp) - CHAIN_REPORT_OVERLAP_PADDING_SECONDS;

  const chainEnd =
    Number(chain.endTimestamp) + CHAIN_REPORT_OVERLAP_PADDING_SECONDS;

  const warStart = Number(war.startTimestamp);
  const warEnd = Number(war.endTimestamp);

  return chainStart <= warEnd && chainEnd >= warStart;
}

/* =========================
   ATTACK SUMMARY ACTION
========================= */

async function handleApplyAttackSummary(env, request, body) {
  requireDb(env);
  requireSecret(env);

  const currentUser = await getCurrentUserPrivate(env, request);

  const warId = String(body.warId || "").trim();
  const reset = body.reset === true;

  if (!warId) {
    return json(
      {
        success: false,
        message: "Missing war ID."
      },
      400
    );
  }

  const war = await env.DB.prepare(
    `
    SELECT
      war_id,
      faction_id,
      faction_name,
      opponent_faction_id,
      opponent_faction_name,
      start_timestamp,
      end_timestamp
    FROM wars
    WHERE war_id = ?
      AND faction_id = ?
    `
  )
    .bind(warId, currentUser.faction_id)
    .first();

  if (!war) {
    return json(
      {
        success: false,
        message: "War not found for your faction."
      },
      404
    );
  }

  if (!war.start_timestamp || !war.end_timestamp) {
    return json(
      {
        success: false,
        message: "War is missing start/end timestamps. Attack summary cannot be fetched."
      },
      400
    );
  }

  if (!currentUser.api_key_encrypted || !currentUser.api_key_iv) {
    return json(
      {
        success: false,
        message: "No stored API key found for this account."
      },
      400
    );
  }

  const apiKey = await decryptText(
    env.APP_SECRET,
    currentUser.api_key_encrypted,
    currentUser.api_key_iv
  );

  let summaryState;

  if (reset) {
    await deleteAttackSummaryState(env, war.faction_id, war.war_id);

    summaryState = createAttackSummaryState(war);

    await env.DB.prepare(
      `
      UPDATE war_log
      SET outside_hits = 0,
          assists = 0,
          score_down = 0,
          synced_at = ?
      WHERE war_id = ?
        AND faction_id = ?
      `
    )
      .bind(nowUnix(), war.war_id, war.faction_id)
      .run();
  } else {
    summaryState = await loadAttackSummaryState(env, war.faction_id, war.war_id);

    if (!summaryState) {
      summaryState = createAttackSummaryState(war);
    }
  }

  summaryState = normalizeAttackSummaryState(summaryState, war);

  const callsThisStep = await processAttackSummaryStep(
    apiKey,
    war,
    summaryState
  );

  const done = summaryState.pendingWindows.length === 0;

  if (!done) {
    await saveAttackSummaryState(env, war.faction_id, war.war_id, summaryState);

    return json({
      success: true,
      message: "Attack summary partially processed.",
      done: false,
      warId: war.war_id,
      callsThisStep,
      pendingWindows: summaryState.pendingWindows.length,
      summary: publicAttackSummary(summaryState)
    });
  }

  await applyAttackSummaryToWarLog(
    env,
    war,
    Object.values(summaryState.players)
  );

  await deleteAttackSummaryState(env, war.faction_id, war.war_id);

  return json({
    success: true,
    message: "Attack summary applied.",
    done: true,
    warId: war.war_id,
    callsThisStep,
    pendingWindows: 0,
    summary: publicAttackSummary(summaryState)
  });
}

function createAttackSummaryState(war) {
  const exactStartTimestamp = Number(war.start_timestamp);
  const exactEndTimestamp = Number(war.end_timestamp);

  const fetchStartTimestamp =
    exactStartTimestamp - ATTACK_TIME_PADDING_SECONDS;

  const fetchEndTimestamp =
    exactEndTimestamp + ATTACK_TIME_PADDING_SECONDS;

  return {
    warId: String(war.war_id),
    factionId: Number(war.faction_id),
    exactStartTimestamp,
    exactEndTimestamp,
    fetchStartTimestamp,
    fetchEndTimestamp,
    pendingWindows: [
      {
        from: fetchStartTimestamp,
        to: fetchEndTimestamp
      }
    ],
    seenAttackIds: [],
    stats: {
      checked: 0,
      ignoredOutsideExactWarWindow: 0,
      rawAttackRowsReturned: 0,
      uniqueAttacksFetched: 0,
      windowsFetched: 0,
      splitWindows: 0,
      saturatedLeafWindows: 0,
      outsideHits: 0,
      assists: 0,
      scoreDown: 0,
      scoreDownRankedWarOnly: 0,
      scoreDownNonRankedWar: 0,
      scoreDownRankedWarOnlyCount: 0,
      scoreDownNonRankedWarCount: 0
    },
    players: {},
    createdAt: nowUnix(),
    updatedAt: nowUnix()
  };
}

function normalizeAttackSummaryState(state, war) {
  const exactStartTimestamp = Number(war.start_timestamp);
  const exactEndTimestamp = Number(war.end_timestamp);

  state.warId = String(war.war_id);
  state.factionId = Number(war.faction_id);

  state.exactStartTimestamp = Number(state.exactStartTimestamp || exactStartTimestamp);
  state.exactEndTimestamp = Number(state.exactEndTimestamp || exactEndTimestamp);

  state.fetchStartTimestamp = Number(
    state.fetchStartTimestamp ||
    state.exactStartTimestamp - ATTACK_TIME_PADDING_SECONDS
  );

  state.fetchEndTimestamp = Number(
    state.fetchEndTimestamp ||
    state.exactEndTimestamp + ATTACK_TIME_PADDING_SECONDS
  );

  if (!Array.isArray(state.pendingWindows)) {
    state.pendingWindows = [
      {
        from: state.fetchStartTimestamp,
        to: state.fetchEndTimestamp
      }
    ];
  }

  if (!Array.isArray(state.seenAttackIds)) {
    state.seenAttackIds = [];
  }

  if (!state.stats || typeof state.stats !== "object") {
    state.stats = {};
  }

  const statDefaults = {
    checked: 0,
    ignoredOutsideExactWarWindow: 0,
    rawAttackRowsReturned: 0,
    uniqueAttacksFetched: 0,
    windowsFetched: 0,
    splitWindows: 0,
    saturatedLeafWindows: 0,
    outsideHits: 0,
    assists: 0,
    scoreDown: 0,
    scoreDownRankedWarOnly: 0,
    scoreDownNonRankedWar: 0,
    scoreDownRankedWarOnlyCount: 0,
    scoreDownNonRankedWarCount: 0
  };

  for (const [key, value] of Object.entries(statDefaults)) {
    if (state.stats[key] === undefined || state.stats[key] === null) {
      state.stats[key] = value;
    }
  }

  if (!state.players || typeof state.players !== "object") {
    state.players = {};
  }

  state.updatedAt = nowUnix();

  return state;
}

async function processAttackSummaryStep(apiKey, war, state) {
  const seenAttackIds = new Set(state.seenAttackIds || []);
  let callsThisStep = 0;

  while (
    state.pendingWindows.length > 0 &&
    callsThisStep < ATTACK_FETCH_WINDOWS_PER_STEP
  ) {
    if (state.stats.windowsFetched >= ATTACK_FETCH_MAX_WINDOWS) {
      throw new Error(
        `Attack summary stopped after ${ATTACK_FETCH_MAX_WINDOWS} windows. The war window is too dense to import safely.`
      );
    }

    const window = state.pendingWindows.shift();

    const page = await fetchFactionAttacksPage(
      apiKey,
      window.from,
      window.to
    );

    callsThisStep += 1;
    state.stats.windowsFetched += 1;
    state.stats.rawAttackRowsReturned += page.attacks.length;

    const windowSize = Number(window.to) - Number(window.from);
    const looksCapped = page.attacks.length >= ATTACK_PAGE_SOFT_LIMIT;

    if (looksCapped && windowSize > ATTACK_MIN_SPLIT_SECONDS) {
      state.stats.splitWindows += 1;

      const middleTimestamp = Math.floor(
        Number(window.from) + windowSize / 2
      );

      state.pendingWindows.unshift(
        {
          from: middleTimestamp + 1,
          to: Number(window.to)
        }
      );

      state.pendingWindows.unshift(
        {
          from: Number(window.from),
          to: middleTimestamp
        }
      );

      continue;
    }

    if (looksCapped) {
      state.stats.saturatedLeafWindows += 1;
    }

    for (const attack of page.attacks) {
      if (!attack.attackId || seenAttackIds.has(attack.attackId)) {
        continue;
      }

      seenAttackIds.add(attack.attackId);

      const attackTimestamp =
        Number(attack.timestampEnded || attack.timestampStarted || 0);

      if (
        attackTimestamp &&
        (
          attackTimestamp < Number(state.exactStartTimestamp) ||
          attackTimestamp > Number(state.exactEndTimestamp)
        )
      ) {
        state.stats.ignoredOutsideExactWarWindow += 1;
        continue;
      }

      state.stats.checked += 1;
      state.stats.uniqueAttacksFetched += 1;

      summarizeAttackIntoState(state, attack, war);
    }
  }

  state.seenAttackIds = [...seenAttackIds];
  state.updatedAt = nowUnix();

  return callsThisStep;
}

function summarizeAttackIntoState(state, attack, war) {
  const factionId = Number(war.faction_id);
  const opponentFactionId = Number(war.opponent_faction_id || 0);

  const attackerFactionId = Number(attack.attackerFactionId || 0);
  const defenderFactionId = Number(attack.defenderFactionId || 0);

  const isOurOutgoing = attackerFactionId === factionId;
  const isIncomingToUs = defenderFactionId === factionId;

  const isAgainstOpponent =
    opponentFactionId &&
    defenderFactionId === opponentFactionId;

  const isFromOpponent =
    opponentFactionId &&
    attackerFactionId === opponentFactionId;

  const scoreValue = Number(attack.scoreGain || 0);

  if (isOurOutgoing && attack.isAssist) {
    const row = getAttackPlayerSummary(
      state.players,
      attack.attackerId,
      attack.attackerName
    );

    row.assists += 1;
    state.stats.assists += 1;
    return;
  }

  if (
    isOurOutgoing &&
    !attack.isAssist &&
    !isAgainstOpponent
  ) {
    const row = getAttackPlayerSummary(
      state.players,
      attack.attackerId,
      attack.attackerName
    );

    row.outsideHits += 1;
    state.stats.outsideHits += 1;
    return;
  }

  if (
    isIncomingToUs &&
    isFromOpponent &&
    !attack.isAssist
  ) {
    const row = getAttackPlayerSummary(
      state.players,
      attack.defenderId,
      attack.defenderName
    );

    row.scoreDown += scoreValue;
    state.stats.scoreDown += scoreValue;

    if (attack.isRankedWar) {
      state.stats.scoreDownRankedWarOnly += scoreValue;
      state.stats.scoreDownRankedWarOnlyCount += 1;
    } else {
      state.stats.scoreDownNonRankedWar += scoreValue;
      state.stats.scoreDownNonRankedWarCount += 1;
    }
  }
}

function getAttackPlayerSummary(players, playerId, playerName) {
  const id = String(Number(playerId));

  if (!players[id]) {
    players[id] = {
      playerId: Number(playerId),
      playerName: playerName || `Player ${playerId}`,
      outsideHits: 0,
      assists: 0,
      scoreDown: 0
    };
  }

  return players[id];
}

function publicAttackSummary(state) {
  return {
    checked: state.stats.checked,
    ignoredOutsideExactWarWindow: state.stats.ignoredOutsideExactWarWindow,
    rawAttackRowsReturned: state.stats.rawAttackRowsReturned,
    uniqueAttacksFetched: state.stats.uniqueAttacksFetched,
    windowsFetched: state.stats.windowsFetched,
    splitWindows: state.stats.splitWindows,
    saturatedLeafWindows: state.stats.saturatedLeafWindows,
    outsideHits: state.stats.outsideHits,
    assists: state.stats.assists,
    scoreDown: state.stats.scoreDown,
    scoreDownRankedWarOnly: state.stats.scoreDownRankedWarOnly,
    scoreDownNonRankedWar: state.stats.scoreDownNonRankedWar,
    scoreDownRankedWarOnlyCount: state.stats.scoreDownRankedWarOnlyCount,
    scoreDownNonRankedWarCount: state.stats.scoreDownNonRankedWarCount,
    playersUpdated: Object.keys(state.players || {}).length
  };
}

function attackSummaryStateKey(factionId, warId) {
  return `attack_summary:${factionId}:${warId}`;
}

async function loadAttackSummaryState(env, factionId, warId) {
  const row = await env.DB.prepare(
    `
    SELECT value
    FROM app_meta
    WHERE key = ?
    `
  )
    .bind(attackSummaryStateKey(factionId, warId))
    .first();

  if (!row || !row.value) {
    return null;
  }

  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function saveAttackSummaryState(env, factionId, warId, state) {
  await env.DB.prepare(
    `
    INSERT INTO app_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
    `
  )
    .bind(
      attackSummaryStateKey(factionId, warId),
      JSON.stringify(state),
      nowUnix()
    )
    .run();
}

async function deleteAttackSummaryState(env, factionId, warId) {
  await env.DB.prepare(
    `
    DELETE FROM app_meta
    WHERE key = ?
    `
  )
    .bind(attackSummaryStateKey(factionId, warId))
    .run();
}

async function applyAttackSummaryToWarLog(env, war, rows) {
  const now = nowUnix();

  await env.DB.prepare(
    `
    UPDATE war_log
    SET outside_hits = 0,
        assists = 0,
        score_down = 0,
        synced_at = ?
    WHERE war_id = ?
      AND faction_id = ?
    `
  )
    .bind(now, war.war_id, war.faction_id)
    .run();

  for (const row of rows) {
    await env.DB.prepare(
      `
      INSERT INTO war_log (
        war_id,
        faction_id,
        player_id,
        player_name,
        is_member,
        termed,
        war_hits,
        outside_hits,
        assists,
        score_up,
        score_up_official,
        score_up_adjusted,
        chain_bonus_score,
        chain_bonus_hits,
        score_down,
        synced_at
      )
      VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, 0, 0, 0, 0, 0, ?, ?)
      ON CONFLICT(war_id, player_id) DO UPDATE SET
        player_name = excluded.player_name,
        outside_hits = excluded.outside_hits,
        assists = excluded.assists,
        score_down = excluded.score_down,
        synced_at = excluded.synced_at
      `
    )
      .bind(
        war.war_id,
        war.faction_id,
        row.playerId,
        row.playerName,
        row.outsideHits,
        row.assists,
        row.scoreDown,
        now
      )
      .run();
  }
}

/* =========================
   TORN FETCHING
========================= */

async function verifyTornApiKey(apiKey) {
  const url =
    "https://api.torn.com/user/?selections=profile&key=" +
    encodeURIComponent(apiKey) +
    "&timestamp=" +
    Date.now();

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error("Torn returned invalid JSON.");
  }

  if (!response.ok) {
    throw new Error(`Torn API request failed with status ${response.status}.`);
  }

  if (data.error) {
    const message =
      data.error.error ||
      data.error.message ||
      "Unknown Torn API error.";

    throw new Error(`Torn API error: ${message}`);
  }

  return data;
}

async function fetchRankedWarReport(rankId, apiKey) {
  const v2Url =
    "https://api.torn.com/v2/faction/" +
    encodeURIComponent(rankId) +
    "/rankedwarreport?key=" +
    encodeURIComponent(apiKey) +
    "&timestamp=" +
    Date.now();

  const v1Url =
    "https://api.torn.com/torn/" +
    encodeURIComponent(rankId) +
    "?selections=rankedwarreport&key=" +
    encodeURIComponent(apiKey) +
    "&timestamp=" +
    Date.now();

  const v2Result = await fetchTornJson(v2Url);

  if (v2Result.success) {
    return v2Result.data;
  }

  const v1Result = await fetchTornJson(v1Url);

  if (v1Result.success) {
    return v1Result.data;
  }

  throw new Error(
    v2Result.message ||
    v1Result.message ||
    "Failed to fetch ranked war report."
  );
}

async function fetchFactionAttacksPage(apiKey, fromTimestamp, toTimestamp) {
  const url =
    "https://api.torn.com/faction/?selections=attacks" +
    "&from=" +
    encodeURIComponent(fromTimestamp) +
    "&to=" +
    encodeURIComponent(toTimestamp) +
    "&key=" +
    encodeURIComponent(apiKey) +
    "&timestamp=" +
    Date.now();

  const result = await fetchTornJson(url);

  if (!result.success) {
    throw new Error(result.message || "Failed to fetch faction attacks.");
  }

  const rawAttacks =
    result.data.attacks ||
    result.data.faction_attacks ||
    {};

  const attacks = normalizeAttackEntries(rawAttacks)
    .map(([attackId, attack]) => normalizeAttack(attackId, attack))
    .filter(attack => attack.attackId);

  return {
    attacks
  };
}

async function fetchTornJson(url) {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });

    let data;

    try {
      data = await response.json();
    } catch {
      return {
        success: false,
        message: "Torn returned invalid JSON."
      };
    }

    if (data.error) {
      const message =
        data.error.error ||
        data.error.message ||
        "Unknown Torn API error.";

      return {
        success: false,
        message: `Torn API error: ${message}`
      };
    }

    if (!response.ok) {
      return {
        success: false,
        message: `Torn API request failed with status ${response.status}.`
      };
    }

    return {
      success: true,
      data
    };
  } catch (error) {
    return {
      success: false,
      message: error.message || "Torn API request failed."
    };
  }
}

/* =========================
   NORMALIZERS
========================= */

function normalizeFaction(profile) {
  const factionData = profile.faction || {};

  const factionId =
    Number(factionData.faction_id) ||
    Number(factionData.id) ||
    Number(profile.faction_id) ||
    null;

  const factionName =
    factionData.faction_name ||
    factionData.name ||
    profile.faction_name ||
    null;

  return {
    factionId,
    factionName
  };
}

function normalizeRankedWarReport(rawData, rankId, ownFactionId) {
  const report =
    rawData.rankedwarreport ||
    rawData.ranked_war_report ||
    rawData.rankedWarReport ||
    rawData.report ||
    rawData;

  const factions =
    report.factions ||
    report.faction ||
    rawData.factions ||
    {};

  const factionEntries = normalizeFactionEntries(factions);

  if (!factionEntries.length) {
    throw new Error("Ranked war report did not contain faction data.");
  }

  const ownEntry = factionEntries.find(([id, faction]) => {
    const possibleId =
      Number(id) ||
      Number(faction.id) ||
      Number(faction.faction_id) ||
      Number(faction.factionId);

    return possibleId === ownFactionId;
  });

  if (!ownEntry) {
    throw new Error(
      `This report does not contain your faction ID (${ownFactionId}).`
    );
  }

  const opponentEntry =
    factionEntries.find(([id, faction]) => {
      const possibleId =
        Number(id) ||
        Number(faction.id) ||
        Number(faction.faction_id) ||
        Number(faction.factionId);

      return possibleId !== ownFactionId;
    }) || [null, {}];

  const [ownIdRaw, ownFaction] = ownEntry;
  const [opponentIdRaw, opponentFaction] = opponentEntry;

  const factionId =
    Number(ownIdRaw) ||
    Number(ownFaction.id) ||
    Number(ownFaction.faction_id) ||
    Number(ownFaction.factionId) ||
    ownFactionId;

  const opponentFactionId =
    Number(opponentIdRaw) ||
    Number(opponentFaction.id) ||
    Number(opponentFaction.faction_id) ||
    Number(opponentFaction.factionId) ||
    null;

  const factionName =
    pickString(ownFaction, [
      "name",
      "faction_name",
      "factionName"
    ]) || "Unknown faction";

  const opponentFactionName =
    pickString(opponentFaction, [
      "name",
      "faction_name",
      "factionName"
    ]) || "Unknown opponent";

  const warInfo =
    report.war ||
    report.ranked_war ||
    report.rankedWar ||
    {};

  const startTimestamp =
    pickNumber(warInfo, ["start", "started", "start_timestamp", "startTimestamp"]) ||
    pickNumber(report, ["start", "started", "start_timestamp", "startTimestamp"]) ||
    null;

  const endTimestamp =
    pickNumber(warInfo, ["end", "ended", "end_timestamp", "endTimestamp"]) ||
    pickNumber(report, ["end", "ended", "end_timestamp", "endTimestamp"]) ||
    null;

  const membersRaw =
    ownFaction.members ||
    ownFaction.member ||
    {};

  const members = normalizeMemberEntries(membersRaw)
    .map(([id, member]) => {
      const playerId =
        Number(id) ||
        Number(member.id) ||
        Number(member.user_id) ||
        Number(member.player_id) ||
        Number(member.playerId);

      const playerName =
        pickString(member, ["name", "player_name", "playerName"]) ||
        `Player ${playerId}`;

      const warHits = pickNumber(member, [
        "attacks",
        "hits",
        "war_hits",
        "warHits",
        "attacks_made"
      ]);

      const scoreUp = pickNumber(member, [
        "score",
        "score_gain",
        "scoreGain",
        "points",
        "points_gained",
        "respect",
        "respect_gain",
        "respectGain",
        "respect_gained"
      ]);

      return {
        playerId,
        playerName,
        warHits,
        scoreUp
      };
    })
    .filter(member => member.playerId && member.playerName);

  if (!members.length) {
    throw new Error("No member rows found in the ranked war report.");
  }

  return {
    warId: String(rankId),
    reportId: String(rankId),
    factionId,
    factionName,
    opponentFactionId,
    opponentFactionName,
    startTimestamp,
    endTimestamp,
    members
  };
}

function normalizeFactionEntries(factions) {
  if (Array.isArray(factions)) {
    return factions.map(faction => {
      const id =
        faction.id ||
        faction.faction_id ||
        faction.factionId ||
        null;

      return [String(id || ""), faction];
    });
  }

  if (factions && typeof factions === "object") {
    return Object.entries(factions);
  }

  return [];
}

function normalizeMemberEntries(members) {
  if (Array.isArray(members)) {
    return members.map(member => {
      const id =
        member.id ||
        member.user_id ||
        member.player_id ||
        member.playerId ||
        null;

      return [String(id || ""), member];
    });
  }

  if (members && typeof members === "object") {
    return Object.entries(members);
  }

  return [];
}

function normalizeAttackEntries(attacks) {
  if (Array.isArray(attacks)) {
    return attacks.map(attack => {
      const attackId =
        attack.id ||
        attack.attack_id ||
        attack.attackId ||
        null;

      return [String(attackId || ""), attack];
    });
  }

  if (attacks && typeof attacks === "object") {
    return Object.entries(attacks);
  }

  return [];
}

function normalizeAttack(attackId, attack) {
  const attackerId =
    pickNumber(attack, ["attacker_id", "attackerId"]) ||
    pickNumber(attack.attacker || {}, ["id", "user_id", "player_id"]);

  const defenderId =
    pickNumber(attack, ["defender_id", "defenderId"]) ||
    pickNumber(attack.defender || {}, ["id", "user_id", "player_id"]);

  const attackerName =
    pickString(attack, ["attacker_name", "attackerName"]) ||
    pickString(attack.attacker || {}, ["name"]) ||
    `Player ${attackerId}`;

  const defenderName =
    pickString(attack, ["defender_name", "defenderName"]) ||
    pickString(attack.defender || {}, ["name"]) ||
    `Player ${defenderId}`;

  const attackerFactionId =
    parseFactionId(
      attack.attacker_faction_id ??
      attack.attackerFactionId ??
      attack.attacker_faction ??
      attack.attackerFaction ??
      attack.attacker?.faction
    );

  const defenderFactionId =
    parseFactionId(
      attack.defender_faction_id ??
      attack.defenderFactionId ??
      attack.defender_faction ??
      attack.defenderFaction ??
      attack.defender?.faction
    );

  const result =
    pickString(attack, ["result", "attack_result", "attackResult"]) ||
    "";

  const resultText = result.toLowerCase();

  const hasAssistModifier =
    attack.modifiers &&
    Object.prototype.hasOwnProperty.call(attack.modifiers, "assist");

  const assistModifierNumber = Number(attack.modifiers?.assist);

  const isAssist =
    resultText.includes("assist") ||
    attack.is_assist === true ||
    Number(attack.is_assist || 0) === 1 ||
    attack.assist === true ||
    Number(attack.assist || 0) === 1 ||
    attack.modifiers?.assist === true ||
    (
      hasAssistModifier &&
      attack.modifiers.assist !== false &&
      (
        !Number.isFinite(assistModifierNumber) ||
        assistModifierNumber !== 0
      )
    );

  const isRankedWar =
    attack.is_ranked_war === true ||
    attack.isRankedWar === true ||
    attack.ranked_war === true ||
    attack.rankedWar === true ||
    Number(attack.is_ranked_war || 0) === 1 ||
    Number(attack.isRankedWar || 0) === 1 ||
    Number(attack.ranked_war || 0) === 1 ||
    Number(attack.rankedWar || 0) === 1 ||
    attack.modifiers?.ranked_war === true ||
    attack.modifiers?.rankedWar === true ||
    Number(attack.modifiers?.ranked_war || 0) === 1 ||
    Number(attack.modifiers?.rankedWar || 0) === 1;

  const scoreGain =
    pickNumber(attack, [
      "score",
      "score_gain",
      "scoreGain",
      "points",
      "points_gained",
      "respect_gain",
      "respectGain",
      "respect",
      "respect_gained"
    ]);

  const timestampStarted =
    pickNumber(attack, [
      "timestamp_started",
      "timestampStarted",
      "started",
      "start"
    ]);

  const timestampEnded =
    pickNumber(attack, [
      "timestamp_ended",
      "timestampEnded",
      "ended",
      "end"
    ]);

  return {
    attackId: String(attackId || attack.id || attack.attack_id || ""),
    attackerId,
    attackerName,
    defenderId,
    defenderName,
    attackerFactionId,
    defenderFactionId,
    result,
    isAssist,
    isRankedWar,
    scoreGain,
    timestampStarted,
    timestampEnded
  };
}

function parseFactionId(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number" || typeof value === "string") {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  if (typeof value === "object") {
    const number =
      Number(value.id) ||
      Number(value.faction_id) ||
      Number(value.factionId);

    return Number.isFinite(number) && number > 0 ? number : null;
  }

  return null;
}

/* =========================
   DATABASE / SESSION
========================= */

async function createSession(env, userId) {
  const token = randomBase64Url(48);
  const tokenHash = await sha256Hex(token);
  const sessionId = randomBase64Url(24);

  const now = nowUnix();
  const expiresAt = now + SESSION_SECONDS;

  await env.DB.prepare(
    `
    INSERT INTO sessions (
      session_id,
      user_id,
      token_hash,
      created_at,
      expires_at
    )
    VALUES (?, ?, ?, ?, ?)
    `
  )
    .bind(sessionId, userId, tokenHash, now, expiresAt)
    .run();

  return {
    token,
    expiresAt
  };
}

function rowToPublicUser(row) {
  return {
    userId: row.user_id,
    playerId: row.player_id,
    playerName: row.player_name,
    factionId: row.faction_id,
    factionName: row.faction_name,
    isAdmin: Number(row.is_admin) === 1
  };
}

function buildSessionCookie(token) {
  return [
    `rwengine_session=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_SECONDS}`
  ].join("; ");
}

function clearSessionCookie() {
  return [
    "rwengine_session=",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0"
  ].join("; ");
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";

  const cookies = cookieHeader
    .split(";")
    .map(cookie => cookie.trim())
    .filter(Boolean);

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex === -1) continue;

    const cookieName = cookie.slice(0, separatorIndex);
    const cookieValue = cookie.slice(separatorIndex + 1);

    if (cookieName === name) {
      return decodeURIComponent(cookieValue);
    }
  }

  return null;
}

/* =========================
   PASSWORD HASHING
========================= */

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );

  return bufferToHex(derivedBits);
}

/* =========================
   API KEY ENCRYPTION
========================= */

async function encryptText(secret, text) {
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("rwengine-v2-api-key-encryption"),
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv
    },
    key,
    encoder.encode(text)
  );

  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}

async function decryptText(secret, ciphertextBase64, ivBase64) {
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("rwengine-v2-api-key-encryption"),
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["decrypt"]
  );

  const iv = base64ToBytes(ivBase64);
  const ciphertext = base64ToBytes(ciphertextBase64);

  const plaintextBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv
    },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintextBuffer);
}

/* =========================
   HELPERS
========================= */

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders
    }
  });
}

function requireDb(env) {
  if (!env.DB) {
    throw new Error("D1 binding missing. Expected binding name: DB.");
  }
}

function requireSecret(env) {
  if (!env.APP_SECRET) {
    throw new Error("Missing APP_SECRET secret.");
  }
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function randomBase64Url(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));

  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sha256Hex(value) {
  const encoder = new TextEncoder();

  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(value)
  );

  return bufferToHex(hashBuffer);
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function pickString(object, keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) {
      const value = String(object[key]).trim();

      if (value) {
        return value;
      }
    }
  }

  return null;
}

function pickTimestamp(object, keys) {
  for (const key of keys) {
    const value = object?.[key];

    const timestamp = normalizeUnixTimestamp(value);

    if (timestamp) {
      return timestamp;
    }
  }

  return 0;
}

function normalizeUnixTimestamp(value) {
  if (value === undefined || value === null) {
    return 0;
  }

  if (typeof value === "object") {
    const nested =
      value.timestamp ??
      value.time ??
      value.epoch ??
      value.unix ??
      value.seconds ??
      value.value ??
      value.date;

    return normalizeUnixTimestamp(nested);
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }

  if (number > 1000000000000) {
    return Math.floor(number / 1000);
  }

  return Math.floor(number);
}

function pickNumber(object, keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) {
      const number = Number(object[key]);

      if (Number.isFinite(number)) {
        return number;
      }
    }
  }

  return 0;
}
