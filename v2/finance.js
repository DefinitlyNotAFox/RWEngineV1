import {
  state, on, financeApi, currentFactionId, canEditFactionView,
  formatNumber, formatCompact, formatDate, formatAge, escapeHtml
} from './core.js?v=9';

let data = null;
let loading = false;
let syncing = false;
let loadedFactionId = null;
let autoSyncAttemptedFactionId = null;
let statusMessage = '';
let statusError = false;

export function initFinance() {
  document.querySelector('#financeSync')?.addEventListener('click', () => syncFinance(true));

  on('route', route => {
    if (route === 'finance') loadFinance(false);
  });

  on('faction', () => {
    data = null;
    loadedFactionId = null;
    autoSyncAttemptedFactionId = null;
    statusMessage = '';
    statusError = false;
    renderFinance();
    if (state.route === 'finance') loadFinance(true);
  });

  on('role-preview', () => renderFinance());
}

export async function loadFinance(force = false) {
  const factionId = Number(currentFactionId() || 0);
  if (!factionId || loading) return;
  if (!force && data && Number(loadedFactionId) === factionId) {
    renderFinance();
    maybeAutoSync();
    return;
  }

  loading = true;
  statusMessage = 'Loading finance data…';
  statusError = false;
  renderFinance();

  try {
    data = await financeApi('summary');
    loadedFactionId = factionId;
    statusMessage = '';
    renderFinance();
    maybeAutoSync();
  } catch (error) {
    statusMessage = error.message || 'Failed to load finance data.';
    statusError = true;
    renderFinance();
  } finally {
    loading = false;
  }
}

async function maybeAutoSync() {
  const factionId = Number(currentFactionId() || 0);
  if (
    !factionId ||
    autoSyncAttemptedFactionId === factionId ||
    data?.canManage !== true ||
    !canEditFactionView()
  ) return;

  const last = Number(data?.lastSyncAt || 0);
  const stale = !last || Math.floor(Date.now() / 1000) - last >= 3600;
  if (!stale) return;

  autoSyncAttemptedFactionId = factionId;
  await syncFinance(false);
}

async function syncFinance(manual = false) {
  if (syncing || data?.canManage !== true || !canEditFactionView()) return;

  syncing = true;
  statusMessage = manual ? 'Syncing armory expenses…' : 'Updating armory expenses…';
  statusError = false;
  renderFinance();

  try {
    data = await financeApi('syncArmory');
    loadedFactionId = Number(currentFactionId() || 0);
    const stored = Number(data?.sync?.stored || 0);
    statusMessage = manual
      ? `Armory sync complete · ${formatNumber(stored)} expense event${stored === 1 ? '' : 's'} processed.`
      : '';
    statusError = false;
  } catch (error) {
    statusMessage = error.message || 'Failed to sync armory expenses.';
    statusError = true;
  } finally {
    syncing = false;
    renderFinance();
  }
}

function renderFinance() {
  const view = document.querySelector('#financeView');
  if (!view) return;

  const sync = document.querySelector('#financeSync');
  const status = document.querySelector('#financeStatus');
  const metrics = document.querySelector('#financeMetrics');
  const chart = document.querySelector('#financeChart');
  const body = document.querySelector('#financeBody');
  const empty = document.querySelector('#financeEmpty');

  const canSync = Boolean(data?.canManage && canEditFactionView());
  sync?.classList.toggle('hidden', !canSync);
  if (sync) {
    sync.disabled = syncing || loading;
    sync.textContent = syncing ? 'Syncing…' : 'Sync armory';
  }

  if (status) {
    const freshness = data?.lastSyncAt
      ? `Armory synced ${formatAge(Math.max(0, Math.floor(Date.now()/1000) - Number(data.lastSyncAt)))}`
      : 'Armory not synced yet';
    status.textContent = statusMessage || freshness;
    status.classList.toggle('error', statusError);
    status.classList.toggle('hidden', !status.textContent);
  }

  if (!data) {
    if (metrics) metrics.innerHTML = '';
    if (chart) chart.innerHTML = loading
      ? '<div class="finance-empty">Loading finance data…</div>'
      : '';
    if (body) body.innerHTML = '';
    empty?.classList.add('hidden');
    return;
  }

  const totals = data.totals || {};
  if (metrics) {
    metrics.innerHTML = [
      financeMetric('War income', totals.income),
      financeMetric('Member payouts', totals.memberPayout),
      financeMetric('Armory', totals.armoryExpense),
      financeMetric('Faction net', totals.net, true)
    ].join('');
  }

  const tracked = Array.isArray(data.wars) ? data.wars : [];

  if (chart) chart.innerHTML = renderFinanceTrend(tracked.slice(0, 12).reverse());

  if (body) {
    body.innerHTML = tracked.length
      ? tracked.map(renderFinanceRow).join('')
      : '';
  }

  empty?.classList.toggle('hidden', tracked.length > 0);
}

function financeMetric(label, value, signed = false) {
  const number = Math.round(Number(value || 0));
  const cls = signed ? (number > 0 ? ' positive' : number < 0 ? ' negative' : '') : '';
  return `
    <span class="finance-summary-item">
      <span>${escapeHtml(label)}</span>
      <strong class="${cls.trim()}">${escapeHtml(formatMoney(number))}</strong>
    </span>
  `;
}

function renderFinanceRow(row) {
  const stamp = Number(row.endTimestamp || row.startTimestamp || row.importedAt || 0);
  const net = Math.round(Number(row.net || 0));
  const margin = Number(row.margin);
  return `
    <div class="finance-row" role="row">
      <div class="finance-war" role="cell">
        <strong>${escapeHtml(row.opponentFactionName || 'Unknown opponent')}</strong>
        <span>${stamp ? escapeHtml(formatDate(stamp)) : 'Unknown date'} · #${escapeHtml(row.warId)}</span>
      </div>
      <div role="cell"><strong>${escapeHtml(formatMoney(row.income))}</strong><span>${escapeHtml(row.incomeSource || '')}</span></div>
      <div role="cell"><strong>${escapeHtml(formatMoney(row.memberPayout))}</strong><span>${row.payoutStatus === 'paid' ? 'Confirmed' : 'Outstanding'}</span></div>
      <div role="cell"><strong>${escapeHtml(formatMoney(row.armoryExpense))}</strong><span>${formatNumber(row.armoryItems || 0)} items</span></div>
      <div role="cell" class="finance-net ${net > 0 ? 'positive' : net < 0 ? 'negative' : ''}">
        <strong>${escapeHtml(formatMoney(net))}</strong>
        <span>${Number.isFinite(margin) ? escapeHtml(formatPercentValue(margin)) : '—'}</span>
      </div>
    </div>
  `;
}

function renderFinanceTrend(rows) {
  if (!rows.length) {
    return '<div class="finance-empty">Confirmed payouts will appear here.</div>';
  }

  const width = 1120;
  const height = 300;
  const left = 70;
  const right = 24;
  const top = 28;
  const bottom = 55;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = rows.flatMap(row => [
    Number(row.income || 0),
    Number(row.memberPayout || 0),
    Number(row.armoryExpense || 0)
  ]).filter(Number.isFinite);
  const max = Math.max(1, ...values) * 1.08;
  const xFor = index => left + (index / Math.max(1, rows.length - 1)) * plotWidth;
  const yFor = value => top + (1 - Math.max(0, Number(value || 0)) / max) * plotHeight;

  const series = [
    ['income','Income','finance-line income'],
    ['memberPayout','Payouts','finance-line payouts'],
    ['armoryExpense','Armory','finance-line armory']
  ];

  const lines = series.map(([key,label,cls]) => {
    const path = rows.map((row,index) => {
      const x = xFor(index);
      const y = yFor(row[key]);
      return `${index ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ');

    const dots = rows.map((row,index) => `
      <circle class="${cls}" cx="${xFor(index).toFixed(2)}" cy="${yFor(row[key]).toFixed(2)}" r="3">
        <title>${escapeHtml(label)} · ${escapeHtml(formatMoney(row[key]))}</title>
      </circle>
    `).join('');

    return `<path class="${cls}" d="${path}"></path>${dots}`;
  }).join('');

  const ticks = Array.from({length:5}, (_,index) => {
    const ratio = index / 4;
    return {
      value:max * (1 - ratio),
      y:top + ratio * plotHeight
    };
  });

  return `
    <div class="finance-chart-head">
      <div>
        <strong>War finances</strong>
        <span>Income versus member payouts and armory usage</span>
      </div>
      <div class="finance-legend">
        <span class="income"><i></i>Income</span>
        <span class="payouts"><i></i>Payouts</span>
        <span class="armory"><i></i>Armory</span>
      </div>
    </div>
    <svg class="finance-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="War finance trend">
      ${ticks.map(tick => `
        <line class="finance-gridline" x1="${left}" y1="${tick.y.toFixed(2)}" x2="${width-right}" y2="${tick.y.toFixed(2)}"></line>
        <text x="${left-12}" y="${(tick.y+4).toFixed(2)}" text-anchor="end">${escapeHtml(formatCompact(tick.value))}</text>
      `).join('')}
      ${lines}
      ${rows.map((row,index) => {
        const label = String(row.opponentFactionName || 'War');
        const short = label.length > 14 ? label.slice(0, 12) + '…' : label;
        return `<text class="finance-x-label" x="${xFor(index).toFixed(2)}" y="${height-20}" text-anchor="middle">${escapeHtml(short)}</text>`;
      }).join('')}
    </svg>
  `;
}

function formatMoney(value) {
  const number = Math.round(Number(value || 0));
  const sign = number < 0 ? '-' : '';
  return sign + '$' + new Intl.NumberFormat(undefined, {
    maximumFractionDigits:0
  }).format(Math.abs(number));
}

function formatPercentValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat(undefined, {
    style:'percent',
    minimumFractionDigits:0,
    maximumFractionDigits:1
  }).format(number);
}
