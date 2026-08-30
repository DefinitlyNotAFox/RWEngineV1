const membersBody = document.querySelector('#membersBody');
const membersTable = document.querySelector('.members-table');

let statsSortDirection = 'desc';
let statsSortActive = false;
let applyingSort = false;

if (membersBody && membersTable) {
  installStatsSort();

  const observer = new MutationObserver(() => {
    if (!statsSortActive || applyingSort) return;
    applyStatsSort();
  });

  observer.observe(membersBody, { childList: true });
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

    // Missing/estimated-unavailable data always remains at the bottom.
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
