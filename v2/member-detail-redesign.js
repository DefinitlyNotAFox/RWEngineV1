const membersBody = document.querySelector('#membersBody');
const memberSearch = document.querySelector('#memberSearch');
const refreshButton = document.querySelector('#refreshButton');
const applyRangeButton = document.querySelector('#applyRangeButton');
const syncButton = document.querySelector('#syncIntelButton');
const membersNav = document.querySelector('.nav-button[data-tab="members"]');

if (membersBody) {
  installStylesheet();

  membersBody.addEventListener('click', event => {
    if (event.target.closest('tr.member-row[data-member-id]')) scheduleDetailRedesign();
  });

  memberSearch?.addEventListener('input', scheduleDetailRedesign);
  refreshButton?.addEventListener('click', scheduleDetailRedesign);
  applyRangeButton?.addEventListener('click', scheduleDetailRedesign);
  syncButton?.addEventListener('click', scheduleDetailRedesign);
  membersNav?.addEventListener('click', scheduleDetailRedesign);
  window.addEventListener('rwe:member-sort-reset', scheduleDetailRedesign);
}

function installStylesheet() {
  if (document.querySelector('link[data-rwe-member-detail-redesign]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/v2/member-detail-redesign.css?v=2';
  link.dataset.rweMemberDetailRedesign = '1';
  document.head.appendChild(link);
}

function scheduleDetailRedesign() {
  // The detail row renders once as loading and again after the lazy API call.
  // Bounded checks cover both renders without a continuous observer.
  [0, 60, 180, 450, 900, 1600, 2600].forEach(delay => {
    window.setTimeout(redesignVisibleMemberDetail, delay);
  });
}

function redesignVisibleMemberDetail() {
  const panel = membersBody.querySelector('.member-inline-panel');
  const body = panel?.querySelector('.member-inline-body');
  if (!panel || !body || body.classList.contains('member-detail-redesigned')) return;

  const summaryGrid = directChild(body, '.detail-grid:not(.compact)') || body.querySelector(':scope > .detail-grid');
  const performanceSection = body.querySelector(':scope > .member-detail-section');
  const performanceGrid = performanceSection?.querySelector('.detail-grid.compact');
  const warTable = performanceSection?.querySelector('.detail-war-table');

  if (!summaryGrid || !performanceSection || !performanceGrid) return;

  compactHeader(panel);

  const summaryCards = [...summaryGrid.children];
  const performanceCards = [...performanceGrid.children];
  const warCount = countWarRows(warTable);

  const warDetails = document.createElement('details');
  warDetails.className = 'member-disclosure';
  warDetails.open = true;
  warDetails.innerHTML = '<summary><span>War performance</span></summary>';

  const warBody = document.createElement('div');
  warBody.className = 'member-disclosure-body';
  const warMetrics = document.createElement('div');
  warMetrics.className = 'member-compact-metrics';

  // Participation is already visible in the roster row. Keep only values that
  // add new information when the member is expanded.
  performanceCards
    .filter(card => cardLabel(card) !== 'participation')
    .forEach(card => warMetrics.appendChild(toMetricLine(card)));

  warBody.appendChild(warMetrics);
  warDetails.appendChild(warBody);

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

  body.replaceChildren(warDetails, historyDetails, trackingDetails);
  body.classList.add('member-detail-redesigned');
  panel.classList.add('compact-member-panel');
}

function compactHeader(panel) {
  const header = panel.querySelector('.member-inline-header');
  if (!header) return;
  header.classList.add('compact-member-header');
  header.querySelector('.eyebrow')?.remove();
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
