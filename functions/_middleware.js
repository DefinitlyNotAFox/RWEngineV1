const MAINTENANCE_KEY = 'maintenance_mode';

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (!isProtectedRequest(request, url)) return next();
  if (!env.DB) return next();

  const maintenance = await readMaintenance(env.DB);
  if (!maintenance.enabled) return next();

  // Admin control must remain reachable so maintenance can be disabled.
  if (url.pathname === '/v2/admin') return next();

  // Keep scheduled collection alive while the public/member UI is closed.
  if (url.pathname === '/v2/sync-current' && validCronSecret(env, request)) {
    return next();
  }

  // Login/logout stay reachable. Login itself rejects non-admin accounts while
  // maintenance is active.
  if (url.pathname === '/api' && request.method === 'POST') {
    const body = await request.clone().json().catch(() => ({}));
    const action = String(body?.action || '');
    if (action === 'login' || action === 'logout' || action === 'ping') {
      return next();
    }
  }

  if (await isAdminSession(env.DB, request)) return next();

  return maintenanceResponse();
}

function isProtectedRequest(request, url) {
  if (url.pathname === '/api') return true;
  if (url.pathname === '/v2/share') return true;
  if (url.pathname.startsWith('/v2/') && request.method !== 'GET') return true;
  return false;
}

async function readMaintenance(db) {
  try {
    const row = await db.prepare(
      'SELECT value, updated_at FROM app_meta WHERE key = ? LIMIT 1'
    ).bind(MAINTENANCE_KEY).first();

    if (!row) return { enabled:false, updatedAt:null };

    let value = row.value;
    try { value = JSON.parse(String(row.value || '')); } catch (_) {}

    const enabled = typeof value === 'object'
      ? Boolean(value?.enabled)
      : ['1','true','on','enabled'].includes(String(value || '').toLowerCase());

    return {
      enabled,
      updatedAt:Number(row.updated_at || 0) || null
    };
  } catch (_) {
    // A failed maintenance-state read must not accidentally lock everyone out.
    return { enabled:false, updatedAt:null };
  }
}

async function isAdminSession(db, request) {
  const token = cookie(request, 'rwengine_session');
  if (!token) return false;

  const tokenHash = await sha256(token);
  const row = await db.prepare(`
    SELECT u.is_admin, u.is_disabled
    FROM sessions s
    JOIN users u ON u.user_id = s.user_id
    WHERE s.token_hash = ?
      AND s.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, unixNow()).first();

  return Boolean(
    row &&
    Number(row.is_admin) === 1 &&
    Number(row.is_disabled) !== 1
  );
}

function validCronSecret(env, request) {
  const expected = String(env.CRON_SECRET || '');
  const supplied = String(request.headers.get('X-RWE-Cron-Secret') || '');
  return Boolean(expected && supplied && supplied === expected);
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
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)))
  );
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function maintenanceResponse() {
  return new Response(JSON.stringify({
    success:false,
    maintenance:true,
    message:'RWEngine is currently under maintenance.'
  }), {
    status:503,
    headers:{
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store, max-age=0',
      'Retry-After':'900'
    }
  });
}
