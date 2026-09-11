import {
  state, on, emit, intelV2Api, syncApi,
  metric, formatNumber, formatCompact, formatDecimal, formatPercent,
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
let sortKey = 'attention';
let sortDirection = 'desc';
let trendDays = 90;
let loading = false;
let syncJob = null;
let syncing = false;

const detailCache = new Map();
const detailLoading = new Set();

export function initIntelV2() {
  renderFilters();

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
    if (route === 'intel') {
      loadIntelV2(false);
    }
  });

  on('faction', () => {
    resetIntelState();
    if (state.route === 'intel') loadIntelV2(true);
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
    return;
  }

  loading = true;
  setIntelStatus('Loading Intel…');

  try {
    overview = await intelV2Api('overview');
    loadedFactionId = factionId;
    setIntelStatus('');
    renderIntelV2();
    renderIntelFreshness();
    await refreshSyncStatus();
  } catch (error) {
    overview = null;
    setIntelStatus(error.message || 'Failed to load Intel 2.0.', true);
    renderIntelV2();
  } finally {
    loading = false;
  }
}

function renderFilters() {
  const container = document.querySelector('#intelFilters');
  if (!container) return;
  container.innerHTML = filters.map(([key,label]) =>
    `<button class="intel2-filter${key === activeFilter ? ' active' : ''}" type="button" data-intel-filter="${key}">${label}</button>`
  ).join('');
}

function renderIntelV2() {
  renderSummary();
  renderHeaders();

  const body = document.querySelector('#intelBody');
  if (!body) return;

  if (loading && !overview) {
    body.innerHTML = '<tr class="empty-row"><td colspan="8">Loading Intel…</td></tr>';
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
    body.innerHTML = '<tr class="empty-row"><td colspan="8">No members match this view.</td></tr>';
    return;
  }

  body.innerHTML = rows.map(member => {
    const signal = topSignal(member);
    const selected = Number(selectedMemberId) === Number(member.playerId);

    return `
      <tr class="clickable${selected ? ' selected' : ''}" data-member-id="${member.playerId}">
        <td>
          <span class="member-name">${escapeHtml(member.playerName || 'Unknown')}</span>
          <span class="member-meta">${escapeHtml(member.position || 'Member')} · Lv ${escapeHtml(member.level ?? '—')} · [${escapeHtml(member.playerId)}]${member.current ? '' : ' · former'}</span>
        </td>
        <td>
          ${escapeHtml(formatRelative(member.presence?.lastActionAt))}
          ${member.presence?.lastActionStatus ? `<span class="member-meta">${escapeHtml(member.presence.lastActionStatus)}</span>` : ''}
        </td>
        <td>
          ${member.battleStats?.value == null ? '—' : escapeHtml(formatCompact(member.battleStats.value))}
          <span class="trend ${trendClass(member.battleStats?.changePct30d)}">${battleStatsTrend(member)}</span>
        </td>
        <td>
          ${escapeHtml(formatDuration(member.activity?.perDay30d))}
          <span class="trend ${trendClass(member.activity?.changePct)}">${escapeHtml(trendLabel(member.activity?.changePct, 'vs prev 30d'))}</span>
        </td>
        <td>
          ${escapeHtml(formatDecimal(member.xanax?.perDay30d, 2))}
          <span class="trend ${trendClass(member.xanax?.changePct)}">${escapeHtml(trendLabel(member.xanax?.changePct, 'vs prev 30d'))}</span>
        </td>
        <td>
          ${escapeHtml(formatPercent(member.war?.last4?.participation))}
          <span class="member-meta">${formatNumber(member.war?.last4?.warsParticipated)}/${formatNumber(member.war?.last4?.warsAvailable)} wars</span>
        </td>
        <td>${escapeHtml(formatDecimal(member.war?.last4?.hitsPerWar, 1))}</td>
        <td>${signal ? `<span class="signal ${signal.kind}">${escapeHtml(signalLabel(signal, member))}</span>` : '—'}</td>
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

  element.innerHTML = [
    metric('Members', formatNumber(summary.currentMembers)),
    metric('Median stats', formatCompact(summary.medianBattleStats), `${formatNumber(summary.knownBattleStats)} known`),
    metric('Activity / day', formatDuration(summary.avgActivityPerDay30d), '30d average'),
    metric('Xanax / day', formatDecimal(summary.avgXanaxPerDay30d, 2), '30d average'),
    metric('RW participation', formatPercent(summary.avgParticipationLast4), 'last 4 wars'),
    metric('Attention', formatNumber(summary.membersNeedingAttention), 'members')
  ].join('');
}

function renderIntelFreshness() {
  const element = document.querySelector('#intelFreshness');
  if (!element) return;

  const freshness = overview?.freshness;
  if (!freshness?.observedAt) {
    element.textContent = 'No synced Intel data';
    element.classList.remove('stale');
    return;
  }

  element.textContent = freshness.state === 'stale'
    ? `Stale · last snapshot ${formatRelative(freshness.observedAt)}`
    : `Updated ${formatRelative(freshness.observedAt)}`;
  element.classList.toggle('stale', freshness.state === 'stale');
}

function renderHeaders() {
  document.querySelectorAll('[data-intel2-sort]').forEach(header => {
    if (!header.dataset.label) header.dataset.label = header.innerHTML;
    const active = header.dataset.intel2Sort === sortKey;
    header.classList.toggle('sorted', active);
    header.innerHTML = active
      ? `${header.dataset.label} ${sortDirection === 'desc' ? '↓' : '↑'}`
      : header.dataset.label;
  });
}

function matchesFilter(member) {
  const insights = Array.isArray(member.insights) ? member.insights : [];
  const codes = new Set(insights.map(item => item.code));

  if (activeFilter === 'all') return member.current !== false;
  if (activeFilter === 'attention') return member.current !== false && insights.some(item => item.kind === 'attention');
  if (activeFilter === 'inactive') return member.current !== false && codes.has('inactive');
  if (activeFilter === 'war') return member.current !== false && (codes.has('low_war_participation') || codes.has('participation_down'));
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
  if (key === 'member') return member.playerName || '';
  if (key === 'lastAction') return nullable(member.presence?.lastActionAt);
  if (key === 'stats') return nullable(member.battleStats?.value);
  if (key === 'activity') return nullable(member.activity?.perDay30d);
  if (key === 'xanax') return nullable(member.xanax?.perDay30d);
  if (key === 'participation') return nullable(member.war?.last4?.participation);
  if (key === 'hits') return nullable(member.war?.last4?.hitsPerWar);
  if (key === 'attention') {
    const signal = topSignal(member);
    return signal ? priority.length - priorityIndex(signal.code) : 0;
  }
  return 0;
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
    return '<tr class="intel2-detail-row"><td colspan="8"><section class="intel2-detail"><p class="status-line">Loading member history…</p></section></td></tr>';
  }

  if (payload?.error) {
    return `<tr class="intel2-detail-row"><td colspan="8"><section class="intel2-detail"><p class="status-line error">${escapeHtml(payload.error)}</p></section></td></tr>`;
  }

  if (!payload?.member) {
    return '<tr class="intel2-detail-row"><td colspan="8"><section class="intel2-detail"><p class="status-line">Loading member history…</p></section></td></tr>';
  }

  const detailMember = payload.member;
  const history = normalizeHistory(payload.history);

  return `
    <tr class="intel2-detail-row">
      <td colspan="8">
        <section class="intel2-detail">
          <header class="intel2-detail-head">
            <div>
              <h2>${escapeHtml(detailMember.playerName || member.playerName)}</h2>
              <p>${escapeHtml(detailMember.position || 'Member')} · Lv ${escapeHtml(detailMember.level ?? '—')} · ${detailMember.current ? `${formatNumber(detailMember.daysInFaction)} days in faction` : 'former member'}</p>
            </div>
            <a href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(detailMember.playerId)}" target="_blank" rel="noopener noreferrer">Torn profile ↗</a>
          </header>

          <div class="detail-metrics">
            ${metric('Battle stats', detailMember.battleStats?.value == null ? '—' : formatCompact(detailMember.battleStats.value), detailMember.battleStats?.source || 'Unavailable')}
            ${metric('Activity / day', formatDuration(detailMember.activity?.perDay30d), '30d')}
            ${metric('Xanax / day', formatDecimal(detailMember.xanax?.perDay30d, 2), '30d')}
            ${metric('RW participation', formatPercent(detailMember.war?.last4?.participation), 'last 4')}
            ${metric('Hits / war', formatDecimal(detailMember.war?.last4?.hitsPerWar, 1), 'last 4')}
            ${metric('Net score', formatSignedLocal(detailMember.war?.last4?.netScore), 'last 4')}
          </div>

          <div class="intel2-insights">
            ${renderInsights(detailMember)}
          </div>

          <div class="intel2-trend-toolbar">
            <span>Trend window</span>
            <div>
              ${[30,60,90].map(days => `<button type="button" data-trend-days="${days}" class="${trendDays === days ? 'active' : ''}">${days}d</button>`).join('')}
            </div>
          </div>

          <div class="intel2-trends">
            ${trendBlock('Battle stats', history.stats, value => value == null ? '—' : formatCompact(value))}
            ${trendBlock('Activity / day', history.activity, formatDuration)}
            ${trendBlock('Xanax / day', history.xanax, value => formatDecimal(value, 2))}
          </div>

          <div class="intel2-wars">
            <header>Recent wars · ${history.wars.length} available</header>
            ${renderWarHistory(history.wars)}
          </div>

          <footer class="intel2-coverage">
            <span>Coverage</span>
            <b>${formatDecimal(detailMember.coverage?.snapshotDays60d, 0)} snapshot days</b>
            <b>${formatNumber(detailMember.coverage?.warHistoryAvailable)} wars available</b>
            <b>${detailMember.coverage?.battleStatsKnown ? 'battle stats known' : 'battle stats unavailable'}</b>
          </footer>
        </section>
      </td>
    </tr>
  `;
}

function renderInsights(member) {
  const insights = Array.isArray(member.insights) ? member.insights : [];
  if (!insights.length) {
    return '<div class="intel2-insight note"><b>No signals</b><span>No current attention signals for this member.</span></div>';
  }

  return insights.map(item => `
    <div class="intel2-insight ${escapeHtml(item.kind || 'note')}">
      <b>${escapeHtml(signalLabel(item, member))}</b>
      <span>${escapeHtml(item.text || '')}</span>
    </div>
  `).join('');
}

function normalizeHistory(history = {}) {
  const snapshots = Array.isArray(history.snapshots) ? history.snapshots : [];

  return {
    stats:snapshots
      .filter(point => Number.isFinite(Number(point.battleStatsValue)))
      .map(point => ({ at:Number(point.at), value:Number(point.battleStatsValue) })),
    activity:deriveRateSeries(snapshots, 'activityTotalSeconds'),
    xanax:deriveRateSeries(snapshots, 'xanaxTakenTotal'),
    wars:Array.isArray(history.wars) ? history.wars : []
  };
}

function deriveRateSeries(snapshots, key) {
  const rows = snapshots
    .filter(point => Number.isFinite(Number(point.at)) && Number.isFinite(Number(point[key])))
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

  return `
    <section class="intel2-trend">
      <header><strong>${escapeHtml(title)}</strong><span>${escapeHtml(windowLabel)} · ${escapeHtml(latestLabel)}</span></header>
      ${sparkline(filtered)}
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

    await loadIntelV2(true);
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

  const search = document.querySelector('#intelSearch');
  if (search) search.value = '';

  renderFilters();
  renderSync();
}
