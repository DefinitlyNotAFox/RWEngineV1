const state = {
  user: null,
  dashboard: null,
  wars: []
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
  showLogin();
});

refreshButton.addEventListener('click', () => loadCoreData(true));
memberSearch.addEventListener('input', renderMembers);

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
    const [dashboardResponse, warsResponse] = await Promise.all([
      api('getDashboardData', {
        filters: {
          termedFilter: 'ALL',
          memberFilter: 'ALL',
          search: ''
        },
        sortBy: 'ImpactScore',
        sortDirection: 'DESC'
      }),
      api('getImportedWars')
    ]);

    state.dashboard = dashboardResponse;
    state.wars = warsResponse.wars || [];

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

function renderAll() {
  renderOverview();
  renderMembers();
  renderWars();
}

function renderOverview() {
  const summary = state.dashboard?.summary || {};
  const rows = state.dashboard?.rows || [];

  document.querySelector('#metricMembers').textContent = formatNumber(summary.membersShown || 0);
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
  const rows = (state.dashboard?.rows || []).filter(row => {
    if (!search) return true;
    return String(row.Members || '').toLowerCase().includes(search) ||
      String(row.Player_ID || '').includes(search);
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">No matching members.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const isActive = row['Is Member'] === 'ACTIVE';

    return `
      <tr>
        <td>
          <span class="member-name">${escapeHtml(row.Members || 'Unknown')}</span>
          <span class="member-id">${escapeHtml(String(row.Player_ID || ''))}</span>
        </td>
        <td><span class="status-pill ${isActive ? 'active' : ''}">${escapeHtml(row['Is Member'] || '—')}</span></td>
        <td>${formatNumber(row.Wars || 0)}</td>
        <td>${formatNumber(row.Hits || 0)}</td>
        <td>${formatNumber(row['Outside Hits'] || 0)}</td>
        <td>${formatNumber(row.Assists || 0)}</td>
        <td>${formatNumber(row['Sum Score up'] || 0)}</td>
        <td>${formatNumber(row['Sum Score down'] || 0)}</td>
        <td>${formatSigned(row['Net Score'] || 0)}</td>
        <td>${formatDecimal(row['Avg R/hit'] || 0, 2)}</td>
      </tr>
    `;
  }).join('');
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

function formatChainStatus(war) {
  if (!war.chain_adjustment_status) return 'Not adjusted';
  return war.chain_adjustment_status;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatDecimal(value, digits) {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
