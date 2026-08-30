const STORAGE_KEY = 'rwengine.adminFactionView';
const nativeFetch = window.fetch.bind(window);

const adminState = {
  isAdmin: false,
  user: null,
  accountFactionId: null,
  selectedFactionId: readStoredFactionId(),
  factions: [],
  uiReady: false,
  contextReady: false,
  contextPromise: null
};

installAdminStylesheet();
bootstrapAdminFromSession();

window.fetch = async function rwengineAdminAwareFetch(input, init = {}) {
  const requestUrl = resolveUrl(input);
  const requestInit = { ...init };
  let body = parseJsonBody(requestInit.body);
  const action = body?.action || null;

  if (adminState.isAdmin && shouldAwaitAdminContext(requestUrl, action)) {
    await ensureAdminContextReady();
  }

  if (adminState.isAdmin && isAlternateFaction()) {
    const selectedFactionId = Number(adminState.selectedFactionId);

    if (requestUrl.pathname === '/v2/range' || requestUrl.pathname === '/v2/intel') {
      body = { ...(body || {}), factionId: selectedFactionId };
      return nativeFetch('/v2/admin', withJsonBody(requestInit, body));
    }

    if (requestUrl.pathname === '/api' && action === 'getImportedWars') {
      return nativeFetch('/v2/admin', withJsonBody(requestInit, {
        action: 'getImportedWars',
        factionId: selectedFactionId
      }));
    }

    if (
      requestUrl.pathname === '/api' &&
      ['checkImportStatus', 'importRankedWarReport', 'applyAttackSummary', 'applyChainBonusAdjustment'].includes(action)
    ) {
      return jsonResponse(
        409,
        'Historical report importing is currently restricted to your account faction while using the admin faction switcher.'
      );
    }
  }

  const response = await nativeFetch(input, requestInit);

  if (requestUrl.pathname === '/api' && ['me', 'login'].includes(action)) {
    await observeAuthResponse(response);
  } else if (requestUrl.pathname === '/api' && action === 'logout') {
    clearAdminState();
  }

  return response;
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ensureAdminUiShell, { once: true });
} else {
  ensureAdminUiShell();
}

function installAdminStylesheet() {
  if (document.querySelector('link[data-rwe-admin-workspace]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/v2/admin-workspace.css?v=1';
  link.dataset.rweAdminWorkspace = '1';
  document.head.appendChild(link);
}

async function bootstrapAdminFromSession() {
  try {
    const response = await nativeFetch('/api', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'me' })
    });
    if (!response.ok) return;
    const payload = await response.json();
    await observeUser(payload?.user);
  } catch (_) {
    // The normal login flow remains authoritative.
  }
}

async function observeUser(user) {
  if (!user) return;
  adminState.user = user;
  adminState.isAdmin = Boolean(user.isAdmin);
  adminState.accountFactionId = Number(user.factionId || 0) || null;

  if (!adminState.isAdmin) {
    adminState.selectedFactionId = adminState.accountFactionId;
    adminState.contextReady = true;
    return;
  }

  if (!adminState.selectedFactionId) {
    adminState.selectedFactionId = adminState.accountFactionId;
    writeStoredFactionId(adminState.selectedFactionId);
  }

  adminState.contextReady = false;
  adminState.contextPromise = initializeAdminWorkspace().finally(() => {
    adminState.contextReady = true;
  });

  await adminState.contextPromise;

  if (isAlternateFaction()) {
    window.setTimeout(() => {
      document.querySelector('#refreshButton')?.click();
    }, 150);
  }
}

async function observeAuthResponse(response) {
  try {
    const payload = await response.clone().json();
    const user = payload?.user;
    if (!response.ok || !user) return;

    await observeUser(user);
  } catch (_) {
    // Auth payload observation is best-effort; the main app handles errors.
  }
}

function ensureAdminUiShell() {
  if (adminState.uiReady) return;
  adminState.uiReady = true;

  const topbarControls = document.querySelector('.topbar .member-controls');
  if (topbarControls && !document.querySelector('#adminFactionSwitcher')) {
    const switcher = document.createElement('label');
    switcher.id = 'adminFactionSwitcher';
    switcher.className = 'admin-faction-switcher hidden';
    switcher.innerHTML = `
      <span>Admin view</span>
      <select id="adminFactionSelect" aria-label="Faction view"></select>
    `;
    topbarControls.prepend(switcher);

    switcher.querySelector('select')?.addEventListener('change', event => {
      const factionId = Number(event.target.value || 0);
      if (!factionId || factionId === Number(adminState.selectedFactionId)) return;
      writeStoredFactionId(factionId);
      window.location.reload();
    });
  }

  const settingsTab = document.querySelector('#settingsTab');
  if (settingsTab && !document.querySelector('#adminFactionPanel')) {
    const panel = document.createElement('article');
    panel.id = 'adminFactionPanel';
    panel.className = 'panel admin-faction-panel hidden';
    panel.innerHTML = `
      <div class="panel-header admin-panel-header">
        <div>
          <p class="eyebrow">Administrator</p>
          <h2>Faction control</h2>
          <p class="muted">Switch between tracked factions and manage the API key used for faction-level syncing.</p>
        </div>
        <button id="adminFactionRefresh" class="button" type="button">Refresh</button>
      </div>

      <div id="adminFactionStatus" class="admin-faction-status hidden"></div>

      <div class="admin-faction-layout">
        <section>
          <div class="section-heading">
            <p class="eyebrow">Tracked factions</p>
            <h4>Available workspaces</h4>
          </div>
          <div id="adminFactionList" class="admin-faction-list"></div>
        </section>

        <section class="admin-key-card">
          <div class="section-heading">
            <p class="eyebrow">Selected faction</p>
            <h4 id="adminKeyFactionName">—</h4>
          </div>
          <div id="adminKeySummary" class="admin-key-summary"></div>
          <form id="adminApiKeyForm" class="admin-api-key-form">
            <label>
              <span>Faction API key</span>
              <input id="adminFactionApiKey" type="password" autocomplete="off" placeholder="Paste a Torn API key" />
            </label>
            <div class="admin-key-actions">
              <button class="button primary" type="submit">Save key</button>
              <button id="adminRemoveApiKey" class="button" type="button">Remove managed key</button>
            </div>
          </form>
          <p class="muted admin-key-note">
            Keys are verified against Torn, encrypted with the existing RWE application secret, and never displayed again after saving.
          </p>
        </section>
      </div>
    `;
    settingsTab.appendChild(panel);

    panel.querySelector('#adminFactionRefresh')?.addEventListener('click', () => loadAdminFactions(true));
    panel.querySelector('#adminApiKeyForm')?.addEventListener('submit', saveSelectedFactionKey);
    panel.querySelector('#adminRemoveApiKey')?.addEventListener('click', removeSelectedFactionKey);
  }
}

async function ensureAdminContextReady() {
  if (adminState.contextReady) return;
  if (adminState.contextPromise) {
    await adminState.contextPromise;
    return;
  }
  adminState.contextPromise = initializeAdminWorkspace().finally(() => {
    adminState.contextReady = true;
  });
  await adminState.contextPromise;
}

function shouldAwaitAdminContext(url, action) {
  if (url.pathname === '/v2/admin') return false;
  if (url.pathname === '/api' && ['me', 'login', 'logout'].includes(action)) return false;
  return url.origin === window.location.origin;
}

async function initializeAdminWorkspace() {
  ensureAdminUiShell();
  if (!adminState.isAdmin) return;

  document.querySelector('#adminFactionSwitcher')?.classList.remove('hidden');
  document.querySelector('#adminFactionPanel')?.classList.remove('hidden');
  await loadAdminFactions(false);
  updateContextLabels();
  updateHistoricalImportAvailability();

  window.setTimeout(updateContextLabels, 50);
  window.setTimeout(updateContextLabels, 400);
}

async function loadAdminFactions(showBusy) {
  const refreshButton = document.querySelector('#adminFactionRefresh');
  if (showBusy && refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing…';
  }

  setAdminStatus('', '');

  try {
    const payload = await adminApi('listFactions');
    adminState.factions = payload.factions || [];
    adminState.accountFactionId = Number(payload.accountFactionId || adminState.accountFactionId || 0) || null;

    const validIds = new Set(adminState.factions.map(faction => Number(faction.factionId)));
    if (!validIds.has(Number(adminState.selectedFactionId))) {
      adminState.selectedFactionId = adminState.accountFactionId || adminState.factions[0]?.factionId || null;
      writeStoredFactionId(adminState.selectedFactionId);
    }

    renderFactionSwitcher();
    renderFactionAdminPanel();
    updateContextLabels();
    updateHistoricalImportAvailability();
  } catch (error) {
    setAdminStatus('error', error.message || 'Failed to load tracked factions.');
  } finally {
    if (showBusy && refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh';
    }
  }
}

function renderFactionSwitcher() {
  const select = document.querySelector('#adminFactionSelect');
  if (!select) return;

  select.innerHTML = adminState.factions.map(faction => `
    <option value="${faction.factionId}"${Number(faction.factionId) === Number(adminState.selectedFactionId) ? ' selected' : ''}>
      ${escapeHtml(faction.factionName)} [${faction.factionId}]
    </option>
  `).join('');
}

function renderFactionAdminPanel() {
  const list = document.querySelector('#adminFactionList');
  if (!list) return;

  list.innerHTML = adminState.factions.length
    ? adminState.factions.map(faction => {
        const selected = Number(faction.factionId) === Number(adminState.selectedFactionId);
        const keyLabel = faction.hasApiKey
          ? keySourceLabel(faction.keySource, faction.keyOwnerName)
          : 'No API key';
        const syncText = faction.lastSyncAt
          ? `${faction.lastSyncStatus || 'sync'} · ${formatDateTime(faction.lastSyncAt)}`
          : 'Never synced';

        return `
          <button class="admin-faction-row${selected ? ' selected' : ''}" type="button" data-admin-faction-id="${faction.factionId}">
            <span>
              <strong>${escapeHtml(faction.factionName)}</strong>
              <small>[${faction.factionId}] · ${formatNumber(faction.currentMembers)} members · ${formatNumber(faction.warCount)} wars</small>
            </span>
            <span class="admin-faction-row-meta">
              <small>${escapeHtml(keyLabel)}</small>
              <small>${escapeHtml(syncText)}</small>
            </span>
          </button>
        `;
      }).join('')
    : '<div class="empty">No tracked factions found.</div>';

  list.querySelectorAll('[data-admin-faction-id]').forEach(button => {
    button.addEventListener('click', () => {
      const factionId = Number(button.dataset.adminFactionId || 0);
      if (!factionId || factionId === Number(adminState.selectedFactionId)) return;
      writeStoredFactionId(factionId);
      window.location.reload();
    });
  });

  renderSelectedKeyCard();
}

function renderSelectedKeyCard() {
  const faction = selectedFaction();
  const name = document.querySelector('#adminKeyFactionName');
  const summary = document.querySelector('#adminKeySummary');
  const form = document.querySelector('#adminApiKeyForm');
  const input = document.querySelector('#adminFactionApiKey');
  const removeButton = document.querySelector('#adminRemoveApiKey');

  if (!faction || !name || !summary || !form) return;
  name.textContent = `${faction.factionName} [${faction.factionId}]`;

  if (faction.isAccountFaction && faction.keySource === 'account') {
    summary.innerHTML = `
      <strong>Using your account API key</strong>
      <span>${escapeHtml(faction.keyOwnerName || 'Current admin account')}</span>
    `;
  } else if (faction.hasApiKey) {
    summary.innerHTML = `
      <strong>API key configured</strong>
      <span>${escapeHtml(keySourceLabel(faction.keySource, faction.keyOwnerName))}</span>
    `;
  } else {
    summary.innerHTML = `
      <strong>No API key configured</strong>
      <span>Historical data can still be viewed, but faction syncing requires a usable key.</span>
    `;
  }

  if (input) input.value = '';
  if (removeButton) {
    removeButton.disabled = faction.keySource !== 'managed';
    removeButton.title = faction.keySource === 'managed'
      ? 'Remove the admin-managed key'
      : 'There is no admin-managed key to remove';
  }
}

async function saveSelectedFactionKey(event) {
  event.preventDefault();
  const faction = selectedFaction();
  const input = document.querySelector('#adminFactionApiKey');
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  const apiKey = String(input?.value || '').trim();

  if (!faction || !apiKey) {
    setAdminStatus('error', 'Paste an API key for the selected faction.');
    return;
  }

  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Verifying…';
  }
  setAdminStatus('', '');

  try {
    const result = await adminApi('setApiKey', { factionId: faction.factionId, apiKey });
    if (input) input.value = '';
    setAdminStatus('success', result.message || 'API key saved.');
    await loadAdminFactions(false);
  } catch (error) {
    setAdminStatus('error', error.message || 'Failed to save API key.');
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = 'Save key';
    }
  }
}

async function removeSelectedFactionKey() {
  const faction = selectedFaction();
  const button = document.querySelector('#adminRemoveApiKey');
  if (!faction || faction.keySource !== 'managed') return;

  if (button) {
    button.disabled = true;
    button.textContent = 'Removing…';
  }
  setAdminStatus('', '');

  try {
    const result = await adminApi('clearApiKey', { factionId: faction.factionId });
    setAdminStatus('success', result.message || 'Managed key removed.');
    await loadAdminFactions(false);
  } catch (error) {
    setAdminStatus('error', error.message || 'Failed to remove managed key.');
  } finally {
    if (button) button.textContent = 'Remove managed key';
  }
}

function updateContextLabels() {
  if (!adminState.isAdmin) return;
  const faction = selectedFaction();
  if (!faction) return;

  const sidebar = document.querySelector('#factionLabel');
  if (sidebar) sidebar.textContent = `${faction.factionName} · Admin view`;

  const settingsFaction = document.querySelector('#settingsFaction');
  const settingsFactionId = document.querySelector('#settingsFactionId');
  if (settingsFaction) settingsFaction.textContent = faction.factionName;
  if (settingsFactionId) settingsFactionId.textContent = String(faction.factionId);
}

function updateHistoricalImportAvailability() {
  const details = document.querySelector('.war-import');
  if (!details) return;

  const alternate = isAlternateFaction();
  details.classList.toggle('admin-import-disabled', alternate);
  const controls = details.querySelectorAll('textarea, input, button');
  controls.forEach(control => {
    control.disabled = alternate;
  });

  let note = details.querySelector('.admin-import-note');
  if (alternate && !note) {
    note = document.createElement('div');
    note.className = 'admin-import-note';
    note.textContent = 'Historical report importing is disabled while viewing another faction. The archive itself remains fully viewable.';
    details.querySelector('.war-import-body')?.prepend(note);
  } else if (!alternate && note) {
    note.remove();
  }
}

async function adminApi(action, payload = {}) {
  const response = await nativeFetch('/v2/admin', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });

  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error(`Admin backend returned HTTP ${response.status} without JSON.`); }
  if (!response.ok || data.success === false) throw new Error(data.message || `Request failed with HTTP ${response.status}.`);
  return data;
}

function selectedFaction() {
  return adminState.factions.find(faction => Number(faction.factionId) === Number(adminState.selectedFactionId)) || null;
}

function isAlternateFaction() {
  return Boolean(
    adminState.isAdmin &&
    adminState.selectedFactionId &&
    adminState.accountFactionId &&
    Number(adminState.selectedFactionId) !== Number(adminState.accountFactionId)
  );
}

function readStoredFactionId() {
  const value = Number(window.localStorage.getItem(STORAGE_KEY) || 0);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function writeStoredFactionId(factionId) {
  const value = Number(factionId || 0);
  adminState.selectedFactionId = Number.isSafeInteger(value) && value > 0 ? value : null;
  if (adminState.selectedFactionId) window.localStorage.setItem(STORAGE_KEY, String(adminState.selectedFactionId));
  else window.localStorage.removeItem(STORAGE_KEY);
}

function clearAdminState() {
  adminState.isAdmin = false;
  adminState.user = null;
  adminState.accountFactionId = null;
  adminState.factions = [];
  adminState.contextReady = false;
  adminState.contextPromise = null;
}

function resolveUrl(input) {
  if (typeof input === 'string') return new URL(input, window.location.href);
  if (input instanceof URL) return input;
  return new URL(input?.url || window.location.href, window.location.href);
}

function parseJsonBody(body) {
  if (!body || typeof body !== 'string') return null;
  try { return JSON.parse(body); } catch (_) { return null; }
}

function withJsonBody(init, body) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return {
    ...init,
    method: init.method || 'POST',
    credentials: init.credentials || 'same-origin',
    headers,
    body: JSON.stringify(body)
  };
}

function jsonResponse(status, message) {
  return Promise.resolve(new Response(JSON.stringify({ success: false, message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  }));
}

function setAdminStatus(type, message) {
  const box = document.querySelector('#adminFactionStatus');
  if (!box) return;
  box.textContent = message || '';
  box.className = `admin-faction-status${type ? ` is-${type}` : ''}${message ? '' : ' hidden'}`;
}

function keySourceLabel(source, ownerName) {
  const owner = ownerName ? ` · ${ownerName}` : '';
  if (source === 'managed') return `Admin-managed key${owner}`;
  if (source === 'account') return `Your account key${owner}`;
  if (source === 'member') return `Registered member key${owner}`;
  return 'No API key';
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatDateTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value * 1000));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
