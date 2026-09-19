import { loadFactionPermissions } from './faction-leadership.js';

const CONFIG_KEY = 'auto_tag_thresholds_v1';

export const DEFAULT_AUTO_TAG_SETTINGS = {
  lowWarHits: {
    enabled:true,
    yellow:15,
    orange:10,
    red:6
  },
  highWarHits: {
    enabled:true,
    teal:25,
    green:40,
    bright:60
  },
  outsideHits: {
    enabled:true,
    yellow:10
  },
  respectPerHit: {
    enabled:true,
    yellow:4.5,
    orange:4,
    red:3.5,
    minimumHits:10
  },
  assists: {
    enabled:true,
    teal:10,
    green:20,
    bright:35
  },
  trainingEnergy: {
    enabled:true,
    red:400,
    orange:550,
    yellow:700,
    teal:1200,
    green:1350,
    bright:1500
  },
  inactivity: {
    enabled:true,
    yellowHours:24,
    orangeHours:48,
    redHours:72
  }
};

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') {
      return json({ success:false, message:'Method not allowed. Use POST.' }, 405);
    }
    if (!env.DB) throw new Error('D1 binding missing. Expected binding name: DB.');

    const body = await readJson(request);
    const user = await getCurrentUser(env, request);
    const factionId = await resolveFactionId(env.DB, user, body.factionId);
    const action = String(body.action || 'get');

    if (action === 'get') {
      const settings = await loadSettings(env.DB, factionId);
      return json({
        success:true,
        factionId,
        canEdit:await canEditSettings(env.DB, user, factionId),
        defaults:cloneDefaults(),
        settings
      });
    }

    const editable = await canEditSettings(env.DB, user, factionId);
    if (!editable) {
      throw httpError(403, 'Faction-admin access is required to change auto-tag settings.');
    }

    if (action === 'save') {
      const settings = normalizeSettings(body.settings);
      await saveSettings(env.DB, factionId, settings);
      return json({
        success:true,
        factionId,
        settings,
        message:'Auto-tag thresholds saved.'
      });
    }

    if (action === 'reset') {
      await env.DB.prepare(
        'DELETE FROM faction_config WHERE faction_id = ? AND config_key = ?'
      ).bind(factionId, CONFIG_KEY).run();

      return json({
        success:true,
        factionId,
        settings:cloneDefaults(),
        message:'Auto-tag thresholds reset to defaults.'
      });
    }

    throw httpError(400, 'Unknown auto-tag settings action: ' + action);
  } catch (error) {
    return json(
      { success:false, message:error?.message || 'Unexpected auto-tag settings error.' },
      error?.status || 500
    );
  }
}

export function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const settings = cloneDefaults();

  for (const key of Object.keys(settings)) {
    const incoming = source[key];
    if (!incoming || typeof incoming !== 'object') continue;
    settings[key].enabled = incoming.enabled !== false;

    for (const field of Object.keys(settings[key])) {
      if (field === 'enabled') continue;
      if (Object.prototype.hasOwnProperty.call(incoming, field)) {
        settings[key][field] = finiteNumber(incoming[field], key + '.' + field);
      }
    }
  }

  assertRange(settings.lowWarHits.red, settings.lowWarHits.orange, settings.lowWarHits.yellow,
    'Low war hits must increase from red to orange to yellow.');
  assertRange(settings.highWarHits.teal, settings.highWarHits.green, settings.highWarHits.bright,
    'High war hits must increase from teal to green to bright green.');
  assertRange(settings.respectPerHit.red, settings.respectPerHit.orange, settings.respectPerHit.yellow,
    'Respect / hit must increase from red to orange to yellow.');
  assertRange(settings.assists.teal, settings.assists.green, settings.assists.bright,
    'Assists must increase from teal to green to bright green.');
  assertAscending([
    settings.trainingEnergy.red,
    settings.trainingEnergy.orange,
    settings.trainingEnergy.yellow,
    settings.trainingEnergy.teal,
    settings.trainingEnergy.green,
    settings.trainingEnergy.bright
  ], 'Training E thresholds must increase from red through bright green.');
  assertRange(
    settings.inactivity.yellowHours,
    settings.inactivity.orangeHours,
    settings.inactivity.redHours,
    'Inactivity thresholds must increase from yellow to orange to red.'
  );

  if (settings.outsideHits.yellow < 0) {
    throw httpError(400, 'Outside hits cannot be negative.');
  }
  if (settings.respectPerHit.minimumHits < 1 || settings.respectPerHit.minimumHits > 1000) {
    throw httpError(400, 'Respect / hit minimum sample must be between 1 and 1000 hits.');
  }

  for (const [family, config] of Object.entries(settings)) {
    for (const [field, value] of Object.entries(config)) {
      if (field === 'enabled') continue;
      if (value < 0 || value > 100000) {
        throw httpError(400, family + '.' + field + ' is outside the allowed range.');
      }
    }
  }

  return settings;
}

export async function loadSettings(db, factionId) {
  const row = await db.prepare(
    'SELECT config_value FROM faction_config WHERE faction_id = ? AND config_key = ? LIMIT 1'
  ).bind(factionId, CONFIG_KEY).first();

  if (!row?.config_value) return cloneDefaults();

  try {
    return normalizeSettings(JSON.parse(String(row.config_value)));
  } catch (_) {
    return cloneDefaults();
  }
}

async function saveSettings(db, factionId, settings) {
  const now = unixNow();
  await db.prepare(`
    INSERT INTO faction_config (
      faction_id, config_key, config_value, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(faction_id, config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_at = excluded.updated_at
  `).bind(
    factionId,
    CONFIG_KEY,
    JSON.stringify(settings),
    now,
    now
  ).run();
}

async function canEditSettings(db, user, factionId) {
  if (Number(user?.is_admin) === 1) return true;
  const permissions = await loadFactionPermissions(db, user, factionId);
  return permissions.isFactionAdmin === true;
}

async function resolveFactionId(db, user, requestedValue) {
  const accountFactionId = Number(user.faction_id || 0);
  const requestedFactionId = Number(requestedValue || accountFactionId);
  if (!Number.isSafeInteger(requestedFactionId) || requestedFactionId <= 0) {
    throw httpError(400, 'A valid faction is required.');
  }
  if (requestedFactionId !== accountFactionId && Number(user.is_admin) !== 1) {
    throw httpError(403, 'Platform-admin access is required for another faction.');
  }

  const faction = await db.prepare(
    'SELECT faction_id FROM factions WHERE faction_id = ? AND enabled = 1 LIMIT 1'
  ).bind(requestedFactionId).first();
  if (!faction) throw httpError(404, 'That faction is not tracked by RWEngine.');
  return requestedFactionId;
}

async function getCurrentUser(env, request) {
  const token = cookie(request, 'rwengine_session');
  if (!token) throw httpError(401, 'Not logged in.');
  const tokenHash = await sha256(token);
  const user = await env.DB.prepare(`
    SELECT
      u.user_id, u.player_id, u.player_name, u.faction_id, u.faction_name,
      u.is_admin, u.is_disabled
    FROM sessions s
    JOIN users u ON u.user_id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, unixNow()).first();

  if (!user) throw httpError(401, 'Session expired or invalid.');
  if (Number(user.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  return user;
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_AUTO_TAG_SETTINGS));
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw httpError(400, label + ' must be a number.');
  }
  return number;
}

function assertRange(a, b, c, message) {
  if (!(a < b && b < c)) throw httpError(400, message);
}

function assertAscending(values, message) {
  for (let index = 1; index < values.length; index += 1) {
    if (!(values[index - 1] < values[index])) throw httpError(400, message);
  }
}

function cookie(request, name) {
  const source = request.headers.get('Cookie') || '';
  for (const part of source.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readJson(request) {
  try { return await request.json(); } catch (_) { return {}; }
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'Content-Type':'application/json' }
  });
}
