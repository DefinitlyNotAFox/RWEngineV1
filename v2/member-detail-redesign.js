const membersBody = document.querySelector('#membersBody');
const overviewMembers = document.querySelector('#overviewMembers');
const memberSearch = document.querySelector('#memberSearch');
const refreshButton = document.querySelector('#refreshButton');
const applyRangeButton = document.querySelector('#applyRangeButton');
const syncButton = document.querySelector('#syncIntelButton');
const membersNav = document.querySelector('.nav-button[data-tab="members"]');
const performanceNav = document.querySelector('.nav-button[data-tab="performance"]');
const intelFrom = document.querySelector('#intelFrom');
const intelTo = document.querySelector('#intelTo');

const memberLevels = new Map();
let metadataKey = '';
let metadataPromise = null;

if (membersBody) {
  installStylesheet();

  // Members is now a pure roster table. Stop the legacy app.js row-click
  // handler before it can create an inline member-detail row.
  membersBody.addEventListener('click', event => {
    if (event.target.closest('a.member-profile-link')) return;
    const row = event.target.closest('tr.member-row[data-member-id]');
    if (!row) return;
    event.stopImmediatePropagation();
  }, true);

  memberSearch?.addEventListener('input', scheduleRosterFormatting);
  membersNav?.addEventListener('click', scheduleRosterFormatting);
  refreshButton?.addEventListener('click', () => scheduleMetadataRefresh(true));
  applyRangeButton?.addEventListener('click', () => scheduleMetadataRefresh(true));
  syncButton?.addEventListener('click', () => scheduleMetadataRefresh(true));
  window.addEventListener('rwe:member-sort-reset', scheduleRosterFormatting);

  scheduleMetadataRefresh(false);
}

if (overviewMembers) {
  // Ranked-war contributor rows belong in Performance now, not in the removed
  // Members dropdown.
  overviewMembers.addEventListener('click', event => {
    const contributor = event.target.closest('[data-open-member]');
    if (!contributor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    performanceNav?.click();
  }, true);
}

function installStylesheet() {
  if (document.querySelector('link[data-rwe-member-detail-redesign]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/v2/member-detail-redesign.css?v=5';
  link.dataset.rweMemberDetailRedesign = '1';
  document.head.appendChild(link);
}

function scheduleRosterFormatting() {
  [0, 40, 140, 400, 900].forEach(delay => window.setTimeout(formatRosterRows, delay));
}

function scheduleMetadataRefresh(force) {
  [250, 700, 1500].forEach((delay, index) => {
    window.setTimeout(() => refreshRosterMetadata(force && index === 0), delay);
  });
}

async function refreshRosterMetadata(force = false) {
  const from = intelFrom?.value || '';
  const to = intelTo?.value || '';
  const factionId = document.querySelector('#adminFactionSelect')?.value || '';
  const key = `${factionId}:${from}:${to}`;

  if (!force && metadataKey === key && memberLevels.size) {
    formatRosterRows();
    return;
  }
  if (metadataPromise) return metadataPromise;

  metadataPromise = (async () => {
    try {
      const response = await fetch('/v2/range', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'getRange',
          ...(from ? { from } : {}),
          ...(to ? { to } : {})
        })
      });

      const data = await response.json();
      if (!response.ok || data.success === false) return;

      memberLevels.clear();
      for (const member of data.members || []) {
        const playerId = Number(member.playerId || 0);
        if (playerId > 0) memberLevels.set(playerId, member.level ?? null);
      }
      metadataKey = key;
      formatRosterRows();
    } catch (_) {
      // Presentational metadata only; the main app remains authoritative.
    } finally {
      metadataPromise = null;
    }
  })();

  return metadataPromise;
}

function formatRosterRows() {
  // Remove any legacy detail row left behind by a render that happened before
  // this module loaded.
  membersBody.querySelectorAll('tr.member-detail-row').forEach(row => row.remove());

  for (const row of membersBody.querySelectorAll('tr.member-row[data-member-id]')) {
    row.classList.remove('selected');
    row.removeAttribute('title');

    const playerId = Number(row.dataset.memberId || 0);
    const cell = row.cells?.[0];
    if (!playerId || !cell) continue;

    const existingLink = cell.querySelector('.member-profile-link');
    const originalName = cell.querySelector('.member-name')?.textContent?.trim();
    const name = originalName || existingLink?.dataset.playerName || `Player ${playerId}`;
    const originalMeta = cell.querySelector('.member-id')?.textContent || '';

    if (!row.dataset.memberStatus) {
      row.dataset.memberStatus = /\bcurrent\b/i.test(originalMeta) ? 'current' : 'former';
    }

    const level = memberLevels.get(playerId);
    if (level === undefined || level === null || level === '') continue;

    const link = document.createElement('a');
    link.className = 'member-profile-link';
    link.href = `https://www.torn.com/profiles.php?XID=${playerId}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.dataset.playerName = name;
    link.textContent = `${name} [${playerId}]`;
    link.title = `Open ${name}'s Torn profile`;

    const meta = document.createElement('span');
    meta.className = 'member-id member-roster-meta';
    meta.textContent = `Level ${level} · ${row.dataset.memberStatus === 'current' ? 'current member' : 'former member'}`;

    cell.replaceChildren(link, meta);
  }
}
