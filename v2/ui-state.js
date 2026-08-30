const ACTIVE_TAB_KEY = 'rwengine.activeTab';
const VALID_TABS = new Set([
  'overview',
  'members',
  'ranked-war',
  'performance',
  'wars',
  'current-war',
  'settings'
]);

installUiRefinementStyles();
bindTabPersistence();
restoreActiveTab();
repairAdminFactionLabel();

function installUiRefinementStyles() {
  if (document.querySelector('link[data-rwe-ui-refinement]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/v2/ui-refinement.css?v=1';
  link.dataset.rweUiRefinement = '1';
  document.head.appendChild(link);
}

function bindTabPersistence() {
  document.querySelectorAll('.nav-button[data-tab]').forEach(button => {
    button.addEventListener('click', () => rememberTab(button.dataset.tab));
  });

  document.querySelectorAll('.jump-button[data-jump]').forEach(button => {
    button.addEventListener('click', () => rememberTab(button.dataset.jump));
  });
}

function rememberTab(tabName) {
  if (!VALID_TABS.has(tabName)) return;
  try { window.localStorage.setItem(ACTIVE_TAB_KEY, tabName); } catch (_) {}
}

function readStoredTab() {
  try {
    const value = window.localStorage.getItem(ACTIVE_TAB_KEY) || '';
    return VALID_TABS.has(value) ? value : 'overview';
  } catch (_) {
    return 'overview';
  }
}

function restoreActiveTab() {
  const storedTab = readStoredTab();
  if (storedTab === 'overview') return;

  let checks = 0;
  const timer = window.setInterval(() => {
    checks += 1;
    const app = document.querySelector('#appView');
    const targetTab = document.querySelector(`#${CSS.escape(storedTab)}Tab`);
    const targetButton = document.querySelector(`.nav-button[data-tab="${CSS.escape(storedTab)}"]`);

    if (app && !app.classList.contains('hidden') && targetTab && targetButton) {
      window.clearInterval(timer);
      targetButton.click();
      return;
    }

    if (checks >= 80) window.clearInterval(timer);
  }, 50);
}

function repairAdminFactionLabel() {
  let checks = 0;
  const timer = window.setInterval(async () => {
    checks += 1;
    const select = document.querySelector('#adminFactionSelect');
    const option = select?.selectedOptions?.[0];

    if (!select || !option || !option.value) {
      if (checks >= 80) window.clearInterval(timer);
      return;
    }

    window.clearInterval(timer);

    const factionId = Number(option.value || 0);
    if (!factionId || !isPlaceholderFactionName(option.textContent, factionId)) return;

    const factionName = await resolveFactionName(factionId);
    if (!factionName) return;

    option.textContent = `${factionName} [${factionId}]`;

    const sidebar = document.querySelector('#factionLabel');
    if (sidebar && isPlaceholderFactionName(sidebar.textContent, factionId)) {
      sidebar.textContent = `${factionName} · Admin view`;
    }

    const settingsFaction = document.querySelector('#settingsFaction');
    if (settingsFaction && isPlaceholderFactionName(settingsFaction.textContent, factionId)) {
      settingsFaction.textContent = factionName;
    }
  }, 75);
}

async function resolveFactionName(factionId) {
  try {
    const meResponse = await fetch('/api', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'me' })
    });
    const me = await meResponse.json();
    const ownName = String(me?.user?.factionName || '').trim();
    if (
      meResponse.ok &&
      Number(me?.user?.factionId || 0) === factionId &&
      isUsableFactionName(ownName, factionId)
    ) {
      return ownName;
    }
  } catch (_) {}

  try {
    const warsResponse = await fetch('/api', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getImportedWars' })
    });
    const wars = await warsResponse.json();
    if (warsResponse.ok && wars?.success !== false) {
      for (const war of wars.wars || []) {
        const name = String(war?.faction_name || war?.factionName || '').trim();
        if (isUsableFactionName(name, factionId)) return name;
      }
    }
  } catch (_) {}

  return '';
}

function isUsableFactionName(value, factionId) {
  const text = String(value || '').trim();
  return Boolean(text && !isPlaceholderFactionName(text, factionId));
}

function isPlaceholderFactionName(value, factionId) {
  const text = String(value || '').trim();
  if (!text) return true;
  const escapedId = String(factionId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^Faction\\s+${escapedId}(?:\\s*\\[${escapedId}\\])?(?:\\s*·.*)?$`, 'i').test(text);
}
