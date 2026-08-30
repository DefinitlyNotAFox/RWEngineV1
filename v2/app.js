const state = {
  user: null,
  dashboard: null,
  wars: [],
  intel: null,
  intelDays: 30,
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
const intelDays = document.querySelector('#intelDays');
const syncIntelButton = document.querySelector('#syncIntelButton');
const syncStatus = document.querySelector('#syncStatus');

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
  try {
    await api('logout');
  } catch (_) {
    // Local logout still proceeds if the server session has already expired.
  }

  state.user = null;
  state.dashboard = null;
  state.wars = [];
  state.intel = null;
  showLogin();
});

refreshButton.addEventListener('click', () => loadCoreData(true));
memberSearch.addEventListener('input', renderMembers);

intelDays.addEventListener('change', async () => {
  state.intelDays = Number(intelDays.value || 30);
  await loadIntel(true);
});

syncIntelButton.addEventListener('click', runFactionSync);

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

  state.intelDays = Number(intelDays.value || 30);
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
    const [dashboardResponse, warsResponse, intelResponse] = await Promise.all([
      api('getDashboardData', {
        filters: {
          termedFilter: 'ALL',
          memberFilter: 'ALL',
          search: ''
        },
        sortBy: 'ImpactScore',
        sortDirection: 'DESC'
      }),
      api('getImportedWars'),
      intelApi('getIntel', { days: state.intelDays }).catch(error => ({ __error: error }))
    ]);

    state.dashboard = dashboardResponse;
    state.wars = warsResponse.wars || [];

    if (intelResponse?.__error) {
      state.intel = null;
      setGlobalError(`Faction intel is not ready: ${intelResponse.__error.message}`);
    } else {
      state.intel = intelResponse;
    }

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

async function loadIntel(showBusyState = false) {
  if (showBusyState) intelDays.disabled = true;

  try {
    state.intel = await intelApi('getIntel', { days: state.intelDays });
    renderOverview();
    renderMembers();
    renderSyncStatus();
  } catch (error) {
    setGlobalError(`Faction intel: ${error.message}`);
  } finally {
    if (showBusyState) intelDays.disabled = false;
  }
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

    updateLocalSyncJob(job);

    while (!['completed', 'failed'].includes(job.status)) {
      const result = await intelApi('syncStep', { jobId: job.jobId });
      job = result.job;
      updateLocalSyncJob(job);

      if (!job) throw new Error('Faction sync lost its job state.');
      if (job.status === 'failed') throw new Error(job.error || 'Faction sync failed.');
      if (!['completed', 'failed'].includes(job.status)) await sleep(result.busy ? 1200 : 250);
    }

    await loadIntel(false);
  } catch (error) {
    setGlobalError(`Faction sync: ${error.message}`);
    try {
      await loadIntel(false);
    } catch (_) {
      // Keep the original sync error visible.
    }
  } finally {
    state.syncRunning = false;
    syncIntelButton.disabled = false;
    syncIntelButton.textContent = isActiveSync(state.intel?.sync) ? 'Resume sync' : 'Sync faction';
    renderSyncStatus();
  }
}

function updateLocalSyncJob(job) {
  if (!state.intel) state.intel = { members: [], summary: {}, days: state.intelDays };
  state.intel.sync = job;
  renderSyncStatus();
}

function renderAll() {
  renderOverview();
  renderMembers();
  renderWars();
  renderSyncStatus();
}

function renderOverview() {
  const summary = state.dashboard?.summary || {};
  const intelSummary = state.intel?.summary || {};
  const rows = state.dashboard?.rows || [];

  document.querySelector('#metricMembers').textContent = formatNumber(
    intelSummary.currentMembers ?? summary.membersShown ?? 0
  );
  document.querySelector('#metricWars').textContent = formatNumber(state.wars.length);
  document.querySelector('#metricHits').textContent = formatNumber(summary.totalHits || 0);
  document.querySelector('#metricNetScore').textContent = formatSigned(summary.totalNetScore || 0);

  const warsContainer = document.querySelector('#overviewWars');
  const recentWars = state.wars.slice(0, 5);

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
    : '<div class="empty">No imported wars found.</div>';

  const membersContainer = document.querySelector('#overviewMembers');
  const topMembers = [...rows]
    .sort((a, b) => Number(b.ImpactScore || 0) - Number(a.ImpactScore || 0))
    .slice(0, 5);

  membersContainer.innerHTML = topMembers.length
    ? topMembers.map(row => `
        <div class="stack-row">
          <div>
            <strong>${escapeHtml(row.Members || 'Unknown member')}</strong>
            <small>${formatNumber(row.Wars || 0)} wars · ${formatNumber(row.Assists || 0)} assists</small>
          </div>
          <div class="stack-value">${formatNumber(row.Hits || 0)} hits</div>
        </div>
      `).join('')
    : '<div class="empty">No member performance data found.</div>';
}

function renderMembers() {
  const tbody = document.querySelector('#membersBody');
  const search = memberSearch.value.trim().toLowerCase();
  const rows = getMemberRows().filter(row => {
    if (!search) return true;
    return String(row.playerName || '').toLowerCase().includes(search) ||
      String(row.playerId || '').includes(search);
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">No matching members. Run a faction sync to populate faction intelligence.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(row => `
      <tr>
        <td>
          <span class="member-name">${escapeHtml(row.playerName || 'Unknown')}</span>
          <span class="member-id">${escapeHtml(String(row.playerId || ''))}</span>
        </td>
        <td><span class="status-pill ${row.current ? 'active' : ''}">${row.current ? 'CURRENT' : 'LEFT'}</span></td>
        <td>${row.level ?? '—'}</td>
        <td>${escapeHtml(row.position || '—')}</td>
        <td title="${escapeHtml(formatDateTime(row.lastActionAt))}">${formatRelativeTime(row.lastActionAt)}</td>
        <td>${formatCompactNumber(row.battleStatsEstimate)}</td>
        <td>${formatActivityPerDay(row.activityPerDaySeconds)}</td>
        <td>${formatNullableDecimal(row.xanaxPerDay, 2)}</td>
        <td>${formatNumber(row.wars || 0)}</td>
        <td>${formatNumber(row.warHits || 0)}</td>
        <td>${formatPercent(row.participation)}</td>
        <td>${formatSigned(row.netScore || 0)}</td>
      </tr>
    `).join('');
}

function getMemberRows() {
  if (state.intel?.members?.length) return state.intel.members;

  return (state.dashboard?.rows || []).map(row => ({
    playerId: row.Player_ID,
    playerName: row.Members,
    current: row['Is Member'] === 'ACTIVE',
    level: null,
    position: '',
    lastActionAt: null,
    battleStatsEstimate: null,
    activityPerDaySeconds: null,
    xanaxPerDay: null,
    wars: Number(row.Wars || 0),
    warHits: Number(row.Hits || 0),
    participation: null,
    netScore: Number(row['Net Score'] || 0)
  }));
}

function renderSyncStatus() {
  const job = state.intel?.sync || null;

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
    ? `Last sync completed${job.tasksFailed ? ` with ${job.tasksFailed} unavailable/failed snapshots` : ''}.`
    : job.status === 'failed'
      ? `Sync failed: ${job.error || 'Unknown error'}`
      : job.phase === 'initializing'
        ? 'Reading the current faction roster…'
        : `Collecting member snapshots: ${done} / ${total}`;

  syncStatus.innerHTML = `
    <div>
      <strong>${escapeHtml(statusText)}</strong>
      ${job.seedHistory ? '<div>Initial history seed: 90 / 30 / 7 / current</div>' : '<div>Current-day refresh</div>'}
      ${total > 0 ? `<div class="sync-progress"><span style="width:${percent}%"></span></div>` : ''}
    </div>
    <div>${formatNumber(job.apiRequests || 0)} API requests</div>
  `;

  if (!state.syncRunning) {
    syncIntelButton.textContent = isActiveSync(job) ? 'Resume sync' : 'Sync faction';
  }
}

function isActiveSync(job) {
  return Boolean(job && ['queued', 'running'].includes(job.status));
}

function renderWars() {
  const tbody = document.querySelector('#warsBody');

  if (!state.wars.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No imported wars found.</td></tr>';
    return;
  }

  tbody.innerHTML = state.wars.map(war => `
    <tr>
      <td>${escapeHtml(war.opponent_faction_name || 'Unknown opponent')}</td>
      <td>${escapeHtml(String(war.war_id || '—'))}</td>
      <td>${formatWarDate(war.start_timestamp)}</td>
      <td>${formatWarDate(war.end_timestamp)}</td>
      <td>${escapeHtml(formatChainStatus(war))}</td>
    </tr>
  `).join('');
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
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action, ...payload })
  });

  return parseApiResponse(response);
}

async function intelApi(action, payload = {}) {
  const response = await fetch('/v2/intel', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action, ...payload })
  });

  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error(`Backend returned HTTP ${response.status} without JSON.`);
  }

  if (!response.ok || data.success === false) {
    throw new Error(data.message || `Request failed with HTTP ${response.status}.`);
  }

  return data;
}

function formatUser(user) {
  if (!user) return 'Unknown user';
  return `${user.playerName || 'Unknown'} [${user.playerId || '—'}]`;
}

function formatWarDate(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return '—';

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  }).format(new Date(value * 1000));
}

function formatDateTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value * 1000));
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
  return number.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
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
