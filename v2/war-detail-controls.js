const payloadCache = new Map();
const nativeFetch = window.fetch.bind(window);

installStylesheet();
installFetchCapture();
installInteractionHooks();
startControlBootstrap();

function installStylesheet() {
  if (document.querySelector('link[data-rwe-war-detail-controls]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/v2/war-detail-controls.css?v=1';
  link.dataset.rweWarDetailControls = '1';
  document.head.appendChild(link);
}

function installFetchCapture() {
  if (window.__rweWarDetailControlsFetchWrapped) return;
  window.__rweWarDetailControlsFetchWrapped = true;

  window.fetch = async (...args) => {
    const request = args[0];
    const init = args[1] || {};
    const url = requestUrl(request);
    const requestMeta = url.includes('/v2/war-detail') ? parseWarDetailRequest(init.body) : null;
    const response = await nativeFetch(...args);

    if (requestMeta && response.ok) {
      response.clone().json().then(payload => {
        if (!payload || payload.success === false || !payload.war) return;
        const key = payloadKey(
          requestMeta.factionId,
          payload.war.warId || requestMeta.warId,
          requestMeta.excludeChainBonuses
        );
        payloadCache.set(key, payload);
        scheduleRefresh();
      }).catch(() => {});
    }

    return response;
  };
}

function installInteractionHooks() {
  document.addEventListener('click', event => {
    if (
      event.target.closest('[data-war-id]') ||
      event.target.closest('[data-war-detail-mode]') ||
      event.target.closest('[data-war-detail-sort]') ||
      event.target.closest('[data-war-detail-back]')
    ) {
      scheduleRefresh();
    }
  });

  document.addEventListener('change', event => {
    if (event.target.matches('[data-war-detail-chain]')) scheduleRefresh();
  });
}

function startControlBootstrap() {
  let checks = 0;
  const timer = window.setInterval(() => {
    checks += 1;
    if (ensureControls()) {
      window.clearInterval(timer);
      scheduleRefresh();
      return;
    }
    if (checks >= 80) window.clearInterval(timer);
  }, 50);
}

function ensureControls() {
  const header = document.querySelector('.war-detail-header');
  const back = header?.querySelector('[data-war-detail-back]');
  const table = document.querySelector('#warDetailTable');
  if (!header || !back || !table) return false;

  if (!header.querySelector('.war-detail-navigation')) {
    const navigation = document.createElement('div');
    navigation.className = 'war-detail-navigation';
    back.before(navigation);
    navigation.appendChild(back);

    const siblingNav = document.createElement('div');
    siblingNav.className = 'war-detail-sibling-nav';
    siblingNav.innerHTML = `
      <button class="text-button" type="button" data-war-previous>← Previous war</button>
      <button class="text-button" type="button" data-war-next>Next war →</button>
    `;
    navigation.appendChild(siblingNav);

    siblingNav.querySelector('[data-war-previous]')?.addEventListener('click', () => navigateSibling('previous'));
    siblingNav.querySelector('[data-war-next]')?.addEventListener('click', () => navigateSibling('next'));
  }

  if (!table.querySelector('#warDetailFoot')) {
    const foot = document.createElement('tfoot');
    foot.id = 'warDetailFoot';
    table.appendChild(foot);
  }

  return true;
}

function navigateSibling(direction) {
  const rows = orderedWarRows();
  const currentId = selectedWarId();
  const index = rows.findIndex(row => String(row.dataset.warId || '') === currentId);
  if (index < 0) return;

  // Archive order is newest -> oldest. Previous means the chronologically
  // previous (older) war; Next means the chronologically next (newer) war.
  const targetIndex = direction === 'previous' ? index + 1 : index - 1;
  const target = rows[targetIndex];
  if (!target) return;

  target.click();
  document.querySelector('#warsTab')?.scrollIntoView({ block: 'start' });
  scheduleRefresh();
}

function updateSiblingButtons() {
  const previous = document.querySelector('[data-war-previous]');
  const next = document.querySelector('[data-war-next]');
  if (!previous || !next) return;

  const rows = orderedWarRows();
  const currentId = selectedWarId();
  const index = rows.findIndex(row => String(row.dataset.warId || '') === currentId);

  previous.disabled = index < 0 || index >= rows.length - 1;
  next.disabled = index <= 0;

  const previousRow = index >= 0 ? rows[index + 1] : null;
  const nextRow = index > 0 ? rows[index - 1] : null;
  previous.title = previousRow ? `Open war #${previousRow.dataset.warId}` : 'No older imported war';
  next.title = nextRow ? `Open war #${nextRow.dataset.warId}` : 'No newer imported war';
}

function renderTotalsFooter() {
  const foot = document.querySelector('#warDetailFoot');
  const table = document.querySelector('#warDetailTable');
  if (!foot || !table) return;

  const warId = selectedWarId();
  if (!warId || document.querySelector('#warDrilldown')?.classList.contains('hidden')) {
    foot.innerHTML = '';
    return;
  }

  const factionId = currentFactionId();
  const excludeChain = Boolean(document.querySelector('[data-war-detail-chain]')?.checked);
  const payload = payloadCache.get(payloadKey(factionId, warId, excludeChain));
  if (!payload) {
    foot.innerHTML = '';
    return;
  }

  const members = Array.isArray(payload.members) ? payload.members : [];
  const totals = members.reduce((sum, member) => {
    sum.hits += finite(member.hits);
    sum.assists += finite(member.assists);
    sum.outsideHits += finite(member.outsideHits);
    sum.respectEarned += finite(member.respectEarned);
    sum.respectLost += finite(member.respectLost);
    sum.scoreUp += finite(member.scoreUp);
    sum.scoreDown += finite(member.scoreDown);
    sum.netScore += finite(member.netScore);
    return sum;
  }, {
    hits: 0,
    assists: 0,
    outsideHits: 0,
    respectEarned: 0,
    respectLost: 0,
    scoreUp: 0,
    scoreDown: 0,
    netScore: 0
  });

  const detailed = Boolean(document.querySelector('[data-war-detail-mode="detailed"]')?.classList.contains('active'));
  const cells = detailed
    ? [
        totalLabel(members.length),
        totalCount(totals.hits),
        totalCount(totals.assists),
        totalCount(totals.outsideHits),
        totalDecimal(totals.respectEarned),
        totalDecimal(totals.respectLost),
        totalDecimal(totals.scoreUp),
        totalDecimal(totals.scoreDown),
        totalSigned(totals.netScore, true)
      ]
    : [
        totalLabel(members.length),
        totalCount(totals.hits),
        totalCount(totals.assists),
        totalSigned(totals.netScore, true)
      ];

  foot.innerHTML = `<tr>${cells.join('')}</tr>`;
}

function totalLabel(memberCount) {
  return `<td class="performance-member-cell war-detail-total-label"><strong>Total</strong><small>${formatInteger(memberCount)} members</small></td>`;
}

function totalCount(value) {
  return `<td class="performance-stat-cell"><span class="performance-stat-primary">${formatInteger(value)}</span></td>`;
}

function totalDecimal(value) {
  return `<td class="performance-stat-cell"><span class="performance-stat-primary">${formatDecimal(value)}</span></td>`;
}

function totalSigned(value, net = false) {
  return `<td class="performance-stat-cell${net ? ' performance-net-cell' : ''}"><span class="performance-stat-primary">${formatSigned(value)}</span></td>`;
}

function scheduleRefresh() {
  [0, 40, 120, 260].forEach(delay => {
    window.setTimeout(() => {
      ensureControls();
      updateSiblingButtons();
      renderTotalsFooter();
    }, delay);
  });
}

function orderedWarRows() {
  return [...document.querySelectorAll('#warsBody [data-war-id]')];
}

function selectedWarId() {
  try {
    const stored = String(window.localStorage.getItem('rwengine.selectedWarDetail') || '').trim();
    if (stored) return stored;
  } catch (_) {}

  const meta = document.querySelector('#warDetailMeta')?.textContent || '';
  const match = meta.match(/#(\d+)/);
  return match ? match[1] : '';
}

function currentFactionId() {
  return Number(document.querySelector('#adminFactionSelect')?.value || 0) || 0;
}

function payloadKey(factionId, warId, excludeChain) {
  return `${Number(factionId || 0)}:${String(warId || '')}:${excludeChain ? 1 : 0}`;
}

function parseWarDetailRequest(body) {
  if (typeof body !== 'string') return null;
  try {
    const parsed = JSON.parse(body);
    return {
      warId: String(parsed.warId || ''),
      factionId: Number(parsed.factionId || currentFactionId() || 0),
      excludeChainBonuses: parsed.excludeChainBonuses === true
    };
  } catch (_) {
    return null;
  }
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return String(input?.url || '');
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatInteger(value) {
  return new Intl.NumberFormat().format(Math.round(finite(value)));
}

function formatDecimal(value) {
  return finite(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatSigned(value) {
  const number = finite(value);
  const formatted = formatDecimal(number);
  return number > 0 ? `+${formatted}` : formatted;
}
