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

    if (data.resourceType === 'player-analysis') renderPlayerAnalysis(data);
    else renderWar(data);
  } catch (error) {
    showError(error.message || 'Failed to load the shared report.');
  }
}

function renderWar(data) {
  document.querySelector('#warPublicBody')?.classList.remove('hidden');
  document.querySelector('#playerPublicBody')?.classList.add('hidden');
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

function renderPlayerAnalysis(data) {
  const snapshot = data.snapshot || {};
  const analysis = data.analysis || {};
  const player = analysis.player || {};
  const context = analysis.context || {};
  const last4 = analysis.war?.last4 || null;
  const wars = Array.isArray(analysis.war?.history) ? analysis.war.history : [];
  const sources = Array.isArray(analysis.sources) ? analysis.sources : [];

  document.querySelector('#warPublicBody')?.classList.add('hidden');
  document.querySelector('#playerPublicBody')?.classList.remove('hidden');

  document.title = `RWEngine · ${player.playerName || snapshot.targetPlayerName || 'Player'}`;
  setText('#reportMeta', 'Player analysis snapshot');
  setText('#reportTitle', `${player.playerName || snapshot.targetPlayerName || 'Player'} [${player.playerId || snapshot.targetPlayerId || '—'}]`);
  setText('#reportDate', snapshot.createdAt ? `Saved ${formatDate(snapshot.createdAt)}` : '');
  setText('#sharedAt', data.sharedAt ? `Link issued ${formatDate(data.sharedAt)}` : '');

  const grid = document.querySelector('#playerSummaryGrid');
  grid.innerHTML = [
    summaryItem('Level', player.level ?? '—'),
    summaryItem('Battle stats', analysis.battleStats?.value == null ? '—' : formatCompact(analysis.battleStats.value)),
    summaryItem('Activity / day', formatDuration(analysis.activity?.perDay30d)),
    summaryItem('Xanax / day', formatMaybeDecimal(analysis.xanax?.perDay30d)),
    summaryItem('RW participation', last4 ? formatPercent(last4.participation) : '—'),
    summaryItem('Hits / war', last4 ? formatMaybeDecimal(last4.hitsPerWar, 1) : '—')
  ].join('');

  const contextEl = document.querySelector('#playerPublicContext');
  contextEl.innerHTML = [
    player.rank ? `<span>Rank <b>${escapeHtml(player.rank)}</b></span>` : '',
    player.title ? `<span>Title <b>${escapeHtml(player.title)}</b></span>` : '',
    player.factionId ? `<span>Faction <b>${escapeHtml(player.factionId)}</b></span>` : '',
    player.lastActionAt ? `<span>Last action <b>${escapeHtml(formatRelative(player.lastActionAt))}</b></span>` : '',
    context.localFactionName ? `<span>Observed with <b>${escapeHtml(context.localFactionName)}</b></span>` : ''
  ].filter(Boolean).join('');

  const sourceEl = document.querySelector('#playerPublicSources');
  sourceEl.innerHTML = `<span>Sources</span>${sources.length
    ? sources.map(source => `<b title="${escapeHtml(source.detail || '')}">${escapeHtml(source.label || '')}</b>`).join('')
    : '<b>None</b>'}`;

  const warsEl = document.querySelector('#playerPublicWars');
  warsEl.innerHTML = wars.length
    ? wars.map(war => `
        <div class="public-war-row">
          <div>
            <strong>${escapeHtml(war.opponentFactionName || 'Unknown opponent')}</strong>
            <small>#${escapeHtml(war.warId)}${war.endedAt ? ` · ${escapeHtml(formatDate(war.endedAt))}` : ''}</small>
          </div>
          <span>${formatNumber(war.hits)} hits</span>
          <span>${formatNumber(war.assists)} assists</span>
          <span>${formatSigned(war.netScore)} net</span>
        </div>
      `).join('')
    : '<div class="public-war-row empty">No shared war history.</div>';

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

function formatCompact(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: number >= 1e9 ? 2 : 1
  }).format(number);
}

function formatMaybeDecimal(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${Math.round(number * 100)}%`;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return '—';
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  const hours = value / 3600;
  return hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`;
}

function formatRelative(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return '—';
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - value);
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
