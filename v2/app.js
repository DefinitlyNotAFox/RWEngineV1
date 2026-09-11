import {
  state, on, emit,
  api, adminApi, rangeApi, loadWarsApi,
  periodPayload, restorePeriod, setPeriodPreset, renderPeriodControls,
  currentFactionName, currentFactionId,
  routeTo, routeFromHash, setNotice,
  formatNumber, formatDateTime, escapeHtml
} from './core.js';

import { initIntel, renderIntel, refreshSyncStatus } from './intel.js';
import { initWarViews, renderWarOverview, renderArchive, loadPerformance } from './wars.js';

let loading = false;
let adminKeyFactionId = null;

init();

function init() {
  bindAuth();
  bindApplication();
  initIntel();
  initWarViews();
  boot();
}

function bindAuth() {
  document.querySelectorAll('[data-auth-mode]').forEach(button => {
    button.addEventListener('click', () => setAuthMode(button.dataset.authMode));
  });

  document.querySelector('#loginForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    setAuthError('');
    try {
      const result = await api('login', {
        playerId: document.querySelector('#loginPlayerId').value.trim(),
        password: document.querySelector('#loginPassword').value
      });
      document.querySelector('#loginPassword').value = '';
      state.user = result.user;
      await enterApp();
    } catch (error) {
      setAuthError(error.message);
    }
  });

  document.querySelector('#registerForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    setAuthError('');
    try {
      const result = await api('register', {
        apiKey: document.querySelector('#registerApiKey').value.trim(),
        password: document.querySelector('#registerPassword').value,
        confirmPassword: document.querySelector('#registerConfirm').value
      });
      state.user = result.user;
      document.querySelector('#registerApiKey').value = '';
      document.querySelector('#registerPassword').value = '';
      document.querySelector('#registerConfirm').value = '';
      await enterApp();
    } catch (error) {
      setAuthError(error.message);
    }
  });
}

function bindApplication() {
  document.addEventListener('click', event => {
    const routeButton = event.target.closest('[data-route]');
    if (routeButton) {
      routeTo(routeButton.dataset.route);
      return;
    }

    const periodButton = event.target.closest('[data-period]');
    if (periodButton) {
      const next = periodButton.dataset.period;
      if (!['last4','30d','year','all'].includes(next)) return;
      setPeriodPreset(next);
      renderPeriodControls();
      loadRangeOnly();
      return;
    }

    if (event.target.closest('[data-refresh]')) {
      refreshAll(true);
    }
  });

  window.addEventListener('hashchange', () => routeTo(routeFromHash(), { updateHash:false }));

  document.querySelector('#logoutButton')?.addEventListener('click', async () => {
    try { await api('logout'); } catch (_) {}
    resetState();
    showAuth();
  });

  document.querySelector('#adminFactionSelect')?.addEventListener('change', async event => {
    const factionId = Number(event.target.value || 0);
    if (!factionId || factionId === Number(state.selectedFactionId)) return;
    state.selectedFactionId = factionId;
    try { localStorage.setItem('rwengine.adminFaction', String(factionId)); } catch (_) {}
    renderIdentity();
    emit('faction', factionId);
    await refreshAll(false);
  });

  document.querySelector('#adminFactionList')?.addEventListener('click', event => {
    const row = event.target.closest('[data-admin-faction]');
    if (!row) return;
    const factionId = Number(row.dataset.adminFaction || 0);
    if (!factionId) return;
    adminKeyFactionId = factionId;
    if (Number(state.selectedFactionId) !== factionId) {
      state.selectedFactionId = factionId;
      try { localStorage.setItem('rwengine.adminFaction', String(factionId)); } catch (_) {}
      renderIdentity();
      renderAdminContext();
      emit('faction', factionId);
      refreshAll(false);
    } else {
      renderAdminKeyForm();
    }
  });

  document.querySelector('#adminKeyForm')?.addEventListener('submit', saveAdminKey);
  document.querySelector('#adminClearKey')?.addEventListener('click', clearAdminKey);

  on('request-refresh', () => refreshAll(false));

  on('open-member', playerId => {
    routeTo('intel');
    window.setTimeout(() => {
      const row = document.querySelector(`#intelBody tr[data-member-id="${Number(playerId)}"]`);
      row?.click();
      row?.scrollIntoView({ block:'center', behavior:'smooth' });
    }, 0);
  });

  on('route', route => {
    if (route === 'settings') renderAdminSettings();
  });
}

async function boot() {
  try {
    const result = await api('me');
    state.user = result.user;
    await enterApp();
  } catch (_) {
    showAuth();
  }
}

async function enterApp() {
  document.querySelector('#authView')?.classList.add('hidden');
  document.querySelector('#appView')?.classList.remove('hidden');

  if (state.user?.isAdmin) {
    await loadAdminFactions();
  } else {
    state.selectedFactionId = Number(state.user?.factionId || 0) || null;
  }

  renderIdentity();
  renderAdminContext();
  await refreshAll(false);
  routeTo(routeFromHash(), { updateHash:false });
}

function showAuth() {
  document.querySelector('#appView')?.classList.add('hidden');
  document.querySelector('#authView')?.classList.remove('hidden');
  setAuthMode('login');
  setAuthError('');
}

function setAuthMode(mode) {
  const register = mode === 'register';
  document.querySelector('#loginForm')?.classList.toggle('hidden', register);
  document.querySelector('#registerForm')?.classList.toggle('hidden', !register);
  document.querySelectorAll('[data-auth-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.authMode === mode);
  });
  setAuthError('');
}

function setAuthError(message) {
  const el = document.querySelector('#authError');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

async function refreshAll(userInitiated = false) {
  if (loading) return;
  loading = true;
  setRefreshBusy(true);

  if (userInitiated) setNotice('Refreshing data…');

  try {
    const warsResult = await loadWarsApi();
    state.wars = warsResult.wars || [];

    if (!state.period.from && !state.period.to) restorePeriod();
    else setPeriodPreset(state.period.preset);

    const rangeResult = await rangeApi('getRange', periodPayload());
    state.range = rangeResult;

    renderPeriodControls();
    renderIdentity();
    renderHome();
    renderIntel();
    renderWarOverview();
    renderArchive();
    await refreshSyncStatus();

    emit('data');

    if (userInitiated) setNotice('');
  } catch (error) {
    setNotice(error.message || 'Failed to refresh RWEngine data.', 'error');
  } finally {
    loading = false;
    setRefreshBusy(false);
  }
}

async function loadRangeOnly() {
  if (loading) return;
  loading = true;
  setRefreshBusy(true);

  try {
    state.range = await rangeApi('getRange', periodPayload());
    renderPeriodControls();
    renderHome();
    renderIntel();
    renderWarOverview();
    emit('data');
  } catch (error) {
    setNotice(error.message || 'Failed to change period.', 'error');
  } finally {
    loading = false;
    setRefreshBusy(false);
  }
}

function renderHome() {
  const faction = currentFactionName();
  const range = state.range;
  const wars = state.wars.length;

  const factionEl = document.querySelector('#homeFaction');
  if (factionEl) factionEl.textContent = faction;

  const coverage = document.querySelector('#homeCoverage');
  if (coverage) {
    const tracked = range?.trackingStartedAt ? formatDateTime(range.trackingStartedAt) : 'not started';
    const members = formatNumber(range?.summary?.currentMembers || 0);
    coverage.textContent = `${members} current members · ${formatNumber(wars)} imported wars · tracking since ${tracked}`;
  }
}

function renderIdentity() {
  const factionName = currentFactionName();
  const factionId = currentFactionId();
  const userName = state.user?.playerName || 'Account';
  const playerId = state.user?.playerId || '—';

  const factionButton = document.querySelector('#factionButton');
  const accountButton = document.querySelector('#accountButton');
  if (factionButton) factionButton.textContent = factionName;
  if (accountButton) accountButton.textContent = userName;

  document.querySelector('#settingsPlayer').textContent = `${userName} [${playerId}]`;
  document.querySelector('#settingsFaction').textContent = factionName || '—';
  document.querySelector('#settingsFactionId').textContent = factionId || '—';
}

function setRefreshBusy(busy) {
  document.querySelectorAll('[data-refresh]').forEach(button => {
    button.disabled = busy;
    button.textContent = busy ? 'Refreshing…' : 'Refresh';
  });
}

async function loadAdminFactions() {
  const result = await adminApi('listFactions');
  state.adminFactions = result.factions || [];

  let stored = 0;
  try { stored = Number(localStorage.getItem('rwengine.adminFaction') || 0); } catch (_) {}

  const valid = new Set(state.adminFactions.map(item => Number(item.factionId)));
  state.selectedFactionId = valid.has(stored)
    ? stored
    : (valid.has(Number(state.user?.factionId)) ? Number(state.user.factionId) : Number(state.adminFactions[0]?.factionId || 0));

  const validAdminKeyFaction = state.adminFactions.some(item => Number(item.factionId) === Number(adminKeyFactionId));
  if (!validAdminKeyFaction) adminKeyFactionId = state.selectedFactionId;
}

function renderAdminContext() {
  const wrap = document.querySelector('#adminFactionWrap');
  const select = document.querySelector('#adminFactionSelect');
  const section = document.querySelector('#adminSection');

  const isAdmin = Boolean(state.user?.isAdmin);
  wrap?.classList.toggle('hidden', !isAdmin);
  section?.classList.toggle('hidden', !isAdmin);
  if (!isAdmin || !select) return;

  select.innerHTML = state.adminFactions.map(faction =>
    `<option value="${faction.factionId}"${Number(faction.factionId) === Number(state.selectedFactionId) ? ' selected' : ''}>${escapeHtml(faction.factionName)} [${faction.factionId}]</option>`
  ).join('');

  renderAdminSettings();
}

function renderAdminSettings() {
  const section = document.querySelector('#adminSection');
  if (!section || !state.user?.isAdmin) return;

  const list = document.querySelector('#adminFactionList');
  if (list) {
    list.innerHTML = state.adminFactions.map(faction => `
      <button class="admin-faction-row" type="button" data-admin-faction="${faction.factionId}">
        <span>
          <strong>${escapeHtml(faction.factionName)} [${faction.factionId}]</strong>
          <small>${formatNumber(faction.currentMembers)} members · ${formatNumber(faction.warCount)} wars · ${faction.hasApiKey ? `API key: ${escapeHtml(faction.keySource)}` : 'API key missing'}</small>
        </span>
        <b>${Number(faction.factionId) === Number(state.selectedFactionId) ? 'Active' : 'Manage'}</b>
      </button>
    `).join('');
  }

  renderAdminKeyForm();
}

function renderAdminKeyForm() {
  const form = document.querySelector('#adminKeyForm');
  if (!form || !state.user?.isAdmin || !adminKeyFactionId) {
    form?.classList.add('hidden');
    return;
  }

  const faction = state.adminFactions.find(item => Number(item.factionId) === Number(adminKeyFactionId));
  if (!faction) {
    form.classList.add('hidden');
    return;
  }

  form.classList.remove('hidden');
  document.querySelector('#adminKeyHeading').textContent = `${faction.factionName} [${faction.factionId}]`;
  document.querySelector('#adminKeyStatus').textContent = faction.hasApiKey
    ? `Current key source: ${faction.keySource}${faction.keyOwnerName ? ` · ${faction.keyOwnerName}` : ''}`
    : 'No usable API key is available.';
  document.querySelector('#adminClearKey').disabled = faction.keySource !== 'managed';
}

async function saveAdminKey(event) {
  event.preventDefault();
  const key = document.querySelector('#adminApiKey').value.trim();
  if (!key || !adminKeyFactionId) return;

  const status = document.querySelector('#adminKeyStatus');
  try {
    status.textContent = 'Verifying and saving key…';
    const result = await adminApi('setApiKey', { factionId:adminKeyFactionId, apiKey:key });
    document.querySelector('#adminApiKey').value = '';
    status.textContent = result.message || 'API key saved.';
    await loadAdminFactions();
    renderAdminContext();
  } catch (error) {
    status.textContent = error.message || 'Failed to save API key.';
  }
}

async function clearAdminKey() {
  if (!adminKeyFactionId) return;
  const status = document.querySelector('#adminKeyStatus');
  try {
    status.textContent = 'Removing managed key…';
    const result = await adminApi('clearApiKey', { factionId:adminKeyFactionId });
    status.textContent = result.message || 'Managed key removed.';
    await loadAdminFactions();
    renderAdminContext();
  } catch (error) {
    status.textContent = error.message || 'Failed to remove managed key.';
  }
}

function resetState() {
  state.user = null;
  state.adminFactions = [];
  state.selectedFactionId = null;
  state.wars = [];
  state.range = null;
  state.period = { preset:'last4', from:null, to:null };
  state.route = 'home';
  setNotice('');
}
