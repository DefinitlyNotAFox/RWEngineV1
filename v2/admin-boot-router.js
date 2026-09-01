(() => {
  const STORAGE_KEY = 'rwengine.adminFactionView';
  const nativeFetch = window.fetch.bind(window);
  const state = {
    ready: false,
    isAdmin: false,
    accountFactionId: 0,
    selectedFactionId: readStoredFactionId()
  };

  const bootstrap = resolveSession().finally(() => {
    state.ready = true;
  });

  window.fetch = async function rwengineAdminBootFetch(input, init = {}) {
    const url = resolveUrl(input);
    const requestInit = { ...init };
    let body = parseJsonBody(requestInit.body);
    const action = body?.action || null;

    if (shouldBypassBootstrap(url, action)) {
      return nativeFetch(input, requestInit);
    }

    await bootstrap;

    if (state.isAdmin && isAlternateFaction()) {
      const factionId = Number(state.selectedFactionId);

      if (url.pathname === '/v2/range' || url.pathname === '/v2/intel') {
        body = { ...(body || {}), factionId };
        return nativeFetch('/v2/admin', withJsonBody(requestInit, body));
      }

      if (url.pathname === '/api' && action === 'getImportedWars') {
        return nativeFetch('/v2/admin', withJsonBody(requestInit, {
          action: 'getImportedWars',
          factionId
        }));
      }
    }

    return nativeFetch(input, requestInit);
  };

  async function resolveSession() {
    try {
      const response = await nativeFetch('/api', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'me' })
      });
      if (!response.ok) return;
      const payload = await response.json();
      const user = payload?.user;
      if (!user) return;

      state.isAdmin = Boolean(user.isAdmin);
      state.accountFactionId = Number(user.factionId || 0) || 0;

      if (!state.isAdmin) {
        state.selectedFactionId = state.accountFactionId;
        return;
      }

      if (!Number(state.selectedFactionId)) {
        state.selectedFactionId = state.accountFactionId;
        writeStoredFactionId(state.selectedFactionId);
      }
    } catch (_) {
      // Normal app authentication remains authoritative.
    }
  }

  function isAlternateFaction() {
    const selected = Number(state.selectedFactionId || 0);
    const account = Number(state.accountFactionId || 0);
    return selected > 0 && account > 0 && selected !== account;
  }

  function shouldBypassBootstrap(url, action) {
    if (url.origin !== window.location.origin) return true;
    if (url.pathname === '/v2/admin') return true;
    return url.pathname === '/api' && ['me', 'login', 'logout'].includes(action);
  }

  function withJsonBody(init, body) {
    const headers = new Headers(init.headers || {});
    headers.set('Content-Type', 'application/json');
    return {
      ...init,
      method: init.method || 'POST',
      credentials: init.credentials || 'same-origin',
      headers,
      body: JSON.stringify(body || {})
    };
  }

  function parseJsonBody(body) {
    if (!body || typeof body !== 'string') return null;
    try { return JSON.parse(body); } catch (_) { return null; }
  }

  function resolveUrl(input) {
    try {
      const value = typeof input === 'string' || input instanceof URL ? input : input?.url;
      return new URL(value || window.location.href, window.location.href);
    } catch (_) {
      return new URL(window.location.href);
    }
  }

  function readStoredFactionId() {
    try {
      const value = Number(window.localStorage.getItem(STORAGE_KEY) || 0);
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch (_) {
      return 0;
    }
  }

  function writeStoredFactionId(value) {
    try {
      if (Number(value) > 0) window.localStorage.setItem(STORAGE_KEY, String(Number(value)));
    } catch (_) {}
  }
})();
