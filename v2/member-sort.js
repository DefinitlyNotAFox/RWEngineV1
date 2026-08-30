const membersBody = document.querySelector('#membersBody');
const membersTable = document.querySelector('.members-table');

let statsSortDirection = 'desc';
let statsSortActive = false;
let applyingSort = false;

if (membersBody && membersTable) {
  installSortStyles();
  installStatsSort();

  const observer = new MutationObserver(() => {
    if (!statsSortActive || applyingSort) return;
    applyStatsSort();
  });

  observer.observe(membersBody, { childList: true });
}

function installSortStyles() {
  if (document.querySelector('style[data-rwe-member-sort]')) return;

  const style = document.createElement('style');
  style.dataset.rweMemberSort = '1';
  style.textContent = `
    .members-table th.sortable-header { padding: 0; }
    .table-sort-button {
      appearance: none;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      font-weight: inherit;
      letter-spacing: inherit;
      text-transform: inherit;
      width: 100%;
      padding: 10px 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      text-align: left;
    }
    .table-sort-button:hover,
    .table-sort-button.active { color: var(--accent, #8fe4c3); }
    .table-sort-button:focus-visible {
      outline: 1px solid var(--accent, #8fe4c3);
      outline-offset: -2px;
    }
    .sort-indicator { opacity: .65; font-size: 11px; }
    .table-sort-button.active .sort-indicator { opacity: 1; }
  `;
  document.head.appendChild(style);
}

function installStatsSort() {
  const headers = [...membersTable.querySelectorAll('thead th')];
  const statsHeader = headers.find(header => header.textContent.trim().toLowerCase() === 'stats');
  if (!statsHeader) return;

  statsHeader.classList.add('sortable-header');
  statsHeader.innerHTML = `
    <button class="table-sort-button" type="button" aria-label="Sort members by battle stats, highest first">
      <span>Stats</span>
      <span class="sort-indicator" aria-hidden="true">↕</span>
    </button>
  `;

  const button = statsHeader.querySelector('.table-sort-button');
  button?.addEventListener('click', event => {
    event.stopPropagation();

    if (!statsSortActive) {
      statsSortActive = true;
      statsSortDirection = 'desc';
    } else {
      statsSortDirection = statsSortDirection === 'desc' ? 'asc' : 'desc';
    }

    updateSortIndicator(button);
    applyStatsSort();
  });
}

function updateSortIndicator(button) {
  const indicator = button?.querySelector('.sort-indicator');
  if (!indicator) return;

  indicator.textContent = statsSortDirection === 'desc' ? '↓' : '↑';
  button.classList.add('active');
  button.setAttribute(
    'aria-label',
    statsSortDirection === 'desc'
      ? 'Members sorted by battle stats, highest first. Click for lowest first.'
      : 'Members sorted by battle stats, lowest first. Click for highest first.'
  );
}

function applyStatsSort() {
  const memberRows = [...membersBody.querySelectorAll('tr.member-row[data-member-id]')];
  if (memberRows.length < 2) return;

  const groups = memberRows.map((row, index) => {
    const next = row.nextElementSibling;
    return {
      row,
      detail: next?.classList.contains('member-detail-row') ? next : null,
      value: readStatsValue(row),
      index
    };
  });

  groups.sort((a, b) => {
    const aMissing = a.value === null;
    const bMissing = b.value === null;

    if (aMissing && bMissing) return a.index - b.index;
    if (aMissing) return 1;
    if (bMissing) return -1;

    const difference = statsSortDirection === 'desc'
      ? b.value - a.value
      : a.value - b.value;

    return difference || a.index - b.index;
  });

  applyingSort = true;
  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    fragment.appendChild(group.row);
    if (group.detail) fragment.appendChild(group.detail);
  }
  membersBody.appendChild(fragment);
  applyingSort = false;
}

function readStatsValue(row) {
  const text = row.querySelector('td:nth-child(4) .stat-value')?.textContent?.trim();
  if (!text) return null;

  const match = text.toLowerCase().replace(/,/g, '').match(/^([0-9]+(?:\.[0-9]+)?)([kmb])?$/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  const multiplier = match[2] === 'b'
    ? 1e9
    : match[2] === 'm'
      ? 1e6
      : match[2] === 'k'
        ? 1e3
        : 1;

  return value * multiplier;
}
