const loadingState = document.querySelector('#loadingState');
const errorState = document.querySelector('#errorState');
const reportView = document.querySelector('#reportView');

load();

async function load() {
  const token = new URL(window.location.href).searchParams.get('token');
  if (!token) {
    showError('This link is missing its share token.');
    return;
  }

  try {
    const response = await fetch(`/v2/share?token=${encodeURIComponent(token)}`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store'
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.success === false) {
      throw new Error(data?.message || 'This share link is unavailable.');
    }

    renderWar(data);
  } catch (error) {
    showError(error.message || 'Failed to load the shared report.');
  }
}

function renderWar(data) {
  const war = data.war || {};
  const summary = data.summary || {};
  const members = Array.isArray(data.members) ? data.members : [];

  document.title = `RWEngine · ${war.factionName || 'Faction'} vs ${war.opponentFactionName || 'Opponent'}`;
  setText('#reportMeta', `Ranked war #${war.warId || '—'}`);
  setText('#reportTitle', `${war.factionName || 'Faction'} vs ${war.opponentFactionName || 'Unknown opponent'}`);
  setText('#reportDate', formatRange(war.startTimestamp, war.endTimestamp));
  setText('#sharedAt', data.sharedAt ? `Link issued ${formatDate(data.sharedAt)}` : '');

  const scoreLine = document.querySelector('#scoreLine');
  scoreLine.innerHTML = `
    <div class="score-side">
      <span>${escapeHtml(war.factionName || 'Faction')}</span>
      <strong>${formatDecimal(summary.scoreUp)}</strong>
    </div>
    <div class="score-label">Final RW score</div>
    <div class="score-side opponent">
      <strong>${formatDecimal(summary.scoreDown)}</strong>
      <span>${escapeHtml(war.opponentFactionName || 'Opponent')}</span>
    </div>
  `;

  const summaryGrid = document.querySelector('#summaryGrid');
  summaryGrid.innerHTML = [
    summaryItem('Members', formatNumber(summary.members)),
    summaryItem('War hits', formatNumber(summary.hits)),
    summaryItem('Assists', formatNumber(summary.assists)),
    summaryItem('Net score', formatSigned(summary.netScore))
  ].join('');

  const rows = document.querySelector('#memberRows');
  rows.innerHTML = members.length
    ? members.map(member => `
        <tr>
          <td>
            <a class="member-link" href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(member.playerId)}" target="_blank" rel="noopener noreferrer">
              ${escapeHtml(member.playerName || `Player ${member.playerId}`)}
              <small>[${escapeHtml(member.playerId)}]${member.current ? ' · current' : ''}</small>
            </a>
          </td>
          <td>${formatNumber(member.hits)}</td>
          <td>${formatNumber(member.assists)}</td>
          <td>${formatNumber(member.outsideHits)}</td>
          <td>${formatDecimal(member.scoreUp)}</td>
          <td>${formatDecimal(member.scoreDown)}</td>
          <td class="net">${formatSigned(member.netScore)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="7">No member performance stored for this report.</td></tr>';

  loadingState.classList.add('hidden');
  errorState.classList.add('hidden');
  reportView.classList.remove('hidden');
}

function summaryItem(label, value) {
  return `<div class="summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function showError(message) {
  loadingState.classList.add('hidden');
  reportView.classList.add('hidden');
  errorState.textContent = message;
  errorState.classList.remove('hidden');
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value || '';
}

function formatRange(start, end) {
  const a = formatDate(start);
  const b = formatDate(end);
  if (!a && !b) return '';
  if (!a) return b;
  if (!b || a === b) return a;
  return `${a} – ${b}`;
}

function formatDate(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  }).format(new Date(value * 1000));
}

function formatNumber(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat().format(Math.round(number));
}

function formatDecimal(value) {
  const number = Number(value || 0);
  return number.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatSigned(value) {
  const number = Number(value || 0);
  const formatted = formatDecimal(number);
  return number > 0 ? `+${formatted}` : formatted;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
