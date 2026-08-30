const warsTab = document.querySelector('#warsTab');
const warsBody = document.querySelector('#warsBody');
const warsNav = document.querySelector('.nav-button[data-tab="wars"]');
const refreshButton = document.querySelector('#refreshButton');
const adminFactionSelect = document.querySelector('#adminFactionSelect');

let wars = [];
let requestId = 0;

if (warsTab && warsBody) {
  normalizeHeader();
  installRangeRenderGuard();

  warsNav?.addEventListener('click', () => window.setTimeout(() => {
    syncRangeVisibility();
    loadWars(false);
  }, 0));
  refreshButton?.addEventListener('click', () => window.setTimeout(() => loadWars(true), 0));
  adminFactionSelect?.addEventListener('change', () => window.setTimeout(() => loadWars(true), 0));
  window.addEventListener('rwe:wars-changed', () => loadWars(true));

  document.querySelectorAll('.nav-button[data-tab]').forEach(button => {
    if (button === warsNav) return;
    button.addEventListener('click', () => window.setTimeout(syncRangeVisibility, 0));
  });

  syncRangeVisibility();
  loadWars(false);
}

function normalizeHeader() {
  const row = warsTab?.querySelector('table thead tr');
  if (!row) return;
  row.innerHTML = '<th>Opponent</th><th>War ID</th><th>Started</th><th>Ended</th>';
}

function syncRangeVisibility() {
  const toolbar = document.querySelector('#rangeToolbar');
  if (!toolbar) return;
  if (warsTab?.classList.contains('active')) toolbar.classList.add('hidden');
}

function installRangeRenderGuard() {
  if (window.__rweWarHistoryFetchWrapped) return;
  window.__rweWarHistoryFetchWrapped = true;

  const previousFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const url = requestUrl(args[0]);
    const response = await previousFetch(...args);

    if (url.includes('/v2/range')) {
      window.setTimeout(() => {
        if (warsTab?.classList.contains('active')) {
          syncRangeVisibility();
          renderWars();
        }
      }, 0);
    }

    return response;
  };
}

async function loadWars(force) {
  if (!force && wars.length) {
    renderWars();
    return;
  }

  const id = ++requestId;
  try {
    const response = await fetch('/api', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getImportedWars' })
    });
    const data = await response.json();
    if (!response.ok || data.success === false) {
      throw new Error(data.message || `War history request failed with HTTP ${response.status}.`);
    }
    if (id !== requestId) return;

    wars = Array.isArray(data.wars) ? data.wars : [];
    renderWars();
  } catch (error) {
    if (id !== requestId) return;
    warsBody.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(error.message || 'Failed to load imported wars.')}</td></tr>`;
  }
}

function renderWars() {
  normalizeHeader();
  syncRangeVisibility();

  const ordered = [...wars].sort((a, b) => warTimestamp(b) - warTimestamp(a));
  if (!ordered.length) {
    warsBody.innerHTML = '<tr><td colspan="4" class="empty">No imported wars stored for this faction.</td></tr>';
    return;
  }

  warsBody.innerHTML = ordered.map(war => `
    <tr>
      <td>${escapeHtml(war.opponent_faction_name || 'Unknown opponent')}</td>
      <td>${escapeHtml(String(war.war_id || war.report_id || '—'))}</td>
      <td>${formatWarDate(war.start_timestamp)}</td>
      <td>${formatWarDate(war.end_timestamp)}</td>
    </tr>
  `).join('');
}

function warTimestamp(war) {
  return Number(war?.end_timestamp || war?.start_timestamp || war?.imported_at || 0);
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return String(input?.url || '');
}

function formatWarDate(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: '2-digit'
  }).format(new Date(value * 1000));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
