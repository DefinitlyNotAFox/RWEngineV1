import { loadFactionPermissions } from './faction-leadership.js';

const MANAGED_KEY_CONFIG = 'managed_api_key_v1';
const DAY = 86400;
const INITIAL_LOOKBACK = 90 * DAY;
const SYNC_OVERLAP = 3600;

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
    await ensureFinanceSchema(env.DB);
    await ensureWarFinanceColumns(env.DB);

    const permissions = await loadFactionPermissions(env.DB, user, factionId);
    const canManage = Number(user.is_admin) === 1 || permissions.isFactionAdmin === true;
    const action = String(body.action || 'summary');

    if (action === 'summary') {
      return json(await buildFinanceSummary(env.DB, factionId, canManage));
    }

    if (action === 'syncArmory') {
      if (!canManage) throw httpError(403, 'Faction-admin access is required to sync armory expenses.');
      const sync = await syncArmoryExpenses(env, factionId);
      const summary = await buildFinanceSummary(env.DB, factionId, canManage);
      return json({ ...summary, sync });
    }

    throw httpError(400, 'Unknown finance action: ' + action);
  } catch (error) {
    return json(
      { success:false, message:error?.message || 'Unexpected finance error.' },
      error?.status || 500
    );
  }
}

async function buildFinanceSummary(db, factionId, canManage) {
  const warsResult = await db.prepare(`
    SELECT
      war_id,
      opponent_faction_id,
      opponent_faction_name,
      start_timestamp,
      end_timestamp,
      imported_at,
      COALESCE(payout_status, 'outstanding') AS payout_status,
      payout_snapshot_json,
      payout_total_override
    FROM wars
    WHERE faction_id = ?
      AND COALESCE(payout_status, 'outstanding') = 'paid'
    ORDER BY COALESCE(end_timestamp, start_timestamp, imported_at, 0) DESC
    LIMIT 80
  `).bind(factionId).all();

  const expenseResult = await db.prepare(`
    SELECT
      war_id,
      SUM(total_value) AS total_value,
      SUM(quantity) AS quantity,
      COUNT(*) AS event_count
    FROM finance_armory_events
    WHERE faction_id = ? AND war_id IS NOT NULL
    GROUP BY war_id
  `).bind(factionId).all();

  const expenseByWar = new Map(
    (expenseResult.results || []).map(row => [String(row.war_id), {
      totalValue:Number(row.total_value || 0),
      quantity:Number(row.quantity || 0),
      eventCount:Number(row.event_count || 0)
    }])
  );

  const rows = (warsResult.results || []).map(row => {
    const snapshot = parseJson(row.payout_snapshot_json);
    const income = resolveWarIncome(snapshot, row);
    const memberPayout = Math.max(0, Math.round(Number(snapshot?.totalPayout || 0)));
    const armory = expenseByWar.get(String(row.war_id)) || {
      totalValue:0,
      quantity:0,
      eventCount:0
    };
    const net = Math.round(income.amount - memberPayout - armory.totalValue);

    return {
      warId:String(row.war_id),
      opponentFactionId:Number(row.opponent_faction_id || 0) || null,
      opponentFactionName:row.opponent_faction_name || 'Unknown opponent',
      startTimestamp:Number(row.start_timestamp || 0) || null,
      endTimestamp:Number(row.end_timestamp || 0) || null,
      importedAt:Number(row.imported_at || 0) || null,
      payoutStatus:String(row.payout_status || 'outstanding') === 'paid' ? 'paid' : 'outstanding',
      income:income.amount,
      incomeSource:income.source,
      memberPayout,
      armoryExpense:Math.round(armory.totalValue),
      armoryItems:armory.quantity,
      armoryEvents:armory.eventCount,
      net,
      margin:income.amount > 0 ? net / income.amount : null
    };
  });

  const tracked = rows;

  const totals = tracked.reduce((sum,row) => ({
    income:sum.income + row.income,
    memberPayout:sum.memberPayout + row.memberPayout,
    armoryExpense:sum.armoryExpense + row.armoryExpense,
    net:sum.net + row.net
  }), { income:0, memberPayout:0, armoryExpense:0, net:0 });

  const lastSyncAt = Number(await getMeta(db, factionId, 'armory_last_sync') || 0) || null;

  return {
    success:true,
    factionId,
    canManage:Boolean(canManage),
    lastSyncAt,
    totals:{
      ...totals,
      margin:totals.income > 0 ? totals.net / totals.income : null
    },
    wars:rows
  };
}

function resolveWarIncome(snapshot, row) {
  const modules = Array.isArray(snapshot?.profile?.modules) ? snapshot.profile.modules : [];
  const pools = modules
    .filter(module => module?.enabled !== false && module?.percentageBased === true)
    .map(module => Math.max(0, Math.round(Number(module.pool || 0))))
    .filter(value => value > 0);

  if (pools.length) {
    return { amount:Math.max(...pools), source:'Payout pool' };
  }

  const override = Number(row?.payout_total_override);
  if (Number.isFinite(override) && override > 0) {
    return { amount:Math.round(override), source:'Custom payout total' };
  }

  const market = Number(snapshot?.marketValuePayout);
  if (Number.isFinite(market) && market > 0) {
    return { amount:Math.round(market), source:'Market value' };
  }

  const total = Number(snapshot?.totalPayout);
  if (Number.isFinite(total) && total > 0) {
    return { amount:Math.round(total), source:'Confirmed payout' };
  }

  return { amount:0, source:'No income recorded' };
}

async function syncArmoryExpenses(env, factionId) {
  const now = unixNow();
  const lastSyncAt = Number(await getMeta(env.DB, factionId, 'armory_last_sync') || 0);
  const from = lastSyncAt
    ? Math.max(0, lastSyncAt - SYNC_OVERLAP)
    : Math.max(0, now - INITIAL_LOOKBACK);

  const apiKey = await requireFactionApiKey(env, factionId);
  const [newsResult, itemResult] = await Promise.all([
    fetchTornJson(
      `https://api.torn.com/faction/?selections=armorynews&from=${encodeURIComponent(from)}&to=${encodeURIComponent(now)}&key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}`
    ),
    fetchTornJson(
      `https://api.torn.com/torn/?selections=items&key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}`
    )
  ]);

  if (!newsResult.success) {
    throw httpError(502, newsResult.message || 'Failed to fetch Torn armory news.');
  }

  const items = itemResult.success ? normalizeItems(itemResult.data) : [];
  const warsResult = await env.DB.prepare(`
    SELECT war_id, start_timestamp, end_timestamp
    FROM wars
    WHERE faction_id = ?
      AND COALESCE(end_timestamp, start_timestamp, imported_at, 0) >= ?
    ORDER BY COALESCE(end_timestamp, start_timestamp, imported_at, 0) DESC
  `).bind(factionId, from - DAY).all();
  const wars = warsResult.results || [];

  const entries = normalizeNewsEntries(newsResult.data?.armorynews || newsResult.data?.armory_news || {});
  let stored = 0;
  let skipped = 0;

  for (const [newsId, raw] of entries) {
    const event = normalizeArmoryEvent(newsId, raw, items);
    if (!event) {
      skipped += 1;
      continue;
    }

    const warId = findWarForTimestamp(wars, event.at);
    await env.DB.prepare(`
      INSERT INTO finance_armory_events (
        faction_id, news_id, event_at, player_id, player_name,
        item_id, item_name, quantity, unit_value, total_value,
        war_id, raw_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(faction_id, news_id, item_id) DO UPDATE SET
        event_at = excluded.event_at,
        player_id = excluded.player_id,
        player_name = excluded.player_name,
        item_name = excluded.item_name,
        quantity = excluded.quantity,
        unit_value = excluded.unit_value,
        total_value = excluded.total_value,
        war_id = excluded.war_id,
        raw_text = excluded.raw_text
    `).bind(
      factionId,
      event.newsId,
      event.at,
      event.playerId,
      event.playerName,
      event.itemId,
      event.itemName,
      event.quantity,
      event.unitValue,
      event.totalValue,
      warId,
      event.text,
      now
    ).run();
    stored += 1;
  }

  // Re-associate stored events when wars were imported after an earlier armory sync.
  for (const war of wars) {
    const start = Number(war.start_timestamp || 0);
    const end = Number(war.end_timestamp || start || 0);
    if (!start || !end) continue;
    await env.DB.prepare(`
      UPDATE finance_armory_events
      SET war_id = ?
      WHERE faction_id = ?
        AND event_at >= ?
        AND event_at <= ?
        AND (war_id IS NULL OR war_id = ?)
    `).bind(
      String(war.war_id),
      factionId,
      start - SYNC_OVERLAP,
      end + SYNC_OVERLAP,
      String(war.war_id)
    ).run();
  }

  await setMeta(env.DB, factionId, 'armory_last_sync', String(now));

  return {
    from,
    to:now,
    stored,
    skipped,
    marketValuesAvailable:items.length > 0
  };
}

function normalizeArmoryEvent(newsId, raw, items) {
  const text = stripHtml(
    raw?.news ?? raw?.message ?? raw?.text ?? raw?.description ?? ''
  ).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  if (/\b(returned|deposited|added|stocked|placed)\b/i.test(text)) return null;
  if (!/\b(used|withdrew|withdrawn|took|removed|retrieved)\b/i.test(text)) return null;

  const lower = text.toLowerCase();
  const item = items.find(candidate => lower.includes(candidate.nameLower));
  if (!item || item.consumable === false) return null;

  const escaped = escapeRegExp(item.name);
  const before = text.match(new RegExp('(\\d[\\d,]*)\\s*x?\\s*' + escaped, 'i'));
  const after = text.match(new RegExp(escaped + '\\s*[x×]\\s*(\\d[\\d,]*)', 'i'));
  const quantity = Math.max(1, Number(String(before?.[1] || after?.[1] || '1').replaceAll(',', '')) || 1);

  const at = timestampOf(raw);
  if (!at) return null;

  const playerId = Number(
    raw?.user_id ?? raw?.player_id ?? raw?.user?.id ?? raw?.member?.id ?? 0
  ) || null;
  const playerName = String(
    raw?.user_name ?? raw?.player_name ?? raw?.user?.name ?? raw?.member?.name ?? ''
  ).trim() || null;

  return {
    newsId:String(newsId || raw?.id || at + ':' + item.id),
    at,
    playerId,
    playerName,
    itemId:item.id,
    itemName:item.name,
    quantity,
    unitValue:item.marketValue,
    totalValue:Math.round(quantity * item.marketValue),
    text
  };
}

function normalizeItems(data) {
  const source = data?.items || data?.torn?.items || {};
  const entries = Array.isArray(source)
    ? source.map((item,index) => [String(item?.id || index), item])
    : Object.entries(source || {});

  return entries.map(([id,item]) => {
    const name = String(item?.name || item?.item_name || '').trim();
    const marketValue = Number(
      item?.market_value ?? item?.marketValue ?? item?.value ?? item?.market_price ?? 0
    );
    const type = String(item?.type || item?.category || item?.item_type || '').trim();
    const consumable = /drug|medical|temporary|booster|energy|alcohol|candy|enhancer/i.test(type);
    return {
      id:Number(item?.id || id) || 0,
      name,
      nameLower:name.toLowerCase(),
      type,
      consumable,
      marketValue:Number.isFinite(marketValue) && marketValue > 0 ? marketValue : 0
    };
  }).filter(item => item.id > 0 && item.name)
    .sort((a,b) => b.name.length - a.name.length);
}

function normalizeNewsEntries(source) {
  if (Array.isArray(source)) {
    return source.map((item,index) => [String(item?.id || item?.news_id || index), item]);
  }
  return Object.entries(source || {});
}

function findWarForTimestamp(wars, at) {
  const match = (wars || []).find(war => {
    const start = Number(war.start_timestamp || 0);
    const end = Number(war.end_timestamp || start || 0);
    if (!start || !end) return false;
    return at >= start - SYNC_OVERLAP && at <= end + SYNC_OVERLAP;
  });
  return match ? String(match.war_id) : null;
}

function timestampOf(value) {
  const candidates = [
    value?.timestamp,
    value?.timestamp_created,
    value?.created_at,
    value?.time,
    value?.date
  ];
  for (let candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      candidate = candidate.timestamp ?? candidate.time ?? candidate.value;
    }
    let number = Number(candidate);
    if (!Number.isFinite(number) || number <= 0) continue;
    if (number > 1e12) number = Math.floor(number / 1000);
    return Math.floor(number);
  }
  return 0;
}

async function ensureWarFinanceColumns(db) {
  const columns = await db.prepare('PRAGMA table_info(wars)').all();
  const found = new Set((columns.results || []).map(row => String(row.name)));
  const additions = [
    ['payout_status', "ALTER TABLE wars ADD COLUMN payout_status TEXT NOT NULL DEFAULT 'outstanding'"],
    ['payout_snapshot_json', 'ALTER TABLE wars ADD COLUMN payout_snapshot_json TEXT'],
    ['payout_total_override', 'ALTER TABLE wars ADD COLUMN payout_total_override INTEGER']
  ];

  for (const [name, sql] of additions) {
    if (found.has(name)) continue;
    try { await db.prepare(sql).run(); }
    catch (error) {
      if (!/duplicate column|already exists/i.test(String(error?.message || error || ''))) throw error;
    }
  }
}

async function ensureFinanceSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS finance_armory_events (
      faction_id INTEGER NOT NULL,
      news_id TEXT NOT NULL,
      event_at INTEGER NOT NULL,
      player_id INTEGER,
      player_name TEXT,
      item_id INTEGER NOT NULL,
      item_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_value INTEGER NOT NULL DEFAULT 0,
      total_value INTEGER NOT NULL DEFAULT 0,
      war_id TEXT,
      raw_text TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (faction_id, news_id, item_id)
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_finance_armory_war
    ON finance_armory_events(faction_id, war_id, event_at)
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS finance_meta (
      faction_id INTEGER NOT NULL,
      meta_key TEXT NOT NULL,
      meta_value TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (faction_id, meta_key)
    )
  `).run();
}

async function getMeta(db, factionId, key) {
  const row = await db.prepare(
    'SELECT meta_value FROM finance_meta WHERE faction_id = ? AND meta_key = ? LIMIT 1'
  ).bind(factionId, key).first();
  return row?.meta_value ?? null;
}

async function setMeta(db, factionId, key, value) {
  await db.prepare(`
    INSERT INTO finance_meta (faction_id, meta_key, meta_value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(faction_id, meta_key) DO UPDATE SET
      meta_value = excluded.meta_value,
      updated_at = excluded.updated_at
  `).bind(factionId, key, value, unixNow()).run();
}

async function requireFactionApiKey(env, factionId) {
  const managedRow = await env.DB.prepare(
    'SELECT config_value FROM faction_config WHERE faction_id = ? AND config_key = ?'
  ).bind(factionId, MANAGED_KEY_CONFIG).first();
  const managed = parseJson(managedRow?.config_value);
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

async function decryptText(secret, ciphertextBase64, ivBase64) {
  if (!secret) throw new Error('Missing APP_SECRET secret.');
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey({
    name:'PBKDF2',
    salt:encoder.encode('rwengine-v2-api-key-encryption'),
    iterations:100000,
    hash:'SHA-256'
  }, material, { name:'AES-GCM', length:256 }, false, ['decrypt']);

  const plaintext = await crypto.subtle.decrypt(
    { name:'AES-GCM', iv:base64ToBytes(ivBase64) },
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

async function fetchTornJson(url) {
  try {
    const response = await fetch(url, { headers:{ Accept:'application/json' } });
    let data;
    try { data = await response.json(); }
    catch (_) { return { success:false, message:'Torn returned invalid JSON.' }; }
    if (data?.error) {
      return {
        success:false,
        message:'Torn API error: ' + (data.error.error || data.error.message || 'Unknown error.')
      };
    }
    if (!response.ok) {
      return { success:false, message:'Torn API request failed with status ' + response.status + '.' };
    }
    return { success:true, data };
  } catch (error) {
    return { success:false, message:error?.message || 'Torn API request failed.' };
  }
}

async function getCurrentUser(env, request) {
  const token = getCookie(request, 'rwengine_session');
  if (!token) throw httpError(401, 'Not logged in.');

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`
    SELECT
      u.user_id,
      u.player_id,
      u.player_name,
      u.faction_id,
      u.is_admin,
      u.is_disabled
    FROM sessions s
    JOIN users u ON u.user_id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, unixNow()).first();

  if (!row) throw httpError(401, 'Session expired or invalid.');
  if (Number(row.is_disabled) === 1) throw httpError(403, 'This account is disabled.');
  return row;
}

async function resolveFactionId(db, user, requestedValue) {
  const accountFactionId = Number(user.faction_id || 0);
  const requestedFactionId = Number(requestedValue || accountFactionId);
  if (!Number.isSafeInteger(requestedFactionId) || requestedFactionId <= 0) {
    throw httpError(400, 'A valid faction ID is required.');
  }
  if (requestedFactionId !== accountFactionId && Number(user.is_admin) !== 1) {
    throw httpError(403, 'Platform-admin access is required to view another faction.');
  }

  const faction = await db.prepare(
    'SELECT faction_id, enabled FROM factions WHERE faction_id = ? LIMIT 1'
  ).bind(requestedFactionId).first();

  if (!faction || Number(faction.enabled) !== 1) {
    throw httpError(404, 'That faction is not currently tracked by RWE.');
  }
  return requestedFactionId;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseJson(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
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
    headers:{ 'Content-Type':'application/json' }
  });
}
