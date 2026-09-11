import {
  state, on, emit, intelV2Api, syncApi, performanceApi,
  formatNumber, formatCompact, formatDecimal, formatPercent, formatSigned,
  formatDuration, formatRelative, escapeHtml, sleep
} from './core.js';

const filters = [
  ['all','All'],
  ['attention','Needs attention'],
  ['inactive','Inactive 48h+'],
  ['war','Low participation'],
  ['decline','Declining'],
  ['stats','Stats missing/stale'],
  ['former','Former members']
];

const factionColumns = [
  'member','stats','xanax','activity','ocs',
  'participation','hits','assists','outsideHits',
  'respect','score','netScore','attention'
];

const columnLabels = {
  member:['Member',''],
  stats:['Battle stats',''],
  xanax:['Xanax / day',''],
  activity:['Activity / day',''],
  ocs:['OCs',''],
  participation:['Wars / participation',''],
  hits:['Hits per war',''],
  assists:['Assists',''],
  outsideHits:['Outside hits',''],
  respect:['Respect + / −',''],
  score:['Score + / −',''],
  netScore:['Net score',''],
  attention:['Notes','']
};

const factionGroups = [
  ['roster','Roster',1],
  ['training','Activity & training',4],
  ['war','War performance',7],
  ['context','Context',1]
];

const priority = [
  'inactive',
  'low_war_participation',
  'participation_down',
  'activity_down',
  'xanax_down',
  'strong_war_output',
  'activity_up',
  'xanax_up',
  'battle_stats_growth',
  'missing_battle_stats',
  'stale_battle_stats'
];

let overview = null;
let loadedFactionId = null;
let activeFilter = 'all';
let selectedMemberId = null;
let sortKey = 'member';
let sortDirection = 'asc';
let trendDays = 90;
let loading = false;
let syncJob = null;
let syncing = false;
let filterMode = restoreFactionMode();
let timelineRange = { from:null, to:null };
let draftTimelineRange = null;
let selectedWarIds = new Set();
let draftWarIds = new Set();
let calendarCursor = null;
let calendarAnchor = null;
let filterPanelOpen = false;
let loadedAnalysisKey = '';

const factionPerformance = {
  members:new Map(),
  totalWars:0,
  playersWithAttackDetails:0,
  loadedKey:'',
  loading:false,
  error:''
};

const detailCache = new Map();
const detailLoading = new Set();

export function initIntelV2() {
  renderFilters();
  renderFactionControls();

  document.querySelector('#intelSearch')?.addEventListener('input', renderIntelV2);

  document.querySelector('#intelTable thead')?.addEventListener('click', event => {
    const header = event.target.closest('[data-intel2-sort]');
    if (!header) return;
    const key = header.dataset.intel2Sort;
    if (sortKey === key) sortDirection = sortDirection === 'desc' ? 'asc' : 'desc';
    else {
      sortKey = key;
      sortDirection = key === 'member' ? 'asc' : 'desc';
    }
    renderIntelV2();
  });

  document.querySelector('.faction-modes')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-faction-mode]');
    if (!button) return;
    const next = button.dataset.factionMode;
    if (!['timeline','wars'].includes(next) || next === filterMode) return;

    filterMode = next;
    try { localStorage.setItem('rwengine.factionMode', filterMode); } catch (_) {}
    filterPanelOpen = false;
    loadedAnalysisKey = '';
    factionPerformance.loadedKey = '';
    factionPerformance.members.clear();
    ensureFilterState();
    renderFactionControls();
    await loadIntelV2(true);
  });

  document.querySelector('#factionFilterToggle')?.addEventListener('click', () => {
    filterPanelOpen = !filterPanelOpen;
    if (filterPanelOpen) prepareFilterDraft();
    renderFactionControls();
  });

  document.addEventListener('click', event => {
    if (!filterPanelOpen) return;
    if (event.target.closest('#factionFilterPanel')) return;
    if (event.target.closest('#factionFilterToggle')) return;

    filterPanelOpen = false;
    renderFactionControls();
  });

  document.querySelector('#factionScopeAll')?.addEventListener('click', async () => {
    await applyAllScope();
  });

  document.querySelector('#factionFilterPanel')?.addEventListener('click', async event => {
    const nav = event.target.closest('[data-calendar-nav]');
    if (nav) {
      moveCalendar(Number(nav.dataset.calendarNav || 0));
      renderFilterPanel();
      return;
    }

    const day = event.target.closest('[data-calendar-day]');
    if (day && !day.disabled) {
      selectCalendarDay(day.dataset.calendarDay);
      renderFilterPanel();
      return;
    }

    const action = event.target.closest('[data-filter-action]');
    if (!action) return;

    const type = action.dataset.filterAction;
    if (type === 'cancel') {
      filterPanelOpen = false;
      renderFactionControls();
      return;
    }

    if (type === 'calendar-apply') {
      await applyTimelineDraft();
      return;
    }

    if (type === 'wars-all') {
      draftWarIds = new Set(sortedWars().map(war => String(warId(war))).filter(Boolean));
      renderFilterPanel();
      return;
    }

    if (type === 'wars-none') {
      draftWarIds.clear();
      renderFilterPanel();
      return;
    }

    if (type === 'wars-apply') await applyWarDraft();
  });

  document.querySelector('#factionFilterPanel')?.addEventListener('change', event => {
    const checkbox = event.target.closest('[data-war-check]');
    if (!checkbox) return;
    const id = String(checkbox.dataset.warCheck || '').trim();
    if (!id) return;
    if (checkbox.checked) draftWarIds.add(id);
    else draftWarIds.delete(id);
    updateWarApplyState();
  });

  document.querySelector('#intelFilters')?.addEventListener('click', event => {
    const button = event.target.closest('[data-intel-filter]');
    if (!button) return;
    activeFilter = button.dataset.intelFilter || 'all';
    renderFilters();
    renderIntelV2();
  });

  document.querySelector('#intelBody')?.addEventListener('click', async event => {
    const trendButton = event.target.closest('[data-trend-days]');
    if (trendButton) {
      trendDays = Number(trendButton.dataset.trendDays) || 90;
      renderIntelV2();
      return;
    }

    if (event.target.closest('a')) return;

    const row = event.target.closest('tr[data-member-id]');
    if (!row) return;
    const playerId = Number(row.dataset.memberId || 0);
    if (!playerId) return;

    if (selectedMemberId === playerId) {
      selectedMemberId = null;
      renderIntelV2();
      return;
    }

    await openMember(playerId);
  });

  document.querySelector('#syncButton')?.addEventListener('click', runSync);

  on('route', route => {
    if (route !== 'intel') return;
    filterMode = restoreFactionMode();
    ensureFilterState();
    ensureSortKey();
    renderFactionControls();
    loadIntelV2(false);
  });

  on('faction', () => resetIntelState());

  on('data', () => {
    if (state.route !== 'intel') return;
    ensureFilterState();
    renderFactionControls();
    loadIntelV2(true);
  });

  on('open-member', playerId => {
    const search = document.querySelector('#intelSearch');
    if (search) search.value = '';
    if (state.route === 'intel') openMember(Number(playerId));
  });
}

export async function loadIntelV2(force = false) {
  if (loading) return;

  const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
  if (!factionId) return;

  ensureFilterState();
  const key = analysisKey();

  if (!force && overview && Number(loadedFactionId) === factionId && loadedAnalysisKey === key) {
    renderIntelV2();
    await loadFactionPerformance(false);
    return;
  }

  loading = true;
  setIntelStatus('Loading faction data…');

  try {
    overview = await intelV2Api('overview', analysisPayload());
    loadedFactionId = factionId;
    loadedAnalysisKey = key;
    setIntelStatus('');
    renderIntelV2();
    renderIntelFreshness();
    await refreshSyncStatus();
    await loadFactionPerformance(force);
  } catch (error) {
    overview = null;
    setIntelStatus(error.message || 'Failed to load faction data.', true);
    renderIntelV2();
  } finally {
    loading = false;
  }
}

async function loadFactionPerformance(force = false) {
  if (factionPerformance.loading) return;

  const key = performanceKey();
  if (!force && factionPerformance.loadedKey === key) {
    renderIntelV2();
    return;
  }

  factionPerformance.loading = true;
  factionPerformance.error = '';
  renderFactionStatus();
  renderIntelV2();

  try {
    const data = await performanceApi(performancePayload());
    factionPerformance.members = new Map(
      (data.members || []).map(member => [Number(member.playerId), member])
    );
    factionPerformance.totalWars = Number(data.totalWars || 0);
    factionPerformance.playersWithAttackDetails = Number(data.playersWithAttackDetails || 0);
    factionPerformance.loadedKey = key;
  } catch (error) {
    factionPerformance.members.clear();
    factionPerformance.totalWars = 0;
    factionPerformance.playersWithAttackDetails = 0;
    factionPerformance.loadedKey = '';
    factionPerformance.error = error.message || 'Failed to load war performance.';
  } finally {
    factionPerformance.loading = false;
    renderFactionStatus();
    renderIntelV2();
  }
}

function renderFilters() {
  const container = document.querySelector('#intelFilters');
  if (!container) return;
  container.innerHTML = filters.map(([key,label]) =>
    `<button class="intel2-filter${key === activeFilter ? ' active' : ''}" type="button" data-intel-filter="${key}">${label}</button>`
  ).join('');
}

function renderFactionControls() {
  ensureFilterState();

  document.querySelectorAll('[data-faction-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.factionMode === filterMode);
  });

  const toggle = document.querySelector('#factionFilterToggle');
  if (toggle) {
    toggle.textContent = filterMode === 'timeline'
      ? formatRangeLabel(timelineRange)
      : `${selectedWarIds.size} war${selectedWarIds.size === 1 ? '' : 's'} selected`;
    toggle.classList.toggle('active', filterPanelOpen);
  }

  const allButton = document.querySelector('#factionScopeAll');
  if (allButton) {
    allButton.classList.toggle('hidden', filterMode !== 'timeline');
    allButton.classList.toggle('active', filterMode === 'timeline' && isAllTimelineSelected());
  }

  const table = document.querySelector('#intelTable');
  if (table) table.dataset.preset = 'all';

  renderFilterPanel();
  renderFactionStatus();
}

function renderFilterPanel() {
  const panel = document.querySelector('#factionFilterPanel');
  if (!panel) return;

  panel.dataset.mode = filterMode;
  panel.classList.toggle('hidden', !filterPanelOpen);
  if (!filterPanelOpen) {
    panel.innerHTML = '';
    return;
  }

  panel.innerHTML = filterMode === 'timeline'
    ? renderCalendarPicker()
    : renderWarPicker();

  updateWarApplyState();
}

function renderFactionStatus() {
  const element = document.querySelector('#factionTableStatus');
  if (!element) return;

  if (factionPerformance.loading) {
    element.textContent = filterMode === 'timeline'
      ? `Loading war data for ${formatRangeLabel(timelineRange)}…`
      : `Loading ${selectedWarIds.size} selected ranked wars…`;
    element.classList.remove('hidden','error');
    return;
  }

  if (factionPerformance.error) {
    element.textContent = factionPerformance.error;
    element.classList.remove('hidden');
    element.classList.add('error');
    return;
  }

  element.textContent = '';
  element.classList.remove('error');
  element.classList.add('hidden');
}

function renderIntelV2() {
  ensureSortKey();
  renderFactionControls();
  renderHeaders();

  const body = document.querySelector('#intelBody');
  if (!body) return;

  const colspan = factionColumns.length;

  if (loading && !overview) {
    body.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">Loading faction data…</td></tr>`;
    return;
  }

  const members = Array.isArray(overview?.members) ? overview.members : [];
  const query = String(document.querySelector('#intelSearch')?.value || '').trim().toLowerCase();

  const rows = members
    .filter(matchesFilter)
    .filter(member =>
      !query ||
      String(member.playerName || '').toLowerCase().includes(query) ||
      String(member.playerId || '').includes(query)
    )
    .sort(compareMembers);

  const totalRow = renderFactionTotalRow();

  if (!rows.length) {
    body.innerHTML = `${totalRow}<tr class="empty-row"><td colspan="${colspan}">No members match this view.</td></tr>`;
    return;
  }

  body.innerHTML = totalRow + rows.map(member => {
    const selected = Number(selectedMemberId) === Number(member.playerId);

    return `
      <tr class="clickable${selected ? ' selected' : ''}" data-member-id="${member.playerId}">
        ${factionColumns.map(key => renderFactionCell(member, key)).join('')}
      </tr>
      ${selected ? renderDetailRow(member) : ''}
    `;
  }).join('');
}

function renderFactionTotalRow() {
  const summary = overview?.summary;
  if (!summary) return '';

  const current = (overview.members || []).filter(member => member.current !== false);
  const currentPerformance = current.map(member => performanceMember(member)).filter(Boolean);
  const allPerformance = [...factionPerformance.members.values()];
  const totalWars = Number(factionPerformance.totalWars || 0);
  const warLoading = factionPerformance.loading;

  const participation = averageNullable(currentPerformance.map(row => row.participation));
  const totalHits = sumNullable(allPerformance, 'warHits');
  const hitsPerWar = totalWars > 0 && totalHits !== null ? totalHits / totalWars : null;
  const assists = sumNullable(allPerformance, 'assists');
  const assistsPerWar = totalWars > 0 && assists !== null ? assists / totalWars : null;
  const outsideHits = sumNullable(allPerformance, 'outsideHits');
  const respectEarned = sumNullable(allPerformance, 'respectEarned');
  const respectLost = sumNullable(allPerformance, 'respectLost');
  const scoreUp = sumNullable(allPerformance, 'scoreUp');
  const scoreDown = sumNullable(allPerformance, 'scoreDown');
  const netScore = sumNullable(allPerformance, 'netScore');
  const netPerWar = totalWars > 0 && netScore !== null ? netScore / totalWars : null;
  const warScope = filterMode === 'timeline'
    ? `${formatNumber(totalWars)} wars in range`
    : `${selectedWarIds.size} selected war${selectedWarIds.size === 1 ? '' : 's'}`;

  return `
    <tr class="faction-total-row">
      <td class="col-member">
        <span class="member-name">Faction total</span>
        <span class="member-meta">${formatNumber(summary.currentMembers)} current members</span>
      </td>
      <td class="col-stats">
        <strong>${formatCompact(summary.medianBattleStats)}</strong>
        <span class="member-meta">median · ${formatNumber(summary.knownBattleStats)} known</span>
      </td>
      <td class="col-xanax">
        <strong>${formatDecimal(summary.avgXanaxPerDay30d, 2)}</strong>
        <span class="member-meta">average / day</span>
      </td>
      <td class="col-activity">
        <strong>${formatDuration(summary.avgActivityPerDay30d)}</strong>
        <span class="member-meta">average / day</span>
      </td>
      <td class="col-ocs">—</td>
      <td class="col-participation">
        <strong>${warLoading ? '…' : formatPercent(participation)}</strong>
        <span class="member-meta">${escapeHtml(warScope)}</span>
      </td>
      <td class="col-hits">
        <strong>${warLoading ? '…' : formatDecimal(hitsPerWar, 1)}</strong>
        <span class="member-meta">${warLoading ? '…' : `${formatNumber(totalHits)} total`}</span>
      </td>
      <td class="col-assists">
        <strong>${warLoading ? '…' : formatNumber(assists)}</strong>
        <span class="member-meta">${warLoading ? '…' : `${formatDecimal(assistsPerWar, 1)} / war`}</span>
      </td>
      <td class="col-outsideHits">${warLoading ? '…' : formatNumber(outsideHits)}</td>
      <td class="col-respect">
        <strong>${warLoading ? '…' : (respectEarned === null ? '—' : `+${formatDecimal(respectEarned, 2)}`)}</strong>
        <span class="member-meta">${warLoading ? '…' : (respectLost === null ? '—' : `−${formatDecimal(respectLost, 2)}`)}</span>
      </td>
      <td class="col-score">
        <strong>${warLoading ? '…' : (scoreUp === null ? '—' : `+${formatDecimal(scoreUp, 2)}`)}</strong>
        <span class="member-meta">${warLoading ? '…' : (scoreDown === null ? '—' : `−${formatDecimal(scoreDown, 2)}`)}</span>
      </td>
      <td class="col-netScore">
        <strong>${warLoading ? '…' : formatSigned(netScore, 2)}</strong>
        <span class="member-meta">${warLoading ? '…' : `${formatSigned(netPerWar, 2)} / war`}</span>
      </td>
      <td class="col-attention"></td>
    </tr>
  `;
}

function sumNullable(rows, key) {
  const values = rows
    .map(row => nullable(row?.[key]))
    .filter(value => value !== null);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function renderIntelFreshness() {
  const element = document.querySelector('#intelFreshness');
  if (!element) return;

  const freshness = overview?.freshness;
  if (!freshness?.observedAt) {
    element.textContent = 'No synced faction data';
    element.classList.remove('stale');
    return;
  }

  element.textContent = freshness.state === 'stale'
    ? `Stale · last snapshot ${formatRelative(freshness.observedAt)}`
    : `Updated ${formatRelative(freshness.observedAt)}`;
  element.classList.toggle('stale', freshness.state === 'stale');
}

function renderHeaders() {
  const head = document.querySelector('#intelHead');
  if (!head) return;

  const groupRow = factionGroups.map(([key,label,count]) => `
    <th class="faction-group group-${key}" colspan="${count}">${escapeHtml(label)}</th>
  `).join('');

  const columnRow = factionColumns.map(key => {
    const [label, detail] = columnLabels[key] || [key,''];
    const active = key === sortKey;
    if (key === 'ocs') {
      return `<th class="col-ocs"><span>${escapeHtml(label)}</span></th>`;
    }
    return `
      <th class="col-${key}${active ? ' sorted' : ''}">
        <button type="button" data-intel2-sort="${key}">
          <span class="sort-label">${escapeHtml(label)}${detail ? ` <small>${escapeHtml(detail)}</small>` : ''}</span>
          <span class="sort-indicator" aria-hidden="true">${active ? (sortDirection === 'desc' ? '↓' : '↑') : ''}</span>
        </button>
      </th>
    `;
  }).join('');

  head.innerHTML = `
    <tr class="faction-group-row">${groupRow}</tr>
    <tr class="faction-column-row">${columnRow}</tr>
  `;
}

function renderFactionCell(member, key) {
  const performance = performanceMember(member);
  const signal = topSignal(member);

  if (key === 'member') {
    return `<td class="col-member"><span class="member-name">${escapeHtml(member.playerName || 'Unknown')}<span class="entity-id">[${escapeHtml(member.playerId)}]</span></span><span class="member-meta">${escapeHtml(member.position || 'Member')} · Lv ${escapeHtml(member.level ?? '—')}${member.current ? '' : ' · former'}</span></td>`;
  }

  if (key === 'stats') {
    return `<td class="col-stats">${member.battleStats?.value == null ? '—' : escapeHtml(formatCompact(member.battleStats.value))}<span class="trend ${trendClass(member.battleStats?.changePct30d)}">${tableBattleStatsTrend(member)}</span></td>`;
  }

  if (key === 'activity') {
    return `<td class="col-activity">${escapeHtml(formatDuration(member.activity?.perDay30d))}<span class="trend ${trendClass(member.activity?.changePct)}">${escapeHtml(tableTrendLabel(member.activity?.changePct))}</span></td>`;
  }

  if (key === 'xanax') {
    return `<td class="col-xanax">${escapeHtml(formatDecimal(member.xanax?.perDay30d, 2))}<span class="trend ${trendClass(member.xanax?.changePct)}">${escapeHtml(tableTrendLabel(member.xanax?.changePct))}</span></td>`;
  }

  if (key === 'ocs') {
    return '<td class="col-ocs">—</td>';
  }

  if (key === 'participation4') {
    return `<td class="col-participation4">${escapeHtml(formatPercent(member.war?.last4?.participation))}<span class="member-meta">${formatNumber(member.war?.last4?.warsParticipated)}/${formatNumber(member.war?.last4?.warsAvailable)} wars</span></td>`;
  }

  if (key === 'hits4') {
    return `<td class="col-hits4">${escapeHtml(formatDecimal(member.war?.last4?.hitsPerWar, 1))}</td>`;
  }

  if (key === 'attention') {
    return `<td class="col-attention">${signal ? `<span class="signal ${signal.kind}">${escapeHtml(tableSignalLabel(signal, member))}</span>` : '—'}</td>`;
  }

  if (!performance) {
    return `<td class="col-${key}">${factionPerformance.loading ? '…' : '—'}</td>`;
  }

  if (key === 'participation') {
    return `<td class="col-participation"><strong>${formatNumber(performance.wars)} / ${formatNumber(factionPerformance.totalWars)}</strong><span class="member-meta">${formatPercent(performance.participation)} participation</span></td>`;
  }

  if (key === 'hits') {
    return `<td class="col-hits"><strong>${formatDecimal(performance.avgHitsPerWar, 1)}</strong><span class="member-meta">${formatNumber(performance.warHits)} total</span></td>`;
  }

  if (key === 'assists') {
    const perWar = Number(performance.wars) > 0 ? Number(performance.assists || 0) / Number(performance.wars) : null;
    return `<td class="col-assists"><strong>${formatNumber(performance.assists)}</strong><span class="member-meta">${formatDecimal(perWar, 1)} / war</span></td>`;
  }

  if (key === 'outsideHits') return `<td class="col-outsideHits">${formatNumber(performance.outsideHits)}</td>`;
  if (key === 'respect') {
    return `<td class="col-respect"><strong>+${formatDecimal(performance.respectEarned, 2)}</strong><span class="member-meta">−${formatDecimal(performance.respectLost, 2)}</span></td>`;
  }

  if (key === 'score') {
    return `<td class="col-score"><strong>+${formatDecimal(performance.scoreUp, 2)}</strong><span class="member-meta">−${formatDecimal(performance.scoreDown, 2)}</span></td>`;
  }

  if (key === 'netScore') {
    const perWar = Number(performance.wars) > 0 ? Number(performance.netScore || 0) / Number(performance.wars) : null;
    return `<td class="col-netScore"><strong>${formatSigned(performance.netScore, 2)}</strong><span class="member-meta">${formatSigned(perWar, 2)} / war</span></td>`;
  }

  return `<td class="col-${key}">—</td>`;
}

function matchesFilter(member) {
  const insights = Array.isArray(member.insights) ? member.insights : [];
  const codes = new Set(insights.map(item => item.code));

  if (activeFilter === 'all') return member.current !== false;
  if (activeFilter === 'attention') return member.current !== false && topSignal(member)?.kind === 'attention';
  if (activeFilter === 'inactive') return member.current !== false && codes.has('inactive');
  if (activeFilter === 'war') {
    if (!factionPerformance.loadedKey || factionPerformance.totalWars <= 0) return false;
    const performance = performanceMember(member);
    return member.current !== false &&
      performance &&
      Number.isFinite(Number(performance.participation)) &&
      Number(performance.participation) < 0.5;
  }
  if (activeFilter === 'decline') return member.current !== false && (codes.has('activity_down') || codes.has('xanax_down'));
  if (activeFilter === 'stats') return member.current !== false && (codes.has('missing_battle_stats') || codes.has('stale_battle_stats'));
  if (activeFilter === 'former') return member.current === false;
  return true;
}

function compareMembers(a, b) {
  const direction = sortDirection === 'asc' ? 1 : -1;
  const av = sortValue(a, sortKey);
  const bv = sortValue(b, sortKey);

  if (typeof av === 'string' || typeof bv === 'string') {
    return String(av).localeCompare(String(bv)) * direction;
  }
  if (av === null && bv === null) return String(a.playerName).localeCompare(String(b.playerName));
  if (av === null) return 1;
  if (bv === null) return -1;
  return ((av - bv) * direction) || String(a.playerName).localeCompare(String(b.playerName));
}

function sortValue(member, key) {
  const performance = performanceMember(member);

  if (key === 'member') return member.playerName || '';
  if (key === 'stats') return nullable(member.battleStats?.value);
  if (key === 'activity') return nullable(member.activity?.perDay30d);
  if (key === 'xanax') return nullable(member.xanax?.perDay30d);
  if (key === 'ocs') return null;
  if (key === 'participation4') return nullable(member.war?.last4?.participation);
  if (key === 'hits4') return nullable(member.war?.last4?.hitsPerWar);
  if (key === 'participation') return nullable(performance?.participation);
  if (key === 'hits') return nullable(performance?.avgHitsPerWar);
  if (key === 'assists') return nullable(performance?.assists);
  if (key === 'outsideHits') return nullable(performance?.outsideHits);
  if (key === 'respect') {
    const earned = nullable(performance?.respectEarned);
    const lost = nullable(performance?.respectLost);
    if (earned === null && lost === null) return null;
    return Number(earned || 0) - Number(lost || 0);
  }
  if (key === 'score') {
    const up = nullable(performance?.scoreUp);
    const down = nullable(performance?.scoreDown);
    if (up === null && down === null) return null;
    return Number(up || 0) - Number(down || 0);
  }
  if (key === 'netScore') return nullable(performance?.netScore);
  if (key === 'attention') {
    const signal = topSignal(member);
    return signal ? priority.length - priorityIndex(signal.code) : 0;
  }
  return 0;
}

function performanceMember(member) {
  return factionPerformance.members.get(Number(member?.playerId)) || null;
}

function analysisPayload() {
  const range = effectiveRange();
  return range?.from && range?.to ? { from:range.from, to:range.to } : {};
}

function performancePayload() {
  if (filterMode === 'wars') {
    return { warIds:[...selectedWarIds].sort() };
  }
  return analysisPayload();
}

function analysisKey() {
  const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
  const range = effectiveRange();
  return `${factionId}:${range?.from || ''}:${range?.to || ''}`;
}

function performanceKey() {
  const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
  if (filterMode === 'wars') {
    return `${factionId}:wars:${[...selectedWarIds].sort().join(',')}`;
  }
  const range = effectiveRange();
  return `${factionId}:timeline:${range?.from || ''}:${range?.to || ''}`;
}

function ensureSortKey() {
  if (factionColumns.includes(sortKey)) return;
  sortKey = 'member';
  sortDirection = 'asc';
}

function restoreFactionMode() {
  try {
    const stored = localStorage.getItem('rwengine.factionMode');
    if (stored === 'timeline' || stored === 'wars') return stored;
  } catch (_) {}
  return 'timeline';
}

function ensureFilterState() {
  const bounds = availabilityBounds();

  if (!timelineRange.from || !timelineRange.to) {
    timelineRange = restoreTimelineRange(bounds) || defaultTimelineRange(bounds);
  }

  if (bounds.from && timelineRange.from < bounds.from) timelineRange.from = bounds.from;
  if (bounds.to && timelineRange.to > bounds.to) timelineRange.to = bounds.to;
  if (timelineRange.from > timelineRange.to) timelineRange = defaultTimelineRange(bounds);

  const validWarIds = new Set(sortedWars().map(war => String(warId(war))).filter(Boolean));
  selectedWarIds = new Set([...selectedWarIds].map(String).filter(id => validWarIds.has(id)));

  if (!selectedWarIds.size) {
    const restored = restoreWarSelection(validWarIds);
    selectedWarIds = restored.size
      ? restored
      : new Set(sortedWars().slice(0,4).map(war => String(warId(war))).filter(Boolean));
  }

  if (!calendarCursor) {
    calendarCursor = monthStart(timelineRange.from || bounds.from || isoToday());
  }
}

function availabilityBounds() {
  const intel = state.freshness?.datasets?.intel;
  return {
    from:intel?.snapshotFirstAt ? isoDate(intel.snapshotFirstAt) : null,
    to:intel?.snapshotObservedAt ? isoDate(intel.snapshotObservedAt) : null
  };
}

function defaultTimelineRange(bounds) {
  if (!bounds?.to) {
    const to = isoToday();
    return { from:addDays(to,-29), to };
  }
  const candidate = addDays(bounds.to,-29);
  return {
    from:bounds.from && candidate < bounds.from ? bounds.from : candidate,
    to:bounds.to
  };
}

function restoreTimelineRange(bounds) {
  try {
    const parsed = JSON.parse(localStorage.getItem('rwengine.timelineRange') || 'null');
    if (!parsed?.from || !parsed?.to) return null;
    if (bounds?.from && parsed.from < bounds.from) return null;
    if (bounds?.to && parsed.to > bounds.to) return null;
    return { from:parsed.from, to:parsed.to };
  } catch (_) {
    return null;
  }
}

function restoreWarSelection(validIds) {
  try {
    const parsed = JSON.parse(localStorage.getItem('rwengine.selectedWarIds') || '[]');
    return new Set(
      (Array.isArray(parsed) ? parsed : [])
        .map(value => String(value || '').trim())
        .filter(id => id && validIds.has(id))
    );
  } catch (_) {
    return new Set();
  }
}

function effectiveRange() {
  ensureFilterState();
  if (filterMode === 'timeline') return timelineRange;
  return rangeForWarIds(selectedWarIds);
}

function prepareFilterDraft() {
  ensureFilterState();
  if (filterMode === 'timeline') {
    draftTimelineRange = { ...timelineRange };
    calendarAnchor = null;
    calendarCursor = monthStart(draftTimelineRange.from || timelineRange.from);
  } else {
    draftWarIds = new Set(selectedWarIds);
  }
}

async function applyAllScope() {
  filterPanelOpen = false;

  if (filterMode === 'timeline') {
    const bounds = availabilityBounds();
    if (!bounds.from || !bounds.to) return;

    timelineRange = { from:bounds.from, to:bounds.to };
    draftTimelineRange = { ...timelineRange };
    calendarAnchor = null;
    calendarCursor = monthStart(bounds.from);
    try { localStorage.setItem('rwengine.timelineRange', JSON.stringify(timelineRange)); } catch (_) {}
  } else {
    const ids = sortedWars().map(war => String(warId(war))).filter(Boolean);
    if (!ids.length) return;

    selectedWarIds = new Set(ids);
    draftWarIds = new Set(ids);
    try { localStorage.setItem('rwengine.selectedWarIds', JSON.stringify(ids)); } catch (_) {}
  }

  loadedAnalysisKey = '';
  factionPerformance.loadedKey = '';
  factionPerformance.members.clear();
  renderFactionControls();
  await loadIntelV2(true);
}

function isAllTimelineSelected() {
  const bounds = availabilityBounds();
  return Boolean(
    bounds.from && bounds.to &&
    timelineRange.from === bounds.from &&
    timelineRange.to === bounds.to
  );
}

function areAllWarsSelected() {
  const ids = sortedWars().map(war => String(warId(war))).filter(Boolean);
  return Boolean(ids.length) && ids.every(id => selectedWarIds.has(id)) && selectedWarIds.size === ids.length;
}

async function applyTimelineDraft() {
  if (!draftTimelineRange?.from || !draftTimelineRange?.to) return;
  timelineRange = { ...draftTimelineRange };
  try { localStorage.setItem('rwengine.timelineRange', JSON.stringify(timelineRange)); } catch (_) {}
  filterPanelOpen = false;
  loadedAnalysisKey = '';
  factionPerformance.loadedKey = '';
  factionPerformance.members.clear();
  renderFactionControls();
  await loadIntelV2(true);
}

async function applyWarDraft() {
  if (!draftWarIds.size) return;
  selectedWarIds = new Set(draftWarIds);
  try { localStorage.setItem('rwengine.selectedWarIds', JSON.stringify([...selectedWarIds])); } catch (_) {}
  filterPanelOpen = false;
  loadedAnalysisKey = '';
  factionPerformance.loadedKey = '';
  factionPerformance.members.clear();
  renderFactionControls();
  await loadIntelV2(true);
}

function renderCalendarPicker() {
  const bounds = availabilityBounds();
  const first = calendarCursor || monthStart(timelineRange.from || bounds.from || isoToday());
  const second = addMonths(first, 1);
  const range = draftTimelineRange || timelineRange;

  return `
    <div class="calendar-picker">
      <header class="filter-panel-head">
        <div>
          <strong>Timeline</strong>
          <span>${escapeHtml(formatRangeLabel(range))}</span>
        </div>
        <div class="calendar-nav">
          <button type="button" data-calendar-nav="-1" aria-label="Previous month">←</button>
          <button type="button" data-calendar-nav="1" aria-label="Next month">→</button>
        </div>
      </header>
      <div class="calendar-months">
        ${renderCalendarMonth(first, bounds, range)}
        ${renderCalendarMonth(second, bounds, range)}
      </div>
      <footer class="filter-panel-foot">
        <span><i class="calendar-legend-war"></i> Imported ranked war</span>
        <span class="filter-spacer"></span>
        <button type="button" class="text-action" data-filter-action="cancel">Cancel</button>
        <button type="button" class="action primary" data-filter-action="calendar-apply">Apply range</button>
      </footer>
    </div>
  `;
}

function renderCalendarMonth(month, bounds, range) {
  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  const title = month.toLocaleString(undefined, { month:'long', year:'numeric', timeZone:'UTC' });
  const firstWeekday = (new Date(Date.UTC(year, monthIndex, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cells = [];

  for (let i = 0; i < firstWeekday; i++) cells.push('<span class="calendar-day empty"></span>');

  for (let day = 1; day <= days; day++) {
    const date = `${year}-${String(monthIndex + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const available = (!bounds.from || date >= bounds.from) && (!bounds.to || date <= bounds.to);
    const warNames = warsOnDate(date);
    const selected = range?.from && range?.to && date >= range.from && date <= range.to;
    const edge = date === range?.from || date === range?.to;
    const classes = [
      'calendar-day',
      available ? '' : 'unavailable',
      warNames.length ? 'has-war' : '',
      selected ? 'selected' : '',
      edge ? 'edge' : ''
    ].filter(Boolean).join(' ');

    cells.push(`<button type="button" class="${classes}" data-calendar-day="${date}"${available ? '' : ' disabled'} title="${escapeHtml(warNames.join(' · '))}"><span>${day}</span>${warNames.length ? '<i></i>' : ''}</button>`);
  }

  return `
    <section class="calendar-month">
      <header>${escapeHtml(title)}</header>
      <div class="calendar-weekdays">${['M','T','W','T','F','S','S'].map(day => `<span>${day}</span>`).join('')}</div>
      <div class="calendar-grid">${cells.join('')}</div>
    </section>
  `;
}

function renderWarPicker() {
  const wars = sortedWars();

  return `
    <div class="war-picker">
      <header class="filter-panel-head">
        <div>
          <strong>Ranked wars</strong>
          <span>${draftWarIds.size} selected</span>
        </div>
        <div class="war-picker-actions">
          <button type="button" class="text-action" data-filter-action="wars-all">All</button>
          <button type="button" class="text-action" data-filter-action="wars-none">None</button>
        </div>
      </header>
      <div class="war-picker-list">
        ${wars.length ? wars.map(war => {
          const id = String(warId(war));
          const checked = draftWarIds.has(id);
          return `
            <label class="war-picker-row">
              <input type="checkbox" data-war-check="${id}"${checked ? ' checked' : ''}>
              <span>
                <strong>${escapeHtml(warOpponent(war))}<small class="entity-id">#${escapeHtml(id)}</small></strong>
                <small>${escapeHtml(formatWarDate(war))}</small>
              </span>
            </label>
          `;
        }).join('') : '<p class="status-line">No imported ranked wars.</p>'}
      </div>
      <footer class="filter-panel-foot">
        <span class="filter-spacer"></span>
        <button type="button" class="text-action" data-filter-action="cancel">Cancel</button>
        <button id="warSelectionApply" type="button" class="action primary" data-filter-action="wars-apply"${draftWarIds.size ? '' : ' disabled'}>Apply wars</button>
      </footer>
    </div>
  `;
}

function updateWarApplyState() {
  const button = document.querySelector('#warSelectionApply');
  if (button) button.disabled = !draftWarIds.size;
}

function selectCalendarDay(date) {
  if (!calendarAnchor) {
    calendarAnchor = date;
    draftTimelineRange = { from:date, to:date };
    return;
  }

  draftTimelineRange = date < calendarAnchor
    ? { from:date, to:calendarAnchor }
    : { from:calendarAnchor, to:date };
  calendarAnchor = null;
}

function moveCalendar(offset) {
  calendarCursor = addMonths(calendarCursor || monthStart(isoToday()), offset);
}

function rangeForWarIds(ids) {
  const selected = sortedWars().filter(war => ids.has(String(warId(war))));
  if (!selected.length) return timelineRange;

  const starts = selected.map(war => warStartDate(war)).filter(Boolean).sort();
  const ends = selected.map(war => warEndDate(war)).filter(Boolean).sort();

  return {
    from:starts[0] || ends[0] || timelineRange.from,
    to:ends[ends.length - 1] || starts[starts.length - 1] || timelineRange.to
  };
}

function sortedWars() {
  return [...(state.wars || [])].sort((a,b) => warStamp(b) - warStamp(a));
}

function warStamp(war) {
  return Number(war?.endTimestamp || war?.end_timestamp || war?.startTimestamp || war?.start_timestamp || war?.importedAt || war?.imported_at || 0);
}

function warId(war) {
  return war?.warId ?? war?.war_id ?? war?.id ?? 0;
}

function warOpponent(war) {
  return war?.opponentFactionName || war?.opponent_faction_name || war?.opponentName || war?.opponent_name || 'Unknown opponent';
}

function warStartDate(war) {
  const stamp = Number(war?.startTimestamp || war?.start_timestamp || war?.endTimestamp || war?.end_timestamp || war?.importedAt || war?.imported_at || 0);
  return stamp ? isoDate(stamp) : null;
}

function warEndDate(war) {
  const stamp = Number(war?.endTimestamp || war?.end_timestamp || war?.startTimestamp || war?.start_timestamp || war?.importedAt || war?.imported_at || 0);
  return stamp ? isoDate(stamp) : null;
}

function formatWarDate(war) {
  const start = warStartDate(war);
  const end = warEndDate(war);
  if (!start && !end) return 'Date unavailable';
  if (!start || start === end) return humanDate(end || start);
  return `${humanDate(start)} – ${humanDate(end)}`;
}

function warsOnDate(date) {
  return sortedWars()
    .filter(war => {
      const start = warStartDate(war);
      const end = warEndDate(war);
      if (!start && !end) return false;
      return date >= (start || end) && date <= (end || start);
    })
    .map(war => warOpponent(war));
}

function formatRangeLabel(range) {
  if (!range?.from || !range?.to) return 'No available range';
  if (range.from === range.to) return humanDate(range.from);
  return `${humanDate(range.from)} – ${humanDate(range.to)}`;
}

function humanDate(value) {
  if (!value) return '—';
  const date = new Date(value + 'T00:00:00Z');
  return date.toLocaleDateString(undefined, {
    day:'2-digit',
    month:'short',
    year:date.getUTCFullYear() === new Date().getUTCFullYear() ? undefined : 'numeric',
    timeZone:'UTC'
  });
}

function isoDate(timestamp) {
  return new Date(Number(timestamp) * 1000).toISOString().slice(0,10);
}

function isoToday() {
  return new Date().toISOString().slice(0,10);
}

function addDays(value, days) {
  const date = new Date(value + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0,10);
}

function monthStart(value) {
  const date = value instanceof Date ? value : new Date(String(value) + 'T00:00:00Z');
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(value, months) {
  const date = value instanceof Date ? value : monthStart(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + Number(months || 0), 1));
}

function averageNullable(values) {
  const valid = values.map(nullable).filter(value => value !== null);
  if (!valid.length) return null;
  return valid.reduce((sum,value) => sum + value, 0) / valid.length;
}

function tableTrendLabel(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const pct = Math.round(number * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

function tableBattleStatsTrend(member) {
  const value = member?.battleStats?.changePct30d;
  if (value === null || value === undefined || value === '') {
    return member?.battleStats?.value == null ? 'No estimate' : '—';
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const pct = Math.round(number * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

function tableSignalLabel(signal, member) {
  if (!signal) return '—';
  if (signal.code === 'low_war_participation') return 'Low participation';
  if (signal.code === 'participation_down') return 'Participation declining';
  if (signal.code === 'activity_down') return 'Activity declining';
  if (signal.code === 'activity_up') return 'Activity improving';
  if (signal.code === 'xanax_down') return 'Xanax declining';
  if (signal.code === 'xanax_up') return 'Xanax improving';
  if (signal.code === 'strong_war_output') return 'Strong war output';
  if (signal.code === 'missing_battle_stats') return 'Stats missing';
  if (signal.code === 'stale_battle_stats') return 'Stats stale';
  if (signal.code === 'battle_stats_growth') return 'Stats growing';
  return signalLabel(signal, member);
}

function topSignal(member) {
  const scopedOut = new Set([
    'low_war_participation',
    'participation_down',
    'strong_war_output'
  ]);

  const insights = (Array.isArray(member.insights) ? member.insights : [])
    .filter(item => !scopedOut.has(item.code))
    .map(item => ({ ...item }));

  const performance = performanceMember(member);

  if (
    factionPerformance.totalWars > 0 &&
    performance &&
    Number.isFinite(Number(performance.participation)) &&
    Number(performance.participation) < 0.5
  ) {
    insights.push({
      code:'low_war_participation',
      kind:'attention',
      text:`Participated in ${formatNumber(performance.wars)} of ${formatNumber(factionPerformance.totalWars)} selected wars.`
    });
  }

  if (!insights.length) return null;
  return insights.sort((a,b) => priorityIndex(a.code) - priorityIndex(b.code))[0];
}

function priorityIndex(code) {
  const index = priority.indexOf(code);
  return index < 0 ? 999 : index;
}

function signalLabel(signal, member) {
  if (signal.code === 'inactive') {
    const seconds = Number(signal.value || 0);
    const days = Math.max(1, Math.floor(seconds / 86400));
    return `inactive ${days}d`;
  }
  if (signal.code === 'low_war_participation') {
    return `${member.war?.last4?.warsParticipated ?? 0}/${member.war?.last4?.warsAvailable ?? 0} wars`;
  }
  if (signal.code === 'participation_down') return 'participation ↓';
  if (signal.code === 'activity_down') return `activity ${signedPct(member.activity?.changePct)}`;
  if (signal.code === 'activity_up') return `activity ${signedPct(member.activity?.changePct)}`;
  if (signal.code === 'xanax_down') return `xanax ${signedPct(member.xanax?.changePct)}`;
  if (signal.code === 'xanax_up') return `xanax ${signedPct(member.xanax?.changePct)}`;
  if (signal.code === 'missing_battle_stats') return 'stats missing';
  if (signal.code === 'stale_battle_stats') return 'stats stale';
  if (signal.code === 'battle_stats_growth') return `stats ${signedPct(member.battleStats?.changePct30d)}`;
  if (signal.code === 'strong_war_output') return 'war output +';
  return String(signal.code || '').replaceAll('_', ' ');
}

async function openMember(playerId) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) return;

  if (!overview) await loadIntelV2(false);
  selectedMemberId = playerId;
  renderIntelV2();

  const key = detailKey(playerId);
  if (detailCache.has(key) || detailLoading.has(key)) return;

  detailLoading.add(key);
  renderIntelV2();

  try {
    const payload = await intelV2Api('member', { playerId });
    detailCache.set(key, payload);
  } catch (error) {
    detailCache.set(key, { error:error.message || 'Failed to load member detail.' });
  } finally {
    detailLoading.delete(key);
    if (selectedMemberId === playerId) renderIntelV2();
  }
}

function renderDetailRow(member) {
  const key = detailKey(member.playerId);
  const payload = detailCache.get(key);

  if (detailLoading.has(key)) {
    return `<tr class="intel2-detail-row"><td colspan="${factionColumns.length}"><section class="intel2-detail"><p class="status-line">Loading member history…</p></section></td></tr>`;
  }

  if (payload?.error) {
    return `<tr class="intel2-detail-row"><td colspan="${factionColumns.length}"><section class="intel2-detail"><p class="status-line error">${escapeHtml(payload.error)}</p></section></td></tr>`;
  }

  if (!payload?.member) {
    return `<tr class="intel2-detail-row"><td colspan="${factionColumns.length}"><section class="intel2-detail"><p class="status-line">Loading member history…</p></section></td></tr>`;
  }

  const detailMember = payload.member;
  const history = normalizeHistory(payload.history);
  const insights = renderInsights(detailMember);

  return `
    <tr class="intel2-detail-row">
      <td colspan="${factionColumns.length}">
        <section class="intel2-detail">
          <div class="intel2-detail-tools">
            <span>Member context</span>
            <a href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(detailMember.playerId)}" target="_blank" rel="noopener noreferrer">Torn profile ↗</a>
          </div>

          ${insights ? `<div class="intel2-insights">${insights}</div>` : ''}

          <section class="intel2-history">
            <header class="intel2-history-head">
              <div>
                <span class="intel2-history-kicker">History &amp; trends</span>
                <p>How this member has changed over time, plus the wars behind the summary above.</p>
              </div>
              <div class="intel2-history-window" aria-label="History window">
                ${[30,60,90].map(days => `<button type="button" data-trend-days="${days}" class="${trendDays === days ? 'active' : ''}">${days}d</button>`).join('')}
              </div>
            </header>

            <div class="intel2-trends">
              ${trendBlock('Battle stats', history.stats, value => value == null ? '—' : formatCompact(value))}
              ${trendBlock('Activity / day', history.activity, formatDuration)}
              ${trendBlock('Xanax / day', history.xanax, value => formatDecimal(value, 2))}
            </div>

            <section class="intel2-wars">
              <header>
                <strong>Recent wars</strong>
                <span>${history.wars.length} available</span>
              </header>
              ${renderWarHistory(history.wars)}
            </section>

          </section>
        </section>
      </td>
    </tr>
  `;
}

function renderInsights(member) {
  const insights = Array.isArray(member.insights) ? member.insights : [];

  const positive = insights.filter(item => item.kind === 'positive');
  const concerns = insights.filter(item => item.kind === 'attention');
  const notes = insights.filter(item => !['positive','attention'].includes(item.kind));

  return `
    <div class="intel2-trait-grid">
      ${renderTraitGroup('positive', '+', 'Positive', positive, member, 'No standout positives')}
      ${renderTraitGroup('attention', '−', 'Concerns', concerns, member, 'No current concerns')}
    </div>
    ${notes.length ? `
      <div class="intel2-data-notes">
        <span>Data</span>
        ${notes.map(item => `
          <div class="intel2-data-note">
            <b>${escapeHtml(traitTitle(item, member))}</b>
            <span>${escapeHtml(item.text || '')}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function renderTraitGroup(kind, symbol, label, items, member, emptyLabel) {
  return `
    <section class="intel2-trait-group ${kind}">
      <header><span>${symbol}</span><strong>${label}</strong></header>
      <div class="intel2-trait-list">
        ${items.length ? items.map(item => `
          <div class="intel2-trait">
            <b>${escapeHtml(traitTitle(item, member))}</b>
            <span>${escapeHtml(item.text || '')}</span>
          </div>
        `).join('') : `<span class="intel2-trait-empty">${escapeHtml(emptyLabel)}</span>`}
      </div>
    </section>
  `;
}

function traitTitle(item, member) {
  if (item.code === 'inactive') return 'Inactive';
  if (item.code === 'low_war_participation') return 'Low war participation';
  if (item.code === 'participation_down') return 'Participation declining';
  if (item.code === 'activity_down') return 'Activity declining';
  if (item.code === 'activity_up') return 'Activity improving';
  if (item.code === 'xanax_down') return 'Xanax use declining';
  if (item.code === 'xanax_up') return 'Xanax use improving';
  if (item.code === 'missing_battle_stats') return 'Battle stats unavailable';
  if (item.code === 'stale_battle_stats') return 'Battle stats stale';
  if (item.code === 'battle_stats_growth') return 'Battle stats growing';
  if (item.code === 'strong_war_output') return 'Strong war output';
  return signalLabel(item, member);
}

function normalizeHistory(history = {}) {
  const snapshots = Array.isArray(history.snapshots) ? history.snapshots : [];

  const stats = snapshots
    .filter(point => hasNumber(point.battleStatsValue))
    .map(point => ({ at:Number(point.at), value:Number(point.battleStatsValue) }));

  const activityStored = snapshots
    .filter(point =>
      hasNumber(point.activityPerDaySeconds) &&
      Number(point.activityPerDaySeconds) >= 0 &&
      Number(point.activityPerDaySeconds) <= 86400
    )
    .map(point => ({ at:Number(point.at), value:Number(point.activityPerDaySeconds) }));

  const xanaxStored = snapshots
    .filter(point =>
      hasNumber(point.xanaxPerDay) &&
      Number(point.xanaxPerDay) >= 0 &&
      Number(point.xanaxPerDay) <= 10
    )
    .map(point => ({ at:Number(point.at), value:Number(point.xanaxPerDay) }));

  return {
    stats,
    activity:activityStored.length >= 2
      ? activityStored
      : deriveRateSeries(snapshots, 'activityTotalSeconds'),
    xanax:xanaxStored.length >= 2
      ? xanaxStored
      : deriveRateSeries(snapshots, 'xanaxTakenTotal'),
    wars:Array.isArray(history.wars) ? history.wars : []
  };
}

function deriveRateSeries(snapshots, key) {
  const rows = snapshots
    .filter(point => hasNumber(point.at) && hasNumber(point[key]))
    .sort((a,b) => Number(a.at) - Number(b.at));

  const maxPerDay = key === 'activityTotalSeconds'
    ? 86400
    : key === 'xanaxTakenTotal'
      ? 10
      : Infinity;

  const series = [];
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1];
    const current = rows[index];
    const elapsed = (Number(current.at) - Number(previous.at)) / 86400;
    const delta = Number(current[key]) - Number(previous[key]);
    const perDay = elapsed > 0 ? delta / elapsed : null;

    if (
      elapsed >= 0.5 &&
      delta >= 0 &&
      Number.isFinite(perDay) &&
      perDay <= maxPerDay
    ) {
      series.push({ at:Number(current.at), value:perDay });
    }
  }
  return series;
}

function trendBlock(title, series, formatter) {
  const filtered = filterSeries(series, trendDays);
  const valid = filtered.filter(point =>
    point.value !== null &&
    point.value !== undefined &&
    point.value !== '' &&
    Number.isFinite(Number(point.value))
  );
  const latest = valid.length ? valid[valid.length - 1].value : null;
  const availableDays = valid.length > 1
    ? Math.max(1, Math.round(
        (Number(valid[valid.length - 1].at) - Number(valid[0].at)) / 86400
      ))
    : 0;
  const windowLabel = availableDays > 0
    ? (availableDays < trendDays ? `${availableDays}d available` : `${trendDays}d`)
    : 'No trend data';
  const latestLabel = latest === null || latest === undefined ? '—' : formatter(latest);

  const body = valid.length < 2
    ? '<div class="intel2-trend-empty">No history available</div>'
    : sparkline(filtered);

  return `
    <section class="intel2-trend">
      <header>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(windowLabel)} · ${escapeHtml(latestLabel)}</span>
      </header>
      ${body}
    </section>
  `;
}

function filterSeries(series, days) {
  if (!series.length) return [];
  const newest = Math.max(...series.map(point => Number(point.at) || 0));
  const cutoff = newest - days * 86400;
  return series.filter(point => (Number(point.at) || 0) >= cutoff);
}

function sparkline(series) {
  const valid = series
    .map((point,index) => ({ index, value:Number(point.value) }))
    .filter(point => Number.isFinite(point.value));

  if (valid.length < 2) return '<div class="sparkline"></div>';

  const min = Math.min(...valid.map(point => point.value));
  const max = Math.max(...valid.map(point => point.value));
  const spread = max - min || 1;

  const points = valid.map(point => {
    const x = (point.index / Math.max(1, series.length - 1)) * 100;
    const y = 48 - ((point.value - min) / spread) * 42;
    return [x,y];
  });

  const path = points
    .map(([x,y],index) => index === 0
      ? `M ${x.toFixed(2)} ${y.toFixed(2)}`
      : `L ${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ');

  return `<svg class="sparkline" viewBox="0 0 100 54" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="50" x2="100" y2="50"></line><path d="${path}"></path></svg>`;
}

function renderWarHistory(wars) {
  if (!wars.length) return '<div class="line-row"><small>No imported war history available.</small></div>';

  return wars.map(war => `
    <div class="intel2-war">
      <div>
        <strong>${escapeHtml(war.opponentFactionName || war.opponent || 'Unknown opponent')}</strong>
        <small>#${escapeHtml(war.warId)}</small>
      </div>
      <span>${formatNumber(war.hits)} hits</span>
      <span>${formatNumber(war.assists)} assists</span>
      <span>${formatNumber(war.outsideHits)} outside</span>
      <span>${formatSignedLocal(war.netScore)} net</span>
    </div>
  `).join('');
}

async function refreshSyncStatus() {
  try {
    const result = await syncApi('getSyncStatus');
    syncJob = result.job || null;
  } catch (_) {
    syncJob = null;
  }
  renderSync();
}

async function runSync() {
  if (syncing) return;
  syncing = true;

  const button = document.querySelector('#syncButton');
  if (button) {
    button.disabled = true;
    button.textContent = 'Syncing…';
  }

  try {
    const started = await syncApi('startSync');
    syncJob = started.job || null;
    renderSync();

    let safety = 0;
    while (syncJob && !['completed','failed'].includes(syncJob.status) && safety < 500) {
      const result = await syncApi('syncStep', { jobId:syncJob.jobId });
      syncJob = result.job || syncJob;
      renderSync();

      if (syncJob.status === 'failed') {
        throw new Error(syncJob.error || 'Faction sync failed.');
      }

      if (!['completed','failed'].includes(syncJob.status)) {
        await sleep(result.busy ? 1200 : 300);
      }
      safety += 1;
    }

    if (safety >= 500) throw new Error('Faction sync exceeded the safety limit.');

    emit('request-refresh', { source:'sync' });
  } catch (error) {
    syncJob = { status:'failed', error:error.message || 'Faction sync failed.' };
    renderSync();
  } finally {
    syncing = false;
    if (button) {
      button.disabled = false;
      button.textContent = 'Sync faction';
    }
  }
}

function renderSync() {
  const element = document.querySelector('#syncLine');
  if (!element) return;

  if (!syncJob || syncJob.status === 'completed') {
    element.classList.add('hidden');
    element.textContent = '';
    return;
  }

  element.classList.remove('hidden');
  element.classList.toggle('error', syncJob.status === 'failed');

  if (syncJob.status === 'failed') {
    element.textContent = syncJob.error || 'Faction sync failed.';
    return;
  }

  const done = Number(syncJob.tasksCompleted || 0);
  const total = Number(syncJob.tasksTotal || 0);
  const phase = syncJob.phase || syncJob.status || 'syncing';
  element.textContent = total > 0
    ? `Syncing faction · ${phase} · ${done}/${total}`
    : `Syncing faction · ${phase}`;
}

function setIntelStatus(message, error = false) {
  const element = document.querySelector('#syncLine');
  if (!element || syncJob) return;
  element.textContent = message || '';
  element.classList.toggle('hidden', !message);
  element.classList.toggle('error', error);
}

function battleStatsTrend(member) {
  if (member.battleStats?.value == null) return 'No estimate';
  if (!member.battleStats?.trendReliable) {
    return member.battleStats?.source ? String(member.battleStats.source) : 'No comparison';
  }
  return trendLabel(member.battleStats.changePct30d, '30d');
}

function trendLabel(value, suffix) {
  const number = nullable(value);
  if (number === null) return 'No comparison';
  const pct = Math.round(number * 100);
  return `${pct > 0 ? '+' : ''}${pct}% ${suffix}`;
}

function trendClass(value) {
  const number = nullable(value);
  if (number === null || Math.abs(number) < 0.1) return '';
  return number > 0 ? 'up' : 'down';
}

function signedPct(value) {
  const number = nullable(value);
  if (number === null) return '—';
  const pct = Math.round(number * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

function formatSignedLocal(value) {
  const number = nullable(value);
  if (number === null) return '—';
  const formatted = formatDecimal(number, 2);
  return number > 0 ? `+${formatted}` : formatted;
}

function hasNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function nullable(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function detailKey(playerId) {
  const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
  return `${factionId}:${playerId}`;
}

function resetIntelState() {
  overview = null;
  loadedFactionId = null;
  loadedAnalysisKey = '';
  selectedMemberId = null;
  detailCache.clear();
  detailLoading.clear();
  syncJob = null;
  activeFilter = 'all';
  trendDays = 90;

  timelineRange = { from:null, to:null };
  draftTimelineRange = null;
  selectedWarIds = new Set();
  draftWarIds = new Set();
  calendarCursor = null;
  calendarAnchor = null;
  filterPanelOpen = false;

  factionPerformance.members.clear();
  factionPerformance.totalWars = 0;
  factionPerformance.playersWithAttackDetails = 0;
  factionPerformance.loadedKey = '';
  factionPerformance.loading = false;
  factionPerformance.error = '';

  const search = document.querySelector('#intelSearch');
  if (search) search.value = '';

  renderFilters();
  renderFactionControls();
  renderSync();
}
