import {
  state, on, emit, intelV2Api, syncApi, performanceApi, periodPayload,
  metric, formatNumber, formatCompact, formatDecimal, formatPercent, formatSigned,
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

const factionPresets = [
  ['overview','Overview'],
  ['activity','Activity'],
  ['training','Training'],
  ['war','War'],
  ['all','All']
];

const presetColumns = {
  overview:['member','lastAction','stats','activity','xanax','participation4','hits4','attention'],
  activity:['member','lastAction','activity','xanax','attention'],
  training:['member','stats','xanax','attention'],
  war:['member','wars','participation','hits','assists','outsideHits','netScore','attention'],
  all:[
    'member','lastAction','stats','activity','xanax',
    'wars','participation','hits','assists','outsideHits',
    'respectEarned','respectLost','scoreUp','scoreDown','netScore','attention'
  ]
};

const columnLabels = {
  member:['Member',''],
  lastAction:['Last action',''],
  stats:['Battle stats',''],
  activity:['Activity / day','30d'],
  xanax:['Xanax / day','30d'],
  participation4:['War participation','last 4'],
  hits4:['Hits per war','last 4'],
  wars:['Wars joined',''],
  participation:['Participation',''],
  hits:['Hits per war',''],
  assists:['Assists',''],
  outsideHits:['Outside hits',''],
  respectEarned:['Respect gained',''],
  respectLost:['Respect lost',''],
  scoreUp:['Score gained',''],
  scoreDown:['Score lost',''],
  netScore:['Net score',''],
  attention:['Signal','']
};

const presetGroups = {
  overview:[
    ['roster','Roster',2],
    ['training','Training',3],
    ['war','War',2],
    ['context','Context',1]
  ],
  activity:[
    ['roster','Roster',2],
    ['activity','Activity',2],
    ['context','Context',1]
  ],
  training:[
    ['roster','Roster',1],
    ['training','Training',2],
    ['context','Context',1]
  ],
  war:[
    ['roster','Roster',1],
    ['war','War performance',6],
    ['context','Context',1]
  ],
  all:[
    ['roster','Roster',2],
    ['training','Training',3],
    ['war','War performance',10],
    ['context','Context',1]
  ]
};

const presetGuides = {
  overview:'A compact faction overview combining roster state, training activity and recent war participation.',
  activity:'Compare member activity, Xanax use and current attention signals.',
  training:'Compare battle-stat estimates and Xanax usage across the roster.',
  war:'Cross-war member performance for the selected war range. Open Archive for individual war reports.',
  all:'Every comparable roster, training and war metric RWEngine currently collects.'
};

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
let activePreset = restoreFactionPreset();
let activeFilter = 'all';
let selectedMemberId = null;
let sortKey = 'attention';
let sortDirection = 'desc';
let trendDays = 90;
let loading = false;
let syncJob = null;
let syncing = false;

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
  renderPresetControls();

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

  document.querySelector('#factionPresets')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-faction-preset]');
    if (!button) return;

    const next = button.dataset.factionPreset;
    if (!presetColumns[next]) return;

    activePreset = next;
    try { localStorage.setItem('rwengine.factionPreset', activePreset); } catch (_) {}
    ensureSortKey();
    renderPresetControls();
    renderIntelV2();

    if (needsPerformance()) await loadFactionPerformance(false);
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
    activePreset = restoreFactionPreset();
    ensureSortKey();
    renderPresetControls();
    loadIntelV2(false);
  });

  on('period', () => {
    factionPerformance.loadedKey = '';
    factionPerformance.members.clear();
    renderPresetControls();
    if (state.route === 'intel' && needsPerformance()) loadFactionPerformance(true);
  });

  on('faction', () => {
    resetIntelState();
  });

  on('data', () => {
    if (state.route === 'intel') loadIntelV2(true);
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

  if (!force && overview && Number(loadedFactionId) === factionId) {
    renderIntelV2();
    if (needsPerformance()) await loadFactionPerformance(false);
    return;
  }

  loading = true;
  setIntelStatus('Loading faction data…');

  try {
    overview = await intelV2Api('overview');
    loadedFactionId = factionId;
    setIntelStatus('');
    renderIntelV2();
    renderIntelFreshness();
    await refreshSyncStatus();

    if (needsPerformance()) await loadFactionPerformance(force);
  } catch (error) {
    overview = null;
    setIntelStatus(error.message || 'Failed to load faction data.', true);
    renderIntelV2();
  } finally {
    loading = false;
  }
}

async function loadFactionPerformance(force = false) {
  if (!needsPerformance() || factionPerformance.loading) return;

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
    const data = await performanceApi(periodPayload());
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

function renderPresetControls() {
  const container = document.querySelector('#factionPresets');
  if (container) {
    container.innerHTML = factionPresets.map(([key,label]) =>
      `<button type="button" data-faction-preset="${key}" class="${activePreset === key ? 'active' : ''}">${label}</button>`
    ).join('');
  }

  document.querySelector('#factionWarPeriodWrap')?.classList.toggle('hidden', !needsPerformance());

  const guide = document.querySelector('#factionTableGuide');
  if (guide) guide.textContent = presetGuides[activePreset] || '';

  const table = document.querySelector('#intelTable');
  if (table) table.dataset.preset = activePreset;

  renderFactionStatus();
}

function renderFactionStatus() {
  const element = document.querySelector('#factionTableStatus');
  if (!element) return;

  if (!needsPerformance()) {
    element.textContent = '';
    element.classList.add('hidden');
    element.classList.remove('error');
    return;
  }

  if (factionPerformance.loading) {
    element.textContent = `War range: ${periodLabel()} · loading performance…`;
    element.classList.remove('hidden','error');
    return;
  }

  if (factionPerformance.error) {
    element.textContent = factionPerformance.error;
    element.classList.remove('hidden');
    element.classList.add('error');
    return;
  }

  if (factionPerformance.loadedKey) {
    element.textContent = `War range: ${periodLabel()} · ${formatNumber(factionPerformance.totalWars)} imported war${factionPerformance.totalWars === 1 ? '' : 's'}`;
    element.classList.remove('hidden','error');
    return;
  }

  element.textContent = '';
  element.classList.add('hidden');
}

function renderIntelV2() {
  ensureSortKey();
  renderPresetControls();
  renderSummary();
  renderHeaders();

  const body = document.querySelector('#intelBody');
  if (!body) return;

  const columns = activeColumns();
  const colspan = columns.length;

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

  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">No members match this view.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map(member => {
    const selected = Number(selectedMemberId) === Number(member.playerId);

    return `
      <tr class="clickable${selected ? ' selected' : ''}" data-member-id="${member.playerId}">
        ${columns.map(key => renderFactionCell(member, key)).join('')}
      </tr>
      ${selected ? renderDetailRow(member) : ''}
    `;
  }).join('');
}

function renderSummary() {
  const element = document.querySelector('#intelSummary');
  if (!element) return;

  const summary = overview?.summary;
  if (!summary) {
    element.innerHTML = '';
    return;
  }

  const current = (overview.members || []).filter(member => member.current !== false);

  if (activePreset === 'activity') {
    const inactive = current.filter(member =>
      (member.insights || []).some(item => item.code === 'inactive')
    ).length;
    const improving = current.filter(member =>
      (member.insights || []).some(item => item.code === 'activity_up')
    ).length;
    const declining = current.filter(member =>
      (member.insights || []).some(item => item.code === 'activity_down')
    ).length;

    element.innerHTML = [
      metric('Members', formatNumber(summary.currentMembers), 'current roster'),
      metric('Activity / day', formatDuration(summary.avgActivityPerDay30d), '30d roster average'),
      metric('Xanax / day', formatDecimal(summary.avgXanaxPerDay30d, 2), '30d roster average'),
      metric('Inactive 48h+', formatNumber(inactive), 'members'),
      metric('Activity improving', formatNumber(improving), 'members'),
      metric('Activity declining', formatNumber(declining), 'members')
    ].join('');
    return;
  }

  if (activePreset === 'training') {
    const growth = current.filter(member =>
      (member.insights || []).some(item => item.code === 'battle_stats_growth')
    ).length;
    const unavailable = current.filter(member =>
      (member.insights || []).some(item => ['missing_battle_stats','stale_battle_stats'].includes(item.code))
    ).length;

    element.innerHTML = [
      metric('Members', formatNumber(summary.currentMembers), 'current roster'),
      metric('Median stats', formatCompact(summary.medianBattleStats), `${formatNumber(summary.knownBattleStats)} estimates known`),
      metric('Stats growing', formatNumber(growth), 'members'),
      metric('Xanax / day', formatDecimal(summary.avgXanaxPerDay30d, 2), '30d roster average'),
      metric('Stats unavailable', formatNumber(unavailable), 'missing or stale'),
      metric('Attention', formatNumber(summary.membersNeedingAttention), 'actionable signals')
    ].join('');
    return;
  }

  if (activePreset === 'war') {
    const rows = current.map(member => performanceMember(member)).filter(Boolean);
    const totalHits = rows.reduce((sum,row) => sum + Number(row.warHits || 0), 0);
    const totalAssists = rows.reduce((sum,row) => sum + Number(row.assists || 0), 0);
    const totalNet = rows.reduce((sum,row) => sum + Number(row.netScore || 0), 0);
    const participation = averageNullable(rows.map(row => row.participation));

    element.innerHTML = [
      metric('Wars', factionPerformance.loading ? '…' : formatNumber(factionPerformance.totalWars), 'selected range'),
      metric('Participation', factionPerformance.loading ? '…' : formatPercent(participation), 'roster average'),
      metric('War hits', factionPerformance.loading ? '…' : formatNumber(totalHits), 'all members'),
      metric('Hits per war', factionPerformance.loading || !factionPerformance.totalWars ? '—' : formatDecimal(totalHits / factionPerformance.totalWars, 1), 'faction average'),
      metric('Assists', factionPerformance.loading ? '…' : formatNumber(totalAssists), 'selected range'),
      metric('Net score', factionPerformance.loading ? '…' : formatSigned(totalNet, 2), 'score gained − lost')
    ].join('');
    return;
  }

  if (activePreset === 'all') {
    const rows = current.map(member => performanceMember(member)).filter(Boolean);
    const participation = averageNullable(rows.map(row => row.participation));

    element.innerHTML = [
      metric('Members', formatNumber(summary.currentMembers), 'current roster'),
      metric('Median stats', formatCompact(summary.medianBattleStats), `${formatNumber(summary.knownBattleStats)} estimates known`),
      metric('Activity / day', formatDuration(summary.avgActivityPerDay30d), '30d average'),
      metric('Xanax / day', formatDecimal(summary.avgXanaxPerDay30d, 2), '30d average'),
      metric('War participation', factionPerformance.loading ? '…' : formatPercent(participation), 'selected range'),
      metric('Attention', formatNumber(summary.membersNeedingAttention), 'actionable signals')
    ].join('');
    return;
  }

  element.innerHTML = [
    metric('Members', formatNumber(summary.currentMembers), 'current roster'),
    metric('Median stats', formatCompact(summary.medianBattleStats), `${formatNumber(summary.knownBattleStats)} estimates known`),
    metric('Activity / day', formatDuration(summary.avgActivityPerDay30d), '30d roster average'),
    metric('Xanax / day', formatDecimal(summary.avgXanaxPerDay30d, 2), '30d roster average'),
    metric('War participation', formatPercent(summary.avgParticipationLast4), 'last 4 imported wars'),
    metric('Attention', formatNumber(summary.membersNeedingAttention), 'actionable signals')
  ].join('');
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

  const groupRow = (presetGroups[activePreset] || []).map(([key,label,count]) => `
    <th class="faction-group group-${key}" colspan="${count}">${escapeHtml(label)}</th>
  `).join('');

  const columnRow = activeColumns().map(key => {
    const [label, detail] = columnLabels[key] || [key,''];
    const active = key === sortKey;
    return `
      <th class="col-${key}${active ? ' sorted' : ''}">
        <button type="button" data-intel2-sort="${key}">
          ${escapeHtml(label)}${detail ? ` <small>${escapeHtml(detail)}</small>` : ''}${active ? ` ${sortDirection === 'desc' ? '↓' : '↑'}` : ''}
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
    return `<td class="col-member"><span class="member-name">${escapeHtml(member.playerName || 'Unknown')}</span><span class="member-meta">${escapeHtml(member.position || 'Member')} · Lv ${escapeHtml(member.level ?? '—')} · [${escapeHtml(member.playerId)}]${member.current ? '' : ' · former'}</span></td>`;
  }

  if (key === 'lastAction') {
    return `<td class="col-lastAction">${escapeHtml(formatRelative(member.presence?.lastActionAt))}${member.presence?.lastActionStatus ? `<span class="member-meta">${escapeHtml(member.presence.lastActionStatus)}</span>` : ''}</td>`;
  }

  if (key === 'stats') {
    return `<td class="col-stats">${member.battleStats?.value == null ? '—' : escapeHtml(formatCompact(member.battleStats.value))}<span class="trend ${trendClass(member.battleStats?.changePct30d)}">${battleStatsTrend(member)}</span></td>`;
  }

  if (key === 'activity') {
    return `<td class="col-activity">${escapeHtml(formatDuration(member.activity?.perDay30d))}<span class="trend ${trendClass(member.activity?.changePct)}">${escapeHtml(trendLabel(member.activity?.changePct, 'vs prev 30d'))}</span></td>`;
  }

  if (key === 'xanax') {
    return `<td class="col-xanax">${escapeHtml(formatDecimal(member.xanax?.perDay30d, 2))}<span class="trend ${trendClass(member.xanax?.changePct)}">${escapeHtml(trendLabel(member.xanax?.changePct, 'vs prev 30d'))}</span></td>`;
  }

  if (key === 'participation4') {
    return `<td class="col-participation4">${escapeHtml(formatPercent(member.war?.last4?.participation))}<span class="member-meta">${formatNumber(member.war?.last4?.warsParticipated)}/${formatNumber(member.war?.last4?.warsAvailable)} wars</span></td>`;
  }

  if (key === 'hits4') {
    return `<td class="col-hits4">${escapeHtml(formatDecimal(member.war?.last4?.hitsPerWar, 1))}</td>`;
  }

  if (key === 'attention') {
    return `<td class="col-attention">${signal ? `<span class="signal ${signal.kind}">${escapeHtml(signalLabel(signal, member))}</span>` : '—'}</td>`;
  }

  if (!performance) {
    return `<td class="col-${key}">${factionPerformance.loading ? '…' : '—'}</td>`;
  }

  if (key === 'wars') {
    return `<td class="col-wars"><strong>${formatNumber(performance.wars)}</strong><span class="member-meta">of ${formatNumber(factionPerformance.totalWars)}</span></td>`;
  }

  if (key === 'participation') {
    return `<td class="col-participation">${formatPercent(performance.participation)}</td>`;
  }

  if (key === 'hits') {
    return `<td class="col-hits"><strong>${formatDecimal(performance.avgHitsPerWar, 1)}</strong><span class="member-meta">${formatNumber(performance.warHits)} total</span></td>`;
  }

  if (key === 'assists') {
    const perWar = Number(performance.wars) > 0 ? Number(performance.assists || 0) / Number(performance.wars) : null;
    return `<td class="col-assists"><strong>${formatNumber(performance.assists)}</strong><span class="member-meta">${formatDecimal(perWar, 1)} / war</span></td>`;
  }

  if (key === 'outsideHits') return `<td class="col-outsideHits">${formatNumber(performance.outsideHits)}</td>`;
  if (key === 'respectEarned') return `<td class="col-respectEarned">${formatDecimal(performance.respectEarned, 2)}</td>`;
  if (key === 'respectLost') return `<td class="col-respectLost">${formatDecimal(performance.respectLost, 2)}</td>`;
  if (key === 'scoreUp') return `<td class="col-scoreUp">${formatDecimal(performance.scoreUp, 2)}</td>`;
  if (key === 'scoreDown') return `<td class="col-scoreDown">${formatDecimal(performance.scoreDown, 2)}</td>`;

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
  if (activeFilter === 'attention') return member.current !== false && insights.some(item => item.kind === 'attention');
  if (activeFilter === 'inactive') return member.current !== false && codes.has('inactive');
  if (activeFilter === 'war') {
    if (needsPerformance() && factionPerformance.loadedKey) {
      const performance = performanceMember(member);
      return member.current !== false && Number(performance?.participation ?? 1) < 0.5;
    }
    return member.current !== false && (codes.has('low_war_participation') || codes.has('participation_down'));
  }
  if (activeFilter === 'decline') return member.current !== false && (codes.has('activity_down') || codes.has('xanax_down') || codes.has('participation_down'));
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
  if (key === 'lastAction') return nullable(member.presence?.lastActionAt);
  if (key === 'stats') return nullable(member.battleStats?.value);
  if (key === 'activity') return nullable(member.activity?.perDay30d);
  if (key === 'xanax') return nullable(member.xanax?.perDay30d);
  if (key === 'participation4') return nullable(member.war?.last4?.participation);
  if (key === 'hits4') return nullable(member.war?.last4?.hitsPerWar);
  if (key === 'wars') return nullable(performance?.wars);
  if (key === 'participation') return nullable(performance?.participation);
  if (key === 'hits') return nullable(performance?.avgHitsPerWar);
  if (key === 'assists') return nullable(performance?.assists);
  if (key === 'outsideHits') return nullable(performance?.outsideHits);
  if (key === 'respectEarned') return nullable(performance?.respectEarned);
  if (key === 'respectLost') return nullable(performance?.respectLost);
  if (key === 'scoreUp') return nullable(performance?.scoreUp);
  if (key === 'scoreDown') return nullable(performance?.scoreDown);
  if (key === 'netScore') return nullable(performance?.netScore);
  if (key === 'attention') {
    const signal = topSignal(member);
    return signal ? priority.length - priorityIndex(signal.code) : 0;
  }
  return 0;
}

function activeColumns() {
  return presetColumns[activePreset] || presetColumns.overview;
}

function needsPerformance() {
  return activePreset === 'war' || activePreset === 'all';
}

function performanceMember(member) {
  return factionPerformance.members.get(Number(member?.playerId)) || null;
}

function performanceKey() {
  const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
  const period = periodPayload();
  return `${factionId}:${period.from || ''}:${period.to || ''}`;
}

function ensureSortKey() {
  const columns = activeColumns();
  if (columns.includes(sortKey)) return;

  if (activePreset === 'war') sortKey = 'netScore';
  else if (activePreset === 'activity') sortKey = 'activity';
  else if (activePreset === 'training') sortKey = 'stats';
  else sortKey = 'attention';

  sortDirection = sortKey === 'member' ? 'asc' : 'desc';
}

function restoreFactionPreset() {
  try {
    const stored = localStorage.getItem('rwengine.factionPreset');
    if (presetColumns[stored]) return stored;
  } catch (_) {}
  return 'overview';
}

function periodLabel() {
  const labels = {
    last4:'Last 4 wars',
    '30d':'30 days',
    year:'This year',
    all:'All imported wars'
  };
  return labels[state.period?.preset] || 'Selected range';
}

function averageNullable(values) {
  const valid = values.map(nullable).filter(value => value !== null);
  if (!valid.length) return null;
  return valid.reduce((sum,value) => sum + value, 0) / valid.length;
}

function topSignal(member) {
  const insights = Array.isArray(member.insights) ? member.insights : [];
  if (!insights.length) return null;
  return [...insights].sort((a,b) => priorityIndex(a.code) - priorityIndex(b.code))[0];
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
    return `<tr class="intel2-detail-row"><td colspan="${activeColumns().length}"><section class="intel2-detail"><p class="status-line">Loading member history…</p></section></td></tr>`;
  }

  if (payload?.error) {
    return `<tr class="intel2-detail-row"><td colspan="${activeColumns().length}"><section class="intel2-detail"><p class="status-line error">${escapeHtml(payload.error)}</p></section></td></tr>`;
  }

  if (!payload?.member) {
    return `<tr class="intel2-detail-row"><td colspan="${activeColumns().length}"><section class="intel2-detail"><p class="status-line">Loading member history…</p></section></td></tr>`;
  }

  const detailMember = payload.member;
  const history = normalizeHistory(payload.history);
  const insights = renderInsights(detailMember);

  return `
    <tr class="intel2-detail-row">
      <td colspan="${activeColumns().length}">
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
  selectedMemberId = null;
  detailCache.clear();
  detailLoading.clear();
  syncJob = null;
  activeFilter = 'all';
  trendDays = 90;

  factionPerformance.members.clear();
  factionPerformance.totalWars = 0;
  factionPerformance.playersWithAttackDetails = 0;
  factionPerformance.loadedKey = '';
  factionPerformance.loading = false;
  factionPerformance.error = '';

  const search = document.querySelector('#intelSearch');
  if (search) search.value = '';

  renderFilters();
  renderPresetControls();
  renderSync();
}
