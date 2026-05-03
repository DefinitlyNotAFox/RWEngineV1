const SESSION_DAYS = 14;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;

const ATTACK_PAGE_SOFT_LIMIT = 100;
const ATTACK_FETCH_MAX_WINDOWS = 800;
const ATTACK_FETCH_WINDOWS_PER_STEP = 5;
const ATTACK_TIME_PADDING_SECONDS = 60;
const ATTACK_MIN_SPLIT_SECONDS = 1;

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
    return json(
      {
        success: false,
        message: "Missing Torn API key."
      },
      400
    );
  }

  if (!password || password.length < 8) {
    return json(
      {
        success: false,
        message: "Password must be at least 8 characters."
      },
      400
    );
  }

  if (password !== confirmPassword) {
    return json(
      {
        success: false,
        message: "Passwords do not match."
      },
      400
    );
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

async function handleLogin(env, body) {
  requireDb(env);

  const playerId = Number(body.playerId);
  const password = String(body.password || "");

  if (!playerId) {
    return json(
      {
        success: false,
        message: "Missing Torn player ID."
      },
      400
    );
  }

  if (!password) {
    return json(
      {
        success: false,
        message: "Missing password."
      },
      400
    );
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
    return json(
      {
        success: false,
        message: "Invalid player ID or password."
      },
      401
    );
  }

  if (Number(userRow.is_disabled) === 1) {
    return json(
      {
        success: false,
        message: "This account is disabled."
      },
      403
    );
  }

  const attemptedHash = await hashPassword(password, userRow.password_salt);

  if (attemptedHash !== userRow.password_hash) {
    return json(
      {
        success: false,
        message: "Invalid player ID or password."
      },
      401
    );
  }

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
      user: rowToPublicUser(userRow)
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
    return json(
      {
        success: false,
        message: "Not logged in."
      },
      401
    );
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

  return json({
    success: true,
    message: "Session restored.",
    user: rowToPublicUser(row)
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
      SUM(score_down) AS score_down
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
      imported_at
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

  const currentUser = await getCurrentUserPrivate(env, request);

  if (Number(currentUser.is_admin) !== 1) {
    return json(
      {
        success: false,
        message: "Only admins can import ranked war reports."
      },
      403
    );
  }

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
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ranked', ?, ?, ?)
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
      updated_at = excluded.updated_at
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
        score_down,
        synced_at
      )
      VALUES (?, ?, ?, ?, 1, 0, ?, 0, 0, ?, 0, ?)
      `
    )
      .bind(
        normalized.warId,
        normalized.factionId,
        member.playerId,
        member.playerName,
        member.warHits,
        member.scoreUp,
        now
      )
      .run();
  }

  return json({
    success: true,
    skipped: false,
    overwritten: Boolean(existingWarBeforeFetch || existingWarAfterFetch),
    message: `War imported. Members added: ${normalized.members.length}.`,
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
   ATTACK SUMMARY ACTION
========================= */

async function handleApplyAttackSummary(env, request, body) {
  requireDb(env);
  requireSecret(env);

  const currentUser = await getCurrentUserPrivate(env, request);

  if (Number(currentUser.is_admin) !== 1) {
    return json(
      {
        success: false,
        message: "Only admins can apply attack summaries."
      },
      403
    );
  }

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
      scoreDown: 0
    },

    players: {},
    createdAt: nowUnix(),
    updatedAt: nowUnix()
  };
}

  return {
    warId: String(war.war_id),
    factionId: Number(war.faction_id),
    startTimestamp,
    endTimestamp,
    pendingWindows: [
      {
        from: startTimestamp,
        to: endTimestamp
      }
    ],
    seenAttackIds: [],
    stats: {
      checked: 0,
      rawAttackRowsReturned: 0,
      uniqueAttacksFetched: 0,
      windowsFetched: 0,
      splitWindows: 0,
      saturatedLeafWindows: 0,
      outsideHits: 0,
      assists: 0,
      scoreDown: 0
    },
    players: {},
    createdAt: nowUnix(),
    updatedAt: nowUnix()
  };
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
    rawAttackRowsReturned: state.stats.rawAttackRowsReturned,
    uniqueAttacksFetched: state.stats.uniqueAttacksFetched,
    windowsFetched: state.stats.windowsFetched,
    splitWindows: state.stats.splitWindows,
    saturatedLeafWindows: state.stats.saturatedLeafWindows,
    outsideHits: state.stats.outsideHits,
    assists: state.stats.assists,
    scoreDown: state.stats.scoreDown,
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
        score_down,
        synced_at
      )
      VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, 0, ?, ?)
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

  const isAssist =
    resultText.includes("assist") ||
    attack.is_assist === true ||
    Number(attack.is_assist || 0) === 1 ||
    attack.assist === true ||
    Number(attack.assist || 0) === 1 ||
    Number(attack.modifiers?.assist || 0) > 1;

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
