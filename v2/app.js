import {
  state, on, emit,
  api, adminApi, rangeApi, loadWarsApi, freshnessApi, shareApi, rolesApi, autoTagsApi,
  periodPayload, restorePeriod, setPeriodPreset, renderPeriodControls,
  currentFactionName, currentFactionId,
  actualUserRole, availableViewRoles, currentViewRole,
  canEditFactionView, isPlatformAdminView, isRolePreviewActive, restoreRolePreview,
  roleLabel, setRolePreview,
  routeTo, routeFromHash, setNotice,
  formatNumber, formatDate, formatDateTime, formatAge, escapeHtml
} from './core.js?v=5';

import { sortFactionAccounts, sortTrackedFactions } from './sort.js?v=1';

import { initIntel, renderIntel, refreshSyncStatus } from './intel.js?v=6';
import { initIntelV2 } from './intel-v2.js?v=52';
import { initWarViews, renderWarOverview, renderArchive } from './wars.js?v=19';

const legacyIntelMode = new URL(location.href).searchParams.get('legacyIntel') === '1';

let loading = false;
let adminKeyFactionId = null;
let databaseBusy = false;
let maintenanceBusy = false;
let personalApiKeyBusy = false;
let factionRolesLoading = false;
let factionRoleCandidates = [];
let autoTagSettingsLoading = false;
let autoTagSettingsBusy = false;
let accountCloseBusy = false;

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
      if (Number(error?.status) === 503) {
        showMaintenance();
      } else {
        setAuthError(error.message);
      }
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
    const maintenanceActive = Boolean(state.maintenanceMode);
    try { await api('logout'); } catch (_) {}
    resetState();
    if (maintenanceActive) showMaintenance();
    else showAuth();
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

  document.querySelector('#rolePreviewSelect')?.addEventListener('change', event => {
    setRolePreview(event.target.value);
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
  document.querySelector('#personalApiKeyForm')?.addEventListener('submit', savePersonalApiKey);
  document.querySelector('#personalApiKeyRemove')?.addEventListener('click', removePersonalApiKey);
  document.querySelector('#closeAccountButton')?.addEventListener('click', closeAccount);
  document.querySelector('#adminClearKey')?.addEventListener('click', clearAdminKey);
  document.querySelector('#databaseCheck')?.addEventListener('click', checkDatabaseStatus);
  document.querySelector('#databaseApply')?.addEventListener('click', applyDatabaseMaintenance);
  document.querySelector('#maintenanceToggle')?.addEventListener('click', toggleMaintenance);
  document.querySelector('#maintenanceAdminLogin')?.addEventListener('click', () => showAuth(true));

  document.querySelector('#accessList')?.addEventListener('change', handleAccessChange);
  document.querySelector('#factionRolesList')?.addEventListener('change', handleFactionRoleChange);
  document.querySelector('#factionRoleAddToggle')?.addEventListener('click', () => toggleFactionRoleAdd(true));
  document.querySelector('#factionRoleAddCancel')?.addEventListener('click', () => toggleFactionRoleAdd(false));
  document.querySelector('#factionRoleAddForm')?.addEventListener('submit', handleFactionRoleAdd);
  document.querySelector('#autoTagSettingsForm')?.addEventListener('submit', saveAutoTagSettings);
  document.querySelector('#autoTagSettingsReset')?.addEventListener('click', resetAutoTagSettings);

  on('request-refresh', () => refreshAll(false));

  on('open-member', () => {
    routeTo('intel');
    window.setTimeout(() => {
      document.querySelector('#intelBody [data-member-id].selected')?.scrollIntoView({ block:'center', behavior:'smooth' });
    }, 0);
  });

  on('route', route => {
    if (route === 'settings') {
      renderSettingsPermissions();
      renderAdminSettings();
      loadAccessList();
      loadFactionRoles();
      loadAutoTagSettings();
    }
  });

  on('role-preview', () => {
    renderRolePreview();
    renderIdentity();
    renderSettingsPermissions();
    renderAdminContext();
    renderArchive();
    if (state.route === 'settings') {
      loadAccessList();
      loadFactionRoles();
      loadAutoTagSettings();
    }
  });
}

async function boot() {
  try {
    const result = await api('me');
    state.user = result.user;
    await enterApp();
  } catch (error) {
    if (Number(error?.status) === 503) showMaintenance();
    else showAuth();
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

  restoreRolePreview();
  renderRolePreview();
  renderIdentity();
  renderAdminContext();

  // Restore the previous view while faction data refreshes.
  routeTo(routeFromHash(), { updateHash:false });
  await refreshAll(false);
}

function showAuth(adminOnly = false) {
  document.querySelector('#appView')?.classList.add('hidden');
  document.querySelector('#maintenanceView')?.classList.add('hidden');
  document.querySelector('#authView')?.classList.remove('hidden');
  document.querySelector('[data-auth-mode="register"]')?.classList.toggle('hidden', adminOnly);
  setAuthMode('login');
  setAuthError('');
}

function showMaintenance() {
  document.querySelector('#appView')?.classList.add('hidden');
  document.querySelector('#authView')?.classList.add('hidden');
  document.querySelector('#maintenanceView')?.classList.remove('hidden');
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
    if (legacyIntelMode) renderIntel();
    renderArchive();
    renderFreshness();
    if (legacyIntelMode) await refreshSyncStatus();

    emit('data');
    if (state.route === 'settings') {
      loadAccessList();
      loadFactionRoles();
      loadAutoTagSettings();
    }

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
    renderIntel();
    emit('data');
  } catch (error) {
    setNotice(error.message || 'Failed to change period.', 'error');
  } finally {
    loading = false;
    setRefreshBusy(false);
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

  renderSettingsPermissions();
  if (!canEditFactionView()) {
    list.innerHTML = '';
    if (status) {
      status.textContent = '';
      status.classList.add('hidden');
    }
    return;
  }

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
            <select class="access-select" data-access-key="${escapeHtml(resource.resourceKey)}" aria-label="Visibility for ${escapeHtml(resource.title || 'war report')}">
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
  if (!canEditFactionView()) return;
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
    ['Attack aggregates', required.attackAggregates],
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
  const userName = state.user?.playerName || 'Account';

  const factionButton = document.querySelector('#factionButton');
  const accountButton = document.querySelector('#accountButton');
  if (factionButton) factionButton.textContent = factionName;
  if (accountButton) accountButton.textContent = userName;

  renderPersonalApiKeyStatus();
  renderSettingsPermissions();
}

function renderPersonalApiKeyStatus(message = '', error = false) {
  const status = document.querySelector('#personalApiKeyStatus');
  if (!status || personalApiKeyBusy && !message) return;

  const hasApiKey = Boolean(state.user?.hasApiKey);
  const pending = personalApiKeyBusy && !error && /verifying|checking|saving|removing/i.test(message);
  const detailState = error ? 'error' : pending ? 'pending' : hasApiKey ? 'ok' : 'missing';

  status.textContent = message || (
    hasApiKey
      ? 'Verified and ready.'
      : 'No verified key.'
  );
  status.classList.toggle('error', Boolean(error));
  status.dataset.state = detailState;

  const removeButton = document.querySelector('#personalApiKeyRemove');
  if (removeButton) removeButton.disabled = personalApiKeyBusy || !hasApiKey;
}

function renderSettingsPermissions() {
  const reportSection = document.querySelector('#reportAccessSection');
  const rolesSection = document.querySelector('#factionRolesSection');
  const autoTagsSection = document.querySelector('#autoTagSettingsSection');
  const factionHeading = document.querySelector('#factionSettingsHeading');
  const canManageReports = canEditFactionView();
  const canManageRoles = canManageFactionRolesView();
  const canManageAutoTags = canManageAutoTagSettingsView();
  const showFactionSettings = canManageReports || canManageRoles || canManageAutoTags;

  reportSection?.classList.toggle('hidden', !canManageReports);
  rolesSection?.classList.toggle('hidden', !canManageRoles);
  autoTagsSection?.classList.toggle('hidden', !canManageAutoTags);
  factionHeading?.classList.toggle('hidden', !showFactionSettings);

  if (!canManageReports) {
    const list = document.querySelector('#accessList');
    if (list) list.innerHTML = '';
  }
  if (!canManageRoles) {
    const list = document.querySelector('#factionRolesList');
    if (list) list.innerHTML = '';
  }
  if (!canManageAutoTags) {
    const list = document.querySelector('#autoTagSettingsList');
    if (list) list.innerHTML = '';
  }
}

function canManageAutoTagSettingsView() {
  if (!state.user) return false;
  const viewRole = currentViewRole();
  if (viewRole === 'platform_admin') return true;
  if (viewRole !== 'faction_admin') return false;
  if (state.user.isAdmin) return Boolean(currentFactionId());

  return Number(state.user.factionId || 0) === Number(currentFactionId() || 0);
}

function canManageFactionRolesView() {
  if (!state.user) return false;
  if (state.user.isAdmin && isPlatformAdminView()) return true;

  const sameFaction = Number(state.user.factionId || 0) === Number(currentFactionId() || 0);
  const leadership = String(state.user.factionLeadershipRole || '');
  const leadershipCanManage = ['leader','co_leader'].includes(leadership);
  const loweredPreview = isRolePreviewActive() &&
    !['platform_admin','faction_admin'].includes(currentViewRole());

  return sameFaction && leadershipCanManage && !loweredPreview;
}

function renderRolePreview() {
  const wrap = document.querySelector('#rolePreviewWrap');
  const select = document.querySelector('#rolePreviewSelect');
  if (!wrap || !select) return;

  const roles = availableViewRoles();
  const visible = roles.length > 1;
  wrap.classList.toggle('hidden', !visible);
  wrap.classList.toggle('preview-active', isRolePreviewActive());
  document.body.dataset.viewRole = currentViewRole();

  if (!visible) {
    select.innerHTML = '';
    return;
  }

  const current = currentViewRole();
  select.innerHTML = roles.map(role =>
    `<option value="${role}"${role === current ? ' selected' : ''}>${roleLabel(role)}</option>`
  ).join('');
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

async function savePersonalApiKey(event) {
  event.preventDefault();
  if (personalApiKeyBusy) return;

  const input = document.querySelector('#personalApiKey');
  const apiKey = String(input?.value || '').trim();
  if (!apiKey) {
    renderPersonalApiKeyStatus('Enter a Torn API key first.', true);
    return;
  }

  personalApiKeyBusy = true;
  setPersonalApiKeyBusy(true);
  renderPersonalApiKeyStatus('Verifying this key with Torn…');

  try {
    const previousFactionId = Number(state.user?.factionId || 0);
    const result = await api('updateApiKey', { apiKey });
    state.user = result.user;
    if (input) input.value = '';

    if (state.user?.isAdmin) {
      await loadAdminFactions();
    } else {
      state.selectedFactionId = Number(state.user?.factionId || 0) || null;
    }

    restoreRolePreview();
    renderRolePreview();
    renderIdentity();
    renderAdminContext();

    if (previousFactionId !== Number(state.user?.factionId || 0)) {
      emit('faction', state.user?.factionId || null);
    }
    await refreshAll(false);
    renderPersonalApiKeyStatus(result.message || 'Personal Torn API key saved.');
  } catch (error) {
    renderPersonalApiKeyStatus(error.message || 'Failed to save that API key.', true);
  } finally {
    personalApiKeyBusy = false;
    setPersonalApiKeyBusy(false);
  }
}

function setPersonalApiKeyBusy(busy) {
  const input = document.querySelector('#personalApiKey');
  const button = document.querySelector('#personalApiKeySave');
  const removeButton = document.querySelector('#personalApiKeyRemove');
  if (input) input.disabled = busy;
  if (button) button.disabled = busy;
  if (removeButton) removeButton.disabled = busy || !state.user?.hasApiKey;
}

async function removePersonalApiKey() {
  if (personalApiKeyBusy || !state.user?.hasApiKey) return;
  if (!window.confirm('Remove your saved Torn API key?')) return;

  personalApiKeyBusy = true;
  setPersonalApiKeyBusy(true);
  renderPersonalApiKeyStatus('Removing saved key…');

  try {
    const result = await api('removeApiKey');
    state.user = result.user;
    renderIdentity();
    renderPersonalApiKeyStatus(result.message || 'Saved API key removed.');
  } catch (error) {
    renderPersonalApiKeyStatus(error.message || 'Failed to remove the saved key.', true);
  } finally {
    personalApiKeyBusy = false;
    setPersonalApiKeyBusy(false);
  }
}

async function closeAccount() {
  if (accountCloseBusy) return;
  if (!window.confirm('Close your RWEngine account? This removes your login and saved API key and cannot be undone.')) return;

  const button = document.querySelector('#closeAccountButton');
  const status = document.querySelector('#closeAccountStatus');
  const maintenanceActive = Boolean(state.maintenanceMode);
  accountCloseBusy = true;
  if (button) button.disabled = true;
  if (status) status.textContent = 'Closing account…';

  try {
    await api('closeAccount', { confirm:'CLOSE' });
    resetState();
    if (maintenanceActive) showMaintenance();
    else showAuth();
  } catch (error) {
    if (status) status.textContent = error.message || 'Failed to close the account.';
    accountCloseBusy = false;
    if (button) button.disabled = false;
  }
}

const AUTO_TAG_SETTING_ROWS = [
  {
    key:'lowWarHits',
    group:'War',
    title:'Low war hits / war',
    thresholds:[
      ['yellow','Yellow','<','negative yellow',1],
      ['orange','Orange','<','negative orange',1],
      ['red','Red','<','negative red',1]
    ]
  },
  {
    key:'highWarHits',
    group:'War',
    title:'High war hits / war',
    thresholds:[
      ['teal','Teal','≥','positive teal',1],
      ['green','Green','≥','positive green',1],
      ['bright','Bright green','≥','positive bright',1]
    ]
  },
  {
    key:'outsideHits',
    group:'War',
    title:'Outside hits / war',
    thresholds:[
      ['yellow','Yellow','≥','negative yellow',1]
    ]
  },
  {
    key:'respectPerHit',
    group:'War',
    title:'Respect / hit',
    thresholds:[
      ['yellow','Yellow','<','negative yellow',0.1],
      ['orange','Orange','<','negative orange',0.1],
      ['red','Red','<','negative red',0.1],
      ['minimumHits','Min. hits','≥','neutral',1]
    ]
  },
  {
    key:'assists',
    group:'War',
    title:'Assists / war',
    thresholds:[
      ['teal','Teal','≥','positive teal',1],
      ['green','Green','≥','positive green',1],
      ['bright','Bright green','≥','positive bright',1]
    ]
  },
  {
    key:'trainingEnergy',
    group:'Training',
    title:'Training E / day',
    thresholds:[
      ['yellow','Yellow','<','negative yellow',1],
      ['orange','Orange','<','negative orange',1],
      ['red','Red','<','negative red',1],
      ['teal','Teal','≥','positive teal',1],
      ['green','Green','≥','positive green',1],
      ['bright','Bright green','≥','positive bright',1]
    ]
  },
  {
    key:'inactivity',
    group:'Activity',
    title:'Inactivity',
    thresholds:[
      ['yellowHours','Yellow','≥','negative yellow',1,'h'],
      ['orangeHours','Orange','≥','negative orange',1,'h'],
      ['redHours','Red','≥','negative red',1,'h']
    ]
  }
];

async function loadAutoTagSettings() {
  const list = document.querySelector('#autoTagSettingsList');
  const status = document.querySelector('#autoTagSettingsStatus');
  renderSettingsPermissions();
  if (!list || !canManageAutoTagSettingsView() || autoTagSettingsLoading) return;

  autoTagSettingsLoading = true;
  setAutoTagSettingsBusy(true);
  if (status) {
    status.textContent = '';
    status.classList.add('hidden');
    status.classList.remove('error');
  }

  try {
    const result = await autoTagsApi('get');
    renderAutoTagSettings(result.settings || result.defaults || {});
  } catch (error) {
    list.innerHTML = '';
    setAutoTagSettingsStatus(error.message || 'Failed to load tag settings.', true);
  } finally {
    autoTagSettingsLoading = false;
    setAutoTagSettingsBusy(false);
  }
}

function renderAutoTagSettings(settings) {
  const list = document.querySelector('#autoTagSettingsList');
  if (!list) return;

  let previousGroup = '';
  list.innerHTML = AUTO_TAG_SETTING_ROWS.map(row => {
    const config = settings?.[row.key] || {};
    const enabled = config.enabled !== false;
    const groupHeading = row.group !== previousGroup
      ? `<div class="auto-tag-group-heading">${escapeHtml(row.group)}</div>`
      : '';
    previousGroup = row.group;

    const hasPositive = row.thresholds.some(([, , , tone]) => String(tone).includes('positive'));
    const hasNegative = row.thresholds.some(([, , , tone]) => String(tone).includes('negative'));
    const lanes = hasPositive && hasNegative
      ? [
          row.thresholds.filter(([, , , tone]) => !String(tone).includes('positive')),
          row.thresholds.filter(([, , , tone]) => String(tone).includes('positive'))
        ]
      : [row.thresholds];

    const renderThreshold = ([field,label,operator,tone,step,suffix = '']) => `
      <label class="auto-tag-threshold ${escapeHtml(tone)}">
        <span>${escapeHtml(label)} <b>${escapeHtml(operator)}</b></span>
        <span class="auto-tag-threshold-input">
          <input
            type="number"
            min="0"
            max="100000"
            step="${escapeHtml(step)}"
            value="${escapeHtml(config[field] ?? '')}"
            data-auto-tag-field="${escapeHtml(field)}"
            aria-label="${escapeHtml(row.title + ' ' + label)}"
          />
          ${suffix ? `<em>${escapeHtml(suffix)}</em>` : ''}
        </span>
      </label>
    `;

    return `
      ${groupHeading}
      <section class="auto-tag-setting-row${enabled ? '' : ' disabled'}${lanes.length > 1 ? ' split' : ''}" data-auto-tag-family="${escapeHtml(row.key)}">
        <div class="auto-tag-setting-info">
          <label class="auto-tag-setting-toggle">
            <input type="checkbox" data-auto-tag-enabled="${escapeHtml(row.key)}"${enabled ? ' checked' : ''} />
            <span>${escapeHtml(row.title)}</span>
          </label>
        </div>
        <div class="auto-tag-threshold-lanes">
          ${lanes.map(thresholds => `
            <div class="auto-tag-thresholds">
              ${thresholds.map(renderThreshold).join('')}
            </div>
          `).join('')}
        </div>
      </section>
    `;
  }).join('');

  list.querySelectorAll('[data-auto-tag-enabled]').forEach(input => {
    input.addEventListener('change', () => {
      input.closest('.auto-tag-setting-row')?.classList.toggle('disabled', !input.checked);
    });
  });
}

function collectAutoTagSettings() {
  const settings = {};
  document.querySelectorAll('#autoTagSettingsList [data-auto-tag-family]').forEach(row => {
    const family = row.dataset.autoTagFamily;
    const enabled = row.querySelector('[data-auto-tag-enabled]')?.checked !== false;
    const config = { enabled };

    row.querySelectorAll('[data-auto-tag-field]').forEach(input => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) {
        throw new Error('Every auto-tag threshold needs a numeric value.');
      }
      config[input.dataset.autoTagField] = value;
    });
    settings[family] = config;
  });
  return settings;
}

async function saveAutoTagSettings(event) {
  event.preventDefault();
  if (autoTagSettingsBusy || !canManageAutoTagSettingsView()) return;

  autoTagSettingsBusy = true;
  setAutoTagSettingsBusy(true);
  setAutoTagSettingsStatus('Saving thresholds…');

  try {
    const result = await autoTagsApi('save', {
      settings:collectAutoTagSettings()
    });
    renderAutoTagSettings(result.settings || {});
    emit('tag-settings', {
      factionId:currentFactionId(),
      settings:result.settings || {}
    });
    setAutoTagSettingsStatus(result.message || 'Tag thresholds saved.');
  } catch (error) {
    setAutoTagSettingsStatus(error.message || 'Failed to save tag thresholds.', true);
  } finally {
    autoTagSettingsBusy = false;
    setAutoTagSettingsBusy(false);
  }
}

async function resetAutoTagSettings() {
  if (autoTagSettingsBusy || !canManageAutoTagSettingsView()) return;

  autoTagSettingsBusy = true;
  setAutoTagSettingsBusy(true);
  setAutoTagSettingsStatus('Restoring defaults…');

  try {
    const result = await autoTagsApi('reset');
    renderAutoTagSettings(result.settings || {});
    emit('tag-settings', {
      factionId:currentFactionId(),
      settings:result.settings || {}
    });
    setAutoTagSettingsStatus(result.message || 'Tag thresholds reset.');
  } catch (error) {
    setAutoTagSettingsStatus(error.message || 'Failed to reset tag thresholds.', true);
  } finally {
    autoTagSettingsBusy = false;
    setAutoTagSettingsBusy(false);
  }
}

function setAutoTagSettingsBusy(busy) {
  document.querySelectorAll('#autoTagSettingsForm input, #autoTagSettingsForm button').forEach(control => {
    control.disabled = Boolean(busy);
  });
}

function setAutoTagSettingsStatus(message, error = false) {
  const status = document.querySelector('#autoTagSettingsStatus');
  if (!status) return;
  status.textContent = message || '';
  status.classList.toggle('hidden', !message);
  status.classList.toggle('error', Boolean(error));
}

async function loadFactionRoles() {
  const list = document.querySelector('#factionRolesList');
  const status = document.querySelector('#factionRolesStatus');
  renderSettingsPermissions();
  if (!list || !canManageFactionRolesView() || factionRolesLoading) return;

  factionRolesLoading = true;
  if (status) {
    status.textContent = '';
    status.classList.add('hidden');
    status.classList.remove('error');
  }

  try {
    const result = await rolesApi('list');
    renderFactionRoles(result);
  } catch (error) {
    list.innerHTML = '';
    if (status) {
      status.textContent = error.message || 'Failed to load faction roles.';
      status.classList.remove('hidden');
      status.classList.add('error');
    }
  } finally {
    factionRolesLoading = false;
  }
}

function renderFactionRoles(result) {
  const list = document.querySelector('#factionRolesList');
  if (!list) return;

  const permissions = result.permissions || {};
  const accounts = sortFactionAccounts(result.accounts);
  const assignedAccounts = accounts.filter(account => account.role !== 'member');
  list.innerHTML = assignedAccounts.length
    ? assignedAccounts.map(account => {
        const protectedAccount = Boolean(account.protected);
        const coCannotChangeAdmin = !permissions.canGrantAdmin && account.role === 'faction_admin';
        const disabled = protectedAccount || coCannotChangeAdmin;
        const choices = account.platformAdmin
          ? ['platform_admin']
          : permissions.canGrantAdmin
            ? ['member','assistant','faction_admin']
          : account.role === 'faction_admin'
            ? ['faction_admin']
            : ['member','assistant'];
        const leadership = account.leadershipRole === 'leader'
          ? 'Leader · protected'
          : account.leadershipRole === 'co_leader'
            ? 'Co-leader'
            : '';
        const platform = account.platformAdmin ? 'Platform admin · protected' : '';
        const meta = [leadership, platform].filter(Boolean).join(' · ') || 'Registered account';

        return `
          <div class="access-row role-access-row${protectedAccount ? ' is-protected' : ''}" data-account-role="${escapeHtml(account.role)}">
            <div>
              <strong>${escapeHtml(account.playerName || `Player ${account.playerId}`)}</strong>
              <small>[${escapeHtml(account.playerId)}] · ${escapeHtml(meta)}</small>
            </div>
            <select class="access-select" data-role-user-id="${escapeHtml(account.userId)}" aria-label="Role for ${escapeHtml(account.playerName || `Player ${account.playerId}`)}"${disabled ? ' disabled' : ''}>
              ${choices.map(role => `
                <option value="${role}"${role === account.role ? ' selected' : ''}>${escapeHtml(roleLabel(role))}</option>
              `).join('')}
            </select>
          </div>
        `;
      }).join('')
    : '<div class="access-empty">No elevated account roles.</div>';

  renderFactionRoleAdd(accounts, permissions);
}

function renderFactionRoleAdd(accounts, permissions) {
  const toggle = document.querySelector('#factionRoleAddToggle');
  const form = document.querySelector('#factionRoleAddForm');
  const input = document.querySelector('#factionRoleMemberSearch');
  const options = document.querySelector('#factionRoleMemberOptions');
  const roleSelect = document.querySelector('#factionRoleNewRole');
  if (!toggle || !form || !input || !options || !roleSelect) return;

  factionRoleCandidates = accounts.filter(account => account.role === 'member');
  options.innerHTML = factionRoleCandidates.map(account =>
    `<option value="${escapeHtml(factionRoleCandidateLabel(account))}"></option>`
  ).join('');

  const roles = permissions.canGrantAdmin
    ? ['assistant','faction_admin']
    : ['assistant'];
  roleSelect.innerHTML = roles.map(role =>
    `<option value="${role}">${escapeHtml(roleLabel(role))}</option>`
  ).join('');

  [...form.elements].forEach(control => { control.disabled = false; });
  toggle.disabled = factionRoleCandidates.length === 0;
  toggle.textContent = factionRoleCandidates.length ? '+ Add member' : 'No members available';
  input.value = '';
  toggleFactionRoleAdd(false);
}

function factionRoleCandidateLabel(account) {
  return `${account.playerName || `Player ${account.playerId}`} [${account.playerId}]`;
}

function resolveFactionRoleCandidate(value) {
  const query = String(value || '').trim().toLowerCase();
  if (!query) return null;

  const exact = factionRoleCandidates.find(account =>
    factionRoleCandidateLabel(account).toLowerCase() === query
  );
  if (exact) return exact;

  const idMatch = query.match(/(?:^|\[)(\d+)\]?$/);
  if (idMatch) {
    const playerId = Number(idMatch[1]);
    const byId = factionRoleCandidates.find(account => Number(account.playerId) === playerId);
    if (byId) return byId;
  }

  const nameMatches = factionRoleCandidates.filter(account =>
    String(account.playerName || '').toLowerCase() === query
  );
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

function toggleFactionRoleAdd(show) {
  const toggle = document.querySelector('#factionRoleAddToggle');
  const form = document.querySelector('#factionRoleAddForm');
  if (!toggle || !form) return;

  const visible = Boolean(show && factionRoleCandidates.length);
  toggle.classList.toggle('hidden', visible);
  form.classList.toggle('hidden', !visible);
  if (visible) {
    window.setTimeout(() => document.querySelector('#factionRoleMemberSearch')?.focus(), 0);
  }
}

async function handleFactionRoleAdd(event) {
  event.preventDefault();
  if (!canManageFactionRolesView()) return;

  const form = event.currentTarget;
  const input = document.querySelector('#factionRoleMemberSearch');
  const roleSelect = document.querySelector('#factionRoleNewRole');
  const status = document.querySelector('#factionRolesStatus');
  const account = resolveFactionRoleCandidate(input?.value);
  if (!account) {
    if (status) {
      status.textContent = 'Choose a member from the search suggestions.';
      status.classList.remove('hidden');
      status.classList.add('error');
    }
    return;
  }

  const controls = [...form.elements];
  controls.forEach(control => { control.disabled = true; });
  try {
    const result = await rolesApi('setRole', {
      userId:Number(account.userId || 0),
      role:roleSelect?.value || 'assistant'
    });
    await loadFactionRoles();
    if (status) {
      status.textContent = result.message || 'Faction role granted.';
      status.classList.remove('hidden', 'error');
    }
  } catch (error) {
    controls.forEach(control => { control.disabled = false; });
    if (status) {
      status.textContent = error.message || 'Failed to grant that faction role.';
      status.classList.remove('hidden');
      status.classList.add('error');
    }
  }
}

async function handleFactionRoleChange(event) {
  const select = event.target.closest('[data-role-user-id]');
  if (!select || !canManageFactionRolesView()) return;

  const status = document.querySelector('#factionRolesStatus');
  let feedback = '';
  let failed = false;
  select.disabled = true;
  try {
    const result = await rolesApi('setRole', {
      userId:Number(select.dataset.roleUserId || 0),
      role:select.value
    });
    feedback = result.message || 'Faction role updated.';
  } catch (error) {
    feedback = error.message || 'Failed to update faction role.';
    failed = true;
  } finally {
    await loadFactionRoles();
    if (status && feedback) {
      status.textContent = feedback;
      status.classList.remove('hidden');
      status.classList.toggle('error', failed);
    }
  }
}


async function loadAdminFactions() {
  const [result, maintenance] = await Promise.all([
    adminApi('listFactions'),
    adminApi('getMaintenance')
  ]);
  state.adminFactions = sortTrackedFactions(result.factions);
  state.maintenanceMode = Boolean(maintenance?.enabled);
  state.maintenanceUpdatedAt = Number(maintenance?.updatedAt || 0) || null;

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

  const isAdmin = Boolean(state.user?.isAdmin && isPlatformAdminView());
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
  if (!section || !state.user?.isAdmin || !isPlatformAdminView()) return;

  const list = document.querySelector('#adminFactionList');
  if (list) {
    list.innerHTML = state.adminFactions.map(faction => `
      <button class="admin-faction-row" type="button" data-admin-faction="${faction.factionId}">
        <span>
          <strong>${escapeHtml(faction.factionName)} [${faction.factionId}]</strong>
          <small>${formatNumber(faction.currentMembers)} members · ${formatNumber(faction.warCount)} ${Number(faction.warCount) === 1 ? 'war' : 'wars'} · ${faction.hasApiKey ? `${escapeHtml(faction.keySource)} API` : 'API missing'} · ${adminSyncLabel(faction)}</small>
        </span>
        <b>${Number(faction.factionId) === Number(state.selectedFactionId) ? 'Active' : 'Manage'}</b>
      </button>
    `).join('');
  }

  renderAdminKeyForm();
  renderMaintenanceControl();
}

function renderMaintenanceControl() {
  const button = document.querySelector('#maintenanceToggle');
  const status = document.querySelector('#maintenanceStatus');
  if (!button || !status || !state.user?.isAdmin) return;

  const enabled = Boolean(state.maintenanceMode);
  button.textContent = enabled ? 'Maintenance: On' : 'Maintenance: Off';
  button.classList.toggle('maintenance-active', enabled);
  button.disabled = maintenanceBusy;

  const updatedAt = Number(state.maintenanceUpdatedAt || 0);
  const age = updatedAt
    ? formatAge(Math.max(0, Math.floor(Date.now() / 1000) - updatedAt))
    : null;

  status.textContent = enabled
    ? `Admin-only access enabled${age ? ` · changed ${age}` : ''}`
    : `Normal access enabled${age ? ` · changed ${age}` : ''}`;
}

async function toggleMaintenance() {
  if (maintenanceBusy || !state.user?.isAdmin) return;
  maintenanceBusy = true;
  renderMaintenanceControl();

  try {
    const result = await adminApi('setMaintenance', {
      enabled:!Boolean(state.maintenanceMode)
    });
    state.maintenanceMode = Boolean(result.enabled);
    state.maintenanceUpdatedAt = Number(result.updatedAt || 0) || null;
  } catch (error) {
    setNotice(error.message || 'Failed to change maintenance mode.', 'error');
  } finally {
    maintenanceBusy = false;
    renderMaintenanceControl();
  }
}

function adminSyncLabel(faction) {
  const status = String(faction.lastSyncStatus || 'never');
  const failed = Number(faction.lastSyncFailedTasks || 0);
  const at = Number(faction.lastSyncAt || 0);
  const age = at ? formatAge(Math.max(0, Math.floor(Date.now() / 1000) - at)) : null;

  if (status === 'never') return 'Not synced';

  let label = status === 'completed' ? 'Synced' : `Sync ${status}`;
  if (age) label += ` ${age}`;
  if (failed) label += ` · ${failed} failed`;
  return escapeHtml(label);
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
  accountCloseBusy = false;
  state.user = null;
  state.rolePreview = null;
  state.adminFactions = [];
  state.selectedFactionId = null;
  state.wars = [];
  state.range = null;
  state.freshness = null;
  state.maintenanceMode = false;
  state.maintenanceUpdatedAt = null;
  state.period = { preset:'last4', from:null, to:null };
  state.route = 'intel';
  setNotice('');
}
