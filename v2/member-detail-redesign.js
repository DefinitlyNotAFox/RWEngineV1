const membersBody = document.querySelector('#membersBody');
const memberSearch = document.querySelector('#memberSearch');
const refreshButton = document.querySelector('#refreshButton');
const applyRangeButton = document.querySelector('#applyRangeButton');
const syncButton = document.querySelector('#syncIntelButton');
const membersNav = document.querySelector('.nav-button[data-tab="members"]');
const intelFrom = document.querySelector('#intelFrom');
const intelTo = document.querySelector('#intelTo');

const memberLevels = new Map();
let metadataKey = '';
let metadataPromise = null;

if (membersBody) {
  installStylesheet();

  membersBody.addEventListener('click', event => {
    if (event.target.closest('tr.member-row[data-member-id]')) {
      scheduleDetailRedesign();
      scheduleRosterFormatting();
    }
  });

  memberSearch?.addEventListener('input', scheduleRosterFormatting);
  membersNav?.addEventListener('click', () => {
    scheduleRosterFormatting();
    scheduleDetailRedesign();
  });

  refreshButton?.addEventListener('click', () => scheduleMetadataRefresh(true));
  applyRangeButton?.addEventListener('click', () => scheduleMetadataRefresh(true));
  syncButton?.addEventListener('click', () => scheduleMetadataRefresh(true));
  window.addEventListener('rwe:member-sort-reset', () => {
    scheduleRosterFormatting();
    scheduleDetailRedesign();
  });

  scheduleMetadataRefresh(false);
  scheduleDetailRedesign();
}

function installStylesheet() {
  if (document.querySelector('link[data-rwe-member-detail-redesign]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/v2/member-detail-redesign.css?v=4';
  link.dataset.rweMemberDetailRedesign = '1';
  document.head.appendChild(link);
}

function scheduleDetailRedesign() {
  [0, 60, 180, 450, 900, 1600, 2600].forEach(delay => {
    window.setTimeout(() => {
      redesignVisibleMemberDetail();
      formatRosterRows();
    }, delay);
  });
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
  for (const row of membersBody.querySelectorAll('tr.member-row[data-member-id]')) {
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

    let level = memberLevels.get(playerId);
    if (level === undefined || level === null) level = row.dataset.memberLevel || levelFromExpandedRow(row);
    if (level === undefined || level === null || level === '') continue;

    const link = document.createElement('a');
    link.className = 'member-profile-link';
    link.href = `https://www.torn.com/profiles.php?XID=${playerId}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.dataset.playerName = name;
    link.textContent = `${name} [${playerId}]`;
    link.title = `Open ${name}'s Torn profile`;
    link.addEventListener('click', event => event.stopPropagation());

    const meta = document.createElement('span');
    meta.className = 'member-id member-roster-meta';
    meta.textContent = `Level ${level} · ${row.dataset.memberStatus === 'current' ? 'current member' : 'former member'}`;

    cell.replaceChildren(link, meta);
  }
}

function levelFromExpandedRow(row) {
  const detail = row.nextElementSibling;
  if (!detail?.classList.contains('member-detail-row')) return null;
  const text = detail.querySelector('.member-inline-header p:last-child')?.textContent || '';
  const match = text.match(/Level\s+(\d+)/i);
  if (!match) return null;
  row.dataset.memberLevel = match[1];
  return match[1];
}

function redesignVisibleMemberDetail() {
  const panel = membersBody.querySelector('.member-inline-panel');
  const body = panel?.querySelector('.member-inline-body');
  if (!panel || !body) return;

  preserveExpandedLevel(panel);
  stripRepeatedHeader(panel);
  if (body.classList.contains('member-detail-redesigned')) return;

  const summaryGrid = directChild(body, '.detail-grid:not(.compact)') || body.querySelector(':scope > .detail-grid');
  if (!summaryGrid) return;

  const summaryCards = [...summaryGrid.children];
  const trackingLine = document.createElement('div');
  trackingLine.className = 'member-tracking-inline';
  trackingLine.textContent = buildTrackingSummary(summaryCards);

  body.replaceChildren(trackingLine);
  body.classList.add('member-detail-redesigned');
  panel.classList.add('compact-member-panel');
}

function preserveExpandedLevel(panel) {
  const detailRow = panel.closest('tr.member-detail-row');
  const memberRow = detailRow?.previousElementSibling;
  if (!memberRow?.matches('tr.member-row[data-member-id]')) return;
  const text = panel.querySelector('.member-inline-header p:last-child')?.textContent || '';
  const match = text.match(/Level\s+(\d+)/i);
  if (match) memberRow.dataset.memberLevel = match[1];
}

function stripRepeatedHeader(panel) {
  const header = panel.querySelector('.member-inline-header');
  if (!header) return;

  const close = header.querySelector('[data-close-member]');
  if (close) {
    close.classList.add('member-floating-close');
    panel.appendChild(close);
  }
  header.remove();
  panel.classList.add('compact-member-panel');
}

function directChild(parent, selector) {
  return [...parent.children].find(child => child.matches(selector)) || null;
}

function buildTrackingSummary(summaryCards) {
  const notes = [];

  for (const card of summaryCards) {
    const label = card.querySelector('span')?.textContent?.trim();
    const note = card.querySelector('small')?.textContent?.trim();
    if (!label || !note) continue;

    if (label === 'Battle stats') {
      if (/verified/i.test(note)) notes.push('Battle stats verified by member API');
      else if (/estimate/i.test(note)) notes.push('Battle stats use an estimate');
      else notes.push('No battle-stat source');
    }

    if (label === 'Activity / day') {
      notes.push(note.replace(/\.$/, ''));
    }

    if (label === 'OCs / month' && /tracking will|unavailable/i.test(note)) {
      notes.push('OC trend not available yet');
    }
  }

  return notes.filter(Boolean).join(' · ') || 'No additional tracking details available yet';
}
