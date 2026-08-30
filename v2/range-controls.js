const intelFrom = document.querySelector('#intelFrom');
const intelTo = document.querySelector('#intelTo');
const applyRangeButton = document.querySelector('#applyRangeButton');
const memberSearch = document.querySelector('#memberSearch');
const syncStatus = document.querySelector('#syncStatus');
const metricMembers = document.querySelector('#metricMembers');

let trackingStartDate = null;
let availableMinDate = null;
let importedWars = [];
let activePreset = null;
let restoringBounds = false;

if (intelFrom && intelTo && applyRangeButton && syncStatus) {
  installStylesheet();
  hideLegacyRangeInputs();
  installToolbar();
  installObservers();
  updateVisibility();
  window.setTimeout(refreshBounds, 750);
}

function installStylesheet() {
  if (document.querySelector('link[data-rwe-range-controls]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/v2/range-controls.css?v=2';
  link.dataset.rweRangeControls = '1';
  document.head.appendChild(link);
}

function hideLegacyRangeInputs() {
  intelFrom.closest('label')?.classList.add('hidden');
  intelTo.closest('label')?.classList.add('hidden');
  applyRangeButton.classList.add('hidden');
  memberSearch?.classList.add('member-search-only');
}

function installToolbar() {
  if (document.querySelector('#rangeToolbar')) return;

  const toolbar = document.createElement('section');
  toolbar.id = 'rangeToolbar';
  toolbar.className = 'period-toolbar';
  toolbar.innerHTML = `
    <div class="period-main-row">
      <span class="period-label">Period</span>
      <div class="period-presets" role="group" aria-label="Analytics period">
        <button class="period-preset" type="button" data-range-preset="last4">Last 4 wars</button>
        <button class="period-preset" type="button" data-range-preset="month">This month</button>
        <button class="period-preset" type="button" data-range-preset="year">This year</button>
        <button class="period-preset" type="button" data-range-preset="wars">All wars</button>
        <button class="period-preset" type="button" data-range-preset="available">All available</button>
        <button class="period-preset" type="button" data-range-preset="custom">Custom</button>
      </div>
    </div>

    <div id="customRangeControls" class="period-custom-row hidden">
      <label>
        <span>From</span>
        <input id="customRangeFrom" type="date" aria-label="Custom period start" />
      </label>
      <span class="period-to">to</span>
      <label>
        <span>To</span>
        <input id="customRangeTo" type="date" aria-label="Custom period end" />
      </label>
      <button id="customRangeApply" class="button" type="button">Apply</button>
    </div>

    <div id="rangeCoverageNote" class="period-note hidden"></div>
  `;

  syncStatus.insertAdjacentElement('afterend', toolbar);

  toolbar.querySelectorAll('[data-range-preset]').forEach(button => {
    button.addEventListener('click', () => selectPreset(button.dataset.rangePreset));
  });

  toolbar.querySelector('#customRangeApply')?.addEventListener('click', applyCustomRange);
  toolbar.querySelector('#customRangeFrom')?.addEventListener('change', updateCoverageNoteFromDisplay);
  toolbar.querySelector('#customRangeTo')?.addEventListener('change', updateCoverageNoteFromDisplay);

  document.querySelectorAll('.nav-button').forEach(button => {
    button.addEventListener('click', () => window.setTimeout(updateVisibility, 0));
  });
}

function installObservers() {
  const minObserver = new MutationObserver(() => {
    const candidate = intelFrom.min;

    if (!restoringBounds && candidate && candidate !== availableMinDate) {
      if (!trackingStartDate || !availableMinDate || candidate > availableMinDate) trackingStartDate = candidate;
    }

    restoreAvailableBounds();
  });
  minObserver.observe(intelFrom, { attributes: true, attributeFilter: ['min', 'max'] });

  if (metricMembers) {
    const dataObserver = new MutationObserver(() => {
      if (metricMembers.textContent.trim() === '—') return;
      window.setTimeout(refreshBounds, 0);
    });
    dataObserver.observe(metricMembers, { childList: true, characterData: true, subtree: true });
  }
}

async function refreshBounds() {
  captureTrackingStart();

  try {
    importedWars = await fetchImportedWars();
  } catch (_) {
    importedWars = [];
  }

  updateAvailableMinFromWars();
  syncCustomInputs();
  updateCoverageNote();
}

function updateAvailableMinFromWars() {
  const earliestWarStart = importedWars
    .map(warStartTimestamp)
    .filter(Boolean)
    .sort((a, b) => a - b)[0];

  const earliestWarDate = earliestWarStart ? toDateInput(earliestWarStart) : null;
  availableMinDate = minDate(earliestWarDate, trackingStartDate) || trackingStartDate || earliestWarDate;
  restoreAvailableBounds();
}

function captureTrackingStart() {
  const currentMin = intelFrom.min;
  if (!currentMin) return;

  if (!availableMinDate || currentMin !== availableMinDate) {
    trackingStartDate = currentMin;
  }
}

function restoreAvailableBounds() {
  if (!availableMinDate) return;

  const today = toDateInput(Math.floor(Date.now() / 1000));
  restoringBounds = true;

  try {
    intelFrom.min = availableMinDate;
    intelTo.min = availableMinDate;
    intelFrom.max = today;
    intelTo.max = today;

    const displayFrom = document.querySelector('#customRangeFrom');
    const displayTo = document.querySelector('#customRangeTo');
    if (displayFrom) {
      displayFrom.min = availableMinDate;
      displayFrom.max = today;
    }
    if (displayTo) {
      displayTo.min = availableMinDate;
      displayTo.max = today;
    }
  } finally {
    queueMicrotask(() => { restoringBounds = false; });
  }
}

async function selectPreset(preset) {
  if (preset === 'custom') {
    await refreshBounds();
    activePreset = 'custom';
    updatePresetButtons();
    document.querySelector('#customRangeControls')?.classList.remove('hidden');
    syncCustomInputs();
    updateCoverageNoteFromDisplay();
    return;
  }

  document.querySelector('#customRangeControls')?.classList.add('hidden');

  try {
    importedWars = await fetchImportedWars();
    updateAvailableMinFromWars();
  } catch (_) {}

  const now = new Date();
  const today = toDateInput(Math.floor(Date.now() / 1000));
  let fromDate = null;
  let toDate = today;

  if (preset === 'last4') {
    const latestFour = importedWars
      .map(war => ({
        war,
        start: warStartTimestamp(war),
        end: warEndTimestamp(war)
      }))
      .filter(item => item.start || item.end)
      .sort((a, b) => (b.end || b.start) - (a.end || a.start))
      .slice(0, 4);

    if (!latestFour.length) {
      showToolbarMessage('No imported wars are available for this faction yet.');
      return;
    }

    fromDate = toDateInput(Math.min(...latestFour.map(item => item.start || item.end)));
    toDate = toDateInput(Math.max(...latestFour.map(item => item.end || item.start)));
  } else if (preset === 'month') {
    fromDate = localDateInput(new Date(now.getFullYear(), now.getMonth(), 1));
    if (availableMinDate && fromDate < availableMinDate) fromDate = availableMinDate;
  } else if (preset === 'year') {
    fromDate = localDateInput(new Date(now.getFullYear(), 0, 1));
    if (availableMinDate && fromDate < availableMinDate) fromDate = availableMinDate;
  } else if (preset === 'wars') {
    const starts = importedWars.map(warStartTimestamp).filter(Boolean);
    const ends = importedWars.map(warEndTimestamp).filter(Boolean);

    if (!starts.length && !ends.length) {
      showToolbarMessage('No imported wars are available for this faction yet.');
      return;
    }

    const earliest = Math.min(...(starts.length ? starts : ends));
    const latest = Math.max(...(ends.length ? ends : starts));
    fromDate = toDateInput(earliest);
    toDate = toDateInput(latest);
  } else if (preset === 'available') {
    fromDate = availableMinDate || trackingStartDate || today;
    toDate = today;
  } else {
    return;
  }

  activePreset = preset;
  updatePresetButtons();
  applyDates(fromDate, toDate);
}

function applyCustomRange() {
  const from = document.querySelector('#customRangeFrom')?.value;
  const to = document.querySelector('#customRangeTo')?.value;

  if (!from || !to) {
    showToolbarMessage('Choose both a start and end date.');
    return;
  }
  if (from > to) {
    showToolbarMessage('The start date must be before the end date.');
    return;
  }

  activePreset = 'custom';
  updatePresetButtons();
  applyDates(from, to);
}

function applyDates(from, to) {
  if (!from || !to) return;

  intelFrom.value = from;
  intelTo.value = to;
  syncCustomInputs();
  updateCoverageNote();
  applyRangeButton.click();
}

function syncCustomInputs() {
  const displayFrom = document.querySelector('#customRangeFrom');
  const displayTo = document.querySelector('#customRangeTo');
  if (displayFrom) displayFrom.value = intelFrom.value || '';
  if (displayTo) displayTo.value = intelTo.value || '';
}

function updateCoverageNoteFromDisplay() {
  const selected = document.querySelector('#customRangeFrom')?.value || intelFrom.value;
  updateCoverageNote(selected);
}

function updateCoverageNote(selectedFrom = intelFrom.value) {
  const note = document.querySelector('#rangeCoverageNote');
  if (!note) return;

  if (trackingStartDate && selectedFrom && selectedFrom < trackingStartDate) {
    note.innerHTML = `
      <strong>Historical coverage</strong>
      <span>Daily member tracking starts ${formatDate(trackingStartDate)}. Earlier dates can show imported war data, but activity, Xanax, OC and stat-change history is unavailable.</span>
    `;
    note.classList.remove('hidden');
  } else {
    note.textContent = '';
    note.classList.add('hidden');
  }
}

function showToolbarMessage(message) {
  const note = document.querySelector('#rangeCoverageNote');
  if (!note) return;
  note.innerHTML = `<strong>Period unavailable</strong><span>${escapeHtml(message)}</span>`;
  note.classList.remove('hidden');
}

function updatePresetButtons() {
  document.querySelectorAll('[data-range-preset]').forEach(button => {
    button.classList.toggle('active', button.dataset.rangePreset === activePreset);
  });
}

function updateVisibility() {
  const toolbar = document.querySelector('#rangeToolbar');
  if (!toolbar) return;
  const active = document.querySelector('.nav-button.active')?.dataset.tab;
  toolbar.classList.toggle('hidden', ['current-war', 'settings'].includes(active));
}

async function fetchImportedWars() {
  const response = await fetch('/api', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'getImportedWars' })
  });

  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error(`War archive returned HTTP ${response.status} without JSON.`); }
  if (!response.ok || data.success === false) throw new Error(data.message || 'Failed to load imported wars.');
  return data.wars || [];
}

function warStartTimestamp(war) {
  return Number(war?.start_timestamp || war?.end_timestamp || war?.imported_at || 0);
}

function warEndTimestamp(war) {
  return Number(war?.end_timestamp || war?.start_timestamp || war?.imported_at || 0);
}

function minDate(a, b) {
  if (a && b) return a < b ? a : b;
  return a || b || null;
}

function localDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toDateInput(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' }).format(date);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
