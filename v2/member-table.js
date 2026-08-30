const membersBody = document.querySelector('#membersBody');
const membersTable = document.querySelector('.members-table');
const warsMetric = document.querySelector('#metricWars');
const memberSearch = document.querySelector('#memberSearch');
const refreshButton = document.querySelector('#refreshButton');
const syncButton = document.querySelector('#syncIntelButton');
const applyRangeButton = document.querySelector('#applyRangeButton');

const sortState = {
  key: null,
  direction: 'desc'
};

const sortColumns = {
  stats: { index: 3, label: 'Stats', parse: parseScaledNumber },
  activity: { index: 4, label: 'Activity / day', parse: parseDuration },
  xanax: { index: 5, label: 'Xanax / day', parse: parseNumber },
  ocs: { index: 6, label: 'OCs / month', parse: parseNumber },
  participation: { index: 7, label: 'RW participation', parse: parseNumber },
  hits: { index: 8, label: 'Avg hits / war', parse: parseNumber }
};

if (membersBody && membersTable) {
  installStylesheet();
  installHeaders();

  memberSearch?.addEventListener('input', schedulePresentation);
  membersBody.addEventListener('click', event => {
    if (event.target.closest('tr.member-row[data-member-id]')) {
      resetSort();
      schedulePresentationBurst();
      return;
    }
    schedulePresentation();
  });
  refreshButton?.addEventListener('click', () => {
    resetSort();
    schedulePresentationBurst();
  });
  syncButton?.addEventListener('click', () => {
    resetSort();
    schedulePresentationBurst();
  });
  applyRangeButton?.addEventListener('click', schedulePresentationBurst);
  window.addEventListener('rwe:member-sort-reset', () => {
    resetSort();
    schedulePresentationBurst();
  });

  window.setTimeout(schedulePresentation, 500);
  window.setTimeout(schedulePresentation, 1400);
}

function installStylesheet() {
  if (document.querySelector('link[data-rwe-member-table]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/v2/member-table.css?v=2';
  link.dataset.rweMemberTable = '1';
  document.head.appendChild(link);
}

function installHeaders() {
  const headers = [...membersTable.querySelectorAll('thead th')];

  for (const [key, config] of Object.entries(sortColumns)) {
    const header = headers[config.index];
    if (!header || header.querySelector('[data-member-sort]')) continue;

    header.classList.add('sortable-header');
    header.innerHTML = `
      <button class="table-sort-button" type="button" data-member-sort="${key}">
        <span>${escapeHtml(config.label)}</span>
        <span class="sort-indicator" aria-hidden="true">↕</span>
      </button>
    `;
  }

  membersTable.addEventListener('click', event => {
    const button = event.target.closest('[data-member-sort]');
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();

    const key = button.dataset.memberSort;
    if (!sortColumns[key]) return;

    if (sortState.key === key) {
      sortState.direction = sortState.direction === 'desc' ? 'asc' : 'desc';
    } else {
      sortState.key = key;
      sortState.direction = 'desc';
    }

    applyPresentation();
  });
}

function schedulePresentation() {
  window.requestAnimationFrame(applyPresentation);
}

function schedulePresentationBurst() {
  [0, 60, 180, 450, 900, 1600, 2600].forEach(delay => {
    window.setTimeout(schedulePresentation, delay);
  });
}

function applyPresentation() {
  applyEmptyStates();
  updateIndicators();
  if (sortState.key) applySort();
}

function resetSort() {
  if (!sortState.key) return;
  sortState.key = null;
  sortState.direction = 'desc';
  updateIndicators();
}

function applyEmptyStates() {
  const hasWars = Number(String(warsMetric?.textContent || '0').replace(/[^0-9.-]/g, '')) > 0;

  for (const row of membersBody.querySelectorAll('tr.member-row[data-member-id]')) {
    const cells = row.cells;
    if (cells.length < 9) continue;

    replaceUnavailable(cells[3], 'No stat source');
    replaceUnavailable(cells[4], 'Needs 2 snapshots');
    replaceUnavailable(cells[5], 'Needs 2 snapshots');
    replaceUnavailable(cells[6], 'Not tracked yet');
    if (!hasWars) {
      replaceUnavailable(cells[7], 'No wars');
      replaceUnavailable(cells[8], 'No wars');
    }
  }
}

function replaceUnavailable(cell, replacement) {
  if (!cell || cell.textContent.trim() !== 'Unavailable') return;
  const marker = cell.querySelector('.unavailable');
  if (marker) marker.textContent = replacement;
  else cell.textContent = replacement;
  cell.classList.add('metric-not-ready');
  cell.title = replacement;
}

function applySort() {
  const config = sortColumns[sortState.key];
  if (!config) return;

  const memberRows = [...membersBody.querySelectorAll('tr.member-row[data-member-id]')];
  if (memberRows.length < 2) return;

  const groups = memberRows.map((row, index) => {
    const next = row.nextElementSibling;
    return {
      row,
      detail: next?.classList.contains('member-detail-row') ? next : null,
      value: readSortValue(row, config),
      index
    };
  });

  groups.sort((a, b) => {
    const aMissing = a.value === null;
    const bMissing = b.value === null;

    if (aMissing && bMissing) return a.index - b.index;
    if (aMissing) return 1;
    if (bMissing) return -1;

    const difference = sortState.direction === 'desc'
      ? b.value - a.value
      : a.value - b.value;

    return difference || a.index - b.index;
  });

  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    fragment.appendChild(group.row);
    if (group.detail) fragment.appendChild(group.detail);
  }
  membersBody.appendChild(fragment);
}

function readSortValue(row, config) {
  const cell = row.cells[config.index];
  if (!cell) return null;
  const text = cell.querySelector('.stat-value')?.textContent?.trim() || cell.textContent.trim();
  if (!text || /unavailable|no stat source|needs 2 snapshots|not tracked|no wars/i.test(text)) return null;
  return config.parse(text);
}

function updateIndicators() {
  membersTable.querySelectorAll('[data-member-sort]').forEach(button => {
    const key = button.dataset.memberSort;
    const indicator = button.querySelector('.sort-indicator');
    const active = key === sortState.key;
    button.classList.toggle('active', active);
    if (indicator) indicator.textContent = active ? (sortState.direction === 'desc' ? '↓' : '↑') : '↕';
  });
}

function parseScaledNumber(text) {
  const normalized = normalizeDecimalText(text).toLowerCase();
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)([kmbt])?$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const multipliers = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  return value * (multipliers[match[2]] || 1);
}

function parseDuration(text) {
  const lower = String(text || '').toLowerCase();
  let seconds = 0;
  let matched = false;
  const hour = lower.match(/([0-9]+(?:[.,][0-9]+)?)\s*h/);
  const minute = lower.match(/([0-9]+(?:[.,][0-9]+)?)\s*m/);
  const second = lower.match(/([0-9]+(?:[.,][0-9]+)?)\s*s/);
  if (hour) { seconds += Number(hour[1].replace(',', '.')) * 3600; matched = true; }
  if (minute) { seconds += Number(minute[1].replace(',', '.')) * 60; matched = true; }
  if (second) { seconds += Number(second[1].replace(',', '.')); matched = true; }
  return matched && Number.isFinite(seconds) ? seconds : null;
}

function parseNumber(text) {
  const normalized = normalizeDecimalText(text).replace(/%/g, '');
  const match = normalized.match(/-?[0-9]+(?:\.[0-9]+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function normalizeDecimalText(text) {
  let value = String(text || '').trim().replace(/\s+/g, '');
  if (value.includes(',') && !value.includes('.')) value = value.replace(',', '.');
  else if (value.includes(',') && value.includes('.')) value = value.replace(/,/g, '');
  return value;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
