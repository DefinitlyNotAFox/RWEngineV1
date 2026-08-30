const warsTab = document.querySelector('#warsTab');
const warsBody = document.querySelector('#warsBody');
const warsNav = document.querySelector('.nav-button[data-tab="wars"]');
const refreshButton = document.querySelector('#refreshButton');
const adminFactionSelect = document.querySelector('#adminFactionSelect');
const pageTitle = document.querySelector('#pageTitle');
const archiveWrap = warsBody?.closest('.table-wrap');
const importPanel = warsTab?.querySelector('.war-import');

const SELECTED_WAR_KEY = 'rwengine.selectedWarDetail';
const DETAIL_MODE_KEY = 'rwengine.warDetailMode';
const DETAIL_CHAIN_KEY = 'rwengine.warDetailExcludeChain';

let wars = [];
let requestId = 0;
let detailRequestId = 0;
let selectedWarId = readStorage(SELECTED_WAR_KEY, '');
let detailMode = readStorage(DETAIL_MODE_KEY, 'detailed') === 'simplified' ? 'simplified' : 'detailed';
let excludeChainBonuses = readStorage(DETAIL_CHAIN_KEY, '0') === '1';
let detailMembers = [];
let detailPayload = null;
let detailSortKey = 'netScore';
let detailSortDirection = 'desc';
let detailSearch = '';
const detailCache = new Map();

if (warsTab && warsBody) {
  installStylesheet();
  ensureDetailShell();
  normalizeHeader();
  installRangeRenderGuard();

  warsNav?.addEventListener('click', () => window.setTimeout(async () => {
    syncRangeVisibility();
    await loadWars(false);
    maybeRestoreStoredWar();
  }, 0));
  refreshButton?.addEventListener('click', () => window.setTimeout(() => {
    detailCache.clear();
    loadWars(true);
    if (selectedWarId) loadWarDetail(true);
  }, 0));
  adminFactionSelect?.addEventListener('change', () => window.setTimeout(() => {
    closeWarDetail(true);
    detailCache.clear();
    loadWars(true);
  }, 0));
  window.addEventListener('rwe:wars-changed', () => {
    detailCache.clear();
    loadWars(true);
    if (selectedWarId) loadWarDetail(true);
  });

  document.querySelectorAll('.nav-button[data-tab]').forEach(button => {
    if (button === warsNav) return;
    button.addEventListener('click', () => window.setTimeout(syncRangeVisibility, 0));
  });

  warsBody.addEventListener('click', event => {
    const row = event.target.closest('[data-war-id]');
    if (row) openWarDetail(row.dataset.warId);
  });
  warsBody.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key)) return;
    const row = event.target.closest('[data-war-id]');
    if (!row) return;
    event.preventDefault();
    openWarDetail(row.dataset.warId);
  });

  syncRangeVisibility();
  loadWars(false).then(maybeRestoreStoredWar);
}

function installStylesheet() {
  if (document.querySelector('link[data-rwe-war-drilldown]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/v2/war-drilldown.css?v=1';
  link.dataset.rweWarDrilldown = '1';
  document.head.appendChild(link);
}

function ensureDetailShell() {
  if (document.querySelector('#warDrilldown')) return;
  const panel = warsTab?.querySelector('.panel');
  if (!panel) return;

  const detail = document.createElement('section');
  detail.id = 'warDrilldown';
  detail.className = 'war-drilldown hidden';
  detail.innerHTML = `
    <header class="war-detail-header">
      <button class="text-button war-detail-back" type="button" data-war-detail-back>← Back to War history</button>
      <div class="war-detail-heading">
        <small id="warDetailMeta">Ranked war</small>
        <h2 id="warDetailTitle">War detail</h2>
        <span id="warDetailDate"></span>
      </div>
    </header>

    <div id="warDetailScore" class="war-detail-score"></div>
    <div id="warDetailMetrics" class="war-detail-metrics"></div>

    <div class="war-detail-toolbar">
      <div class="performance-mode-switch" role="group" aria-label="War detail table mode">
        <button class="performance-mode-button" type="button" data-war-detail-mode="simplified">Simplified</button>
        <button class="performance-mode-button" type="button" data-war-detail-mode="detailed">Detailed</button>
      </div>
      <div class="war-detail-toolbar-right">
        <label class="performance-former-toggle">
          <input type="checkbox" data-war-detail-chain />
          <span>Exclude chain bonuses</span>
        </label>
        <input class="search war-detail-search" type="search" placeholder="Search member…" data-war-detail-search />
      </div>
    </div>

    <div id="warDetailStatus" class="performance-status"></div>
    <div class="table-wrap war-detail-table-wrap">
      <table id="warDetailTable">
        <thead id="warDetailHead"></thead>
        <tbody id="warDetailBody"></tbody>
      </table>
    </div>
  `;
  panel.appendChild(detail);

  detail.querySelector('[data-war-detail-back]')?.addEventListener('click', () => closeWarDetail(false));
  detail.querySelectorAll('[data-war-detail-mode]').forEach(button => {
    button.addEventListener('click', () => {
      const mode = button.dataset.warDetailMode;
      if (!['simplified', 'detailed'].includes(mode) || mode === detailMode) return;
      detailMode = mode;
      writeStorage(DETAIL_MODE_KEY, detailMode);
      ensureValidDetailSort();
      renderWarDetail();
    });
  });
  detail.querySelector('[data-war-detail-chain]')?.addEventListener('change', event => {
    excludeChainBonuses = Boolean(event.currentTarget.checked);
    writeStorage(DETAIL_CHAIN_KEY, excludeChainBonuses ? '1' : '0');
    loadWarDetail(false);
  });
  detail.querySelector('[data-war-detail-search]')?.addEventListener('input', event => {
    detailSearch = String(event.currentTarget.value || '').trim().toLowerCase();
    renderDetailBody();
  });
  detail.querySelector('#warDetailTable')?.addEventListener('click', event => {
    const button = event.target.closest('[data-war-detail-sort]');
    if (!button) return;
    const key = button.dataset.warDetailSort;
    if (!detailColumns().some(column => column.key === key)) return;
    if (detailSortKey === key) detailSortDirection = detailSortDirection === 'desc' ? 'asc' : 'desc';
    else {
      detailSortKey = key;
      detailSortDirection = key === 'member' ? 'asc' : 'desc';
    }
    renderWarDetail();
  });
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
        if (warsTab?.classList.contains('active') && !selectedWarId) {
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
    if (!response.ok || data.success === false) throw new Error(data.message || `War history request failed with HTTP ${response.status}.`);
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
    <tr class="war-history-row" data-war-id="${escapeHtml(String(war.war_id || war.report_id || ''))}" tabindex="0" role="button" title="Open ranked-war details">
      <td><strong>${escapeHtml(war.opponent_faction_name || 'Unknown opponent')}</strong></td>
      <td>#${escapeHtml(String(war.war_id || war.report_id || '—'))}</td>
      <td>${formatWarDate(war.start_timestamp)}</td>
      <td>${formatWarDate(war.end_timestamp)}</td>
    </tr>
  `).join('');
}

function maybeRestoreStoredWar() {
  if (!selectedWarId || !warsTab?.classList.contains('active')) return;
  if (!wars.some(war => String(war.war_id || war.report_id) === String(selectedWarId))) {
    closeWarDetail(false);
    return;
  }
  openWarDetail(selectedWarId, false);
}

function openWarDetail(warId, persist = true) {
  const id = String(warId || '').trim();
  if (!id) return;
  selectedWarId = id;
  if (persist) writeStorage(SELECTED_WAR_KEY, id);

  archiveWrap?.classList.add('hidden');
  importPanel?.classList.add('hidden');
  const detail = document.querySelector('#warDrilldown');
  detail?.classList.remove('hidden');
  if (pageTitle) pageTitle.textContent = `War #${id}`;
  loadWarDetail(false);
}

function closeWarDetail(keepStored) {
  selectedWarId = '';
  detailMembers = [];
  detailPayload = null;
  detailSearch = '';
  if (!keepStored) removeStorage(SELECTED_WAR_KEY);

  document.querySelector('#warDrilldown')?.classList.add('hidden');
  archiveWrap?.classList.remove('hidden');
  importPanel?.classList.remove('hidden');
  const search = document.querySelector('[data-war-detail-search]');
  if (search) search.value = '';
  if (pageTitle && warsTab?.classList.contains('active')) pageTitle.textContent = 'War history';
  renderWars();
}

async function loadWarDetail(force) {
  if (!selectedWarId) return;
  const factionId = Number(document.querySelector('#adminFactionSelect')?.value || 0) || undefined;
  const cacheKey = `${factionId || 'account'}:${selectedWarId}:${excludeChainBonuses ? 1 : 0}`;
  if (!force && detailCache.has(cacheKey)) {
    applyDetailPayload(detailCache.get(cacheKey));
    return;
  }

  const id = ++detailRequestId;
  setDetailStatus(excludeChainBonuses ? 'Matching chain bonus reports…' : 'Loading war performance…');
  setDetailLoading(true);

  try {
    const response = await fetch('/v2/war-detail', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        warId: selectedWarId,
        ...(factionId ? { factionId } : {}),
        excludeChainBonuses
      })
    });
    const data = await response.json();
    if (!response.ok || data.success === false) throw new Error(data.message || `War detail request failed with HTTP ${response.status}.`);
    if (id !== detailRequestId || String(data.war?.warId) !== String(selectedWarId)) return;

    detailCache.set(cacheKey, data);
    applyDetailPayload(data);
  } catch (error) {
    if (id !== detailRequestId) return;
    detailMembers = [];
    detailPayload = null;
    setDetailStatus(error.message || 'Failed to load war detail.', true);
    renderDetailBody();
  } finally {
    if (id === detailRequestId) setDetailLoading(false);
  }
}

function applyDetailPayload(data) {
  detailPayload = data;
  detailMembers = Array.isArray(data.members) ? data.members : [];
  const war = data.war || {};
  if (pageTitle) pageTitle.textContent = `War #${war.warId || selectedWarId}`;

  const meta = document.querySelector('#warDetailMeta');
  const title = document.querySelector('#warDetailTitle');
  const date = document.querySelector('#warDetailDate');
  if (meta) meta.textContent = `Ranked war #${war.warId || selectedWarId}`;
  if (title) title.textContent = `${war.factionName || 'Faction'} vs ${war.opponentFactionName || 'Unknown opponent'}`;
  if (date) date.textContent = formatWarRange(war.startTimestamp, war.endTimestamp);

  renderWarDetail();
}

function renderWarDetail() {
  if (!detailPayload) {
    renderDetailBody();
    return;
  }

  const chainToggle = document.querySelector('[data-war-detail-chain]');
  if (chainToggle) chainToggle.checked = excludeChainBonuses;
  document.querySelectorAll('[data-war-detail-mode]').forEach(button => {
    const active = button.dataset.warDetailMode === detailMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  renderDetailScore();
  renderDetailMetrics();
  renderDetailHead();
  renderDetailBody();

  const chain = detailPayload.chainBonusSummary || {};
  if (excludeChainBonuses) {
    setDetailStatus(`Excluded ${formatNumber(chain.outgoingHits || 0)} outgoing + ${formatNumber(chain.incomingHits || 0)} incoming chain bonus hits.`);
  } else {
    setDetailStatus('Official ranked-war values · chain bonuses included.');
  }
}

function renderDetailScore() {
  const container = document.querySelector('#warDetailScore');
  if (!container || !detailPayload) return;
  const war = detailPayload.war || {};
  const summary = detailPayload.summary || {};
  container.innerHTML = `
    <div class="war-detail-side">
      <span>${escapeHtml(war.factionName || 'Faction')}</span>
      <strong>${formatDecimal(summary.officialScoreUp || 0, 2)}</strong>
    </div>
    <div class="war-detail-versus">Final RW score</div>
    <div class="war-detail-side is-opponent">
      <span>${escapeHtml(war.opponentFactionName || 'Opponent')}</span>
      <strong>${formatDecimal(summary.officialScoreDown || 0, 2)}</strong>
    </div>
  `;
}

function renderDetailMetrics() {
  const container = document.querySelector('#warDetailMetrics');
  if (!container || !detailPayload) return;
  const summary = detailPayload.summary || {};
  const hitNote = excludeChainBonuses && Number(summary.displayHits) !== Number(summary.officialHits)
    ? `${formatNumber(summary.officialHits || 0)} official`
    : 'Faction war hits';
  const netNote = excludeChainBonuses && Number(summary.displayNetScore) !== Number(summary.officialNetScore)
    ? `${formatSigned(summary.officialNetScore || 0, 2)} official`
    : 'Score + minus Score -';

  container.innerHTML = `
    ${metricCard('Members', formatNumber(summary.members || 0), 'Report participants')}
    ${metricCard('War hits', formatNumber(summary.displayHits || 0), hitNote)}
    ${metricCard('Assists', formatNumber(summary.assists || 0), 'Verified attack rows')}
    ${metricCard('Net score', formatSigned(summary.displayNetScore || 0, 2), netNote)}
  `;
}

function metricCard(label, value, note) {
  return `<article><span>${escapeHtml(label)}</span><strong>${value}</strong><small>${escapeHtml(note)}</small></article>`;
}

function renderDetailHead() {
  const head = document.querySelector('#warDetailHead');
  if (!head) return;
  ensureValidDetailSort();
  head.innerHTML = `<tr>${detailColumns().map(column => {
    const active = detailSortKey === column.key;
    const indicator = active ? `<span class="performance-sort-indicator">${detailSortDirection === 'desc' ? '↓' : '↑'}</span>` : '';
    return `
      <th class="performance-sort-header${column.key === 'member' ? ' is-left' : ''}${column.key === 'netScore' ? ' is-net' : ''}">
        <button class="performance-sort${active ? ' active' : ''}" type="button" data-war-detail-sort="${column.key}">
          <span>${escapeHtml(column.label)}</span>${indicator}
        </button>
      </th>
    `;
  }).join('')}</tr>`;
}

function renderDetailBody() {
  const body = document.querySelector('#warDetailBody');
  if (!body) return;
  const columns = detailColumns();

  if (!detailPayload && selectedWarId) {
    body.innerHTML = `<tr><td colspan="${columns.length}" class="empty">Loading war performance…</td></tr>`;
    return;
  }

  const rows = detailMembers
    .filter(member => !detailSearch || String(member.playerName || '').toLowerCase().includes(detailSearch) || String(member.playerId || '').includes(detailSearch))
    .sort(compareDetailMembers);

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${columns.length}" class="empty">No matching member performance found for this war.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map(member => `
    <tr>
      ${columns.map(column => `<td class="${column.key === 'member' ? 'performance-member-cell' : 'performance-stat-cell'}${column.key === 'netScore' ? ' performance-net-cell' : ''}">${formatDetailCell(member, column.key)}</td>`).join('')}
    </tr>
  `).join('');
}

function detailColumns() {
  if (detailMode === 'simplified') {
    return [
      { key: 'member', label: 'Member' },
      { key: 'hits', label: 'Hits' },
      { key: 'assists', label: 'Assists' },
      { key: 'netScore', label: 'Net score' }
    ];
  }
  return [
    { key: 'member', label: 'Member' },
    { key: 'hits', label: 'Hits' },
    { key: 'assists', label: 'Assists' },
    { key: 'outsideHits', label: 'Outside' },
    { key: 'respectEarned', label: 'Respect +' },
    { key: 'respectLost', label: 'Respect -' },
    { key: 'scoreUp', label: 'Score +' },
    { key: 'scoreDown', label: 'Score -' },
    { key: 'netScore', label: 'Net score' }
  ];
}

function ensureValidDetailSort() {
  if (detailColumns().some(column => column.key === detailSortKey)) return;
  detailSortKey = 'netScore';
  detailSortDirection = 'desc';
}

function compareDetailMembers(a, b) {
  const direction = detailSortDirection === 'asc' ? 1 : -1;
  if (detailSortKey === 'member') return String(a.playerName || '').localeCompare(String(b.playerName || ''), undefined, { sensitivity: 'base' }) * direction;
  const av = nullableNumber(a[detailSortKey]);
  const bv = nullableNumber(b[detailSortKey]);
  if (av === null && bv === null) return String(a.playerName || '').localeCompare(String(b.playerName || ''));
  if (av === null) return 1;
  if (bv === null) return -1;
  return ((av - bv) * direction) || String(a.playerName || '').localeCompare(String(b.playerName || ''));
}

function formatDetailCell(member, key) {
  if (key === 'member') {
    return `
      <a class="performance-member-link" href="https://www.torn.com/profiles.php?XID=${Number(member.playerId || 0)}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(member.playerName || `Player ${member.playerId || '—'}`)} [${escapeHtml(String(member.playerId || '—'))}]
      </a>
      ${member.current ? '' : '<small>former member</small>'}
    `;
  }
  const value = member[key];
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '<span class="performance-missing">—</span>';
  if (['hits', 'assists', 'outsideHits'].includes(key)) return `<span class="performance-stat-primary">${formatNumber(value)}</span>`;
  if (key === 'netScore') return `<span class="performance-stat-primary">${formatSigned(value, 2)}</span>`;
  return `<span class="performance-stat-primary">${formatDecimal(value, 2)}</span>`;
}

function setDetailLoading(loading) {
  const toggle = document.querySelector('[data-war-detail-chain]');
  if (toggle) toggle.disabled = loading;
}

function setDetailStatus(message, error = false) {
  const box = document.querySelector('#warDetailStatus');
  if (!box) return;
  box.textContent = message || '';
  box.classList.toggle('is-error', Boolean(error));
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
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' }).format(new Date(value * 1000));
}

function formatWarRange(start, end) {
  const startText = formatWarDate(start);
  const endText = formatWarDate(end);
  return startText === endText ? startText : `${startText} – ${endText}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Math.round(Number(value || 0)));
}

function formatDecimal(value, digits) {
  return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatSigned(value, digits) {
  const number = Number(value || 0);
  const formatted = formatDecimal(number, digits);
  return number > 0 ? `+${formatted}` : formatted;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readStorage(key, fallback) {
  try { return window.localStorage.getItem(key) ?? fallback; }
  catch (_) { return fallback; }
}

function writeStorage(key, value) {
  try { window.localStorage.setItem(key, String(value)); } catch (_) {}
}

function removeStorage(key) {
  try { window.localStorage.removeItem(key); } catch (_) {}
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
