import {
  state, on, emit,
  api, adminApi, rangeApi, loadWarsApi, freshnessApi, shareApi,
  periodPayload, restorePeriod, setPeriodPreset, renderPeriodControls,
  currentFactionName, currentFactionId,
  routeTo, routeFromHash, setNotice,
  formatNumber, formatDate, formatDateTime, formatAge, escapeHtml
} from './core.js';

import { initIntel, renderIntel, refreshSyncStatus } from './intel.js?v=2';
import { initIntelV2 } from './intel-v2.js?v=28';
import { initWarViews, renderWarOverview, renderArchive } from './wars.js?v=10';

const legacyIntelMode = new URL(location.href).searchParams.get('legacyIntel') === '1';

let loading = false;
let adminKeyFactionId = null;
let databaseBusy = false;

init();

function init() {
  bindAuth();
  bindApplication();
  configureIntelMode();
  if (legacyIntelMode) initIntel();
  else initIntelV2();
  initWarViews();
  boot();
}

function configureIntelMode() {
  document.body.classList.toggle('legacy-intel-mode', legacyIntelMode);
  document.querySelector('#intelFilters')?.classList.toggle('hidden', legacyIntelMode);
  document.querySelector('#periodControl')?.classList.toggle('hidden', !legacyIntelMode);
  document.querySelectorAll('[data-intel2-only]').forEach(element => {
    element.classList.toggle('hidden', legacyIntelMode);
  });

  if (legacyIntelMode) {
    const head = document.querySelector('#intelHead');
    if (head) {
      head.innerHTML = `
        <tr>
          <th>Member</th>
          <th data-intel-sort="stats">Battle stats</th>
          <th data-intel-sort="activity">Activity / day</th>
          <th data-intel-sort="xanax">Xanax / day</th>
          <th data-intel-sort="participation">War participation</th>
          <th data-intel-sort="hits">Hits per war</th>
        </tr>
      `;
    }
  }
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
      if (legacyIntelMode) loadRangeOnly();
      return;
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
    adminKeyFactionId = factionId;
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
  document.querySelector('#databaseCheck')?.addEventListener('click', checkDatabaseStatus);
  document.querySelector('#databaseApply')?.addEventListener('click', applyDatabaseMaintenance);

  document.querySelector('#accessList')?.addEventListener('change', handleAccessChange);

  on('request-refresh', () => refreshAll(false));

  on('open-member', () => {
    routeTo('intel');
    window.setTimeout(() => {
      document.querySelector('#intelBody [data-member-id].selected')?.scrollIntoView({ block:'center', behavior:'smooth' });
    }, 0);
  });

  on('route', route => {
    if (route === 'settings') {
      renderAdminSettings();
      loadAccessList();
    }
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

  // Restore the previous workspace immediately so reloads do not flash Home
  // while faction data is still refreshing.
  routeTo(routeFromHash(), { updateHash:false });
  await refreshAll(false);
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
  if (userInitiated) setRefreshStatus('Refreshing data…');

  try {
    const [warsResult, freshnessResult] = await Promise.all([
      loadWarsApi(),
      freshnessApi().catch(() => null)
    ]);
    state.wars = warsResult.wars || [];
    state.freshness = freshnessResult || null;

    if (!state.period.from && !state.period.to) restorePeriod();
    else setPeriodPreset(state.period.preset);

    if (legacyIntelMode) {
      state.range = await rangeApi('getRange', periodPayload());
    } else {
      state.range = null;
    }

    renderPeriodControls();
    renderIdentity();
    renderHome();
    if (legacyIntelMode) renderIntel();
    renderArchive();
    renderFreshness();
    if (legacyIntelMode) await refreshSyncStatus();

    emit('data');
    if (state.route === 'settings') loadAccessList();

    if (userInitiated) setRefreshStatus('');
  } catch (error) {
    setRefreshStatus(error.message || 'Failed to refresh RWEngine data.', true);
  } finally {
    loading = false;
  }
}

async function loadRangeOnly() {
  if (!legacyIntelMode || loading) return;
  loading = true;
  setRefreshBusy(true);

  try {
    state.range = await rangeApi('getRange', periodPayload());
    renderPeriodControls();
    renderHome();
    renderIntel();
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
    const intel = state.freshness?.datasets?.intel;
    const members = formatNumber(
      legacyIntelMode
        ? range?.summary?.currentMembers || 0
        : intel?.memberCount || 0
    );
    const freshness = intel?.observedAt
      ? ` · faction data ${intel.state === 'stale' ? 'stale' : 'updated'} ${formatAge(intel.ageSeconds)}`
      : '';
    coverage.textContent = `${members} current members · ${formatNumber(wars)} imported wars${freshness}`;
  }
}

function renderFreshness() {
  const intel = state.freshness?.datasets?.intel;
  const wars = state.freshness?.datasets?.wars;

  setFreshness(
    '#intelFreshness',
    intel?.state === 'syncing'
      ? `Syncing · ${intel.activeSync?.phase || 'updating'}`
      : intel?.observedAt
        ? `${intel.state === 'stale' ? 'Stale' : 'Updated'} ${formatAge(intel.ageSeconds)}`
        : 'No synced Intel data',
    intel?.state === 'stale'
  );

  const warText = wars?.warCount
    ? `Archive updated ${formatAge(wars.ageSeconds)}`
    : 'No archive data';

  setFreshness('#archiveFreshness', warText, false);
}

function setFreshness(selector, message, stale) {
  const element = document.querySelector(selector);
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('stale', Boolean(stale));
}

async function loadAccessList() {
  const list = document.querySelector('#accessList');
  const status = document.querySelector('#accessStatus');
  if (!list || !state.user) return;

  try {
    if (status) {
      status.textContent = '';
      status.classList.add('hidden');
    }

    const result = await shareApi('list');
    const resources = result.resources || [];

    list.innerHTML = resources.length
      ? resources.map(resource => `
          <div class="access-row">
            <div>
              <strong>${escapeHtml(resource.title || 'War report')}</strong>
              <small>#${escapeHtml(resource.resourceKey)} · ${escapeHtml(formatDate(resource.endedAt || resource.importedAt))}${resource.publicLinkActive ? ' · public link active' : ''}</small>
            </div>
            <select class="access-select" data-access-key="${escapeHtml(resource.resourceKey)}">
              <option value="private"${resource.visibility === 'private' ? ' selected' : ''}>Private</option>
              <option value="faction"${resource.visibility === 'faction' ? ' selected' : ''}>Faction</option>
              <option value="public"${resource.visibility === 'public' ? ' selected' : ''}>Public</option>
            </select>
          </div>
        `).join('')
      : '<div class="access-empty">No report visibility settings to manage.</div>';
  } catch (error) {
    list.innerHTML = '';
    if (status) {
      status.textContent = error.message || 'Failed to load report visibility.';
      status.classList.remove('hidden');
      status.classList.add('error');
    }
  }
}

async function handleAccessChange(event) {
  const select = event.target.closest('[data-access-key]');
  if (!select) return;

  const status = document.querySelector('#accessStatus');
  select.disabled = true;

  try {
    const result = await shareApi('setVisibility', {
      resourceType: 'war',
      warId: select.dataset.accessKey,
      visibility: select.value
    });

    if (result.shareUrl) {
      try {
        await navigator.clipboard.writeText(result.shareUrl);
        if (status) status.textContent = 'Public link created and copied.';
      } catch (_) {
        if (status) status.textContent = 'Public link created. Open the report to copy or rotate it.';
      }
    } else if (status) {
      status.textContent = result.message || 'Visibility updated.';
    }

    if (status) {
      status.classList.remove('hidden', 'error');
    }

    await refreshAll(false);
  } catch (error) {
    if (status) {
      status.textContent = error.message || 'Failed to update visibility.';
      status.classList.remove('hidden');
      status.classList.add('error');
    }
    await loadAccessList();
  } finally {
    select.disabled = false;
  }
}

async function checkDatabaseStatus() {
  if (!state.user?.isAdmin || databaseBusy) return;

  const factionId = Number(state.selectedFactionId || 0);
  if (!factionId) {
    setDatabaseStatus('Select a tracked faction first.', true);
    return;
  }

  databaseBusy = true;
  setDatabaseButtons(true);
  setDatabaseStatus('Checking D1 schema and query plans…');
  clearDatabaseDiagnostics();

  try {
    const result = await adminApi('databaseStatus', { factionId });
    renderDatabaseDiagnostics(result);

    if (result.schema?.ready && !(result.warnings || []).length) {
      setDatabaseStatus('D1 maintenance is applied and the sampled plans show no full scans of the watched analytics tables.');
    } else if (!result.schema?.ready) {
      setDatabaseStatus('D1 is missing one or more maintenance objects. Apply maintenance before benchmarking.', true);
    } else {
      setDatabaseStatus('D1 schema is ready, but one or more sampled plans still contain a full table scan.', true);
    }
  } catch (error) {
    setDatabaseStatus(error.message || 'Failed to inspect D1.', true);
  } finally {
    databaseBusy = false;
    setDatabaseButtons(false);
  }
}

async function applyDatabaseMaintenance() {
  if (!state.user?.isAdmin || databaseBusy) return;

  const factionId = Number(state.selectedFactionId || 0);
  if (!factionId) {
    setDatabaseStatus('Select a tracked faction first.', true);
    return;
  }

  databaseBusy = true;
  setDatabaseButtons(true);
  clearDatabaseDiagnostics();

  let step = 0;
  try {
    while (step < 20) {
      setDatabaseStatus(`Applying database maintenance · step ${step + 1}…`);
      const result = await adminApi('applyDatabaseMaintenance', {
        factionId,
        step
      });

      step = Number(result.nextStep ?? step + 1);
      if (result.done) break;
    }

    if (step >= 20) {
      throw new Error('Database maintenance exceeded the safety step limit.');
    }

    setDatabaseStatus('Database maintenance applied. Verifying query plans…');
    const status = await adminApi('databaseStatus', { factionId });
    renderDatabaseDiagnostics(status);

    if (status.schema?.ready && !(status.warnings || []).length) {
      setDatabaseStatus('Database maintenance complete. Required indexes are present and sampled plans show no watched full scans.');
    } else if (!status.schema?.ready) {
      setDatabaseStatus('Maintenance ran, but D1 is still missing a required object.', true);
    } else {
      setDatabaseStatus('Maintenance is applied, but a sampled query plan still contains a full scan.', true);
    }
  } catch (error) {
    setDatabaseStatus(error.message || 'Database maintenance failed.', true);
  } finally {
    databaseBusy = false;
    setDatabaseButtons(false);
  }
}

function renderDatabaseDiagnostics(result) {
  const container = document.querySelector('#databaseDiagnostics');
  if (!container) return;

  const required = result.schema?.required || {};
  const schemaRows = [
    ['Permissions table', required.resourcePermissionsTable],
    ['Permission lookup index', required.resourcePermissionLookupIndex],
    ['Permission owner index', required.resourcePermissionOwnerIndex],
    ['Attack attacker index', required.attackerIndex],
    ['Attack defender index', required.defenderIndex],
    ['Snapshot history index', required.snapshotIndex],
    ['War-log player index', required.warLogIndex]
  ];

  const plans = Array.isArray(result.plans) ? result.plans : [];
  const sample = result.sample || {};

  container.innerHTML = `
    <div class="database-summary">
      <div>
        <strong>${escapeHtml(result.faction?.factionName || 'Faction')} [${escapeHtml(result.faction?.factionId || '—')}]</strong>
        <small>Sample war #${escapeHtml(sample.warId || '—')} · player ${escapeHtml(sample.playerName || sample.playerId || '—')}</small>
      </div>
      <b class="${result.schema?.ready ? 'ok' : 'warn'}">${result.schema?.ready ? 'Schema ready' : 'Maintenance required'}</b>
    </div>

    <div class="database-object-list">
      ${schemaRows.map(([label, ready]) => `
        <div><span>${escapeHtml(label)}</span><b class="${ready ? 'ok' : 'warn'}">${ready ? 'Present' : 'Missing'}</b></div>
      `).join('')}
    </div>

    <div class="database-plan-list">
      ${plans.map(plan => `
        <section>
          <header>
            <strong>${escapeHtml(plan.label || 'Query plan')}</strong>
            <b class="${plan.ok && !(plan.warnings || []).length ? 'ok' : 'warn'}">${plan.ok ? ((plan.warnings || []).length ? 'Scan found' : 'OK') : 'Failed'}</b>
          </header>
          ${(plan.details || []).map(detail => `<code>${escapeHtml(detail)}</code>`).join('') || '<code>No plan rows returned.</code>'}
        </section>
      `).join('')}
    </div>

    ${(result.warnings || []).length ? `
      <div class="database-warning-list">
        ${result.warnings.map(warning => `<span>${escapeHtml(warning)}</span>`).join('')}
      </div>
    ` : ''}
  `;

  container.classList.remove('hidden');
}

function clearDatabaseDiagnostics() {
  const container = document.querySelector('#databaseDiagnostics');
  if (!container) return;
  container.innerHTML = '';
  container.classList.add('hidden');
}

function setDatabaseStatus(message, error = false) {
  const element = document.querySelector('#databaseStatus');
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('hidden', !message);
  element.classList.toggle('error', error);
}

function setDatabaseButtons(disabled) {
  const check = document.querySelector('#databaseCheck');
  const apply = document.querySelector('#databaseApply');
  if (check) check.disabled = disabled;
  if (apply) apply.disabled = disabled;
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

function setRefreshStatus(message = '', error = false) {
  const factionLine = document.querySelector('#refreshLine');
  const onFaction = state.route === 'intel';

  if (factionLine) {
    factionLine.textContent = onFaction ? (message || '') : '';
    factionLine.classList.toggle('hidden', !onFaction || !message);
    factionLine.classList.toggle('error', onFaction && error);
  }

  if (onFaction) {
    setNotice('');
  } else {
    setNotice(message || '', error ? 'error' : '');
  }
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
  document.querySelector('#factionButton')?.classList.toggle('hidden', isAdmin);
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
  state.freshness = null;
  state.period = { preset:'last4', from:null, to:null };
  state.route = 'home';
  setNotice('');
}
