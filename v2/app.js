const state = {
  user: null,
  dashboard: null,
  wars: [],
  range: null,
  syncJob: null,
  syncRunning: false
};

const loginView = document.querySelector('#loginView');
const appView = document.querySelector('#appView');
const loginForm = document.querySelector('#loginForm');
const playerIdInput = document.querySelector('#playerIdInput');
const passwordInput = document.querySelector('#passwordInput');
const loginError = document.querySelector('#loginError');
const globalError = document.querySelector('#globalError');
const refreshButton = document.querySelector('#refreshButton');
const logoutButton = document.querySelector('#logoutButton');
const memberSearch = document.querySelector('#memberSearch');
const intelFrom = document.querySelector('#intelFrom');
const intelTo = document.querySelector('#intelTo');
const applyRangeButton = document.querySelector('#applyRangeButton');
const syncIntelButton = document.querySelector('#syncIntelButton');
const syncStatus = document.querySelector('#syncStatus');
const memberModal = document.querySelector('#memberModal');
const memberModalBackdrop = document.querySelector('#memberModalBackdrop');
const memberModalClose = document.querySelector('#memberModalClose');
const memberModalName = document.querySelector('#memberModalName');
const memberModalMeta = document.querySelector('#memberModalMeta');
const memberModalBody = document.querySelector('#memberModalBody');

const pageTitles = {
  overview: 'Overview',
  members: 'Members',
  wars: 'Wars',
  'current-war': 'Current War',
  settings: 'Settings'
};

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  setLoginError('');

  try {
    const response = await api('login', {
      playerId: playerIdInput.value.trim(),
      password: passwordInput.value
    });

    state.user = response.user;
    passwordInput.value = '';
    await enterApp();
  } catch (error) {
    setLoginError(error.message);
  }
});

logoutButton.addEventListener('click', async () => {
  try { await api('logout'); } catch (_) {}
  state.user = null;
  state.dashboard = null;
  state.wars = [];
  state.range = null;
  state.syncJob = null;
  closeMemberModal();
  showLogin();
});

refreshButton.addEventListener('click', () => loadCoreData(true));
memberSearch.addEventListener('input', renderMembers);
applyRangeButton.addEventListener('click', () => loadRange(true));
syncIntelButton.addEventListener('click', runFactionSync);
memberModalBackdrop.addEventListener('click', closeMemberModal);
memberModalClose.addEventListener('click', closeMemberModal);

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !memberModal.classList.contains('hidden')) closeMemberModal();
});

document.querySelector('#membersBody').addEventListener('click', event => {
  const row = event.target.closest('tr[data-member-id]');
  if (row) openMember(Number(row.dataset.memberId));
});

document.querySelectorAll('.nav-button').forEach(button => {
  button.addEventListener('click', () => showTab(button.dataset.tab));
});

document.querySelectorAll('.jump-button').forEach(button => {
  button.addEventListener('click', () => showTab(button.dataset.jump));
});

boot();

async function boot() {
  try {
    const response = await api('me');
    state.user = response.user;
    await enterApp();
  } catch (_) {
    showLogin();
  }
}

async function enterApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');

  document.querySelector('#userLabel').textContent = formatUser(state.user);
  document.querySelector('#factionLabel').textContent = state.user?.factionName || 'No faction';
  document.querySelector('#settingsPlayer').textContent = formatUser(state.user);
  document.querySelector('#settingsFaction').textContent = state.user?.factionName || '—';
  document.querySelector('#settingsFactionId').textContent = state.user?.factionId ?? '—';

  showTab('overview');
  await loadCoreData(false);
}

function showLogin() {
  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
  setGlobalError('');
  setLoginError('');
}

async function loadCoreData(showRefreshState) {
  if (showRefreshState) {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing…';
  }

  setGlobalError('');

  try {
    const [dashboardResponse, warsResponse, rangeResponse, syncResponse] = await Promise.all([
      api('getDashboardData', {
        filters: { termedFilter: 'ALL', memberFilter: 'ALL', search: '' },
        sortBy: 'ImpactScore',
        sortDirection: 'DESC'
      }),
      api('getImportedWars'),
      rangeApi('getRange', getRangePayload()),
      intelApi('getSyncStatus').catch(() => ({ job: null }))
    ]);

    state.dashboard = dashboardResponse;
    state.wars = warsResponse.wars || [];
    state.range = rangeResponse;
    state.syncJob = syncResponse.job || null;

    syncRangeInputs();
    renderAll();
  } catch (error) {
    setGlobalError(error.message);
  } finally {
    if (showRefreshState) {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh';
    }
  }
}

async function loadRange(showBusyState = false) {
  if (showBusyState) {
    applyRangeButton.disabled = true;
    applyRangeButton.textContent = 'Applying…';
  }

  setGlobalError('');
  try {
    state.range = await rangeApi('getRange', getRangePayload());
    syncRangeInputs();
    renderOverview();
    renderMembers();
    renderWars();
  } catch (error) {
    setGlobalError(`Date range: ${error.message}`);
  } finally {
    if (showBusyState) {
      applyRangeButton.disabled = false;
      applyRangeButton.textContent = 'Apply';
    }
  }
}

function getRangePayload() {
  return {
    from: intelFrom.value || undefined,
    to: intelTo.value || undefined
  };
}

function syncRangeInputs() {
  const range = state.range?.range;
  if (!range) return;
  intelFrom.value = range.fromDate;
  intelTo.value = range.toDate;
  intelFrom.min = state.range?.trackingStartedAt ? toDateInput(state.range.trackingStartedAt) : '';
  intelTo.min = intelFrom.min;
  const today = toDateInput(Math.floor(Date.now() / 1000));
  intelFrom.max = today;
  intelTo.max = today;
}

async function runFactionSync() {
  if (state.syncRunning) return;

  state.syncRunning = true;
  syncIntelButton.disabled = true;
  syncIntelButton.textContent = 'Syncing…';
  setGlobalError('');

  try {
    const start = await intelApi('startSync');
    let job = start.job;
    if (!job) throw new Error('The backend did not return a sync job.');

    state.syncJob = job;
    renderSyncStatus();

    while (!['completed', 'failed'].includes(job.status)) {
      const result = await intelApi('syncStep', { jobId: job.jobId });
      job = result.job;
      state.syncJob = job;
      renderSyncStatus();

      if (!job) throw new Error('Faction sync lost its job state.');
      if (job.status === 'failed') throw new Error(job.error || 'Faction sync failed.');
      if (!['completed', 'failed'].includes(job.status)) await sleep(result.busy ? 1200 : 250);
    }

    await loadCoreData(false);
  } catch (error) {
    setGlobalError(`Faction sync: ${error.message}`);
    try {
      const sync = await intelApi('getSyncStatus');
      state.syncJob = sync.job || state.syncJob;
    } catch (_) {}
  } finally {
    state.syncRunning = false;
    syncIntelButton.disabled = false;
    syncIntelButton.textContent = isActiveSync(state.syncJob) ? 'Resume sync' : 'Sync faction';
    renderSyncStatus();
  }
}

function renderAll() {
  renderOverview();
  renderMembers();
  renderWars();
  renderSyncStatus();
}

function renderOverview() {
  const members = state.range?.members || [];
  const summary = state.range?.summary || {};
  const totalHits = members.reduce((sum, member) => sum + Number(member.warHits || 0), 0);
  const netScore = members.reduce((sum, member) => sum + Number(member.netScore || 0), 0);

  document.querySelector('#metricMembers').textContent = formatNumber(summary.currentMembers || 0);
  document.querySelector('#metricWars').textContent = formatNumber(summary.warsInPeriod || 0);
  document.querySelector('#metricHits').textContent = formatNumber(totalHits);
  document.querySelector('#metricNetScore').textContent = formatSigned(netScore);

  const warsContainer = document.querySelector('#overviewWars');
  const recentWars = getWarsInRange().slice(0, 5);
  warsContainer.innerHTML = recentWars.length
    ? recentWars.map(war => `
        <div class="stack-row">
          <div>
            <strong>${escapeHtml(war.opponent_faction_name || 'Unknown opponent')}</strong>
            <small>${formatWarDate(war.end_timestamp || war.start_timestamp)}</small>
          </div>
          <div class="stack-value">#${escapeHtml(String(war.war_id || war.report_id || '—'))}</div>
        </div>
      `).join('')
    : '<div class="empty">No imported wars in this range.</div>';

  const membersContainer = document.querySelector('#overviewMembers');
  const topMembers = [...members]
    .sort((a, b) => Number(b.netScore || 0) - Number(a.netScore || 0) || Number(b.warHits || 0) - Number(a.warHits || 0))
    .slice(0, 5);

  membersContainer.innerHTML = topMembers.length
    ? topMembers.map(member => `
        <button class="stack-row stack-button" data-open-member="${member.playerId}" type="button">
          <div>
            <strong>${escapeHtml(member.playerName || 'Unknown member')}</strong>
            <small>${formatNumber(member.assists || 0)} assists · ${formatNumber(member.warHits || 0)} hits</small>
          </div>
          <div class="stack-value">${formatSigned(member.netScore || 0)}</div>
        </button>
      `).join('')
    : '<div class="empty">No member data in this range.</div>';

  membersContainer.querySelectorAll('[data-open-member]').forEach(button => {
    button.addEventListener('click', () => openMember(Number(button.dataset.openMember)));
  });

  const trackingStartedAt = state.range?.trackingStartedAt;
  document.querySelector('#trackingText').textContent = trackingStartedAt
    ? `Tracking began ${formatDateTime(trackingStartedAt)}. Activity and development metrics only use RWE snapshots recorded from that point forward.`
    : 'Activity and development metrics begin when the faction starts being tracked by RWE.';
}

function renderMembers() {
  const tbody = document.querySelector('#membersBody');
  const search = memberSearch.value.trim().toLowerCase();
  const rows = (state.range?.members || []).filter(member => {
    if (!search) return true;
    return String(member.playerName || '').toLowerCase().includes(search) || String(member.playerId || '').includes(search);
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">No matching members in the selected range.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(member => `
    <tr data-member-id="${member.playerId}" class="member-row" title="Open member details">
      <td>
        <span class="member-name">${escapeHtml(member.playerName || 'Unknown')}</span>
        <span class="member-id">${escapeHtml(String(member.playerId || ''))}${member.current ? ' · current' : ' · left'}</span>
      </td>
      <td>${escapeHtml(member.position || '—')}</td>
      <td title="${escapeHtml(formatDateTime(member.lastActionAt))}">${formatRelativeTime(member.lastActionAt)}</td>
      <td>${formatBattleStats(member)}</td>
      <td>${formatActivityPerDay(member.activityPerDaySeconds)}</td>
      <td>${formatNullableDecimal(member.xanaxPerDay, 2)}</td>
      <td>${formatNullableDecimal(member.ocsPerMonth, 1)}</td>
      <td>${formatPercent(member.participation)}</td>
      <td>${formatNullableDecimal(member.avgHitsPerWar, 1)}</td>
    </tr>
  `).join('');
}

async function openMember(playerId) {
  const summaryMember = (state.range?.members || []).find(member => Number(member.playerId) === Number(playerId));
  memberModalName.textContent = summaryMember?.playerName || `Player ${playerId}`;
  memberModalMeta.textContent = summaryMember ? `${summaryMember.position || 'Member'} · [${playerId}]` : `[${playerId}]`;
  memberModalBody.innerHTML = '<div class="modal-loading">Loading member details…</div>';
  memberModal.classList.remove('hidden');
  memberModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');

  try {
    const response = await rangeApi('getMemberDetail', { playerId, ...getRangePayload() });
    renderMemberModal(response.member, response.wars || []);
  } catch (error) {
    memberModalBody.innerHTML = `<div class="error-banner">${escapeHtml(error.message)}</div>`;
  }
}

function closeMemberModal() {
  memberModal.classList.add('hidden');
  memberModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function renderMemberModal(member, wars) {
  memberModalName.textContent = member.playerName || `Player ${member.playerId}`;
  memberModalMeta.textContent = `${member.position || 'Member'} · Level ${member.level ?? '—'} · [${member.playerId}]`;

  const warRows = wars.length
    ? wars.map(war => `
        <tr>
          <td>${escapeHtml(war.opponentFactionName || 'Unknown')}</td>
          <td>${formatWarDate(war.endTimestamp || war.startTimestamp)}</td>
          <td>${formatNumber(war.hits)}</td>
          <td>${formatNumber(war.assists)}</td>
          <td>${formatNumber(war.outsideHits)}</td>
          <td>${formatDecimal(war.respectEarned, 2)}</td>
          <td>${formatDecimal(war.respectLost, 2)}</td>
          <td>${formatSigned(war.netScore)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="8" class="empty">No imported ranked wars in this range.</td></tr>';

  memberModalBody.innerHTML = `
    <div class="detail-grid">
      ${detailCard('Battle stats', formatBattleStats(member), member.battleStatsVerified ? 'Verified by member API' : member.battleStatsValue ? 'Estimate' : 'Unavailable')}
      ${detailCard('Activity / day', formatActivityPerDay(member.activityPerDaySeconds), coverageText(member.coverageDays))}
      ${detailCard('Xanax / day', formatNullableDecimal(member.xanaxPerDay, 2), member.xanaxTaken !== null ? `${formatNumber(member.xanaxTaken)} in range` : 'Unavailable')}
      ${detailCard('OCs / month', formatNullableDecimal(member.ocsPerMonth, 1), member.ocCount !== null ? `${formatNumber(member.ocCount)} in range` : 'Tracking will be added next')}
    </div>

    <section class="member-detail-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Ranked war performance</p>
          <h3>Selected range</h3>
        </div>
      </div>
      <div class="detail-grid compact">
        ${detailCard('Participation', formatPercent(member.participation), `${formatNumber(member.wars || 0)} wars`)}
        ${detailCard('War hits', formatNumber(member.warHits || 0), `${formatNullableDecimal(member.avgHitsPerWar, 1)} avg / war`)}
        ${detailCard('Assists', formatNumber(member.assists || 0), `${formatNumber(member.outsideHits || 0)} outside hits`)}
        ${detailCard('Respect earned', formatDecimal(member.respectEarned || 0, 2), `${formatDecimal(member.respectLost || 0, 2)} lost`)}
        ${detailCard('Score gained', formatNumber(member.scoreUp || 0), `${formatNumber(member.scoreDown || 0)} lost`)}
        ${detailCard('Net score', formatSigned(member.netScore || 0), 'After score lost')}
      </div>

      <div class="table-wrap modal-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Opponent</th>
              <th>Date</th>
              <th>Hits</th>
              <th>Assists</th>
              <th>Outside</th>
              <th>Respect +</th>
              <th>Respect -</th>
              <th>Net score</th>
            </tr>
          </thead>
          <tbody>${warRows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function detailCard(label, value, note) {
  return `
    <article class="detail-card">
      <span>${escapeHtml(label)}</span>
      <strong>${value}</strong>
      <small>${escapeHtml(note || '')}</small>
    </article>
  `;
}

function coverageText(days) {
  const number = Number(days || 0);
  if (!number) return 'Needs at least two snapshots';
  return `${number.toFixed(number >= 10 ? 0 : 1)} days of recorded coverage`;
}

function renderSyncStatus() {
  const job = state.syncJob;
  if (!job) {
    syncStatus.classList.add('hidden');
    syncIntelButton.textContent = state.syncRunning ? 'Syncing…' : 'Sync faction';
    return;
  }

  syncStatus.classList.remove('hidden');
  const total = Number(job.tasksTotal || 0);
  const done = Number(job.tasksCompleted || 0) + Number(job.tasksFailed || 0);
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const statusText = job.status === 'completed'
    ? `Last sync completed${job.tasksFailed ? ` with ${job.tasksFailed} unavailable snapshots` : ''}.`
    : job.status === 'failed'
      ? `Sync failed: ${job.error || 'Unknown error'}`
      : job.phase === 'initializing'
        ? 'Reading the current faction roster…'
        : `Collecting member snapshots: ${done} / ${total}`;

  syncStatus.innerHTML = `
    <div>
      <strong>${escapeHtml(statusText)}</strong>
      <div>RWE trend data uses current observations recorded from the faction tracking start.</div>
      ${total > 0 ? `<div class="sync-progress"><span style="width:${percent}%"></span></div>` : ''}
    </div>
    <div>${formatNumber(job.apiRequests || 0)} API requests</div>
  `;

  if (!state.syncRunning) syncIntelButton.textContent = isActiveSync(job) ? 'Resume sync' : 'Sync faction';
}

function isActiveSync(job) {
  return Boolean(job && ['queued', 'running'].includes(job.status));
}

function renderWars() {
  const tbody = document.querySelector('#warsBody');
  const wars = getWarsInRange();

  if (!wars.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No imported wars found in this range.</td></tr>';
    return;
  }

  tbody.innerHTML = wars.map(war => `
    <tr>
      <td>${escapeHtml(war.opponent_faction_name || 'Unknown opponent')}</td>
      <td>${escapeHtml(String(war.war_id || '—'))}</td>
      <td>${formatWarDate(war.start_timestamp)}</td>
      <td>${formatWarDate(war.end_timestamp)}</td>
      <td>${escapeHtml(formatChainStatus(war))}</td>
    </tr>
  `).join('');
}

function getWarsInRange() {
  const from = Number(state.range?.range?.from || 0);
  const to = Number(state.range?.range?.to || Number.MAX_SAFE_INTEGER);
  return (state.wars || []).filter(war => {
    const timestamp = Number(war.end_timestamp || war.start_timestamp || war.imported_at || 0);
    return timestamp >= from && timestamp <= to;
  });
}

function showTab(tabName) {
  document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.nav-button').forEach(button => button.classList.remove('active'));
  document.querySelector(`#${CSS.escape(tabName)}Tab`)?.classList.add('active');
  document.querySelector(`.nav-button[data-tab="${CSS.escape(tabName)}"]`)?.classList.add('active');
  document.querySelector('#pageTitle').textContent = pageTitles[tabName] || 'RWEngine';
}

async function api(action, payload = {}) {
  const response = await fetch('/api', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });
  return parseApiResponse(response);
}

async function intelApi(action, payload = {}) {
  const response = await fetch('/v2/intel', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });
  return parseApiResponse(response);
}

async function rangeApi(action, payload = {}) {
  const response = await fetch('/v2/range', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error(`Backend returned HTTP ${response.status} without JSON.`); }
  if (!response.ok || data.success === false) throw new Error(data.message || `Request failed with HTTP ${response.status}.`);
  return data;
}

function formatUser(user) {
  if (!user) return 'Unknown user';
  return `${user.playerName || 'Unknown'} [${user.playerId || '—'}]`;
}

function formatWarDate(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' }).format(new Date(value * 1000));
}

function formatDateTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value * 1000));
}

function toDateInput(timestamp) {
  return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
}

function formatRelativeTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return '—';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - value);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatActivityPerDay(value) {
  if (value === null || value === undefined || value === '') return 'Unavailable';
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 'Unavailable';
  const minutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function formatBattleStats(member) {
  const value = member?.battleStatsValue;
  if (value === null || value === undefined || value === '') return '<span class="unavailable">Unavailable</span>';
  const label = member.battleStatsVerified ? 'verified' : 'estimate';
  return `<span class="stat-value">${escapeHtml(formatCompactNumber(value))}</span><small class="stat-source ${member.battleStatsVerified ? 'verified' : ''}">${label}</small>`;
}

function formatCompactNumber(value) {
  if (value === null || value === undefined || value === '') return 'Unavailable';
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 'Unavailable';
  if (number >= 1e9) return `${(number / 1e9).toFixed(number >= 10e9 ? 1 : 2)}b`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 10e6 ? 1 : 2)}m`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(number >= 10e3 ? 1 : 2)}k`;
  return formatNumber(number);
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') return 'Unavailable';
  const number = Number(value);
  if (!Number.isFinite(number)) return 'Unavailable';
  return `${Math.round(number * 100)}%`;
}

function formatNullableDecimal(value, digits) {
  if (value === null || value === undefined || value === '') return 'Unavailable';
  const number = Number(value);
  if (!Number.isFinite(number)) return 'Unavailable';
  return number.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatDecimal(value, digits) {
  const number = Number(value || 0);
  return number.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatChainStatus(war) {
  if (!war.chain_adjustment_status) return 'Not adjusted';
  return war.chain_adjustment_status;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatSigned(value) {
  const number = Number(value || 0);
  if (number > 0) return `+${formatNumber(number)}`;
  return formatNumber(number);
}

function setLoginError(message) {
  loginError.textContent = message || '';
  loginError.classList.toggle('hidden', !message);
}

function setGlobalError(message) {
  globalError.textContent = message || '';
  globalError.classList.toggle('hidden', !message);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
