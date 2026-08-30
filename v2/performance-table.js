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
const FORMER_KEY = 'rwengine.performanceFormerMembers';
const EXCLUDE_CHAIN_KEY = 'rwengine.performanceExcludeChainBonuses';

const state = {
  members: [],
  totalWars: 0,
  playersWithAttackDetails: 0,
  mode: readMode(),
  includeFormer: readFormerPreference(),
  excludeChainBonuses: readChainPreference(),
  sortKey: 'netScore',
  sortDirection: 'desc',
  loadedKey: '',
  requestId: 0,
  loading: false
};

const simplifiedColumns = [
  column('member', 'Member'),
  column('wars', 'Wars'),
  column('hits', 'Hits'),
  column('assists', 'Assists'),
  column('netScore', 'Net score')
];

const detailedColumns = [
  column('member', 'Member'),
  column('wars', 'Wars'),
  column('hits', 'Hits'),
  column('assists', 'Assists'),
  column('outsideHits', 'Outside'),
  column('respectEarned', 'Respect +'),
  column('respectLost', 'Respect -'),
  column('scoreUp', 'Score +'),
  column('scoreDown', 'Score -'),
  column('netScore', 'Net score')
];

if (performanceTab && performanceTable && performanceHead && performanceBody) {
  installStylesheet();
  installFilters();
  bindEvents();
  updateModeButtons();
  updateFilterToggles();
  render();
  if (isPerformanceActive()) loadPerformance(false);
}

function column(key, label) {
  return { key, label };
}

function installStylesheet() {
  if (document.querySelector('link[data-rwe-performance-table]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/v2/performance-table.css?v=4';
  link.dataset.rwePerformanceTable = '1';
  document.head.appendChild(link);
}

function installFilters() {
  const toolbar = performanceTab?.querySelector('.performance-toolbar');
  if (!toolbar || toolbar.querySelector('[data-performance-former]')) return;

  const search = toolbar.querySelector('.performance-search');
  const controls = document.createElement('div');
  controls.className = 'performance-toolbar-right';
  controls.innerHTML = `
    <label class="performance-former-toggle">
      <input type="checkbox" data-performance-chain />
      <span>Exclude chain bonuses</span>
    </label>
    <label class="performance-former-toggle">
      <input type="checkbox" data-performance-former />
      <span>Former members</span>
    </label>
  `;

  if (search) {
    search.before(controls);
    controls.appendChild(search);
  } else {
    toolbar.appendChild(controls);
  }
}

function bindEvents() {
  performanceModeButtons.forEach(button => {
    button.addEventListener('click', () => {
      const mode = button.dataset.performanceMode;
      if (!['simplified', 'detailed'].includes(mode) || mode === state.mode) return;
      state.mode = mode;
      try { localStorage.setItem(MODE_KEY, mode); } catch (_) {}
      updateModeButtons();
      ensureValidSort();
      render();
    });
  });

  performanceSearch?.addEventListener('input', renderBody);

  performanceTab?.querySelector('[data-performance-former]')?.addEventListener('change', event => {
    state.includeFormer = Boolean(event.currentTarget.checked);
    try { localStorage.setItem(FORMER_KEY, state.includeFormer ? '1' : '0'); } catch (_) {}
    renderBody();
  });

  performanceTab?.querySelector('[data-performance-chain]')?.addEventListener('change', event => {
    state.excludeChainBonuses = Boolean(event.currentTarget.checked);
    try { localStorage.setItem(EXCLUDE_CHAIN_KEY, state.excludeChainBonuses ? '1' : '0'); } catch (_) {}
    renderBody();
  });

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

  refreshButton?.addEventListener('click', invalidatePerformance);
  applyRangeButton?.addEventListener('click', invalidatePerformance);
  window.addEventListener('rwe:wars-changed', invalidatePerformance);
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
  setStatus('Loading imported war reports…');
  renderBody();

  try {
    const selectedFactionId = Number(document.querySelector('#adminFactionSelect')?.value || 0) || undefined;
    const response = await fetch('/v2/performance', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(selectedFactionId ? { factionId: selectedFactionId } : {}),
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
    state.totalWars = Number(data.totalWars || 0);
    state.playersWithAttackDetails = Number(data.playersWithAttackDetails || 0);
    state.loadedKey = key;

    if (state.totalWars > 0 && state.playersWithAttackDetails === 0) {
      setStatus(`${state.totalWars} imported war${state.totalWars === 1 ? '' : 's'} in period · attack detail not collected; assists, respect and chain-bonus filtering require rebuilding the report attack pass`);
    } else {
      setStatus(state.totalWars > 0 ? `${state.totalWars} imported war${state.totalWars === 1 ? '' : 's'} in period` : '');
    }
    render();
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.members = [];
    state.totalWars = 0;
    state.playersWithAttackDetails = 0;
    setStatus(error.message || 'Failed to load performance data.', true);
    render();
  } finally {
    if (requestId === state.requestId) state.loading = false;
  }
}

function normalizeMember(member) {
  const wars = numberOrZero(member.wars);
  const hits = numberOrZero(member.warHits);
  const assists = nullableNumber(member.assists);
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
    assistsPerWar: assists !== null ? perWar(assists, wars) : null,
    outsideHits: numberOrZero(member.outsideHits),
    respectEarned: nullableNumber(member.respectEarned),
    respectLost: nullableNumber(member.respectLost),
    scoreUp: numberOrZero(member.scoreUp),
    scoreDown: numberOrZero(member.scoreDown),
    netScore,
    netPerWar: perWar(netScore, wars),
    chainBonusHitsOut: numberOrZero(member.chainBonusHitsOut),
    chainBonusScoreOut: numberOrZero(member.chainBonusScoreOut),
    chainBonusHitsIn: numberOrZero(member.chainBonusHitsIn),
    chainBonusScoreIn: numberOrZero(member.chainBonusScoreIn),
    chainBonusRespectLostIn: numberOrZero(member.chainBonusRespectLostIn)
  };
}

function currentDataKey() {
  const factionId = document.querySelector('#adminFactionSelect')?.value || 'account';
  return `${factionId}:${intelFrom?.value || ''}:${intelTo?.value || ''}`;
}

function render() {
  ensureValidSort();
  renderHead();
  renderBody();
}

function renderHead() {
  const columns = activeColumns();
  performanceHead.innerHTML = `<tr>${columns.map(config => {
    const active = state.sortKey === config.key;
    const indicator = active ? `<span class="performance-sort-indicator" aria-hidden="true">${state.sortDirection === 'desc' ? '↓' : '↑'}</span>` : '';
    const align = config.key === 'member' ? ' is-left' : '';
    const net = config.key === 'netScore' ? ' is-net' : '';
    return `
      <th class="performance-sort-header${align}${net}">
        <button type="button" data-performance-sort="${config.key}" class="performance-sort${active ? ' active' : ''}">
          <span>${escapeHtml(config.label)}</span>${indicator}
        </button>
      </th>
    `;
  }).join('')}</tr>`;
}

function renderBody() {
  const query = performanceSearch?.value.trim().toLowerCase() || '';
  const rows = state.members
    .filter(member => state.includeFormer || member.current)
    .filter(member => !query || member.playerName.toLowerCase().includes(query) || String(member.playerId).includes(query))
    .sort(compareMembers);

  const columns = activeColumns();

  if (state.loading && !state.members.length) {
    performanceBody.innerHTML = `<tr><td colspan="${columns.length}" class="empty">Loading imported war reports…</td></tr>`;
    return;
  }

  if (!rows.length) {
    const message = !state.includeFormer && state.members.length
      ? 'No current members have ranked-war performance in this period. Enable Former members to include report history.'
      : 'No imported ranked-war performance is available for this period.';
    performanceBody.innerHTML = `<tr><td colspan="${columns.length}" class="empty">${message}</td></tr>`;
    return;
  }

  performanceBody.innerHTML = rows.map(member => `
    <tr>
      ${columns.map(config => {
        const baseClass = config.key === 'member' ? 'performance-member-cell' : 'performance-stat-cell';
        const netClass = config.key === 'netScore' ? ' performance-net-cell' : '';
        return `<td class="${baseClass}${netClass}">${formatCell(member, config)}</td>`;
      }).join('')}
    </tr>
  `).join('');
}

function compareMembers(a, b) {
  const key = state.sortKey;
  const direction = state.sortDirection === 'asc' ? 1 : -1;

  if (key === 'member') {
    return a.playerName.localeCompare(b.playerName, undefined, { sensitivity: 'base' }) * direction;
  }

  const aValue = nullableNumber(displayMetrics(a)[key]);
  const bValue = nullableNumber(displayMetrics(b)[key]);
  if (aValue === null && bValue === null) return a.playerName.localeCompare(b.playerName);
  if (aValue === null) return 1;
  if (bValue === null) return -1;
  return ((aValue - bValue) * direction) || a.playerName.localeCompare(b.playerName);
}

function displayMetrics(member) {
  if (!state.excludeChainBonuses) return member;

  const hits = Math.max(0, member.hits - member.chainBonusHitsOut);
  const respectEarned = member.respectEarned === null
    ? null
    : Math.max(0, member.respectEarned - member.chainBonusScoreOut);
  const respectLost = member.respectLost === null
    ? null
    : Math.max(0, member.respectLost - member.chainBonusRespectLostIn);
  const scoreUp = Math.max(0, member.scoreUp - member.chainBonusScoreOut);
  const scoreDown = Math.max(0, member.scoreDown - member.chainBonusScoreIn);
  const netScore = scoreUp - scoreDown;

  return {
    ...member,
    hits,
    hitsPerWar: perWar(hits, member.wars),
    respectEarned,
    respectLost,
    scoreUp,
    scoreDown,
    netScore,
    netPerWar: perWar(netScore, member.wars)
  };
}

function formatCell(member, config) {
  if (config.key === 'member') {
    const formerLabel = member.current ? '' : '<small>former member</small>';
    return `
      <a class="performance-member-link" href="https://www.torn.com/profiles.php?XID=${member.playerId}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(member.playerName)} [${member.playerId}]
      </a>
      ${formerLabel}
    `;
  }

  const metrics = displayMetrics(member);

  if (config.key === 'wars') {
    return stackedStat(
      formatNumber(metrics.wars),
      metrics.participation === null ? '— participation' : `${Math.round(metrics.participation * 100)}% participation`
    );
  }

  if (config.key === 'hits') {
    return stackedStat(
      formatNumber(metrics.hits),
      metrics.hitsPerWar === null ? '— / war' : `${formatDecimal(metrics.hitsPerWar, 1)} / war`
    );
  }

  if (config.key === 'assists') {
    return stackedStat(
      metrics.assists === null ? '—' : formatNumber(metrics.assists),
      metrics.assistsPerWar === null ? '— / war' : `${formatDecimal(metrics.assistsPerWar, 1)} / war`
    );
  }

  if (config.key === 'netScore') {
    return stackedStat(
      formatSigned(metrics.netScore, 2),
      metrics.netPerWar === null ? '— / war' : `${formatSigned(metrics.netPerWar, 2)} / war`
    );
  }

  const value = metrics[config.key];
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return '<span class="performance-missing">—</span>';
  }

  if (config.key === 'outsideHits') return formatNumber(value);
  if (config.key === 'respectEarned' || config.key === 'respectLost') return formatDecimal(value, 2);
  if (config.key === 'scoreUp' || config.key === 'scoreDown') return formatDecimal(value, 2);
  return escapeHtml(String(value));
}

function stackedStat(primary, secondary) {
  return `<span class="performance-stat-primary">${primary}</span><small class="performance-stat-secondary">${secondary}</small>`;
}

function activeColumns() {
  return state.mode === 'detailed' ? detailedColumns : simplifiedColumns;
}

function ensureValidSort() {
  if (activeColumns().some(column => column.key === state.sortKey)) return;
  state.sortKey = activeColumns().some(column => column.key === 'netScore') ? 'netScore' : activeColumns()[0]?.key || 'member';
  state.sortDirection = state.sortKey === 'member' ? 'asc' : 'desc';
}

function updateModeButtons() {
  performanceModeButtons.forEach(button => {
    const active = button.dataset.performanceMode === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  performanceTab?.classList.toggle('is-detailed', state.mode === 'detailed');
}

function updateFilterToggles() {
  const former = performanceTab?.querySelector('[data-performance-former]');
  if (former) former.checked = state.includeFormer;
  const chain = performanceTab?.querySelector('[data-performance-chain]');
  if (chain) chain.checked = state.excludeChainBonuses;
}

function readMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'detailed' ? 'detailed' : 'simplified';
  } catch (_) {
    return 'simplified';
  }
}

function readFormerPreference() {
  try {
    return localStorage.getItem(FORMER_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function readChainPreference() {
  try {
    return localStorage.getItem(EXCLUDE_CHAIN_KEY) === '1';
  } catch (_) {
    return false;
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
