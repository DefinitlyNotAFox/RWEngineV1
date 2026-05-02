const SESSION_DAYS = 14;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;

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
   TORN
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
