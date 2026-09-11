import {
  state, on, emit, rangeApi, syncApi,
  metric, median, average,
  formatNumber, formatCompact, formatDecimal, formatPercent,
  formatDuration, formatRelative, formatDate, formatDateTime,
  escapeHtml, sleep
} from './core.js';

const sort = { key: 'stats', direction: 'desc' };
let selectedMemberId = null;
const detailCache = new Map();
const detailLoading = new Set();
let syncJob = null;
let syncing = false;

export function initIntel() {
  document.querySelector('#intelSearch')?.addEventListener('input', renderIntel);

  document.querySelector('.intel-table thead')?.addEventListener('click', event => {
    const header = event.target.closest('[data-intel-sort]');
    if (!header) return;
    const key = header.dataset.intelSort;
    if (sort.key === key) sort.direction = sort.direction === 'desc' ? 'asc' : 'desc';
    else {
      sort.key = key;
      sort.direction = key === 'lastAction' ? 'asc' : 'desc';
    }
    renderIntel();
  });

  document.querySelector('#intelBody')?.addEventListener('click', event => {
    if (event.target.closest('a')) return;
    const row = event.target.closest('tr[data-member-id]');
    if (!row) return;
    const playerId = Number(row.dataset.memberId);
    if (!playerId) return;
    toggleMember(playerId);
  });

  document.querySelector('#syncButton')?.addEventListener('click', runSync);

  on('period', () => {
    selectedMemberId = null;
    detailCache.clear();
    detailLoading.clear();
  });

  on('faction', () => {
    selectedMemberId = null;
    detailCache.clear();
    detailLoading.clear();
    syncJob = null;
    renderSync();
  });

  on('open-member', playerId => {
    const search = document.querySelector('#intelSearch');
    if (search) search.value = '';
    openMember(Number(playerId));
  });
}

export function renderIntel() {
  const members = Array.isArray(state.range?.members) ? state.range.members : [];
  renderSummary(members);
  renderHeaders();

  const query = String(document.querySelector('#intelSearch')?.value || '').trim().toLowerCase();
  const rows = members
    .filter(member => !query ||
      String(member.playerName || '').toLowerCase().includes(query) ||
      String(member.playerId || '').includes(query))
    .sort(compareMembers);

  const body = document.querySelector('#intelBody');
  if (!body) return;

  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="7">No members match this view.</td></tr>';
    return;
  }

  body.innerHTML = rows.map(member => {
    const selected = Number(selectedMemberId) === Number(member.playerId);
    return `
      <tr class="clickable${selected ? ' selected' : ''}" data-member-id="${member.playerId}">
        <td>
          <span class="member-name">${escapeHtml(member.playerName || 'Unknown')}</span>
          <span class="member-meta">${escapeHtml(member.position || 'Member')} · Lv ${escapeHtml(member.level ?? '—')} · [${escapeHtml(member.playerId)}]</span>
        </td>
        <td title="${escapeHtml(formatDateTime(member.lastActionAt))}">
          ${escapeHtml(formatRelative(member.lastActionAt))}
          ${member.lastActionStatus ? `<span class="member-meta">${escapeHtml(member.lastActionStatus)}</span>` : ''}
        </td>
        <td>
          ${member.battleStatsValue == null ? '—' : escapeHtml(formatCompact(member.battleStatsValue))}
          ${member.battleStatsSource ? `<span class="stat-source${member.battleStatsVerified ? ' verified' : ''}">${escapeHtml(member.battleStatsVerified ? 'verified' : member.battleStatsSource)}</span>` : ''}
        </td>
        <td>${escapeHtml(formatDuration(member.activityPerDaySeconds))}</td>
        <td>${escapeHtml(formatDecimal(member.xanaxPerDay, 2))}</td>
        <td>${escapeHtml(formatPercent(member.participation))}</td>
        <td>${escapeHtml(formatDecimal(member.avgHitsPerWar, 1))}</td>
      </tr>
      ${selected ? renderDetailRow(member) : ''}
    `;
  }).join('');
}

export async function refreshSyncStatus() {
  try {
    const result = await syncApi('getSyncStatus');
    syncJob = result.job || null;
  } catch (_) {
    syncJob = null;
  }
  renderSync();
}

function renderSummary(members) {
  const current = members.filter(member => member.current !== false);
  const stats = current.map(member => Number(member.battleStatsValue)).filter(value => Number.isFinite(value) && value > 0);
  const activity = current.map(member => Number(member.activityPerDaySeconds)).filter(Number.isFinite);
  const xanax = current.map(member => Number(member.xanaxPerDay)).filter(Number.isFinite);
  const participation = current.map(member => Number(member.participation)).filter(Number.isFinite);

  const el = document.querySelector('#intelSummary');
  if (!el) return;

  el.innerHTML = [
    metric('Members', formatNumber(current.length)),
    metric('Median stats', median(stats) == null ? '—' : formatCompact(median(stats)), stats.length ? `${stats.length} known` : 'No estimates'),
    metric('Activity / day', average(activity) == null ? '—' : formatDuration(average(activity)), 'Average'),
    metric('Xanax / day', average(xanax) == null ? '—' : formatDecimal(average(xanax), 2), 'Average'),
    metric('RW participation', average(participation) == null ? '—' : formatPercent(average(participation)), 'Average')
  ].join('');
}

function renderHeaders() {
  document.querySelectorAll('.intel-table th[data-intel-sort]').forEach(header => {
    if (!header.dataset.label) header.dataset.label = header.textContent.trim();
    const active = header.dataset.intelSort === sort.key;
    header.classList.toggle('sorted', active);
    header.textContent = active
      ? `${header.dataset.label} ${sort.direction === 'desc' ? '↓' : '↑'}`
      : header.dataset.label;
  });
}

function compareMembers(a, b) {
  const direction = sort.direction === 'asc' ? 1 : -1;
  const values = {
    lastAction: member => Number(member.lastActionAt || 0),
    stats: member => nullable(member.battleStatsValue),
    activity: member => nullable(member.activityPerDaySeconds),
    xanax: member => nullable(member.xanaxPerDay),
    participation: member => nullable(member.participation),
    hits: member => nullable(member.avgHitsPerWar)
  };
  const getter = values[sort.key] || values.stats;
  const av = getter(a);
  const bv = getter(b);
  if (av === null && bv === null) return String(a.playerName).localeCompare(String(b.playerName));
  if (av === null) return 1;
  if (bv === null) return -1;
  return ((av - bv) * direction) || String(a.playerName).localeCompare(String(b.playerName));
}

function nullable(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function toggleMember(playerId) {
  if (Number(selectedMemberId) === playerId) {
    selectedMemberId = null;
    renderIntel();
    return;
  }
  await openMember(playerId);
}

async function openMember(playerId) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) return;
  selectedMemberId = playerId;
  renderIntel();

  const key = detailKey(playerId);
  if (detailCache.has(key) || detailLoading.has(key)) return;

  detailLoading.add(key);
  renderIntel();
  try {
    const result = await rangeApi('getMemberDetail', {
      playerId,
      ...(state.period.from ? { from: state.period.from } : {}),
      ...(state.period.to ? { to: state.period.to } : {})
    });
    detailCache.set(key, result);
  } catch (error) {
    detailCache.set(key, { error: error.message || 'Failed to load member detail.' });
  } finally {
    detailLoading.delete(key);
    if (Number(selectedMemberId) === playerId) renderIntel();
  }
}

function detailKey(playerId) {
  return `${state.selectedFactionId || state.user?.factionId || 0}:${playerId}:${state.period.from || ''}:${state.period.to || ''}`;
}

function renderDetailRow(member) {
  const key = detailKey(member.playerId);
  const detail = detailCache.get(key);
  const loading = detailLoading.has(key);

  let content = '<p class="status-line">Loading member detail…</p>';
  if (detail?.error) {
    content = `<p class="status-line error">${escapeHtml(detail.error)}</p>`;
  } else if (detail?.member) {
    content = renderDetail(detail);
  } else if (!loading) {
    content = '<p class="status-line">Loading member detail…</p>';
  }

  return `
    <tr class="member-detail-row">
      <td colspan="7">
        <section class="member-detail">
          <header class="member-detail-head">
            <div>
              <h3>${escapeHtml(member.playerName || `Player ${member.playerId}`)}</h3>
              <p>${escapeHtml(member.position || 'Member')} · Lv ${escapeHtml(member.level ?? '—')} · [${escapeHtml(member.playerId)}]</p>
            </div>
            <a href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(member.playerId)}" target="_blank" rel="noopener noreferrer">Torn profile ↗</a>
          </header>
          ${content}
        </section>
      </td>
    </tr>
  `;
}

function renderDetail(detail) {
  const member = detail.member || {};
  const wars = Array.isArray(detail.wars) ? detail.wars : [];

  return `
    <div class="detail-metrics">
      ${metric('Stats', member.battleStatsValue == null ? '—' : formatCompact(member.battleStatsValue), member.battleStatsVerified ? 'Verified' : (member.battleStatsSource || 'Estimate'))}
      ${metric('Activity / day', formatDuration(member.activityPerDaySeconds), member.coverageDays ? `${formatDecimal(member.coverageDays, 1)}d coverage` : '')}
      ${metric('Xanax / day', formatDecimal(member.xanaxPerDay, 2), member.xanaxTaken == null ? '' : `${formatNumber(member.xanaxTaken)} in period`)}
      ${metric('Wars', formatNumber(member.wars), formatPercent(member.participation))}
      ${metric('Hits / war', formatDecimal(member.avgHitsPerWar, 1), `${formatNumber(member.warHits)} hits`)}
      ${metric('Net score', formatDecimal(member.netScore, 2), member.avgScorePerHit == null ? '' : `${formatDecimal(member.avgScorePerHit, 2)} score / hit`)}
    </div>
    <div class="detail-war-list">
      <header>War history</header>
      ${wars.length ? wars.slice(0, 12).map(war => `
        <div class="line-row">
          <div>
            <strong>${escapeHtml(war.opponentFactionName || 'Unknown opponent')}</strong>
            <small>${escapeHtml(formatDate(war.endTimestamp || war.startTimestamp))} · #${escapeHtml(war.warId)}</small>
          </div>
          <b>${escapeHtml(formatNumber(war.hits))} hits · ${escapeHtml(formatDecimal(Number(war.scoreUp || 0) - Number(war.scoreDown || 0), 2))}</b>
        </div>
      `).join('') : '<div class="line-row"><small>No war history in this period.</small></div>'}
    </div>
  `;
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
      const result = await syncApi('syncStep', { jobId: syncJob.jobId });
      syncJob = result.job || syncJob;
      renderSync();
      if (syncJob.status === 'failed') throw new Error(syncJob.error || 'Faction sync failed.');
      if (!['completed','failed'].includes(syncJob.status)) await sleep(result.busy ? 1200 : 300);
      safety += 1;
    }

    if (safety >= 500) throw new Error('Faction sync exceeded the safety limit.');
    emit('request-refresh', { source: 'sync' });
  } catch (error) {
    syncJob = { status: 'failed', error: error.message || 'Faction sync failed.' };
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
  const el = document.querySelector('#syncLine');
  if (!el) return;

  if (!syncJob || syncJob.status === 'completed') {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }

  el.classList.remove('hidden');
  el.classList.toggle('error', syncJob.status === 'failed');

  if (syncJob.status === 'failed') {
    el.textContent = syncJob.error || 'Faction sync failed.';
    return;
  }

  const done = Number(syncJob.completed_tasks || syncJob.completedTasks || 0);
  const total = Number(syncJob.total_tasks || syncJob.totalTasks || 0);
  const stage = syncJob.current_stage || syncJob.currentStage || syncJob.status || 'syncing';
  el.textContent = total > 0
    ? `Syncing faction · ${stage} · ${done}/${total}`
    : `Syncing faction · ${stage}`;
}
