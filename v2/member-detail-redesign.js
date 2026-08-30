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
  link.href = '/v2/member-detail-redesign.css?v=3';
  link.dataset.rweMemberDetailRedesign = '1';
  document.head.appendChild(link);
}

function scheduleDetailRedesign() {
  // The detail row renders as loading, then once again after the lazy API call.
  // Bounded checks handle both states without continuously observing the DOM.
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
    if (level === undefined || level === null) level = levelFromExpandedRow(row);

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
    meta.textContent = `Level ${level ?? '—'} · ${row.dataset.memberStatus === 'current' ? 'current member' : 'former member'}`;

    cell.replaceChildren(link, meta);
  }
}

function levelFromExpandedRow(row) {
  const detail = row.nextElementSibling;
  if (!detail?.classList.contains('member-detail-row')) return null;
  const text = detail.querySelector('.member-inline-header p:last-child')?.textContent || '';
  const match = text.match(/Level\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

function redesignVisibleMemberDetail() {
  const panel = membersBody.querySelector('.member-inline-panel');
  const body = panel?.querySelector('.member-inline-body');
  if (!panel || !body) return;

  stripRepeatedHeader(panel);
  if (body.classList.contains('member-detail-redesigned')) return;

  const summaryGrid = directChild(body, '.detail-grid:not(.compact)') || body.querySelector(':scope > .detail-grid');
  const performanceSection = body.querySelector(':scope > .member-detail-section');
  const performanceGrid = performanceSection?.querySelector('.detail-grid.compact');
  const warTable = performanceSection?.querySelector('.detail-war-table');

  // Still waiting for the lazy member-detail response.
  if (!summaryGrid || !performanceSection || !performanceGrid) return;

  const summaryCards = [...summaryGrid.children];
  const performanceCards = [...performanceGrid.children];
  const warCount = countWarRows(warTable);

  const performance = document.createElement('section');
  performance.className = 'member-performance-strip';

  const performanceLabel = document.createElement('span');
  performanceLabel.className = 'member-performance-label';
  performanceLabel.textContent = 'War performance';

  const warMetrics = document.createElement('div');
  warMetrics.className = 'member-compact-metrics';
  performanceCards
    .filter(card => cardLabel(card) !== 'participation')
    .forEach(card => warMetrics.appendChild(toMetricLine(card)));

  performance.append(performanceLabel, warMetrics);

  const historyDetails = document.createElement('details');
  historyDetails.className = 'member-disclosure';
  historyDetails.innerHTML = `
    <summary>
      <span>Historical wars</span>
      <small>${warCount > 0 ? `${warCount} war${warCount === 1 ? '' : 's'}` : 'No wars in period'}</small>
    </summary>
  `;
  const historyBody = document.createElement('div');
  historyBody.className = 'member-disclosure-body member-history-body';
  if (warTable) historyBody.appendChild(warTable);
  historyDetails.appendChild(historyBody);

  const trackingDetails = document.createElement('details');
  trackingDetails.className = 'member-disclosure';
  trackingDetails.innerHTML = '<summary><span>Tracking details</span></summary>';
  const trackingBody = document.createElement('div');
  trackingBody.className = 'member-disclosure-body';
  trackingBody.innerHTML = `<p class="member-tracking-summary">${escapeHtml(buildTrackingSummary(summaryCards, warCount))}</p>`;
  trackingDetails.appendChild(trackingBody);

  body.replaceChildren(performance, historyDetails, trackingDetails);
  body.classList.add('member-detail-redesigned');
  panel.classList.add('compact-member-panel');
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

function cardLabel(card) {
  return card.querySelector('span')?.textContent?.trim().toLowerCase() || '';
}

function toMetricLine(card) {
  const line = document.createElement('article');
  line.className = 'member-metric-line';

  const label = card.querySelector('span')?.textContent?.trim() || '';
  const strong = card.querySelector('strong');
  const note = card.querySelector('small')?.textContent?.trim() || '';

  const labelNode = document.createElement('span');
  labelNode.textContent = label;

  const valueWrap = document.createElement('div');
  const valueNode = document.createElement('strong');
  valueNode.innerHTML = strong?.innerHTML || '—';
  valueWrap.appendChild(valueNode);

  if (note) {
    const noteNode = document.createElement('small');
    noteNode.textContent = note;
    valueWrap.appendChild(noteNode);
  }

  line.append(labelNode, valueWrap);
  return line;
}

function buildTrackingSummary(summaryCards, warCount) {
  const notes = [];

  for (const card of summaryCards) {
    const label = card.querySelector('span')?.textContent?.trim();
    const note = card.querySelector('small')?.textContent?.trim();
    if (!label || !note) continue;

    if (label === 'Battle stats') {
      if (/verified/i.test(note)) notes.push('Battle stats are verified by the member API.');
      else if (/estimate/i.test(note)) notes.push('Battle stats currently use an estimate.');
      else notes.push('No battle-stat source is currently available.');
    }

    if (label === 'Activity / day' && note) {
      notes.push(note.endsWith('.') ? note : `${note}.`);
    }
  }

  if (!warCount) notes.push('No imported ranked wars are available in this period.');
  return notes.join(' ') || 'No additional tracking details are available for this member yet.';
}

function countWarRows(warTable) {
  if (!warTable) return 0;
  return [...warTable.querySelectorAll('tbody tr')]
    .filter(row => !row.querySelector('td.empty'))
    .length;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
