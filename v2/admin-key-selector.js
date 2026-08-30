let adminPanel = null;
let keyTargetFactionId = null;
let installed = false;

waitForAdminPanel();

function waitForAdminPanel() {
  const existing = document.querySelector('#adminFactionPanel');
  if (existing) {
    adminPanel = existing;
    installKeyManagementSelection();
    return;
  }

  const observer = new MutationObserver(() => {
    const panel = document.querySelector('#adminFactionPanel');
    if (!panel) return;
    observer.disconnect();
    adminPanel = panel;
    installKeyManagementSelection();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function installKeyManagementSelection() {
  if (!adminPanel || installed) return;
  installed = true;

  const eyebrow = adminPanel.querySelector('.admin-key-card .section-heading .eyebrow');
  if (eyebrow) eyebrow.textContent = 'API key target';

  document.addEventListener('click', event => {
    const row = event.target.closest?.('.admin-faction-row[data-admin-faction-id]');
    if (!row || !adminPanel.contains(row)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const factionId = Number(row.dataset.adminFactionId || 0);
    if (!factionId) return;

    keyTargetFactionId = factionId;
    selectFactionRow(factionId);
    refreshKeyTarget(factionId).catch(error => {
      setStatus('error', error.message || 'Failed to load faction key status.');
    });
  }, true);

  document.addEventListener('submit', event => {
    if (event.target?.id !== 'adminApiKeyForm') return;

    event.preventDefault();
    event.stopImmediatePropagation();
    saveKeyForTarget(event.target).catch(error => {
      setStatus('error', error.message || 'Failed to save API key.');
    });
  }, true);

  document.addEventListener('click', event => {
    const button = event.target.closest?.('#adminRemoveApiKey');
    if (!button) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    removeKeyForTarget(button).catch(error => {
      setStatus('error', error.message || 'Failed to remove managed API key.');
    });
  }, true);

  const observer = new MutationObserver(() => {
    if (!keyTargetFactionId) {
      const workspaceFactionId = Number(document.querySelector('#adminFactionSelect')?.value || 0);
      const selectedRowId = Number(adminPanel.querySelector('.admin-faction-row.selected')?.dataset.adminFactionId || 0);
      keyTargetFactionId = selectedRowId || workspaceFactionId || null;
    }

    if (keyTargetFactionId) selectFactionRow(keyTargetFactionId);
  });

  observer.observe(adminPanel, { childList: true, subtree: true });
}

async function refreshKeyTarget(factionId) {
  const payload = await adminApi('listFactions');
  const faction = (payload.factions || []).find(item => Number(item.factionId) === Number(factionId));
  if (!faction) throw new Error('Tracked faction not found.');

  renderKeyTarget(faction);
  updateFactionRowMeta(faction);
}

function renderKeyTarget(faction) {
  const name = document.querySelector('#adminKeyFactionName');
  const summary = document.querySelector('#adminKeySummary');
  const input = document.querySelector('#adminFactionApiKey');
  const removeButton = document.querySelector('#adminRemoveApiKey');

  if (name) name.textContent = `${faction.factionName} [${faction.factionId}]`;
  if (input) input.value = '';

  if (summary) {
    if (faction.hasApiKey) {
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
  }

  if (removeButton) {
    removeButton.disabled = faction.keySource !== 'managed';
    removeButton.title = faction.keySource === 'managed'
      ? 'Remove the admin-managed key'
      : 'There is no admin-managed key to remove';
  }
}

async function saveKeyForTarget(form) {
  const factionId = resolveKeyTargetFactionId();
  const input = document.querySelector('#adminFactionApiKey');
  const submit = form.querySelector('button[type="submit"]');
  const apiKey = String(input?.value || '').trim();

  if (!factionId) throw new Error('Select a faction from the tracked-factions list first.');
  if (!apiKey) throw new Error('Paste an API key for the selected faction.');

  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Verifying…';
  }
  setStatus('', '');

  try {
    const result = await adminApi('setApiKey', { factionId, apiKey });
    if (input) input.value = '';
    setStatus('success', result.message || 'API key saved.');
    await refreshKeyTarget(factionId);
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = 'Save key';
    }
  }
}

async function removeKeyForTarget(button) {
  const factionId = resolveKeyTargetFactionId();
  if (!factionId) throw new Error('Select a faction from the tracked-factions list first.');

  button.disabled = true;
  button.textContent = 'Removing…';
  setStatus('', '');

  try {
    const result = await adminApi('clearApiKey', { factionId });
    setStatus('success', result.message || 'Managed API key removed.');
    await refreshKeyTarget(factionId);
  } finally {
    button.textContent = 'Remove managed key';
  }
}

function resolveKeyTargetFactionId() {
  if (keyTargetFactionId) return Number(keyTargetFactionId);

  const selectedRowId = Number(adminPanel?.querySelector('.admin-faction-row.selected')?.dataset.adminFactionId || 0);
  const workspaceFactionId = Number(document.querySelector('#adminFactionSelect')?.value || 0);
  keyTargetFactionId = selectedRowId || workspaceFactionId || null;
  return keyTargetFactionId;
}

function selectFactionRow(factionId) {
  if (!adminPanel) return;
  adminPanel.querySelectorAll('.admin-faction-row[data-admin-faction-id]').forEach(row => {
    row.classList.toggle('selected', Number(row.dataset.adminFactionId) === Number(factionId));
  });
}

function updateFactionRowMeta(faction) {
  if (!adminPanel) return;
  const row = adminPanel.querySelector(`.admin-faction-row[data-admin-faction-id="${faction.factionId}"]`);
  const keyMeta = row?.querySelector('.admin-faction-row-meta small:first-child');
  if (keyMeta) {
    keyMeta.textContent = faction.hasApiKey
      ? keySourceLabel(faction.keySource, faction.keyOwnerName)
      : 'No API key';
  }
}

async function adminApi(action, payload = {}) {
  const response = await fetch('/v2/admin', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });

  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error(`Admin backend returned HTTP ${response.status} without JSON.`); }

  if (!response.ok || data.success === false) {
    throw new Error(data.message || `Request failed with HTTP ${response.status}.`);
  }

  return data;
}

function setStatus(type, message) {
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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
