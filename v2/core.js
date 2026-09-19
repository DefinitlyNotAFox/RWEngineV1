export const state = {
  user: null,
  rolePreview: null,
  adminFactions: [],
  selectedFactionId: null,
  wars: [],
  range: null,
  freshness: null,
  period: { preset: 'last4', from: null, to: null },
  route: 'intel'
};

const listeners = new Map();

export function on(name, handler) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(handler);
  return () => listeners.get(name)?.delete(handler);
}

export function emit(name, detail) {
  for (const handler of listeners.get(name) || []) {
    try { handler(detail); } catch (error) { console.error(error); }
  }
}

export async function api(action, payload = {}) {
  return post('/api', { action, ...payload });
}

export async function adminApi(action, payload = {}) {
  return post('/v2/admin', { action, ...payload });
}

export async function rangeApi(action, payload = {}) {
  if (usesAdminFaction()) {
    return adminApi(action, { factionId: state.selectedFactionId, ...payload });
  }
  return post('/v2/range', { action, ...payload });
}

export async function syncApi(action, payload = {}) {
  return post('/v2/sync-current', {
    action,
    ...(usesAdminFaction() ? { factionId: state.selectedFactionId } : {}),
    ...payload
  });
}

export async function loadWarsApi() {
  if (usesAdminFaction()) {
    return adminApi('getImportedWars', { factionId: state.selectedFactionId });
  }
  return api('getImportedWars');
}

export async function performanceApi(payload = {}) {
  return post('/v2/performance', {
    ...(usesAdminFaction() ? { factionId: state.selectedFactionId } : {}),
    ...payload
  });
}

export async function warDetailApi(payload = {}) {
  return post('/v2/war-detail', {
    ...(usesAdminFaction() ? { factionId: state.selectedFactionId } : {}),
    ...payload
  });
}

export async function attackDetailApi(payload = {}) {
  return post('/v2/war-attack-detail', {
    ...(usesAdminFaction() ? { factionId: state.selectedFactionId } : {}),
    ...payload
  });
}

export async function shareApi(action, payload = {}) {
  return post('/v2/share', {
    action,
    ...(usesAdminFaction() ? { factionId: state.selectedFactionId } : {}),
    ...payload
  });
}

export async function rolesApi(action, payload = {}) {
  return post('/v2/roles', {
    action,
    ...(usesAdminFaction() ? { factionId: state.selectedFactionId } : {}),
    ...payload
  });
}

export async function autoTagsApi(action, payload = {}) {
  return post('/v2/auto-tags', {
    action,
    ...(usesAdminFaction() ? { factionId: state.selectedFactionId } : {}),
    ...payload
  });
}

export async function intelV2Api(action, payload = {}) {
  return post('/v2/intel-v2', {
    action,
    ...(usesAdminFaction() ? { factionId: state.selectedFactionId } : {}),
    ...payload
  });
}

export async function freshnessApi() {
  return post('/v2/freshness', {
    ...(usesAdminFaction() ? { factionId: state.selectedFactionId } : {})
  });
}

export async function importApi(action, payload = {}) {
  if (usesAdminFaction()) {
    return post('/v2/war-import-admin', {
      action,
      factionId: state.selectedFactionId,
      ...payload
    });
  }
  return api(action, payload);
}

export async function warImportJobApi(action, payload = {}) {
  return post('/v2/war-import-job', {
    action,
    ...(usesAdminFaction() ? { factionId: state.selectedFactionId } : {}),
    ...payload
  });
}

export async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error(`HTTP ${response.status} returned no JSON.`);
  }

  if (!response.ok || data?.success === false) {
    const error = new Error(data?.message || `Request failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  return data;
}

export function usesAdminFaction() {
  return Boolean(
    state.user?.isAdmin &&
    Number(state.selectedFactionId || 0) > 0
  );
}

export function currentFactionName() {
  if (state.user?.isAdmin) {
    const faction = state.adminFactions.find(item => Number(item.factionId) === Number(state.selectedFactionId));
    if (faction) return faction.factionName;
  }
  return state.user?.factionName || 'No faction';
}

export function currentFactionId() {
  return Number(state.selectedFactionId || state.user?.factionId || 0) || null;
}

export function actualUserRole(user = state.user) {
  if (user?.isAdmin) return 'platform_admin';
  if (user?.isFactionAdmin) return 'faction_admin';
  if (user?.isAssistant) return 'assistant';
  return 'member';
}

export function availableViewRoles(user = state.user) {
  const actual = actualUserRole(user);
  if (actual === 'platform_admin') return ['platform_admin','faction_admin','assistant','member'];
  if (actual === 'faction_admin') return ['faction_admin','assistant','member'];
  if (actual === 'assistant') return ['assistant','member'];
  return ['member'];
}

export function normalizeViewRole(role, user = state.user) {
  const requested = String(role || '').trim();
  const available = availableViewRoles(user);
  return available.includes(requested) ? requested : actualUserRole(user);
}

export function currentViewRole() {
  return normalizeViewRole(state.rolePreview || actualUserRole());
}

export function setRolePreview(role) {
  const actual = actualUserRole();
  const selected = normalizeViewRole(role);
  state.rolePreview = selected === actual ? null : selected;

  try {
    const key = rolePreviewStorageKey();
    if (state.rolePreview) sessionStorage.setItem(key, state.rolePreview);
    else sessionStorage.removeItem(key);
  } catch (_) {}

  emit('role-preview', currentViewRole());
  return currentViewRole();
}

export function restoreRolePreview() {
  let stored = '';
  try { stored = sessionStorage.getItem(rolePreviewStorageKey()) || ''; } catch (_) {}
  const selected = normalizeViewRole(stored);
  const actual = actualUserRole();
  state.rolePreview = selected === actual ? null : selected;
  return currentViewRole();
}

export function isRolePreviewActive() {
  return Boolean(state.rolePreview && currentViewRole() !== actualUserRole());
}

export function isPlatformAdminView() {
  return currentViewRole() === 'platform_admin';
}

export function canEditFactionView() {
  return ['platform_admin','faction_admin','assistant'].includes(currentViewRole());
}

export function roleLabel(role) {
  if (role === 'platform_admin') return 'Platform admin';
  if (role === 'faction_admin') return 'Faction admin';
  if (role === 'assistant') return 'Assistant';
  return 'Member';
}

export function renderLeadershipMarker(role) {
  if (role === 'leader') {
    return '<span class="faction-leadership-mark leader" title="Faction leader" aria-label="Faction leader">L</span>';
  }
  if (role === 'co_leader') {
    return '<span class="faction-leadership-mark co-leader" title="Faction co-leader" aria-label="Faction co-leader">CO</span>';
  }
  return '';
}

function rolePreviewStorageKey() {
  return `rwengine.rolePreview.${Number(state.user?.userId || 0)}`;
}

export function periodPayload() {
  return {
    ...(state.period.from ? { from: state.period.from } : {}),
    ...(state.period.to ? { to: state.period.to } : {})
  };
}

export function setPeriodPreset(preset) {
  const today = localDate(new Date());
  const wars = [...state.wars].sort((a, b) => warStamp(b) - warStamp(a));
  let from = null;
  let to = today;

  if (preset === 'last4') {
    const recent = wars.slice(0, 4);
    if (recent.length) {
      const starts = recent.map(warStart).filter(Boolean);
      const ends = recent.map(warEnd).filter(Boolean);
      const lower = Math.min(...(starts.length ? starts : ends));
      const upper = Math.max(...(ends.length ? ends : starts));
      from = toDateInput(lower);
      to = toDateInput(upper);
    } else {
      preset = '30d';
    }
  }

  if (preset === '30d') {
    const date = new Date();
    date.setDate(date.getDate() - 29);
    from = localDate(date);
  } else if (preset === 'year') {
    from = `${new Date().getFullYear()}-01-01`;
  } else if (preset === 'all') {
    const stamps = wars.flatMap(war => [warStart(war), warEnd(war)]).filter(Boolean);
    from = stamps.length ? toDateInput(Math.min(...stamps)) : null;
    to = today;
  }

  state.period = { preset, from, to };
  try { localStorage.setItem('rwengine.period', preset); } catch (_) {}
  emit('period', state.period);
  return state.period;
}

export function restorePeriod() {
  let preset = 'last4';
  try {
    const stored = localStorage.getItem('rwengine.period');
    if (['last4','30d','year','all'].includes(stored)) preset = stored;
  } catch (_) {}
  return setPeriodPreset(preset);
}

export function renderPeriodControls() {
  for (const container of document.querySelectorAll('.period-control')) {
    container.innerHTML = [
      ['last4', 'Last 4 wars'],
      ['30d', '30 days'],
      ['year', 'This year'],
      ['all', 'All']
    ].map(([key, label]) =>
      `<button type="button" data-period="${key}" class="${state.period.preset === key ? 'active' : ''}">${label}</button>`
    ).join('');
  }
}

export function setNotice(message = '', kind = '') {
  const notice = document.querySelector('#notice');
  if (!notice) return;
  notice.textContent = message;
  notice.className = `notice${kind ? ` ${kind}` : ''}${message ? '' : ' hidden'}`;
}

export function routeTo(route, options = {}) {
  if (route === 'war' || route === 'performance') {
    try { localStorage.setItem('rwengine.factionMode', 'wars'); } catch (_) {}
    route = 'intel';
  }

  const valid = new Set(['intel','archive','settings']);
  const next = valid.has(route) ? route : 'intel';
  state.route = next;
  try { localStorage.setItem('rwengine.route', next); } catch (_) {}

  document.querySelectorAll('[data-view]').forEach(view => {
    view.classList.toggle('active', view.dataset.view === next);
  });

  document.querySelectorAll('[data-route]').forEach(button => {
    button.classList.toggle('active', button.dataset.route === next);
  });

  if (options.updateHash !== false) {
    const hash = `#${next}`;
    if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  }

  emit('route', next);
}

export function routeFromHash() {
  const value = String(location.hash || '').replace(/^#/, '').trim();

  if (value === 'war' || value === 'performance') {
    try { localStorage.setItem('rwengine.factionPreset', 'war'); } catch (_) {}
    return 'intel';
  }

  if (['intel','archive','settings'].includes(value)) return value;

  try {
    const stored = localStorage.getItem('rwengine.route');
    if (['intel','archive','settings'].includes(stored)) return stored;
  } catch (_) {}

  return 'intel';
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat().format(Math.round(number));
}

export function formatCompact(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: number >= 1e9 ? 2 : 1
  }).format(number);
}

export function formatDecimal(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

export function formatSigned(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const formatted = formatDecimal(number, digits);
  return number > 0 ? `+${formatted}` : formatted;
}

export function formatPercent(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${Math.round(number * 100)}%`;
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return '—';
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  const hours = value / 3600;
  return hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`;
}

export function formatRelative(timestamp) {
  const value = Number(timestamp);
  if (!value) return '—';
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - value);
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

export function formatDate(timestamp) {
  const value = Number(timestamp);
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  }).format(new Date(value * 1000));
}

export function formatAge(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  if (value < 60) return 'just now';
  if (value < 3600) return Math.floor(value / 60) + 'm ago';
  if (value < 86400) return Math.floor(value / 3600) + 'h ago';
  if (value < 604800) return Math.floor(value / 86400) + 'd ago';
  return Math.floor(value / 604800) + 'w ago';
}

export function formatDateTime(timestamp) {
  const value = Number(timestamp);
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value * 1000));
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function metric(label, value, detail = '') {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</div>`;
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function average(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function warStart(war) {
  return Number(war?.start_timestamp || war?.startTimestamp || war?.end_timestamp || war?.endTimestamp || war?.imported_at || 0);
}

export function warEnd(war) {
  return Number(war?.end_timestamp || war?.endTimestamp || war?.start_timestamp || war?.startTimestamp || war?.imported_at || 0);
}

export function warStamp(war) {
  return warEnd(war) || warStart(war);
}

function toDateInput(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  return localDate(date);
}

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
