const ATTACK_STEP_DELAY_MS = 6000;
const ATTACK_DETAIL_STEP_DELAY_MS = 1200;
const WAR_IMPORT_COOLDOWN_MS = 30000;
const ATTACK_STEP_LIMIT = 300;
const ATTACK_DETAIL_STEP_LIMIT = 20;

const form = document.querySelector('#historicalWarImportForm');
const reportIdsInput = document.querySelector('#historicalWarReportIds');
const overwriteInput = document.querySelector('#historicalWarOverwrite');
const statusBox = document.querySelector('#historicalWarImportStatus');
const progressBox = document.querySelector('#historicalWarImportProgress');
const progressSummary = document.querySelector('#historicalWarImportSummary');
const progressBar = document.querySelector('#historicalWarImportBar');
const progressList = document.querySelector('#historicalWarImportList');
const refreshButton = document.querySelector('#refreshButton');

if (form) {
  form.addEventListener('submit', handleImportSubmit);
}

async function handleImportSubmit(event) {
  event.preventDefault();

  const reportIds = parseReportIds(reportIdsInput?.value);
  if (!reportIds.length) {
    showStatus('error', 'Enter at least one ranked war report ID.');
    return;
  }

  const overwrite = Boolean(overwriteInput?.checked);
  const submitButton = form.querySelector('button[type="submit"]');
  const originalText = submitButton?.textContent || 'Import reports';
  const targetName = document.querySelector('#adminFactionSelect')?.selectedOptions?.[0]?.textContent?.trim();

  showStatus('', '');
  progressBox?.classList.remove('hidden');
  if (progressList) progressList.innerHTML = '';
  setOverallProgress(0, reportIds.length, targetName ? `Starting import for ${targetName}…` : 'Starting historical import…');

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Importing…';
  }

  let successful = 0;
  let skipped = 0;
  let failed = 0;
  let overwritten = 0;

  try {
    for (let index = 0; index < reportIds.length; index += 1) {
      const reportId = reportIds[index];
      let usedTornApi = false;

      updateReportRow(reportId, 'active', 'Checking', 'Checking whether this report is already stored.');
      setOverallProgress(index, reportIds.length, `Checking report ${reportId}…`);

      try {
        const existing = await api('checkImportStatus', { rankId: reportId });

        if (existing.exists && !overwrite) {
          skipped += 1;
          updateReportRow(reportId, 'skipped', 'Already stored', 'Skipped. Enable “Overwrite existing reports” to re-import it.');
          setOverallProgress(index + 1, reportIds.length, `Report ${reportId} skipped.`);
          continue;
        }

        if (existing.exists && overwrite) {
          overwritten += 1;
          updateReportRow(reportId, 'active', 'Overwrite', 'Replacing the existing report and rebuilding its attack summary.');
        } else {
          updateReportRow(reportId, 'active', 'Importing', 'Reading ranked-war report data from Torn.');
        }

        const imported = await api('importRankedWarReport', {
          rankId: reportId,
          overwrite
        });
        usedTornApi = true;

        if (imported.skipped) {
          skipped += 1;
          updateReportRow(reportId, 'skipped', 'Skipped', imported.message || 'Report already exists.');
          setOverallProgress(index + 1, reportIds.length, `Report ${reportId} skipped.`);
          continue;
        }

        const warId = imported.war?.warId || imported.war?.war_id || reportId;
        updateReportRow(reportId, 'active', 'Attacks', 'Base report stored. Building the score and attack summary…');

        const summary = await applyAttackSummary(warId, reportId, index, reportIds.length);

        updateReportRow(reportId, 'active', 'Verify', 'Verifying complete attack coverage through Torn API v2…');
        setOverallProgress(index, reportIds.length, `Report ${reportId}: verifying complete attack coverage…`);
        await sleep(ATTACK_DETAIL_STEP_DELAY_MS);
        const detail = await applyAttackDetailSupplement(warId, reportId, index, reportIds.length);

        successful += 1;

        const chain = imported.chainAdjustment;
        const chainNote = chain?.status || chain?.message || 'checked';
        const paginationNote = detail.paginationStopped
          ? ` · pagination ${detail.paginationStopped === 'repeated-page' ? 'stabilized' : 'stopped after no new rows'}`
          : '';
        updateReportRow(
          reportId,
          'success',
          'Complete',
          `Verified ${formatNumber(detail.storedTotal || 0)} unique attack rows via v2 · ${formatNumber(detail.assists || 0)} assists · respect +${formatDecimal(detail.respectEarned || 0, 2)} / -${formatDecimal(detail.respectLost || 0, 2)} · score pass checked ${formatNumber(summary.checked || 0)} · chain adjustment ${chainNote}${paginationNote}.`
        );
        setOverallProgress(index + 1, reportIds.length, `Report ${reportId} complete.`);
      } catch (error) {
        failed += 1;
        updateReportRow(reportId, 'failed', 'Failed', error.message || String(error));
        setOverallProgress(index + 1, reportIds.length, `Report ${reportId} failed.`);
      }

      if (usedTornApi && index < reportIds.length - 1) {
        await cooldown(reportId, WAR_IMPORT_COOLDOWN_MS);
      }
    }

    showStatus(
      failed ? 'warning' : 'success',
      `Import finished: ${successful} successful, ${skipped} skipped, ${failed} failed${overwritten ? `, ${overwritten} overwritten` : ''}.`
    );

    if (reportIdsInput && failed === 0) reportIdsInput.value = '';

    window.dispatchEvent(new CustomEvent('rwe:wars-changed'));
    refreshButton?.click();
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = originalText;
    }
  }
}

async function applyAttackSummary(warId, reportId, reportIndex, totalReports) {
  let reset = true;
  let latestSummary = {};

  for (let step = 0; step < ATTACK_STEP_LIMIT; step += 1) {
    const result = await api('applyAttackSummary', { warId, reset });
    reset = false;
    latestSummary = result.summary || latestSummary;

    const pending = Number(result.pendingWindows || 0);
    const checked = Number(latestSummary.checked || 0);
    const windows = Number(latestSummary.windowsFetched || 0);

    updateReportRow(
      reportId,
      'active',
      'Attacks',
      `Score pass: ${formatNumber(checked)} attacks · ${formatNumber(windows)} windows · ${formatNumber(pending)} pending.`
    );
    setOverallProgress(
      reportIndex,
      totalReports,
      `Report ${reportId}: processing score attack logs (${formatNumber(checked)} checked)…`
    );

    if (result.done) return latestSummary;
    await sleep(ATTACK_STEP_DELAY_MS);
  }

  throw new Error('Attack summary did not finish within the safety limit.');
}

async function applyAttackDetailSupplement(warId, reportId, reportIndex, totalReports) {
  let nextUrl = null;
  let latest = null;
  let previousStoredTotal = -1;
  const seenNextPages = new Set();

  for (let step = 0; step < ATTACK_DETAIL_STEP_LIMIT; step += 1) {
    const result = await attackDetailApi({
      warId,
      ...(nextUrl ? { nextUrl } : {})
    });
    latest = result;

    const storedTotal = Number(result.storedTotal || 0);
    updateReportRow(
      reportId,
      'active',
      'Verify',
      `v2 coverage: ${formatNumber(storedTotal)} unique attack rows · ${formatNumber(result.assists || 0)} assists · ${formatNumber(result.membersWithDetail || 0)} members with detail.`
    );
    setOverallProgress(
      reportIndex,
      totalReports,
      `Report ${reportId}: verified ${formatNumber(storedTotal)} unique attack rows…`
    );

    if (result.done) return result;

    const candidateNextUrl = String(result.nextUrl || '').trim();
    if (!candidateNextUrl) {
      throw new Error('Torn reported more attack pages but did not provide a next page URL.');
    }

    const pageKey = canonicalPageKey(candidateNextUrl);
    if (seenNextPages.has(pageKey)) {
      return { ...result, done: true, nextUrl: null, paginationStopped: 'repeated-page' };
    }

    if (step > 0 && storedTotal <= previousStoredTotal) {
      return { ...result, done: true, nextUrl: null, paginationStopped: 'no-new-rows' };
    }

    seenNextPages.add(pageKey);
    previousStoredTotal = storedTotal;
    nextUrl = candidateNextUrl;
    await sleep(ATTACK_DETAIL_STEP_DELAY_MS);
  }

  throw new Error(`Attack-detail verification exceeded ${ATTACK_DETAIL_STEP_LIMIT} v2 pages${latest ? ` after ${formatNumber(latest.storedTotal || 0)} unique rows` : ''}.`);
}

function canonicalPageKey(value) {
  try {
    const url = new URL(String(value), window.location.origin);
    url.searchParams.delete('key');
    url.searchParams.delete('comment');
    return `${url.origin}${url.pathname}?${[...url.searchParams.entries()]
      .sort(([aKey, aValue], [bKey, bValue]) => `${aKey}=${aValue}`.localeCompare(`${bKey}=${bValue}`))
      .map(([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(val)}`)
      .join('&')}`;
  } catch (_) {
    return String(value);
  }
}

async function attackDetailApi(payload = {}) {
  const adminFactionId = Number(document.querySelector('#adminFactionSelect')?.value || 0);
  const response = await fetch('/v2/war-attack-detail', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      ...(adminFactionId > 0 ? { factionId: adminFactionId } : {})
    })
  });

  let result;
  try {
    result = await response.json();
  } catch (_) {
    throw new Error(`Attack-detail backend returned HTTP ${response.status} without JSON.`);
  }

  if (!response.ok || result.success === false) {
    throw new Error(result.message || `Attack-detail verification failed with HTTP ${response.status}.`);
  }
  return result;
}

async function cooldown(reportId, milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    updateReportRow(reportId, 'success', 'Complete', `Complete. Waiting ${remaining}s before the next report to respect Torn API limits.`);
    await sleep(1000);
  }
}

function parseReportIds(value) {
  return [...new Set(
    String(value || '')
      .split(/[\s,;]+/)
      .map(value => value.trim())
      .filter(Boolean)
  )];
}

function setOverallProgress(done, total, text) {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  if (progressSummary) progressSummary.textContent = `${text} ${done} / ${total}`;
  if (progressBar) progressBar.style.width = `${percent}%`;
}

function updateReportRow(reportId, state, label, message) {
  if (!progressList) return;

  let row = progressList.querySelector(`[data-report-id="${cssEscape(reportId)}"]`);
  if (!row) {
    row = document.createElement('div');
    row.dataset.reportId = reportId;
    progressList.appendChild(row);
  }

  row.className = `historical-import-row is-${state}`;
  row.innerHTML = `
    <strong>#${escapeHtml(reportId)}</strong>
    <span>${escapeHtml(label)}</span>
    <small>${escapeHtml(message)}</small>
  `;
}

function showStatus(type, message) {
  if (!statusBox) return;
  statusBox.textContent = message || '';
  statusBox.className = `historical-import-status${type ? ` is-${type}` : ''}${message ? '' : ' hidden'}`;
}

async function api(action, payload = {}) {
  const adminFactionId = Number(document.querySelector('#adminFactionSelect')?.value || 0);
  const useAdminImporter = adminFactionId > 0;
  const endpoint = useAdminImporter ? '/v2/war-import-admin' : '/api';
  const requestBody = {
    action,
    ...payload,
    ...(useAdminImporter ? { factionId: adminFactionId } : {})
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  let result;
  try {
    result = await response.json();
  } catch (_) {
    throw new Error(`Backend returned HTTP ${response.status} without JSON.`);
  }

  if (!response.ok || result.success === false) {
    throw new Error(result.message || `Request failed with HTTP ${response.status}.`);
  }

  return result;
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

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function sleep(milliseconds) {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
