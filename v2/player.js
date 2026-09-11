import {
  state, on, routeTo, playerAnalysisApi, playerReportsApi, shareApi,
  metric, formatNumber, formatCompact, formatDecimal, formatPercent,
  formatDuration, formatRelative, formatDate, formatDateTime, escapeHtml
} from './core.js';
import { playerAnalysisFixture } from './fixtures/player-analysis.js';

const fixtureMode = new URL(location.href).searchParams.get('playerFixture') === '1';

let searchResults = [];
let analysis = null;
let savedReports = [];
let activeSnapshot = null;
let activeShareUrl = '';
let loading = false;

export function initPlayerAnalysis() {
  document.querySelector('#playerSearchForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const query = String(document.querySelector('#playerSearchInput')?.value || '').trim();
    if (!query) return;
    await runSearch(query);
  });

  document.querySelector('#playerSearchResults')?.addEventListener('click', async event => {
    const row = event.target.closest('[data-player-result]');
    if (!row) return;
    const playerId = Number(row.dataset.playerResult || 0);
    if (playerId) await analyze(playerId);
  });

  document.addEventListener('click', async event => {
    const analyzeButton = event.target.closest('[data-analyze-player]');
    if (analyzeButton) {
      const playerId = Number(analyzeButton.dataset.analyzePlayer || 0);
      if (!playerId) return;
      routeTo('player');
      await analyze(playerId);
      return;
    }

    const saveButton = event.target.closest('[data-save-player-report]');
    if (saveButton) {
      await saveCurrentReport();
      return;
    }

    const openButton = event.target.closest('[data-saved-player-report]');
    if (openButton) {
      await openSavedReport(Number(openButton.dataset.savedPlayerReport || 0));
      return;
    }

    const deleteButton = event.target.closest('[data-delete-player-report]');
    if (deleteButton) {
      await deleteSavedReport(Number(deleteButton.dataset.deletePlayerReport || 0));
      return;
    }

    const newLinkButton = event.target.closest('[data-player-report-link]');
    if (newLinkButton) {
      await rotatePublicLink();
      return;
    }

    const copyButton = event.target.closest('[data-copy-player-link]');
    if (copyButton) {
      await copyPublicLink();
    }
  });

  document.addEventListener('change', async event => {
    const select = event.target.closest('[data-player-report-visibility]');
    if (!select) return;
    await changeSnapshotVisibility(select.value);
  });

  on('faction', () => {
    searchResults = [];
    analysis = null;
    savedReports = [];
    activeSnapshot = null;
    activeShareUrl = '';
    renderSearchResults();
    renderAnalysis();
    renderSavedReports();
  });

  on('route', route => {
    if (route !== 'player') return;

    if (fixtureMode && !analysis) {
      const input = document.querySelector('#playerSearchInput');
      if (input && !input.value) input.value = 'Aster';
      runSearch('Aster');
    }

    if (!fixtureMode) loadSavedReports();
  });
}

async function runSearch(query) {
  if (loading) return;
  loading = true;
  setStatus('Searching…');

  try {
    if (fixtureMode) {
      const lowered = query.toLowerCase();
      searchResults = playerAnalysisFixture.search.filter(item =>
        String(item.playerId) === query ||
        item.playerName.toLowerCase().includes(lowered)
      );
    } else {
      const result = await playerAnalysisApi('search', { query });
      searchResults = result.results || [];
    }

    renderSearchResults();

    const numeric = /^\d+$/.test(query);
    if (numeric && searchResults.length === 1) {
      await analyze(Number(searchResults[0].playerId));
    } else {
      setStatus(searchResults.length ? '' : 'No players found.');
    }
  } catch (error) {
    searchResults = [];
    renderSearchResults();
    setStatus(error.message || 'Player search failed.', true);
  } finally {
    loading = false;
  }
}

async function analyze(playerId) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0 || loading) return;

  loading = true;
  setStatus('Loading player analysis…');

  try {
    if (fixtureMode) {
      analysis = playerId === Number(playerAnalysisFixture.external.player.playerId)
        ? playerAnalysisFixture.external
        : playerAnalysisFixture.analysis;
    } else {
      analysis = await playerAnalysisApi('analyze', { playerId });
    }

    activeSnapshot = null;
    activeShareUrl = '';
    renderAnalysis();
    renderSearchResults();
    setStatus('');
  } catch (error) {
    analysis = null;
    renderAnalysis();
    setStatus(error.message || 'Player analysis failed.', true);
  } finally {
    loading = false;
  }
}

function renderSearchResults() {
  const container = document.querySelector('#playerSearchResults');
  if (!container) return;

  if (!searchResults.length) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = searchResults.map(item => {
    const selected = Number(analysis?.player?.playerId) === Number(item.playerId);
    return `
      <button class="player-result-row${selected ? ' selected' : ''}" type="button" data-player-result="${item.playerId}">
        <span>
          <strong>${escapeHtml(item.playerName || 'Unknown')}</strong>
          <small>[${escapeHtml(item.playerId)}] · Lv ${escapeHtml(item.level ?? '—')}${item.factionId ? ` · faction ${escapeHtml(item.factionId)}` : ''}</small>
        </span>
        <b>${escapeHtml(item.source || 'Torn')}${item.localHistoryAvailable ? ' · history' : ''}</b>
      </button>
    `;
  }).join('');
}

function renderAnalysis() {
  const container = document.querySelector('#playerAnalysisResult');
  const context = document.querySelector('#playerAnalysisContext');
  if (!container) return;

  if (!analysis?.player) {
    container.classList.add('hidden');
    container.innerHTML = '';
    if (context) context.textContent = fixtureMode
      ? 'Fixture mode · no D1 or Torn requests.'
      : 'Search by player name or ID.';
    return;
  }

  const player = analysis.player;
  const local = analysis.context?.localHistoryAvailable === true;
  const last4 = analysis.war?.last4;

  if (context) {
    context.textContent = local
      ? `RWEngine history available · observed ${formatRelative(analysis.context?.observedAt)}`
      : 'Public Torn profile · no permitted RWEngine history';
  }

  container.classList.remove('hidden');
  container.innerHTML = `
    <header class="player-analysis-head">
      <div>
        <p class="kicker">${local ? 'Torn + RWEngine' : 'Torn profile'}</p>
        <h2>${escapeHtml(player.playerName)} <small>[${escapeHtml(player.playerId)}]</small></h2>
        <p>
          Lv ${escapeHtml(player.level ?? '—')}
          ${player.rank ? ` · ${escapeHtml(player.rank)}` : ''}
          ${player.title ? ` · ${escapeHtml(player.title)}` : ''}
          ${player.factionId ? ` · faction ${escapeHtml(player.factionId)}` : ' · no faction'}
        </p>
      </div>
      <div class="player-analysis-actions">
        ${!fixtureMode && !activeSnapshot ? `<button class="text-action" type="button" data-save-player-report="${player.playerId}">Save report</button>` : ''}
        <a href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(player.playerId)}" target="_blank" rel="noopener noreferrer">Torn profile ↗</a>
      </div>
    </header>

    <div class="player-state-line">
      <span>Last action <b>${escapeHtml(formatRelative(player.lastActionAt))}</b></span>
      <span>Status <b>${escapeHtml(player.statusState || player.lastActionStatus || '—')}</b></span>
      <span>Revivable <b>${player.revivable === null || player.revivable === undefined ? '—' : player.revivable ? 'Yes' : 'No'}</b></span>
      ${player.ageDays != null ? `<span>Age <b>${formatNumber(player.ageDays)}d</b></span>` : ''}
    </div>

    <div class="metric-line player-metrics">
      ${metric('Battle stats', analysis.battleStats?.value == null ? '—' : formatCompact(analysis.battleStats.value), analysis.battleStats?.source || 'No estimate')}
      ${metric('Activity / day', formatDuration(analysis.activity?.perDay30d), local ? '30d' : 'No local history')}
      ${metric('Xanax / day', formatDecimal(analysis.xanax?.perDay30d, 2), local ? '30d' : 'No local history')}
      ${metric('RW participation', last4 ? formatPercent(last4.participation) : '—', last4 ? 'last 4 wars' : 'No local history')}
      ${metric('Hits / war', last4 ? formatDecimal(last4.hitsPerWar, 1) : '—', last4 ? 'last 4 wars' : '')}
      ${metric('Net score', last4 ? formatSigned(last4.netScore) : '—', last4 ? 'last 4 wars' : '')}
    </div>

    ${renderSourceLine()}
    ${renderSnapshotControls()}

    ${local ? renderLocalAnalysis() : `
      <section class="player-no-history">
        <strong>No permitted RWEngine history</strong>
        <p>This profile uses current public Torn data only. Historical faction snapshots and war records are not exposed across faction boundaries.</p>
      </section>
    `}
  `;
}

function renderSourceLine() {
  const sources = Array.isArray(analysis?.sources) ? analysis.sources : [];
  return `
    <div class="player-sources">
      <span>Sources</span>
      ${sources.length
        ? sources.map(source => `<b title="${escapeHtml(source.detail || '')}">${escapeHtml(source.label || '')}</b>`).join('')
        : '<b>None</b>'}
    </div>
  `;
}

function renderSnapshotControls() {
  if (!activeSnapshot) return '';

  const visibility = activeSnapshot.visibility || 'private';
  return `
    <div class="player-report-controls">
      <span>Saved snapshot #${escapeHtml(activeSnapshot.snapshotId)} · ${escapeHtml(formatDateTime(activeSnapshot.createdAt))}</span>
      <select class="small-select" data-player-report-visibility>
        <option value="private"${visibility === 'private' ? ' selected' : ''}>Private</option>
        <option value="faction"${visibility === 'faction' ? ' selected' : ''}>Faction</option>
        <option value="public"${visibility === 'public' ? ' selected' : ''}>Public</option>
      </select>
      ${visibility === 'public' ? '<button class="text-action" type="button" data-player-report-link>New public link</button>' : ''}
      ${activeShareUrl ? '<button class="text-action" type="button" data-copy-player-link>Copy link</button>' : ''}
    </div>
  `;
}

async function saveCurrentReport() {
  if (!analysis?.player?.playerId || fixtureMode || loading) return;

  loading = true;
  setStatus('Saving analysis snapshot…');

  try {
    const result = await playerReportsApi('save', { playerId:Number(analysis.player.playerId) });
    activeSnapshot = result.snapshot || null;
    activeShareUrl = '';
    await loadSavedReports();
    renderAnalysis();
    setStatus(result.message || 'Analysis snapshot saved.');
  } catch (error) {
    setStatus(error.message || 'Failed to save analysis snapshot.', true);
  } finally {
    loading = false;
  }
}

async function loadSavedReports() {
  try {
    const result = await playerReportsApi('list');
    savedReports = result.snapshots || [];
    renderSavedReports();
  } catch (_) {
    savedReports = [];
    renderSavedReports();
  }
}

function renderSavedReports() {
  const section = document.querySelector('#playerSavedReports');
  const list = document.querySelector('#playerSavedList');
  if (!section || !list) return;

  if (fixtureMode || !savedReports.length) {
    section.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  section.classList.remove('hidden');
  list.innerHTML = savedReports.map(snapshot => `
    <div class="player-saved-row">
      <button type="button" data-saved-player-report="${snapshot.snapshotId}">
        <strong>${escapeHtml(snapshot.playerName || 'Player ' + snapshot.playerId)}</strong>
        <small>[${escapeHtml(snapshot.playerId)}] · ${escapeHtml(formatDateTime(snapshot.createdAt))}</small>
      </button>
      <span>${escapeHtml(snapshot.visibility || 'private')}</span>
      <button class="text-action" type="button" data-delete-player-report="${snapshot.snapshotId}">Delete</button>
    </div>
  `).join('');
}

async function openSavedReport(snapshotId) {
  if (!snapshotId || loading) return;
  loading = true;
  setStatus('Opening saved report…');

  try {
    const result = await playerReportsApi('get', { snapshotId });
    analysis = result.analysis || null;
    activeSnapshot = result.snapshot || null;
    activeShareUrl = '';
    renderAnalysis();
    renderSearchResults();
    setStatus('');
  } catch (error) {
    setStatus(error.message || 'Failed to open saved report.', true);
  } finally {
    loading = false;
  }
}

async function deleteSavedReport(snapshotId) {
  if (!snapshotId || loading) return;
  loading = true;

  try {
    const result = await playerReportsApi('delete', { snapshotId });
    if (Number(activeSnapshot?.snapshotId) === Number(snapshotId)) {
      activeSnapshot = null;
      activeShareUrl = '';
    }
    await loadSavedReports();
    renderAnalysis();
    setStatus(result.message || 'Saved report deleted.');
  } catch (error) {
    setStatus(error.message || 'Failed to delete saved report.', true);
  } finally {
    loading = false;
  }
}

async function changeSnapshotVisibility(visibility) {
  if (!activeSnapshot?.snapshotId || loading) return;
  loading = true;
  setStatus('Updating report access…');

  try {
    const result = await shareApi('setVisibility', {
      resourceType:'player-analysis',
      resourceKey:String(activeSnapshot.snapshotId),
      visibility
    });

    activeSnapshot = {
      ...activeSnapshot,
      visibility:result.visibility || visibility
    };
    activeShareUrl = String(result.shareUrl || '');

    if (activeShareUrl) {
      try {
        await navigator.clipboard.writeText(activeShareUrl);
        setStatus('Public link created and copied.');
      } catch (_) {
        setStatus('Public link created. Use Copy link to copy it.');
      }
    } else {
      setStatus(result.message || 'Report access updated.');
    }

    await loadSavedReports();
    renderAnalysis();
  } catch (error) {
    setStatus(error.message || 'Failed to update report access.', true);
    renderAnalysis();
  } finally {
    loading = false;
  }
}

async function rotatePublicLink() {
  if (!activeSnapshot?.snapshotId || loading) return;
  loading = true;
  setStatus('Generating new public link…');

  try {
    const result = await shareApi('create', {
      resourceType:'player-analysis',
      resourceKey:String(activeSnapshot.snapshotId)
    });
    activeSnapshot = { ...activeSnapshot, visibility:'public' };
    activeShareUrl = String(result.shareUrl || '');
    renderAnalysis();

    if (activeShareUrl) {
      try {
        await navigator.clipboard.writeText(activeShareUrl);
        setStatus('New public link created and copied.');
      } catch (_) {
        setStatus('New public link created.');
      }
    }
  } catch (error) {
    setStatus(error.message || 'Failed to create public link.', true);
  } finally {
    loading = false;
  }
}

async function copyPublicLink() {
  if (!activeShareUrl) return;
  try {
    await navigator.clipboard.writeText(activeShareUrl);
    setStatus('Public link copied.');
  } catch (_) {
    setStatus('Browser clipboard access failed.', true);
  }
}

function renderLocalAnalysis() {
  const snapshots = Array.isArray(analysis.history?.snapshots) ? analysis.history.snapshots : [];
  const trends = buildTrendSeries(snapshots);
  const wars = Array.isArray(analysis.war?.history) ? analysis.war.history : [];

  return `
    <div class="player-trends">
      ${trendBlock('Battle stats', trends.stats, value => value == null ? '—' : formatCompact(value))}
      ${trendBlock('Activity / day', trends.activity, formatDuration)}
      ${trendBlock('Xanax / day', trends.xanax, value => formatDecimal(value, 2))}
    </div>

    <section class="player-war-history">
      <header>Recent wars</header>
      ${wars.length ? wars.map(war => `
        <div class="player-war-row">
          <div>
            <strong>${escapeHtml(war.opponentFactionName || 'Unknown opponent')}</strong>
            <small>#${escapeHtml(war.warId)} · ${escapeHtml(formatDate(war.endedAt))}</small>
          </div>
          <span>${formatNumber(war.hits)} hits</span>
          <span>${formatNumber(war.assists)} assists</span>
          <span>${formatNumber(war.outsideHits)} outside</span>
          <span>${formatSigned(war.netScore)} net</span>
        </div>
      `).join('') : '<div class="player-war-row empty">No imported war history.</div>'}
    </section>
  `;
}

function buildTrendSeries(snapshots) {
  const sorted = [...snapshots].sort((a,b) => Number(a.at || 0) - Number(b.at || 0));

  const stats = sorted
    .filter(row => Number.isFinite(Number(row.battleStatsValue)))
    .map(row => ({ at:Number(row.at), value:Number(row.battleStatsValue) }));

  if (sorted.some(row => Number.isFinite(Number(row.activityPerDaySeconds)))) {
    return {
      stats,
      activity:sorted
        .filter(row => Number.isFinite(Number(row.activityPerDaySeconds)))
        .map(row => ({ at:Number(row.at), value:Number(row.activityPerDaySeconds) })),
      xanax:sorted
        .filter(row => Number.isFinite(Number(row.xanaxPerDay)))
        .map(row => ({ at:Number(row.at), value:Number(row.xanaxPerDay) }))
    };
  }

  return {
    stats,
    activity:deriveRateSeries(sorted, 'activityTotalSeconds'),
    xanax:deriveRateSeries(sorted, 'xanaxTakenTotal')
  };
}

function deriveRateSeries(rows, key) {
  const usable = rows
    .filter(row => Number.isFinite(Number(row.at)) && Number.isFinite(Number(row[key])))
    .sort((a,b) => Number(a.at) - Number(b.at));

  const result = [];
  for (let index = 1; index < usable.length; index++) {
    const previous = usable[index - 1];
    const current = usable[index];
    const elapsed = (Number(current.at) - Number(previous.at)) / 86400;
    const delta = Number(current[key]) - Number(previous[key]);
    if (elapsed > 0 && delta >= 0) result.push({ at:Number(current.at), value:delta / elapsed });
  }
  return result;
}

function trendBlock(title, series, formatter) {
  const valid = series.filter(point => Number.isFinite(Number(point.value)));
  const latest = valid.length ? valid[valid.length - 1].value : null;

  return `
    <section class="player-trend">
      <header><strong>${escapeHtml(title)}</strong><span>90d · ${escapeHtml(formatter(latest))}</span></header>
      ${sparkline(valid)}
    </section>
  `;
}

function sparkline(series) {
  if (series.length < 2) return '<div class="sparkline"></div>';

  const values = series.map(point => Number(point.value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;

  const path = series.map((point,index) => {
    const x = (index / Math.max(1, series.length - 1)) * 100;
    const y = 48 - ((Number(point.value) - min) / spread) * 42;
    return (index ? 'L ' : 'M ') + x.toFixed(2) + ' ' + y.toFixed(2);
  }).join(' ');

  return `<svg class="sparkline" viewBox="0 0 100 54" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="50" x2="100" y2="50"></line><path d="${path}"></path></svg>`;
}

function formatSigned(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const text = formatDecimal(number, 2);
  return number > 0 ? '+' + text : text;
}

function setStatus(message, error = false) {
  const element = document.querySelector('#playerStatus');
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('hidden', !message);
  element.classList.toggle('error', error);
}
