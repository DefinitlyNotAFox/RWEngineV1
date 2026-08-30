const performanceTab = document.querySelector('#performanceTab');
const performanceTable = document.querySelector('#performanceTable');
const performanceHead = document.querySelector('#performanceHead');
const performanceBody = document.querySelector('#performanceBody');
const performanceSearch = document.querySelector('#performanceSearch');
const performanceStatus = document.querySelector('#performanceStatus');
const performanceModeButtons = [...document.querySelectorAll('[data-performance-mode]')];
const performanceNav = document.querySelector('.nav-button[data-tab="performance"]');
const performanceJumps = [...document.querySelectorAll('[data-jump="performance"]')];
const refreshButton = document.querySelector('#refreshButton');
const applyRangeButton = document.querySelector('#applyRangeButton');
const intelFrom = document.querySelector('#intelFrom');
const intelTo = document.querySelector('#intelTo');

const MODE_KEY = 'rwengine.performanceMode';

const state = {
  members: [],
  mode: readMode(),
  sortKey: 'netPerWar',
  sortDirection: 'desc',
  loadedKey: '',
  requestId: 0,
  loading: false
};

const simplifiedColumns = [
  column('member', 'Member', 'text'),
  column('participation', 'Participation', 'percent'),
  column('hitsPerWar', 'Hits / war', 'decimal'),
  column('assistsPerWar', 'Assists / war', 'decimal'),
  column('netPerWar', 'Net score / war', 'signedDecimal')
];

const detailedColumns = [
  column('member', 'Member', 'text'),
  column('wars', 'Wars', 'integer'),
  column('participation', 'Participation', 'percent'),
  column('hits', 'Hits', 'integer'),
  column('hitsPerWar', 'Hits / war', 'decimal'),
  column('assists', 'Assists', 'integer'),
  column('assistsPerWar', 'Assists / war', 'decimal'),
  column('outsideHits', 'Outside', 'integer'),
  column('respectEarned', 'Respect +', 'decimal2'),
  column('respectLost', 'Respect -', 'decimal2'),
  column('scoreUp', 'Score +', 'integer'),
  column('scoreDown', 'Score -', 'integer'),
  column('netScore', 'Net score', 'signedInteger'),
  column('netPerWar', 'Net / war', 'signedDecimal')
];

if (performanceTab && performanceTable && performanceHead && performanceBody) {
  installStylesheet();
  bindEvents();
  updateModeButtons();
  render();
  if (isPerformanceActive()) loadPerformance(false);
}

function column(key, label, format) {
  return { key, label, format };
}

function installStylesheet() {
  if (document.querySelector('link[data-rwe-performance-table]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/v2/performance-table.css?v=1';
  link.dataset.rwePerformanceTable = '1';
  document.head.appendChild(link);
}

function bindEvents() {
  performanceModeButtons.forEach(button => {
    button.addEventListener('click', () => {
      const mode = button.dataset.performanceMode;
      if (!['simplified', 'detailed'].includes(mode) || mode === state.mode) return;
      state.mode = mode;
      try { localStorage.setItem(MODE_KEY, mode); } catch (_) {}
      updateModeButtons();
      render();
    });
  });

  performanceSearch?.addEventListener('input', renderBody);

  performanceTable.addEventListener('click', event => {
    const button = event.target.closest('[data-performance-sort]');
    if (!button) return;
    const key = button.dataset.performanceSort;
    if (!activeColumns().some(item => item.key === key)) return;

    if (state.sortKey === key) {
      state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
    } else {
      state.sortKey = key;
      state.sortDirection = key === 'member' ? 'asc' : 'desc';
    }
    render();
  });

  performanceNav?.addEventListener('click', () => window.setTimeout(() => loadPerformance(false), 0));
  performanceJumps.forEach(button => {
    button.addEventListener('click', () => window.setTimeout(() => loadPerformance(false), 0));
  });

  refreshButton?.addEventListener('click', () => invalidatePerformance());
  applyRangeButton?.addEventListener('click', () => invalidatePerformance());
  window.addEventListener('rwe:wars-changed', () => invalidatePerformance());
}

function invalidatePerformance() {
  state.loadedKey = '';
  if (isPerformanceActive()) window.setTimeout(() => loadPerformance(true), 0);
}

function isPerformanceActive() {
  return Boolean(performanceTab?.classList.contains('active'));
}

async function loadPerformance(force = false) {
  if (!isPerformanceActive()) return;

  const key = currentDataKey();
  if (!force && state.loadedKey === key && state.members.length) {
    render();
    return;
  }

  const requestId = ++state.requestId;
  state.loading = true;
  setStatus('Loading performance…');
  renderBody();

  try {
    const response = await fetch('/v2/range', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'getRange',
        ...(intelFrom?.value ? { from: intelFrom.value } : {}),
        ...(intelTo?.value ? { to: intelTo.value } : {})
      })
    });

    const data = await response.json();
    if (!response.ok || data.success === false) {
      throw new Error(data.message || `Performance request failed with HTTP ${response.status}.`);
    }
    if (requestId !== state.requestId) return;

    state.members = (data.members || []).map(normalizeMember);
    state.loadedKey = key;
    setStatus('');
    render();
  } catch (error) {
    if (requestId !== state.requestId) return;
    setStatus(error.message || 'Failed to load performance data.', true);
  } finally {
    if (requestId === state.requestId) state.loading = false;
  }
}

function normalizeMember(member) {
  const wars = numberOrZero(member.wars);
  const hits = numberOrZero(member.warHits);
  const assists = numberOrZero(member.assists);
  const netScore = numberOrZero(member.netScore);

  return {
    playerId: Number(member.playerId || 0),
    playerName: member.playerName || `Player ${member.playerId || '—'}`,
    current: Boolean(member.current),
    wars,
    participation: nullableNumber(member.participation),
    hits,
    hitsPerWar: nullableNumber(member.avgHitsPerWar) ?? perWar(hits, wars),
    assists,
    assistsPerWar: perWar(assists, wars),
    outsideHits: numberOrZero(member.outsideHits),
    respectEarned: numberOrZero(member.respectEarned),
    respectLost: numberOrZero(member.respectLost),
    scoreUp: numberOrZero(member.scoreUp),
    scoreDown: numberOrZero(member.scoreDown),
    netScore,
    netPerWar: perWar(netScore, wars)
  };
}

function currentDataKey() {
  const factionId = document.querySelector('#adminFactionSelect')?.value || 'account';
  return `${factionId}:${intelFrom?.value || ''}:${intelTo?.value || ''}`;
}

function render() {
  renderHead();
  renderBody();
}

function renderHead() {
  const columns = activeColumns();
  performanceHead.innerHTML = `<tr>${columns.map(config => {
    const active = state.sortKey === config.key;
    const indicator = active ? (state.sortDirection === 'desc' ? '↓' : '↑') : '↕';
    const align = config.key === 'member' ? ' is-left' : '';
    return `
      <th class="performance-sort-header${align}">
        <button type="button" data-performance-sort="${config.key}" class="performance-sort${active ? ' active' : ''}">
          <span>${escapeHtml(config.label)}</span><span aria-hidden="true">${indicator}</span>
        </button>
      </th>
    `;
  }).join('')}</tr>`;
}

function renderBody() {
  const query = performanceSearch?.value.trim().toLowerCase() || '';
  const rows = state.members
    .filter(member => !query || member.playerName.toLowerCase().includes(query) || String(member.playerId).includes(query))
    .sort(compareMembers);

  const columns = activeColumns();

  if (state.loading && !state.members.length) {
    performanceBody.innerHTML = `<tr><td colspan="${columns.length}" class="empty">Loading performance…</td></tr>`;
    return;
  }

  if (!rows.length) {
    performanceBody.innerHTML = `<tr><td colspan="${columns.length}" class="empty">No member war performance is available for this period.</td></tr>`;
    return;
  }

  performanceBody.innerHTML = rows.map(member => `
    <tr>
      ${columns.map(config => `<td class="${config.key === 'member' ? 'performance-member-cell' : ''}">${formatCell(member, config)}</td>`).join('')}
    </tr>
  `).join('');
}

function compareMembers(a, b) {
  const key = state.sortKey;
  const direction = state.sortDirection === 'asc' ? 1 : -1;

  if (key === 'member') {
    return a.playerName.localeCompare(b.playerName, undefined, { sensitivity: 'base' }) * direction;
  }

  const aValue = nullableNumber(a[key]);
  const bValue = nullableNumber(b[key]);
  if (aValue === null && bValue === null) return a.playerName.localeCompare(b.playerName);
  if (aValue === null) return 1;
  if (bValue === null) return -1;
  return ((aValue - bValue) * direction) || a.playerName.localeCompare(b.playerName);
}

function formatCell(member, config) {
  if (config.key === 'member') {
    return `
      <a class="performance-member-link" href="https://www.torn.com/profiles.php?XID=${member.playerId}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(member.playerName)} [${member.playerId}]
      </a>
      <small>${member.current ? 'current member' : 'former member'}</small>
    `;
  }

  const value = member[config.key];
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '<span class="performance-missing">—</span>';

  switch (config.format) {
    case 'percent': return `${Math.round(Number(value) * 100)}%`;
    case 'integer': return formatNumber(value);
    case 'decimal2': return formatDecimal(value, 2);
    case 'decimal': return formatDecimal(value, 1);
    case 'signedInteger': return formatSigned(value, 0);
    case 'signedDecimal': return formatSigned(value, 1);
    default: return escapeHtml(String(value));
  }
}

function activeColumns() {
  return state.mode === 'detailed' ? detailedColumns : simplifiedColumns;
}

function updateModeButtons() {
  performanceModeButtons.forEach(button => {
    const active = button.dataset.performanceMode === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  performanceTab?.classList.toggle('is-detailed', state.mode === 'detailed');
}

function readMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'detailed' ? 'detailed' : 'simplified';
  } catch (_) {
    return 'simplified';
  }
}

function setStatus(message, isError = false) {
  if (!performanceStatus) return;
  performanceStatus.textContent = message || '';
  performanceStatus.classList.toggle('hidden', !message);
  performanceStatus.classList.toggle('is-error', Boolean(message && isError));
}

function perWar(value, wars) {
  return wars > 0 ? Number(value || 0) / wars : null;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value) {
  return nullableNumber(value) ?? 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Math.round(Number(value || 0)));
}

function formatDecimal(value, digits) {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatSigned(value, digits) {
  const number = Number(value || 0);
  const formatted = digits > 0 ? formatDecimal(number, digits) : formatNumber(number);
  return number > 0 ? `+${formatted}` : formatted;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
