const panel = document.querySelector('#warSharePanel');
const toggle = document.querySelector('[data-war-share-toggle]');
const generateButton = document.querySelector('[data-war-share-generate]');
const copyButton = document.querySelector('[data-war-share-copy]');
const revokeButton = document.querySelector('[data-war-share-revoke]');
const urlInput = document.querySelector('#warShareUrl');
const status = document.querySelector('#warShareStatus');

let currentShareUrl = '';

toggle?.addEventListener('click', async () => {
  if (!panel) return;
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  if (opening) await refreshStatus();
});

generateButton?.addEventListener('click', generateLink);
copyButton?.addEventListener('click', copyLink);
revokeButton?.addEventListener('click', revokeLink);

window.addEventListener('rwe:war-detail-loaded', () => {
  resetPanel();
});

document.addEventListener('click', event => {
  if (event.target.closest('[data-war-detail-back]')) resetPanel(true);
});

async function refreshStatus() {
  const warId = selectedWarId();
  if (!warId) return;

  setBusy(false);
  setStatus('Checking share status…');

  try {
    const data = await shareApi('status', { warId });
    const share = data.share;

    if (share?.enabled) {
      setStatus('A public link exists. Generate replaces the current link.');
      revokeButton.disabled = false;
    } else {
      setStatus('No active public link.');
      revokeButton.disabled = true;
    }
  } catch (error) {
    setStatus(error.message || 'Failed to check sharing status.', true);
  }
}

async function generateLink() {
  const warId = selectedWarId();
  if (!warId) return;

  setBusy(true);
  setStatus('Generating link…');

  try {
    const data = await shareApi('create', { warId });
    currentShareUrl = String(data.shareUrl || '');
    if (!currentShareUrl) throw new Error('Backend did not return a share URL.');

    urlInput.value = currentShareUrl;
    copyButton.classList.remove('hidden');
    revokeButton.disabled = false;
    setStatus('Public link active. Generating another link will invalidate this one.');

    try {
      await copyToClipboard(currentShareUrl);
      setStatus('Public link active and copied to clipboard.');
    } catch (_) {
      urlInput?.focus();
      urlInput?.select();
      setStatus('Public link active. Select and copy it manually.');
    }
  } catch (error) {
    setStatus(error.message || 'Failed to generate share link.', true);
  } finally {
    setBusy(false);
  }
}

async function copyLink() {
  const value = currentShareUrl || String(urlInput?.value || '').trim();
  if (!value) return;

  try {
    await copyToClipboard(value);
    setStatus('Link copied to clipboard.');
  } catch (_) {
    urlInput?.focus();
    urlInput?.select();
    setStatus('Select and copy the link manually.');
  }
}

async function revokeLink() {
  const warId = selectedWarId();
  if (!warId) return;

  revokeButton.disabled = true;
  setStatus('Revoking link…');

  try {
    await shareApi('revoke', { warId });
    currentShareUrl = '';
    urlInput.value = '';
    copyButton.classList.add('hidden');
    setStatus('Public link revoked.');
  } catch (error) {
    setStatus(error.message || 'Failed to revoke share link.', true);
    revokeButton.disabled = false;
  }
}

async function shareApi(action, payload = {}) {
  const body = {
    action,
    resourceType: 'war',
    ...payload
  };

  const factionId = Number(document.querySelector('#adminFactionSelect')?.value || 0);
  if (factionId > 0) body.factionId = factionId;

  const response = await fetch('/v2/share', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error(`Share backend returned HTTP ${response.status} without JSON.`); }

  if (!response.ok || data.success === false) {
    throw new Error(data.message || `Share request failed with HTTP ${response.status}.`);
  }

  return data;
}

function selectedWarId() {
  const meta = document.querySelector('#warDetailMeta')?.textContent || '';
  const match = meta.match(/#(\d+)/);
  if (match) return match[1];

  try {
    return String(window.localStorage.getItem('rwengine.selectedWarDetail') || '').trim();
  } catch (_) {
    return '';
  }
}

function resetPanel(hide = false) {
  currentShareUrl = '';
  if (urlInput) urlInput.value = '';
  copyButton?.classList.add('hidden');
  revokeButton.disabled = false;
  setStatus('');
  if (hide) panel?.classList.add('hidden');
}

function setBusy(busy) {
  if (generateButton) {
    generateButton.disabled = busy;
    generateButton.textContent = busy ? 'Generating…' : 'Generate';
  }
}

function setStatus(message, error = false) {
  if (!status) return;
  status.textContent = message || '';
  status.classList.toggle('is-error', Boolean(error));
}

async function copyToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  if (!urlInput) throw new Error('Clipboard unavailable.');
  urlInput.value = value;
  urlInput.focus();
  urlInput.select();
  if (!document.execCommand('copy')) throw new Error('Clipboard unavailable.');
}
