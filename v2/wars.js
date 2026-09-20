import {
  state, on, emit, post,
  performanceApi, warDetailApi, attackDetailApi, shareApi, importApi, warImportJobApi, payoutApi,
  periodPayload, currentFactionId,
  canEditFactionView, renderLeadershipMarker,
  metric, formatNumber, formatDecimal, formatSigned, formatPercent,
  formatDate, escapeHtml, sleep, warStamp
} from './core.js?v=7';

const ATTACK_STEP_DELAY = 6000;
const DETAIL_STEP_DELAY = 1200;
const IMPORT_COOLDOWN = 30000;
const ATTACK_STEP_LIMIT = 300;
const DETAIL_STEP_LIMIT = 20;
const IMPORT_JOB_POLL_MS = 2500;
let importPollTimer = null;
let importPollIds = [];

const performance = {
  members: [],
  totalWars: 0,
  playersWithAttackDetails: 0,
  warnings: [],
  error: '',
  loadedKey: '',
  loading: false,
  sortKey: 'netScore',
  sortDirection: 'desc',
  chain: new Map()
};

const detail = {
  warId: null,
  payload: null,
  loading: false,
  shareUrl: '',
  sortKey: 'netScore',
  sortDirection: 'desc',
  payout: {
    profile:null,
    draftProfile:null,
    profileDirty:false,
    preview:null,
    runs:[],
    canSave:false,
    needsRebuild:false,
    busy:false,
    loadedWarId:null
  }
};

export function initWarViews() {
  document.querySelector('#performanceSearch')?.addEventListener('input', renderPerformance);
  document.querySelector('#includeFormer')?.addEventListener('change', renderPerformance);
  document.querySelector('#performanceMode')?.addEventListener('change', renderPerformance);
  document.querySelector('#excludeChain')?.addEventListener('change', () => loadPerformance(true));

  document.querySelector('#performanceHead')?.addEventListener('click', event => {
    const button = event.target.closest('[data-performance-sort]');
    if (!button) return;
    const key = button.dataset.performanceSort;
    if (performance.sortKey === key) performance.sortDirection = performance.sortDirection === 'desc' ? 'asc' : 'desc';
    else {
      performance.sortKey = key;
      performance.sortDirection = key === 'member' ? 'asc' : 'desc';
    }
    renderPerformance();
  });

  document.querySelector('#archiveSearch')?.addEventListener('input', renderArchive);
  document.querySelector('#archiveBody')?.addEventListener('click', event => {
    const row = event.target.closest('[data-war-id]');
    if (row) openWar(String(row.dataset.warId));
  });

  document.querySelector('#warDetailBack')?.addEventListener('click', closeWar);
  document.querySelector('#warDetailMode')?.addEventListener('change', renderWarDetail);
  document.querySelector('#warDetailSearch')?.addEventListener('input', renderWarDetail);
  document.querySelector('#warDetailHead')?.addEventListener('click', event => {
    const button = event.target.closest('[data-war-sort]');
    if (!button) return;
    const key = button.dataset.warSort;
    if (detail.sortKey === key) detail.sortDirection = detail.sortDirection === 'desc' ? 'asc' : 'desc';
    else {
      detail.sortKey = key;
      detail.sortDirection = key === 'member' ? 'asc' : 'desc';
    }
    renderWarDetail();
  });
  document.querySelector('#warDetailChain')?.addEventListener('change', () => {
    if (detail.warId) openWar(detail.warId, true);
  });

  document.querySelector('#importToggle')?.addEventListener('click', () => {
    document.querySelector('#importPanel')?.classList.toggle('hidden');
  });
  document.querySelector('#importForm')?.addEventListener('submit', handleImport);

  document.querySelector('#payoutWarSelect')?.addEventListener('change', event => {
    selectPayoutWar(String(event.target.value || ''));
  });
  document.querySelector('#payoutCalculate')?.addEventListener('click', () => calculatePayout(true));
  document.querySelector('#payoutSave')?.addEventListener('click', savePayoutRun);
  document.querySelector('#payoutCopy')?.addEventListener('click', copyPayoutCsv);
  document.querySelector('#payoutHistory')?.addEventListener('change', handlePayoutHistory);

  document.querySelector('#shareToggle')?.addEventListener('click', toggleShare);
  document.querySelector('#shareVisibility')?.addEventListener('change', updateShareVisibility);
  document.querySelector('#shareGenerate')?.addEventListener('click', generateShare);
  document.querySelector('#shareCopy')?.addEventListener('click', copyShare);

  on('route', route => {
    if (route === 'war') renderWarOverview();
    if (route === 'archive') {
      renderArchive();
      resumeBackgroundImports();
    }
    if (route === 'payouts') renderPayoutPage();
    if (route === 'performance') loadPerformance(false);
  });

  on('period', () => {
    performance.loadedKey = '';
    performance.chain.clear();
  });

  on('faction', () => {
    performance.loadedKey = '';
    performance.members = [];
    performance.chain.clear();
    closeWar();
    renderArchive();
    renderWarOverview();
    if (state.route === 'payouts') renderPayoutPage();
  });

  on('data', () => {
    renderWarOverview();
    renderArchive();
    performance.loadedKey = '';
    if (state.route === 'payouts') renderPayoutPage();
    if (state.route === 'performance' && !performance.loading) loadPerformance(true);
  });

  on('role-preview', () => {
    resetSharePanel(true);
    resetPayoutPanel(true);
    renderWarOverview();
    renderPerformance();
    renderWarDetail();
    if (state.route === 'payouts') renderPayoutPage();
  });

  on('payout-settings-preview', async event => {
    if (state.route !== 'payouts' || !detail.warId || !event?.profile) return;
    detail.payout.draftProfile = event.profile;
    detail.payout.profileDirty = true;
    await calculatePayout(false, event.profile);
    if (detail.payout.profileDirty) {
      setPayoutStatus('Previewing unsaved payout profile. Save the profile before saving a payout preset.');
    }
  });

  on('payout-settings', () => {
    detail.payout.draftProfile = null;
    detail.payout.profileDirty = false;
    if (state.route === 'payouts' && detail.warId) {
      detail.payout.loadedWarId = null;
      loadPayoutState(true);
    }
  });
}

export function renderWarOverview() {
  const members = Array.isArray(state.range?.members) ? state.range.members : [];
  const warsInPeriod = Number(state.range?.summary?.warsInPeriod || 0);
  const hits = members.reduce((sum, member) => sum + Number(member.warHits || 0), 0);
  const net = members.reduce((sum, member) => sum + Number(member.netScore || 0), 0);

  const summary = document.querySelector('#warSummary');
  if (summary) {
    summary.innerHTML = [
      metric('Wars', formatNumber(warsInPeriod), 'in selected period'),
      metric('War hits', formatNumber(hits), 'all members'),
      metric('Hits per war', warsInPeriod ? formatDecimal(hits / warsInPeriod, 1) : '—', 'faction average'),
      metric('Net score', formatSigned(net, 2), 'score gained − lost')
    ].join('');
  }

  const recent = warsWithinPeriod().slice(0, 6);
  const recentEl = document.querySelector('#recentWars');
  if (recentEl) {
    recentEl.innerHTML = recent.length
      ? recent.map(war => `
          <button class="line-row" type="button" data-open-war="${escapeHtml(String(war.war_id || war.report_id || ''))}">
            <div><strong>${escapeHtml(war.opponent_faction_name || 'Unknown opponent')}<small class="entity-id">#${escapeHtml(String(war.war_id || war.report_id || '—'))}</small></strong><small>${escapeHtml(formatDate(war.end_timestamp || war.start_timestamp))}</small></div>
            <b>Open →</b>
          </button>
        `).join('')
      : '<div class="line-row"><small>No imported wars in this period.</small></div>';

    recentEl.querySelectorAll('[data-open-war]').forEach(button => {
      button.addEventListener('click', () => {
        const warId = String(button.dataset.openWar || '');
        document.querySelector('[data-route="archive"]')?.click();
        window.setTimeout(() => openWar(warId), 0);
      });
    });
  }

  const contributors = [...members]
    .sort((a,b) => Number(b.netScore || 0) - Number(a.netScore || 0) || Number(b.warHits || 0) - Number(a.warHits || 0))
    .slice(0, 6);
  const contributorsEl = document.querySelector('#topContributors');
  if (contributorsEl) {
    contributorsEl.innerHTML = contributors.length
      ? contributors.map(member => `
          <button class="line-row" type="button" data-open-member="${member.playerId}">
            <div><strong>${escapeHtml(member.playerName || 'Unknown')}${renderLeadershipMarker(member.leadershipRole)}<small class="entity-id">[${escapeHtml(member.playerId)}]</small></strong><small>${formatNumber(member.warHits)} hits · ${formatNumber(member.assists)} assists</small></div>
            <b>${escapeHtml(formatSigned(member.netScore, 2))} net</b>
          </button>
        `).join('')
      : '<div class="line-row"><small>No member performance in this period.</small></div>';

    contributorsEl.querySelectorAll('[data-open-member]').forEach(button => {
      button.addEventListener('click', () => emit('open-member', Number(button.dataset.openMember)));
    });
  }
}

export function renderArchive() {
  const searchInput = document.querySelector('#archiveSearch');
  if (searchInput) searchInput.placeholder = 'Search opponent, faction or war ID';

  const search = String(searchInput?.value || '').trim().toLowerCase();
  const allWars = [...state.wars].sort((a,b) => warStamp(b) - warStamp(a));
  const wars = allWars.filter(war => !search ||
    String(war.opponent_faction_name || '').toLowerCase().includes(search) ||
    String(war.opponent_faction_id || '').includes(search) ||
    String(war.war_id || '').includes(search) ||
    String(war.report_id || '').includes(search));

  const count = document.querySelector('#archiveCount');
  const countLabel = document.querySelector('#archiveCountLabel');
  if (count) count.textContent = formatNumber(search ? wars.length : allWars.length);

  const labelText = search
    ? ` of ${formatNumber(allWars.length)} imported wars`
    : ` imported war${allWars.length === 1 ? '' : 's'}`;

  if (countLabel) {
    countLabel.textContent = labelText;
  } else {
    const legacyLabel = document.querySelector('.archive-count span');
    if (legacyLabel) legacyLabel.textContent = labelText;
  }

  const body = document.querySelector('#archiveBody');
  if (!body) return;

  const legacyTable = body.tagName === 'TBODY';
  if (legacyTable) {
    const table = body.closest('table');
    table?.classList.add('archive-table-v2');

    const head = table?.querySelector('thead');
    if (head) {
      head.innerHTML = `
        <tr>
          <th>Opponent</th>
          <th>Result</th>
          <th>War</th>
          <th>Period</th>
          <th>Duration</th>
          <th>Access</th>
          <th>Data</th>
          <th aria-hidden="true"></th>
        </tr>
      `;
    }

    body.innerHTML = wars.length
      ? wars.map(war => archiveLegacyRow(war)).join('')
      : '<tr class="empty-row"><td colspan="8">No imported wars match this view.</td></tr>';
    return;
  }

  body.innerHTML = wars.length
    ? wars.map(war => archiveGridRow(war)).join('')
    : '<div class="archive-empty">No imported wars match this view.</div>';
}

function archiveGridRow(war) {
  const warId = String(war.war_id || war.report_id || '');
  const reportId = String(war.report_id || '');
  const status = archiveWarStatus(war);
  const visibility = archiveVisibilityLabel(war.visibility);

  return `
    <div class="archive-row" role="row" data-war-id="${escapeHtml(warId)}">
      <div class="archive-cell archive-opponent" role="cell">
        <strong>
          ${escapeHtml(war.opponent_faction_name || 'Unknown opponent')}
          ${war.opponent_faction_id ? `<span class="entity-id">[${escapeHtml(war.opponent_faction_id)}]</span>` : ''}
        </strong>
      </div>
      <div class="archive-cell archive-result" role="cell">
        ${archiveOutcomeMarkup(war)}
      </div>
      <div class="archive-cell archive-war-id" role="cell">
        <strong>#${escapeHtml(warId || 'No data')}</strong>
        ${reportId && reportId !== warId ? `<span>Report #${escapeHtml(reportId)}</span>` : ''}
      </div>
      <div class="archive-cell archive-period" role="cell">
        <strong>${escapeHtml(formatDate(war.start_timestamp))}</strong>
        <span>to ${escapeHtml(formatDate(war.end_timestamp))}</span>
      </div>
      <div class="archive-cell archive-duration" role="cell">
        <strong>${escapeHtml(archiveDuration(war.start_timestamp, war.end_timestamp))}</strong>
      </div>
      <div class="archive-cell archive-access" role="cell">
        <strong>${escapeHtml(visibility)}</strong>
      </div>
      <div class="archive-cell archive-status" role="cell">
        <strong>${escapeHtml(status.label)}</strong>
        <span>${escapeHtml(status.detail)}</span>
      </div>
      <div class="archive-cell archive-open" role="cell" aria-hidden="true">→</div>
    </div>
  `;
}

function archiveLegacyRow(war) {
  const warId = String(war.war_id || war.report_id || '');
  const reportId = String(war.report_id || '');
  const status = archiveWarStatus(war);
  const visibility = archiveVisibilityLabel(war.visibility);

  return `
    <tr data-war-id="${escapeHtml(warId)}">
      <td>
        <span class="member-name">${escapeHtml(war.opponent_faction_name || 'Unknown opponent')}${war.opponent_faction_id ? `<span class="entity-id">[${escapeHtml(war.opponent_faction_id)}]</span>` : ''}</span>
      </td>
      <td>${archiveOutcomeMarkup(war)}</td>
      <td>
        <strong>#${escapeHtml(warId || 'No data')}</strong>
        ${reportId && reportId !== warId ? `<span class="secondary">Report #${escapeHtml(reportId)}</span>` : ''}
      </td>
      <td>
        <strong>${escapeHtml(formatDate(war.start_timestamp))}</strong>
        <span class="secondary">to ${escapeHtml(formatDate(war.end_timestamp))}</span>
      </td>
      <td><strong>${escapeHtml(archiveDuration(war.start_timestamp, war.end_timestamp))}</strong></td>
      <td><strong>${escapeHtml(visibility)}</strong></td>
      <td>
        <strong>${escapeHtml(status.label)}</strong>
        <span class="secondary">${escapeHtml(status.detail)}</span>
      </td>
      <td>→</td>
    </tr>
  `;
}

function warOutcome(scoreUp, scoreDown) {
  const own = Number(scoreUp);
  const opponent = Number(scoreDown);
  if (!Number.isFinite(own) || !Number.isFinite(opponent)) return 'unknown';
  if (own === 0 && opponent === 0) return 'unknown';
  if (own > opponent) return 'win';
  if (own < opponent) return 'loss';
  return 'draw';
}

function warOutcomeLabel(outcome) {
  if (outcome === 'win') return 'Win';
  if (outcome === 'loss') return 'Loss';
  if (outcome === 'draw') return 'Draw';
  return 'No data';
}

function archiveOutcomeMarkup(war) {
  const outcome = warOutcome(war.score_up, war.score_down);
  return `<span class="war-result war-result-${outcome}">${warOutcomeLabel(outcome)}</span>`;
}

function archiveDuration(startTimestamp, endTimestamp) {
  const start = Number(startTimestamp || 0);
  const end = Number(endTimestamp || 0);
  if (!start || !end || end <= start) return 'No data';
  const totalMinutes = Math.max(1, Math.round((end - start) / 60));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function archiveVisibilityLabel(value) {
  if (value === 'private') return 'Private';
  if (value === 'public') return 'Public';
  return 'Faction';
}

function archiveWarStatus(war) {
  const status = String(war.chain_adjustment_status || '').toLowerCase();
  const message = String(war.chain_adjustment_message || '').trim();
  const attackDetailComplete = Number(
    war.attack_detail_complete ?? war.attackDetailComplete ?? 0
  ) === 1;

  if (status === 'failed' || status === 'error') {
    return { label:'Needs attention', detail:message || 'Chain processing failed' };
  }
  if (!attackDetailComplete) {
    return { label:'Incomplete', detail:'Attack verification not complete' };
  }
  if (status === 'pending' || status === 'queued' || status === 'running') {
    return { label:'Processing', detail:'Chain processing' };
  }
  if (
    war.chain_adjusted_at ||
    ['applied','skipped','complete','completed','done'].includes(status)
  ) {
    return { label:'Ready', detail:'War + chain data' };
  }
  return { label:'Imported', detail:'Chain data not checked' };
}

export async function loadPerformance(force = false) {
  if (state.route !== 'performance' || performance.loading) return;

  const key = performanceKey();
  if (!force && performance.loadedKey === key && performance.members.length) {
    renderPerformance();
    return;
  }

  performance.loading = true;
  performance.error = '';
  setPerformanceStatus('Loading performance…');
  renderPerformance();

  try {
    const data = await performanceApi(periodPayload());
    performance.members = (data.members || []).map(member => ({ ...member }));
    performance.totalWars = Number(data.totalWars || 0);
    performance.playersWithAttackDetails = Number(data.playersWithAttackDetails || 0);
    performance.loadedKey = key;
    performance.chain.clear();
    performance.warnings = [];

    if (document.querySelector('#excludeChain')?.checked && performance.members.length) {
      try {
        await loadChainBonuses();
      } catch (error) {
        performance.error = `Chain bonus filtering unavailable: ${error.message || 'lookup failed'}`;
        document.querySelector('#excludeChain').checked = false;
        performance.chain.clear();
      }
    }
  } catch (error) {
    performance.members = [];
    performance.loadedKey = '';
    performance.error = error.message || 'Failed to load performance.';
  } finally {
    performance.loading = false;
    renderPerformance();
  }
}

async function loadChainBonuses() {
  setPerformanceStatus('Matching chain bonus reports…');

  const data = await post('/v2/chain-bonus-performance', {
    ...(state.user?.isAdmin && state.selectedFactionId ? { factionId: state.selectedFactionId } : {}),
    ...periodPayload()
  });

  performance.chain = new Map((data.members || []).map(item => [Number(item.playerId), item]));
  performance.warnings = Array.isArray(data.warnings) ? data.warnings : [];
}

export function renderPerformance() {
  const head = document.querySelector('#performanceHead');
  const body = document.querySelector('#performanceBody');
  if (!head || !body) return;

  const detailMode = document.querySelector('#performanceMode')?.value === 'detail';
  document.querySelector('#performanceTable')?.classList.toggle('is-detail', detailMode);
  const columns = detailMode
    ? ['member','wars','hits','assists','outsideHits','respectEarned','respectLost','scoreUp','scoreDown','netScore']
    : ['member','wars','hits','assists','netScore'];

  const labels = {
    member:'Member', wars:'Wars joined', hits:'Hits', assists:'Assists',
    outsideHits:'Outside hits', respectEarned:'Respect gained', respectLost:'Respect lost',
    scoreUp:'Score gained', scoreDown:'Score lost', netScore:'Net score'
  };

  if (!columns.includes(performance.sortKey)) {
    performance.sortKey = 'netScore';
    performance.sortDirection = 'desc';
  }

  head.innerHTML = `<tr>${columns.map(key => `
    <th class="${key === 'netScore' ? 'net' : ''}">
      <button type="button" data-performance-sort="${key}">${labels[key]}${performance.sortKey === key ? ` ${performance.sortDirection === 'desc' ? '↓' : '↑'}` : ''}</button>
    </th>
  `).join('')}</tr>`;

  const includeFormer = Boolean(document.querySelector('#includeFormer')?.checked);
  const query = String(document.querySelector('#performanceSearch')?.value || '').trim().toLowerCase();

  const rows = performance.members
    .filter(member => includeFormer || member.current)
    .filter(member => !query ||
      String(member.playerName || '').toLowerCase().includes(query) ||
      String(member.playerId || '').includes(query))
    .sort(comparePerformance);

  if (performance.loading && !performance.members.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="${columns.length}">Loading performance…</td></tr>`;
  } else if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="${columns.length}">No performance data in this period.</td></tr>`;
  } else {
    body.innerHTML = rows.map(member => `
      <tr>
        ${columns.map(key => renderPerformanceCell(member, key)).join('')}
      </tr>
    `).join('');
  }

  const coverage = performance.members.length
    ? `${performance.playersWithAttackDetails}/${performance.members.length} members have verified attack detail`
    : '';
  const warning = performance.warnings.length ? ` · ${performance.warnings.length} chain-report warning${performance.warnings.length === 1 ? '' : 's'}` : '';
  if (!performance.loading) {
    if (performance.error) setPerformanceStatus(performance.error, true);
    else setPerformanceStatus(`${formatNumber(performance.totalWars)} imported war${performance.totalWars === 1 ? '' : 's'} in period${coverage ? ` · ${coverage}` : ''}${warning}`);
  }
}

function comparePerformance(a,b) {
  const direction = performance.sortDirection === 'asc' ? 1 : -1;
  if (performance.sortKey === 'member') {
    return String(a.playerName).localeCompare(String(b.playerName)) * direction;
  }
  const av = displayMetric(a, performance.sortKey);
  const bv = displayMetric(b, performance.sortKey);
  if (av == null && bv == null) return String(a.playerName).localeCompare(String(b.playerName));
  if (av == null) return 1;
  if (bv == null) return -1;
  return ((Number(av) - Number(bv)) * direction) || String(a.playerName).localeCompare(String(b.playerName));
}

function renderPerformanceCell(member, key) {
  const value = displayMetric(member, key);
  const classes = key === 'member' ? '' : (key === 'netScore' ? 'net' : '');

  if (key === 'member') {
    return `<td><a href="https://www.torn.com/profiles.php?XID=${member.playerId}" target="_blank" rel="noopener noreferrer"><span class="member-name">${escapeHtml(member.playerName || `Player ${member.playerId}`)}${renderLeadershipMarker(member.leadershipRole)}<span class="entity-id">[${escapeHtml(member.playerId)}]</span></span>${member.current ? '' : '<span class="member-meta">former</span>'}</a></td>`;
  }

  if (key === 'wars') {
    return `<td><strong>${formatNumber(value)}</strong><span class="secondary">${formatPercent(member.participation)} participation</span></td>`;
  }

  if (key === 'hits') {
    const hitsPerWar = Number(member.wars) > 0 ? Number(value) / Number(member.wars) : null;
    return `<td><strong>${formatNumber(value)}</strong><span class="secondary">${hitsPerWar == null ? '—' : formatDecimal(hitsPerWar, 1)} / war</span></td>`;
  }

  if (key === 'assists') {
    const perWar = Number(member.wars) > 0 && value != null ? Number(value) / Number(member.wars) : null;
    return `<td><strong>${value == null ? '—' : formatNumber(value)}</strong><span class="secondary">${perWar == null ? '—' : formatDecimal(perWar, 1)} / war</span></td>`;
  }

  if (key === 'netScore') {
    const perWar = Number(member.wars) > 0 ? Number(value) / Number(member.wars) : null;
    return `<td class="${classes}"><strong>${formatSigned(value, 2)}</strong><span class="secondary">${perWar == null ? '—' : formatSigned(perWar, 2)} / war</span></td>`;
  }

  const formatted = ['outsideHits'].includes(key)
    ? formatNumber(value)
    : formatDecimal(value, 2);
  return `<td class="${classes}">${formatted}</td>`;
}

function displayMetric(member, key) {
  if (key === 'member') return member.playerName;
  const exclude = Boolean(document.querySelector('#excludeChain')?.checked);
  if (!exclude) {
    const direct = {
      hits: member.warHits,
      wars: member.wars,
      assists: member.assists,
      outsideHits: member.outsideHits,
      respectEarned: member.respectEarned,
      respectLost: member.respectLost,
      scoreUp: member.scoreUp,
      scoreDown: member.scoreDown,
      netScore: member.netScore
    };
    return direct[key];
  }

  const chain = performance.chain.get(Number(member.playerId)) || {};
  const adjusted = {
    hits: Math.max(0, Number(member.warHits || 0) - Number(chain.chainBonusHitsOut || 0)),
    wars: member.wars,
    assists: member.assists,
    outsideHits: member.outsideHits,
    respectEarned: member.respectEarned == null ? null : Math.max(0, Number(member.respectEarned) - Number(chain.chainBonusScoreOut || 0)),
    respectLost: member.respectLost == null ? null : Math.max(0, Number(member.respectLost) - Number(chain.chainBonusRespectLostIn || 0)),
    scoreUp: Math.max(0, Number(member.scoreUp || 0) - Number(chain.chainBonusScoreOut || 0)),
    scoreDown: Math.max(0, Number(member.scoreDown || 0) - Number(chain.chainBonusScoreIn || 0))
  };
  adjusted.netScore = adjusted.scoreUp - adjusted.scoreDown;
  return adjusted[key];
}

function setPerformanceStatus(message, error = false) {
  const el = document.querySelector('#performanceStatus');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
  el.classList.toggle('error', error);
}

function performanceKey() {
  return `${currentFactionId() || 0}:${state.period.from || ''}:${state.period.to || ''}`;
}

async function openWar(warId, force = false) {
  if (!warId || (detail.loading && !force)) return;

  detail.warId = String(warId);
  detail.loading = true;
  document.querySelector('#archiveListView')?.classList.add('hidden');
  document.querySelector('#archiveView')?.classList.add('war-open');
  document.querySelector('#warDetailView')?.classList.remove('hidden');
  setDetailLoading();

  try {
    const excludeChainBonuses = Boolean(document.querySelector('#warDetailChain')?.checked);
    let payload;

    try {
      payload = await warDetailApi({ warId: detail.warId, excludeChainBonuses });
    } catch (error) {
      if (!excludeChainBonuses) throw error;
      document.querySelector('#warDetailChain').checked = false;
      payload = await warDetailApi({ warId: detail.warId, excludeChainBonuses:false });
      payload.chainFilterWarning = error.message || 'Chain bonus filtering was unavailable.';
    }

    detail.payload = payload;
    resetSharePanel(true);
    resetPayoutPanel(true);
    renderWarDetail();
  } catch (error) {
    detail.payload = { error: error.message || 'Failed to load war report.' };
    renderWarDetail();
  } finally {
    detail.loading = false;
  }
}

function closeWar() {
  detail.warId = null;
  detail.payload = null;
  detail.shareUrl = '';
  resetPayoutPanel(true);
  document.querySelector('#warDetailView')?.classList.add('hidden');
  document.querySelector('#archiveListView')?.classList.remove('hidden');
  document.querySelector('#archiveView')?.classList.remove('war-open');
  resetSharePanel(true);
}

function setDetailLoading() {
  document.querySelector('#warDetailTitle').textContent = 'Loading war…';
  document.querySelector('#warDetailMeta').textContent = 'Ranked war';
  const resultEl = document.querySelector('#warDetailResult');
  if (resultEl) resultEl.innerHTML = '';
  document.querySelector('#warDetailDate').textContent = '';
  document.querySelector('#warDetailScore').innerHTML = '';
  document.querySelector('#warDetailSummary').innerHTML = '';
  const detailNotice = document.querySelector('#warDetailNotice');
  if (detailNotice) {
    detailNotice.textContent = '';
    detailNotice.classList.add('hidden');
  }
  document.querySelector('#warDetailBody').innerHTML = '<tr class="empty-row"><td>Loading war report…</td></tr>';
  document.querySelector('#warDetailHead').innerHTML = '';
  document.querySelector('#warDetailFoot').innerHTML = '';
}

function renderWarDetail() {
  const canManageAccess = canEditFactionView();
  document.querySelector('#shareToggle')?.classList.toggle('hidden', !canManageAccess);
  if (!canManageAccess) {
    resetSharePanel(true);
    resetPayoutPanel(true);
  }

  const payload = detail.payload;
  if (!payload) return;

  if (payload.error) {
    document.querySelector('#warDetailTitle').textContent = 'War unavailable';
    document.querySelector('#warDetailBody').innerHTML = `<tr class="empty-row"><td>${escapeHtml(payload.error)}</td></tr>`;
    return;
  }

  const war = payload.war || {};
  const summary = payload.summary || {};
  const members = Array.isArray(payload.members) ? payload.members : [];

  const outcome = warOutcome(summary.officialScoreUp, summary.officialScoreDown);
  const ownFactionId = Number(payload.factionId || 0) || null;
  document.querySelector('#warDetailMeta').textContent = `Ranked war #${war.warId || '—'}`;
  document.querySelector('#warDetailTitle').textContent = `${war.factionName || 'Faction'} vs ${war.opponentFactionName || 'Opponent'}`;
  document.querySelector('#warDetailDate').textContent = `${formatDate(war.startTimestamp)} – ${formatDate(war.endTimestamp)}`;

  const resultEl = document.querySelector('#warDetailResult');
  if (resultEl) resultEl.innerHTML = '';

  document.querySelector('#warDetailScore').innerHTML = `
    <div class="score-side">
      <span>${escapeHtml(war.factionName || 'Faction')}${ownFactionId ? ` <span class="entity-id">[${escapeHtml(ownFactionId)}]</span>` : ''}</span>
      <strong>${formatDecimal(summary.displayScoreUp, 2)}</strong>
    </div>
    <div class="score-versus">
      <span class="war-result war-result-${outcome}">${warOutcomeLabel(outcome)}</span>
      <small>RW score</small>
    </div>
    <div class="score-side opponent">
      <strong>${formatDecimal(summary.displayScoreDown, 2)}</strong>
      <span>${escapeHtml(war.opponentFactionName || 'Opponent')}${war.opponentFactionId ? ` <span class="entity-id">[${escapeHtml(war.opponentFactionId)}]</span>` : ''}</span>
    </div>
  `;

  const summaryEl = document.querySelector('#warDetailSummary');
  if (summaryEl) summaryEl.innerHTML = '';

  const detailNotice = document.querySelector('#warDetailNotice');
  if (detailNotice) {
    detailNotice.textContent = payload.chainFilterWarning || '';
    detailNotice.classList.toggle('hidden', !payload.chainFilterWarning);
  }

  const detailed = document.querySelector('#warDetailMode')?.value === 'detail';
  const columns = detailed
    ? ['member','hits','assists','outsideHits','respectEarned','respectLost','scoreUp','scoreDown','netScore']
    : ['member','hits','assists','netScore'];
  const labels = {
    member:'Member', hits:'Hits', assists:'Assists', outsideHits:'Outside hits',
    respectEarned:'Respect gained', respectLost:'Respect lost', scoreUp:'Score gained',
    scoreDown:'Score lost', netScore:'Net score'
  };

  if (!columns.includes(detail.sortKey)) {
    detail.sortKey = 'netScore';
    detail.sortDirection = 'desc';
  }

  document.querySelector('#warDetailHead').innerHTML = `<tr>${columns.map(key => `
    <th class="${key === 'netScore' ? 'net' : ''}">
      <button type="button" data-war-sort="${key}">
        ${labels[key]}${detail.sortKey === key ? ` ${detail.sortDirection === 'desc' ? '↓' : '↑'}` : ''}
      </button>
    </th>
  `).join('')}</tr>`;

  const query = String(document.querySelector('#warDetailSearch')?.value || '').trim().toLowerCase();
  const rows = members
    .filter(member => !query ||
      String(member.playerName || '').toLowerCase().includes(query) ||
      String(member.playerId || '').includes(query))
    .sort(compareWarDetail);

  const totals = members.reduce((sum, member) => {
    for (const key of ['hits','assists','outsideHits','respectEarned','respectLost','scoreUp','scoreDown','netScore']) {
      sum[key] += Number(member[key] || 0);
    }
    return sum;
  }, { hits:0,assists:0,outsideHits:0,respectEarned:0,respectLost:0,scoreUp:0,scoreDown:0,netScore:0 });

  const aggregateValue = key => {
    if (key === 'hits') return summary.displayHits ?? totals.hits;
    if (key === 'assists') return summary.assists ?? totals.assists;
    if (key === 'scoreUp') return summary.displayScoreUp ?? totals.scoreUp;
    if (key === 'scoreDown') return summary.displayScoreDown ?? totals.scoreDown;
    if (key === 'netScore') return summary.displayNetScore ?? totals.netScore;
    return totals[key];
  };

  const totalRow = `<tr class="war-total-row">${columns.map(key => {
    if (key === 'member') {
      return `<td><strong>Faction total</strong><span class="secondary">${formatNumber(summary.members ?? members.length)} members</span></td>`;
    }
    const value = aggregateValue(key);
    const formatted = ['hits','assists','outsideHits'].includes(key)
      ? formatNumber(value)
      : (key === 'netScore' ? formatSigned(value,2) : formatDecimal(value,2));
    return `<td class="${key === 'netScore' ? 'net' : ''}"><strong>${formatted}</strong></td>`;
  }).join('')}</tr>`;

  document.querySelector('#warDetailBody').innerHTML = totalRow + (rows.length
    ? rows.map(member => `<tr>${columns.map(key => renderWarCell(member,key)).join('')}</tr>`).join('')
    : `<tr class="empty-row"><td colspan="${columns.length}">No members match this view.</td></tr>`);

  document.querySelector('#warDetailFoot').innerHTML = '';
}

function compareWarDetail(a, b) {
  const direction = detail.sortDirection === 'asc' ? 1 : -1;

  if (detail.sortKey === 'member') {
    return String(a.playerName || '').localeCompare(String(b.playerName || '')) * direction;
  }

  const av = warDetailMetric(a, detail.sortKey);
  const bv = warDetailMetric(b, detail.sortKey);

  if (av == null && bv == null) return String(a.playerName || '').localeCompare(String(b.playerName || ''));
  if (av == null) return 1;
  if (bv == null) return -1;
  return ((Number(av) - Number(bv)) * direction) || String(a.playerName || '').localeCompare(String(b.playerName || ''));
}

function warDetailMetric(member, key) {
  if (key === 'member') return member.playerName || '';
  const value = member?.[key];
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function renderWarCell(member,key) {
  if (key === 'member') {
    return `<td><a href="https://www.torn.com/profiles.php?XID=${member.playerId}" target="_blank" rel="noopener noreferrer"><span class="member-name">${escapeHtml(member.playerName || `Player ${member.playerId}`)}${renderLeadershipMarker(member.leadershipRole)}<span class="entity-id">[${escapeHtml(member.playerId)}]</span></span>${member.current ? '' : '<span class="member-meta">former</span>'}</a></td>`;
  }
  if (['hits','assists','outsideHits'].includes(key)) return `<td>${formatNumber(member[key])}</td>`;
  if (key === 'netScore') return `<td class="net">${formatSigned(member[key],2)}</td>`;
  return `<td>${member[key] == null ? 'No data' : formatDecimal(member[key],2)}</td>`;
}


function renderPayoutPage() {
  const panel = document.querySelector('#payoutPanel');
  const select = document.querySelector('#payoutWarSelect');
  const meta = document.querySelector('#payoutWarMeta');
  if (!panel || !select) return;

  const allowed = canEditFactionView();
  document.querySelectorAll('[data-route="payouts"]').forEach(button => {
    button.classList.toggle('hidden', !allowed);
  });

  if (!allowed) {
    panel.classList.add('hidden');
    select.innerHTML = '';
    select.disabled = true;
    if (meta) meta.textContent = 'Faction management access is required.';
    return;
  }

  panel.classList.remove('hidden');
  select.disabled = false;

  const wars = [...state.wars]
    .filter(war => String(war.war_id || war.report_id || '').trim())
    .sort((a,b) => warStamp(b) - warStamp(a));

  if (!wars.length) {
    detail.warId = null;
    resetPayoutPanel(false);
    select.innerHTML = '<option value="">No imported wars</option>';
    select.disabled = true;
    if (meta) meta.textContent = 'Import a ranked war in Archive before calculating payouts.';
    renderPayoutPanel();
    return;
  }

  select.innerHTML = wars.map(war => {
    const warId = String(war.war_id || war.report_id || '');
    const opponent = war.opponent_faction_name || 'Unknown opponent';
    const date = formatDate(war.end_timestamp || war.start_timestamp);
    return `<option value="${escapeHtml(warId)}">${escapeHtml(opponent)} · #${escapeHtml(warId)} · ${escapeHtml(date)}</option>`;
  }).join('');

  const available = new Set(wars.map(war => String(war.war_id || war.report_id || '')));
  const selected = available.has(String(detail.warId || ''))
    ? String(detail.warId)
    : String(wars[0].war_id || wars[0].report_id || '');

  select.value = selected;

  if (String(detail.warId || '') !== selected) {
    detail.warId = selected;
    resetPayoutPanel(false);
  }

  renderPayoutWarMeta(wars.find(war => String(war.war_id || war.report_id || '') === selected));

  if (selected && detail.payout.loadedWarId !== selected && !detail.payout.busy) {
    loadPayoutState();
  }
}

function selectPayoutWar(warId) {
  const selected = String(warId || '').trim();
  if (!selected || selected === String(detail.warId || '')) return;

  detail.warId = selected;
  resetPayoutPanel(false);

  const war = state.wars.find(item =>
    String(item.war_id || item.report_id || '') === selected
  );
  renderPayoutWarMeta(war);
  loadPayoutState();
}

function renderPayoutWarMeta(war) {
  const meta = document.querySelector('#payoutWarMeta');
  if (!meta) return;
  if (!war) {
    meta.textContent = '';
    return;
  }

  const opponent = war.opponent_faction_name || 'Unknown opponent';
  const period = `${formatDate(war.start_timestamp)} – ${formatDate(war.end_timestamp)}`;
  meta.innerHTML = `<strong>${escapeHtml(opponent)}</strong><span>${escapeHtml(period)}</span>`;
}

async function loadPayoutState(force = false) {
  if (!detail.warId || (detail.payout.busy && !force)) return;
  detail.payout.busy = true;
  setPayoutStatus('Loading payout profile…');
  setPayoutBusy(true);

  try {
    const result = await payoutApi('list', { warId:detail.warId });
    detail.payout.profile = result.profile || null;
    detail.payout.runs = Array.isArray(result.runs) ? result.runs : [];
    detail.payout.canSave = result.canSave === true;
    detail.payout.needsRebuild = false;
    detail.payout.loadedWarId = String(detail.warId || '');
    renderPayoutHistory();
    renderPayoutPanel();

    await calculatePayout(false);
  } catch (error) {
    setPayoutStatus(error.message || 'Failed to load payout profile.', true);
  } finally {
    detail.payout.busy = false;
    setPayoutBusy(false);
  }
}

async function calculatePayout(showStatus = true, profileOverride = null) {
  if (!detail.warId) return;
  if (showStatus) setPayoutStatus('Calculating payout…');
  setPayoutBusy(true);

  const draftProfile = profileOverride || (detail.payout.profileDirty ? detail.payout.draftProfile : null);

  try {
    const result = await payoutApi('preview', {
      warId:detail.warId,
      ...(draftProfile ? { profile:draftProfile } : {})
    });
    detail.payout.preview = result.preview || null;
    detail.payout.profile = result.preview?.profile || detail.payout.profile;
    detail.payout.canSave = result.canSave === true;
    detail.payout.needsRebuild = false;

    const history = document.querySelector('#payoutHistory');
    if (history) history.value = '';
    renderPayoutPanel();

    const unavailable = Array.isArray(detail.payout.preview?.unavailableModules)
      ? detail.payout.preview.unavailableModules
      : [];
    setPayoutStatus(
      unavailable.length
        ? unavailable.map(item => item.reason || `${item.label || item.id} is unavailable for this war.`).join(' ')
        : ''
    );
  } catch (error) {
    detail.payout.preview = null;
    detail.payout.needsRebuild = false;
    renderPayoutPanel();
    setPayoutStatus(error.message || 'Failed to calculate payout.', true);
  } finally {
    setPayoutBusy(false);
  }
}

async function savePayoutRun() {
  if (!detail.warId || !detail.payout.canSave) return;
  if (detail.payout.profileDirty) {
    setPayoutStatus('Save the payout profile before saving a payout preset.');
    return;
  }
  setPayoutBusy(true);
  setPayoutStatus('Saving payout preset…');

  try {
    const result = await payoutApi('save', { warId:detail.warId });
    if (result.run) {
      detail.payout.runs = [
        {
          runId:Number(result.run.runId || 0),
          createdAt:Number(result.run.createdAt || 0),
          createdByPlayerId:result.run.createdByPlayerId || null,
          totalPayout:Number(result.run.preview?.totalPayout || 0),
          memberCount:Number(result.run.preview?.members?.length || 0),
          preview:result.run.preview || null
        },
        ...detail.payout.runs.filter(run => Number(run.runId) !== Number(result.run.runId))
      ];
      detail.payout.preview = result.run.preview || detail.payout.preview;
    }

    renderPayoutHistory();
    renderPayoutPanel();
    setPayoutStatus(result.message || 'Payout preset saved.');
  } catch (error) {
    detail.payout.needsRebuild = false;
    renderPayoutPanel();
    setPayoutStatus(error.message || 'Failed to save payout preset.', true);
  } finally {
    setPayoutBusy(false);
  }
}

function handlePayoutHistory(event) {
  const value = String(event.target?.value || '');
  if (!value) {
    calculatePayout(false);
    return;
  }

  const run = detail.payout.runs.find(item => String(item.runId) === value);
  if (!run?.preview) return;

  detail.payout.preview = run.preview;
  detail.payout.profile = run.preview.profile || detail.payout.profile;
  detail.payout.needsRebuild = false;
  renderPayoutPanel();
  setPayoutStatus(
    `Saved preset #${formatNumber(run.runId)} · ${formatPayoutDate(run.createdAt)}`
  );
}

function renderPayoutHistory() {
  const select = document.querySelector('#payoutHistory');
  if (!select) return;

  const current = String(select.value || '');
  select.innerHTML = [
    '<option value="">Current preset</option>',
    ...detail.payout.runs.map(run =>
      `<option value="${escapeHtml(run.runId)}">#${escapeHtml(run.runId)} · ${escapeHtml(formatPayoutDate(run.createdAt))} · ${escapeHtml(formatMoney(run.totalPayout))}</option>`
    )
  ].join('');

  if ([...select.options].some(option => option.value === current)) {
    select.value = current;
  }
}

function renderPayoutPanel() {
  const preview = detail.payout.preview;
  const profile = preview?.profile || detail.payout.profile;
  const modules = activePayoutModules(profile);
  const summary = document.querySelector('#payoutProfileSummary');
  const head = document.querySelector('#payoutHead');
  const body = document.querySelector('#payoutBody');
  const foot = document.querySelector('#payoutFoot');
  const payoutSummary = document.querySelector('#payoutSummary');
  const save = document.querySelector('#payoutSave');
  const copy = document.querySelector('#payoutCopy');
  const unavailable = Array.isArray(preview?.unavailableModules) ? preview.unavailableModules : [];

  if (save) save.disabled = !detail.payout.canSave || !preview || detail.payout.profileDirty || unavailable.length > 0;
  if (copy) copy.disabled = !preview;

  if (summary) {
    summary.innerHTML = modules.length
      ? modules.map(module => {
          const milestoneText = module.milestonesIncluded === undefined
            ? ''
            : module.milestonesIncluded !== false
              ? ' · milestones included'
              : ` · milestones ${formatMoney(module.milestoneRate)} / hit`;
          return `<span><strong>${escapeHtml(payoutModuleName(module))}</strong><small>${escapeHtml(formatMoney(module.rate))} / ${escapeHtml(payoutModuleUnit(module))}${escapeHtml(milestoneText)}</small></span>`;
        }).join('')
      : '<span><strong>No payout modules enabled</strong><small>Configure the payout profile above.</small></span>';
  }

  if (!head || !body || !foot || !payoutSummary) return;

  if (!preview) {
    head.innerHTML = '';
    body.innerHTML = '<tr class="empty-row"><td>Calculate to preview this payout.</td></tr>';
    foot.innerHTML = '';
    payoutSummary.innerHTML = '';
    return;
  }

  const active = Array.isArray(preview.activeModules) ? preview.activeModules : [];
  head.innerHTML = `<tr>
    <th>Member</th>
    ${active.map(module => `<th>${escapeHtml(module.shortLabel || module.label || module.id)}</th>`).join('')}
    <th class="net">Total</th>
  </tr>`;

  const members = Array.isArray(preview.members) ? preview.members : [];
  body.innerHTML = members.length
    ? members.map(member => `<tr>
        <td>
          <a href="https://www.torn.com/profiles.php?XID=${escapeHtml(member.playerId)}" target="_blank" rel="noopener noreferrer">
            <span class="member-name">${escapeHtml(member.playerName || `Player ${member.playerId}`)}<span class="entity-id">[${escapeHtml(member.playerId)}]</span></span>
          </a>
        </td>
        ${active.map(module => {
          const component = (member.components || []).find(item => item.id === module.id) || {};
          return `<td><strong>${escapeHtml(formatPayoutQuantity(component.quantity, module.unit))}</strong><span class="member-meta">${escapeHtml(formatMoney(component.payout))}</span></td>`;
        }).join('')}
        <td class="net"><strong>${escapeHtml(formatMoney(member.totalPayout))}</strong></td>
      </tr>`).join('')
    : `<tr class="empty-row"><td colspan="${active.length + 2}">No payout rows.</td></tr>`;

  foot.innerHTML = `<tr class="war-total-row">
    <td><strong>Faction total</strong><span class="secondary">${formatNumber(members.length)} members</span></td>
    ${active.map(module => `<td><strong>${escapeHtml(formatPayoutQuantity(module.quantity, module.unit))}</strong><span class="member-meta">${escapeHtml(formatMoney(module.payout))}</span></td>`).join('')}
    <td class="net"><strong>${escapeHtml(formatMoney(preview.totalPayout))}</strong></td>
  </tr>`;

  payoutSummary.innerHTML = `
    <strong>${escapeHtml(formatMoney(preview.totalPayout))}</strong>
    <span>Total payout · ${formatNumber(members.length)} members · ${formatNumber(active.length)} active module${active.length === 1 ? '' : 's'}</span>
  `;
}

function activePayoutModules(profile) {
  return (Array.isArray(profile?.modules) ? profile.modules : [])
    .filter(module => module?.enabled !== false);
}

function payoutModuleName(module) {
  const names = {
    rankedRespect:'Ranked-war respect',
    outsideChainRespect:'Outside-chain respect',
    warHits:'War hits',
    assists:'Assists',
    outsideHits:'Outside hits'
  };
  return names[module?.id] || module?.id || 'Payout';
}

function payoutModuleUnit(module) {
  return ['rankedRespect','outsideChainRespect'].includes(String(module?.id || '')) ? 'R' :
    String(module?.id || '') === 'assists' ? 'assist' : 'hit';
}

function formatPayoutQuantity(value, unit) {
  const number = Number(value || 0);
  if (unit === 'R') return formatDecimal(number, 2);
  return formatNumber(number);
}

function formatMoney(value) {
  const number = Number(value || 0);
  return '$' + new Intl.NumberFormat(undefined, {
    maximumFractionDigits:0
  }).format(Math.round(number));
}

function formatPayoutDate(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, {
    year:'numeric',
    month:'short',
    day:'2-digit',
    hour:'2-digit',
    minute:'2-digit'
  }).format(new Date(value * 1000));
}

function setPayoutBusy(busy) {
  detail.payout.busy = Boolean(busy);
  document.querySelectorAll('#payoutPanel button, #payoutPanel select').forEach(control => {
    control.disabled = Boolean(busy);
  });

  const save = document.querySelector('#payoutSave');
  const copy = document.querySelector('#payoutCopy');
  if (!busy) {
    const unavailable = Array.isArray(detail.payout.preview?.unavailableModules)
      ? detail.payout.preview.unavailableModules
      : [];
    if (save) save.disabled = !detail.payout.canSave || !detail.payout.preview || detail.payout.profileDirty || unavailable.length > 0;
    if (copy) copy.disabled = !detail.payout.preview;
  }
}

function setPayoutStatus(message, error = false) {
  const status = document.querySelector('#payoutStatus');
  if (!status) return;
  status.textContent = message || '';
  status.classList.toggle('hidden', !message);
  status.classList.toggle('error', Boolean(error));
}

function resetPayoutPanel(hide = false) {
  detail.payout = {
    profile:null,
    draftProfile:null,
    profileDirty:false,
    preview:null,
    runs:[],
    canSave:false,
    needsRebuild:false,
    busy:false,
    loadedWarId:null
  };

  const panel = document.querySelector('#payoutPanel');
  if (panel) panel.classList.toggle('hidden', Boolean(hide && state.route !== 'payouts'));
  const history = document.querySelector('#payoutHistory');
  if (history) history.innerHTML = '<option value="">Current profile</option>';
  const summary = document.querySelector('#payoutProfileSummary');
  if (summary) summary.innerHTML = '';
  const payoutSummary = document.querySelector('#payoutSummary');
  if (payoutSummary) payoutSummary.innerHTML = '';
  const head = document.querySelector('#payoutHead');
  const body = document.querySelector('#payoutBody');
  const foot = document.querySelector('#payoutFoot');
  if (head) head.innerHTML = '';
  if (body) body.innerHTML = '';
  if (foot) foot.innerHTML = '';
  setPayoutStatus('');
}

async function copyPayoutCsv() {
  const preview = detail.payout.preview;
  if (!preview) return;

  const active = Array.isArray(preview.activeModules) ? preview.activeModules : [];
  const header = [
    'Player ID',
    'Member',
    ...active.flatMap(module => [
      `${module.shortLabel || module.label || module.id} quantity`,
      `${module.shortLabel || module.label || module.id} payout`
    ]),
    'Total payout'
  ];

  const rows = (preview.members || []).map(member => {
    const components = new Map((member.components || []).map(item => [item.id, item]));
    return [
      member.playerId,
      member.playerName,
      ...active.flatMap(module => {
        const component = components.get(module.id) || {};
        return [Number(component.quantity || 0), Number(component.payout || 0)];
      }),
      Number(member.totalPayout || 0)
    ];
  });

  const csv = [header, ...rows]
    .map(row => row.map(csvCell).join(','))
    .join('\n');

  try {
    await navigator.clipboard.writeText(csv);
    setPayoutStatus('Payout CSV copied.');
  } catch (_) {
    setPayoutStatus('Could not copy the payout CSV.', true);
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

async function rebuildPayoutData() {
  if (!detail.warId || detail.payout.busy) return;

  setPayoutBusy(true);
  setPayoutStatus('Rebuilding payout detail…');

  try {
    const seen = new Set();
    let nextUrl = null;
    let completed = false;

    for (let step = 0; step < DETAIL_STEP_LIMIT; step++) {
      const result = await attackDetailApi({
        warId:detail.warId,
        ...(nextUrl ? { nextUrl } : {})
      });

      setPayoutStatus(
        `Rebuilding payout detail · ${formatNumber(result.processedTotal ?? result.storedTotal ?? 0)} attacks processed.`
      );

      if (result.done) {
        await attackDetailApi({ warId:detail.warId, finalize:true });
        completed = true;
        break;
      }

      const candidate = String(result.nextUrl || '').trim();
      if (!candidate) throw new Error('Torn did not provide the next attack page.');

      const key = canonicalPage(candidate);
      if (seen.has(key)) {
        await attackDetailApi({ warId:detail.warId, finalize:true });
        completed = true;
        break;
      }

      seen.add(key);
      nextUrl = candidate;
      await sleep(DETAIL_STEP_DELAY);
    }

    if (!completed) throw new Error('Payout detail rebuild exceeded the safety limit.');

    detail.payout.loadedWarId = null;
    await loadPayoutState(true);
    setPayoutStatus('Payout detail rebuilt.');
  } catch (error) {
    setPayoutStatus(error.message || 'Failed to rebuild payout detail.', true);
  } finally {
    setPayoutBusy(false);
  }
}

async function toggleShare() {
  if (!canEditFactionView()) return;
  const panel = document.querySelector('#sharePanel');
  if (!panel || !detail.warId) return;

  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  if (!opening) return;

  setShareStatus('Checking report access…');

  try {
    const result = await shareApi('status', { resourceType:'war', warId:detail.warId });
    applyShareState(result);
  } catch (error) {
    setShareStatus(error.message, true);
  }
}

async function updateShareVisibility() {
  if (!detail.warId || !canEditFactionView()) return;

  const select = document.querySelector('#shareVisibility');
  const visibility = select?.value || 'faction';
  if (select) select.disabled = true;
  setShareStatus('Updating access…');

  try {
    const result = await shareApi('setVisibility', {
      resourceType:'war',
      warId:detail.warId,
      visibility
    });
    applyShareState({ ...result, canManage:true });
  } catch (error) {
    setShareStatus(error.message, true);
    try {
      const status = await shareApi('status', { resourceType:'war', warId:detail.warId });
      applyShareState(status);
    } catch (_) {}
  } finally {
    if (select) select.disabled = false;
  }
}

async function generateShare() {
  if (!detail.warId || !canEditFactionView()) return;

  const button = document.querySelector('#shareGenerate');
  if (button) button.disabled = true;
  setShareStatus('Generating new public link…');

  try {
    const result = await shareApi('create', { resourceType:'war', warId:detail.warId });
    applyShareState({ ...result, canManage:true });
  } catch (error) {
    setShareStatus(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function copyShare() {
  const value = detail.shareUrl || document.querySelector('#shareUrl')?.value || '';
  if (!value) return;

  try {
    await navigator.clipboard.writeText(value);
    setShareStatus('Link copied.');
  } catch (_) {
    document.querySelector('#shareUrl')?.select();
    setShareStatus('Select and copy the link manually.');
  }
}

function applyShareState(result) {
  const visibility = result.visibility || 'faction';
  const canManage = canEditFactionView() && result.canManage === true;
  const select = document.querySelector('#shareVisibility');
  const url = document.querySelector('#shareUrl');
  const generate = document.querySelector('#shareGenerate');
  const copy = document.querySelector('#shareCopy');

  if (select) {
    select.value = visibility;
    select.disabled = !canManage;
  }

  detail.shareUrl = String(result.shareUrl || '');
  if (url) url.value = detail.shareUrl;

  const isPublic = visibility === 'public';
  generate?.classList.toggle('hidden', !isPublic || !canManage);
  copy?.classList.toggle('hidden', !detail.shareUrl);

  if (!canManage) {
    setShareStatus(
      visibility === 'private'
        ? 'Private report. Only Assistants or faction admins can change access.'
        : 'You can view this report, but only Assistants or faction admins can change access.'
    );
    return;
  }

  if (visibility === 'public') {
    setShareStatus(
      detail.shareUrl
        ? 'Public link active. New link rotates the current URL.'
        : result.share?.enabled
          ? 'Public link active. Create a new link to reveal and rotate the URL.'
          : 'Public access enabled.'
    );
  } else if (visibility === 'private') {
    setShareStatus('Private · owner and faction management only.');
  } else {
    setShareStatus('Faction · authenticated faction members can view.');
  }
}

function resetSharePanel(hide = false) {
  detail.shareUrl = '';
  const panel = document.querySelector('#sharePanel');
  if (hide) panel?.classList.add('hidden');

  const input = document.querySelector('#shareUrl');
  if (input) input.value = '';

  const select = document.querySelector('#shareVisibility');
  if (select) {
    select.value = 'faction';
    select.disabled = false;
  }

  document.querySelector('#shareGenerate')?.classList.add('hidden');
  document.querySelector('#shareCopy')?.classList.add('hidden');
  setShareStatus('');
}

function setShareStatus(message, error = false) {
  const el = document.querySelector('#shareStatus');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('error', error);
}

async function handleImport(event) {
  event.preventDefault();
  const ids = parseIds(document.querySelector('#importIds')?.value);
  if (!ids.length) {
    renderImportRows([{ id:'—', state:'error', label:'Invalid', message:'Enter at least one report ID.' }]);
    return;
  }

  const overwrite = Boolean(document.querySelector('#importOverwrite')?.checked);
  const button = event.currentTarget.querySelector('button[type="submit"]');
  if (button) {
    button.disabled = true;
    button.textContent = 'Starting…';
  }

  renderImportRows(ids.map(id => ({
    id,
    state:'',
    label:'Queued',
    message:'Starting background import.'
  })));

  try {
    const result = await warImportJobApi('startBatch', {
      rankIds:ids,
      overwrite
    });
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    renderImportJobRows(jobs);
    startImportPolling(ids);
  } catch (error) {
    renderImportRows(ids.map(id => ({
      id,
      state:'error',
      label:'Failed',
      message:error.message || 'Failed to start background import.'
    })));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Import';
    }
  }
}

function startImportPolling(ids) {
  importPollIds = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!importPollIds.length) return;
  if (importPollTimer) clearTimeout(importPollTimer);
  pollImportJobs();
}

async function pollImportJobs() {
  if (!importPollIds.length) return;

  try {
    const result = await warImportJobApi('status', { rankIds:importPollIds });
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    renderImportJobRows(jobs);

    const active = jobs.some(job => ['queued','running'].includes(String(job.status || '')));
    if (!active) {
      importPollIds = [];
      importPollTimer = null;
      emit('request-refresh', { source:'background-import' });
      return;
    }
  } catch (error) {
    renderImportRows(importPollIds.map(id => ({
      id,
      state:'warning',
      label:'Background',
      message:error.message || 'Import is still running, but status could not be refreshed.'
    })));
  }

  importPollTimer = window.setTimeout(pollImportJobs, IMPORT_JOB_POLL_MS);
}

async function resumeBackgroundImports() {
  try {
    const result = await warImportJobApi('status');
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    const active = jobs.filter(job => ['queued','running'].includes(String(job.status || '')));

    if (active.length) {
      renderImportJobRows(active);
      startImportPolling(active.map(job => job.rankId));
      return;
    }

    const recentFinished = jobs.some(job =>
      ['completed','failed','stalled'].includes(String(job.status || '')) &&
      Number(job.updatedAt || 0) > Math.floor(Date.now() / 1000) - 600
    );
    if (recentFinished) emit('request-refresh', { source:'background-import-resume' });
  } catch (_) {}
}

function renderImportJobRows(jobs) {
  if (!jobs.length) return;
  renderImportRows(jobs.map(job => {
    const status = String(job.status || 'queued');
    const phase = String(job.phase || 'queued');

    if (status === 'completed') {
      return {
        id:job.rankId,
        state:'',
        label:'Complete',
        message:job.message || 'Import complete.'
      };
    }
    if (status === 'failed') {
      return {
        id:job.rankId,
        state:'error',
        label:'Failed',
        message:job.message || 'Background import failed.'
      };
    }
    if (status === 'stalled') {
      return {
        id:job.rankId,
        state:'warning',
        label:'Incomplete',
        message:job.message || 'Import did not finish.'
      };
    }

    const labels = {
      queued:'Queued',
      checking:'Checking',
      report:'War report',
      verification:'Verifying',
      chain:'Chain report'
    };
    return {
      id:job.rankId,
      state:'',
      label:labels[phase] || 'Background',
      message:job.message || 'Import running in background.'
    };
  }));
}

async function importAttackSummary(warId, reportId, rows) {
  let reset = true;
  let latest = {};

  for (let step = 0; step < ATTACK_STEP_LIMIT; step++) {
    const result = await importApi('applyAttackSummary', { warId, reset });
    reset = false;
    latest = result.summary || latest;
    updateImportRow(rows,reportId,'','Attacks',`${formatNumber(latest.checked || 0)} attacks · ${formatNumber(result.pendingWindows || 0)} windows pending.`);
    if (result.done) return latest;
    await sleep(ATTACK_STEP_DELAY);
  }
  throw new Error('Attack summary exceeded the safety limit.');
}

async function importAttackDetail(warId, reportId, rows) {
  let nextUrl = null;
  const seen = new Set();
  let latest = null;

  for (let step = 0; step < DETAIL_STEP_LIMIT; step++) {
    const result = await attackDetailApi({ warId, ...(nextUrl ? { nextUrl } : {}) });
    latest = result;
    const total = Number(result.processedTotal ?? result.storedTotal ?? 0);
    updateImportRow(rows,reportId,'','Verify',`${formatNumber(total)} attacks processed.`);

    if (result.done) return finalizeAttackDetail(warId,result);

    const candidate = String(result.nextUrl || '').trim();
    if (!candidate) throw new Error('Torn did not provide the next attack page.');

    const key = canonicalPage(candidate);
    if (seen.has(key)) {
      return finalizeAttackDetail(warId, {
        ...result,
        paginationStopReason:'repeated-link'
      });
    }

    seen.add(key);
    nextUrl = candidate;
    await sleep(DETAIL_STEP_DELAY);
  }

  throw new Error(`Attack verification exceeded ${DETAIL_STEP_LIMIT} pages${latest ? ` after ${formatNumber(latest.processedTotal ?? latest.storedTotal ?? 0)} attacks` : ''}.`);
}

async function finalizeAttackDetail(warId,result) {
  const final = await attackDetailApi({ warId, finalize:true });
  return { ...result, ...final };
}

function canonicalPage(value) {
  try {
    const url = new URL(String(value), location.origin);
    url.searchParams.delete('key');
    url.searchParams.delete('comment');
    url.searchParams.delete('timestamp');
    return `${url.origin}${url.pathname}?${[...url.searchParams.entries()].sort().map(([k,v]) => `${k}=${v}`).join('&')}`;
  } catch (_) {
    return String(value);
  }
}

function parseIds(value) {
  return [...new Set(String(value || '').split(/[\s,;]+/).map(item => item.trim()).filter(Boolean))];
}

function renderImportRows(rows) {
  const box = document.querySelector('#importProgress');
  if (!box) return;
  box.classList.remove('hidden');
  box.innerHTML = rows.map(row => importRow(row)).join('');
}

function updateImportRow(rows,id,stateValue,label,message) {
  const row = rows.find(item => item.id === id);
  if (!row) return;
  row.state = stateValue;
  row.label = label;
  row.message = message;
  renderImportRows(rows);
}

function importRow(row) {
  return `<div class="import-row${row.state ? ` ${row.state}` : ''}"><strong>#${escapeHtml(row.id)}</strong><span>${escapeHtml(row.label)}</span><small>${escapeHtml(row.message)}</small></div>`;
}

function warsWithinPeriod() {
  const from = state.period.from ? new Date(`${state.period.from}T00:00:00`).getTime()/1000 : -Infinity;
  const to = state.period.to ? new Date(`${state.period.to}T23:59:59`).getTime()/1000 : Infinity;
  return [...state.wars]
    .filter(war => {
      const stamp = warStamp(war);
      return stamp >= from && stamp <= to;
    })
    .sort((a,b) => warStamp(b) - warStamp(a));
}
