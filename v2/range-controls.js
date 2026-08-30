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
let restoringMin = false;

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
  link.href = '/v2/range-controls.css?v=1';
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
  toolbar.className = 'range-toolbar';
  toolbar.innerHTML = `
    <div class="range-preset-row">
      <span class="range-label">Range</span>
      <div class="range-presets" role="group" aria-label="Analytics range">
        <button class="range-preset" type="button" data-range-preset="last4">Last 4</button>
        <button class="range-preset" type="button" data-range-preset="month">This month</button>
        <button class="range-preset" type="button" data-range-preset="year">This year</button>
        <button class="range-preset" type="button" data-range-preset="all">All wars</button>
        <button class="range-preset" type="button" data-range-preset="custom">Custom</button>
      </div>
      <div id="customRangeControls" class="custom-range-controls hidden">
        <input id="customRangeFrom" type="date" aria-label="Custom range start" />
        <span>to</span>
        <input id="customRangeTo" type="date" aria-label="Custom range end" />
        <button id="customRangeApply" class="button" type="button">Apply</button>
      </div>
    </div>
    <div id="rangeCoverageNote" class="range-coverage-note hidden"></div>
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

    if (!restoringMin && candidate && candidate !== availableMinDate) {
      if (!trackingStartDate || candidate > availableMinDate) trackingStartDate = candidate;
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

  const earliestWar = importedWars
    .map(warTimestamp)
    .filter(Boolean)
    .sort((a, b) => a - b)[0];

  const earliestWarDate = earliestWar ? toDateInput(earliestWar) : null;
  availableMinDate = minDate(earliestWarDate, trackingStartDate) || trackingStartDate || earliestWarDate;
  restoreAvailableBounds();
  syncCustomInputs();
  updateCoverageNote();
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
  restoringMin = true;
  try {
    if (intelFrom.min !== availableMinDate) intelFrom.min = availableMinDate;
    if (intelTo.min !== availableMinDate) intelTo.min = availableMinDate;
    if (intelFrom.max !== today) intelFrom.max = today;
    if (intelTo.max !== today) intelTo.max = today;

    const displayFrom = document.querySelector('#customRangeFrom');
    const displayTo = document.querySelector('#customRangeTo');
    if (displayFrom) { displayFrom.min = availableMinDate; displayFrom.max = today; }
    if (displayTo) { displayTo.min = availableMinDate; displayTo.max = today; }
  } finally {
    queueMicrotask(() => { restoringMin = false; });
  }
}

async function selectPreset(preset) {
  if (preset === 'custom') {
    activePreset = 'custom';
    updatePresetButtons();
    document.querySelector('#customRangeControls')?.classList.remove('hidden');
    syncCustomInputs();
    updateCoverageNoteFromDisplay();
    return;
  }

  document.querySelector('#customRangeControls')?.classList.add('hidden');

  if (!importedWars.length) {
    try { importedWars = await fetchImportedWars(); } catch (_) {}
  }

  const today = new Date();
  let fromDate;
  let toDate = toDateInput(Math.floor(Date.now() / 1000));

  if (preset === 'last4') {
    const latestFour = importedWars
      .map(war => ({ war, timestamp: warTimestamp(war) }))
      .filter(item => item.timestamp)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 4);

    if (!latestFour.length) {
      showToolbarMessage('No imported wars are available for this faction yet.');
      return;
    }

    fromDate = toDateInput(Math.min(...latestFour.map(item => item.timestamp)));
    toDate = toDateInput(Math.max(...latestFour.map(item => item.timestamp)));
  } else if (preset === 'month') {
    fromDate = localDateInput(new Date(today.getFullYear(), today.getMonth(), 1));
  } else if (preset === 'year') {
    fromDate = localDateInput(new Date(today.getFullYear(), 0, 1));
  } else if (preset === 'all') {
    const earliest = importedWars.map(warTimestamp).filter(Boolean).sort((a, b) => a - b)[0];
    fromDate = earliest ? toDateInput(earliest) : (trackingStartDate || availableMinDate || toDate);
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
  const displayFrom = document.querySelector('#customRangeFrom');
  const selected = displayFrom?.value || intelFrom.value;
  updateCoverageNote(selected);
}

function updateCoverageNote(selectedFrom = intelFrom.value) {
  const note = document.querySelector('#rangeCoverageNote');
  if (!note) return;

  if (trackingStartDate && selectedFrom && selectedFrom < trackingStartDate) {
    note.textContent = `Historical war data is available for this range. Daily member-stat tracking starts ${formatDate(trackingStartDate)}, so activity, Xanax, OC and stat-change data before that date is unavailable.`;
    note.classList.remove('hidden');
  } else {
    note.textContent = '';
    note.classList.add('hidden');
  }
}

function showToolbarMessage(message) {
  const note = document.querySelector('#rangeCoverageNote');
  if (!note) return;
  note.textContent = message;
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

function warTimestamp(war) {
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
