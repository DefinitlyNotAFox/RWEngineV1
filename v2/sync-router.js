const previousFetch = window.fetch.bind(window);
const SYNC_ACTIONS = new Set(['startSync', 'getSyncStatus', 'syncStep']);

window.fetch = async function rwengineCurrentSyncFetch(input, init = {}) {
  const url = resolveUrl(input);
  const body = parseJsonBody(init.body);
  const action = body?.action;

  if (url.origin === window.location.origin && url.pathname === '/v2/intel' && SYNC_ACTIONS.has(action)) {
    const payload = { ...body };
    const adminFaction = Number(document.querySelector('#adminFactionSelect')?.value || 0);
    if (adminFaction > 0) payload.factionId = adminFaction;

    const headers = new Headers(init.headers || {});
    headers.set('Content-Type', 'application/json');

    return previousFetch('/v2/sync', {
      ...init,
      method: 'POST',
      credentials: init.credentials || 'same-origin',
      headers,
      body: JSON.stringify(payload)
    });
  }

  return previousFetch(input, init);
};

function resolveUrl(input) {
  if (typeof input === 'string') return new URL(input, window.location.href);
  if (input instanceof URL) return input;
  return new URL(input?.url || window.location.href, window.location.href);
}

function parseJsonBody(body) {
  if (!body || typeof body !== 'string') return null;
  try { return JSON.parse(body); } catch (_) { return null; }
}
