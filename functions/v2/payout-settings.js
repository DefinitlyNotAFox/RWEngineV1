import { loadFactionPermissions } from './faction-leadership.js';
import {
  cloneDefaultPayoutProfile,
  loadPayoutProfile,
  normalizePayoutProfile,
  payoutCatalog,
  resetPayoutProfile,
  savePayoutProfile
} from './payout-profile.js';

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
    await ensurePresetSchema(env.DB);
    const canEdit = await canEditSettings(env.DB, user, factionId);

    if (action === 'get') {
      return json({
        success:true,
        factionId,
        canEdit,
        catalog:payoutCatalog(),
        defaults:cloneDefaultPayoutProfile(),
        profile:await loadPayoutProfile(env.DB, factionId),
        presets:canEdit ? await loadPresets(env.DB, factionId) : []
      });
    }

    if (!canEdit) {
      throw httpError(403, 'Faction-admin access is required to change payout settings.');
    }

    if (action === 'save') {
      const profile = normalizePayoutProfile(body.profile);
      await savePayoutProfile(env.DB, factionId, profile);
      return json({
        success:true,
        factionId,
        profile,
        catalog:payoutCatalog(),
        message:'Payout profile saved.'
      });
    }

    if (action === 'reset') {
      const profile = await resetPayoutProfile(env.DB, factionId);
      return json({
        success:true,
        factionId,
        profile,
        catalog:payoutCatalog(),
        presets:await loadPresets(env.DB, factionId),
        message:'Payout profile reset to defaults.'
      });
    }

    if (action === 'savePreset') {
      const name = presetName(body.name);
      const profile = normalizePayoutProfile(body.profile);
      const requestedId = Number(body.presetId || 0);
      const now = unixNow();
      let presetId = requestedId;

      if (requestedId > 0) {
        const existing = await env.DB.prepare(
          'SELECT preset_id FROM payout_setting_presets WHERE faction_id = ? AND preset_id = ? LIMIT 1'
        ).bind(factionId, requestedId).first();
        if (!existing) throw httpError(404, 'Payout preset not found.');

        await env.DB.prepare(`
          UPDATE payout_setting_presets
          SET name = ?, profile_json = ?, updated_at = ?
          WHERE faction_id = ? AND preset_id = ?
        `).bind(name, JSON.stringify(profile), now, factionId, requestedId).run();
      } else {
        const sameName = await env.DB.prepare(
          'SELECT preset_id FROM payout_setting_presets WHERE faction_id = ? AND LOWER(name) = LOWER(?) LIMIT 1'
        ).bind(factionId, name).first();

        if (sameName?.preset_id) {
          presetId = Number(sameName.preset_id);
          await env.DB.prepare(`
            UPDATE payout_setting_presets
            SET name = ?, profile_json = ?, updated_at = ?
            WHERE faction_id = ? AND preset_id = ?
          `).bind(name, JSON.stringify(profile), now, factionId, presetId).run();
        } else {
          const result = await env.DB.prepare(`
            INSERT INTO payout_setting_presets (
              faction_id, name, profile_json, created_by_user_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).bind(
            factionId,
            name,
            JSON.stringify(profile),
            Number(user.user_id),
            now,
            now
          ).run();
          presetId = Number(result.meta?.last_row_id || 0);
        }
      }

      const presets = await loadPresets(env.DB, factionId);
      return json({
        success:true,
        factionId,
        preset:presets.find(item => Number(item.presetId) === Number(presetId)) || null,
        presets,
        message:'Payout preset saved.'
      });
    }

    if (action === 'deletePreset') {
      const presetId = Number(body.presetId || 0);
      if (!Number.isSafeInteger(presetId) || presetId <= 0) {
        throw httpError(400, 'Select a payout preset to delete.');
      }

      const result = await env.DB.prepare(
        'DELETE FROM payout_setting_presets WHERE faction_id = ? AND preset_id = ?'
      ).bind(factionId, presetId).run();

      if (Number(result.meta?.changes || 0) < 1) {
        throw httpError(404, 'Payout preset not found.');
      }

      return json({
        success:true,
        factionId,
        presets:await loadPresets(env.DB, factionId),
        message:'Payout preset deleted.'
      });
    }

    throw httpError(400, 'Unknown payout settings action: ' + action);
  } catch (error) {
    return json({
      success:false,
      message:error?.message || 'Unexpected payout settings error.'
    }, error?.status || 500);
  }
}

async function ensurePresetSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS payout_setting_presets (
      preset_id INTEGER PRIMARY KEY AUTOINCREMENT,
      faction_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      created_by_user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_payout_setting_presets_faction
    ON payout_setting_presets(faction_id, name)
  `).run();
}

async function loadPresets(db, factionId) {
  const result = await db.prepare(`
    SELECT preset_id, name, profile_json, created_at, updated_at
    FROM payout_setting_presets
    WHERE faction_id = ?
    ORDER BY name COLLATE NOCASE, preset_id
  `).bind(factionId).all();

  return (result.results || []).map(row => {
    let profile = cloneDefaultPayoutProfile();
    try { profile = normalizePayoutProfile(JSON.parse(String(row.profile_json || '{}'))); }
    catch (_) {}
    return {
      presetId:Number(row.preset_id),
      name:String(row.name || 'Preset'),
      profile,
      createdAt:Number(row.created_at || 0),
      updatedAt:Number(row.updated_at || 0)
    };
  });
}

function presetName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) throw httpError(400, 'Enter a preset name.');
  if (name.length > 60) throw httpError(400, 'Preset names can be up to 60 characters.');
  return name;
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
      u.user_id, u.player_id, u.player_name, u.faction_id,
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

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

async function readJson(request) {
  try { return await request.json(); }
  catch (_) { return {}; }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }
  });
}
