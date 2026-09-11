const context = document.querySelector('#pageContext');

const meta = {
  overview: ['Workspace', 'Home'],
  members: ['Faction', 'Faction Intel'],
  'ranked-war': ['War', 'Ranked War'],
  performance: ['War', 'Performance'],
  wars: ['War', 'War Archive'],
  settings: ['System', 'Settings']
};

document.querySelectorAll('[data-open-module]').forEach(button => {
  button.addEventListener('click', () => {
    const tab = button.dataset.openModule;
    document.querySelector(`.nav-button[data-tab="${CSS.escape(tab)}"]`)?.click();
  });
});

document.querySelectorAll('.nav-button[data-tab], .jump-button[data-jump]').forEach(button => {
  button.addEventListener('click', () => window.setTimeout(syncShellMeta, 0));
});

window.addEventListener('rwe:tab-changed', syncShellMeta);
syncShellMeta();

function syncShellMeta() {
  const active = document.querySelector('.nav-button.active[data-tab]')?.dataset.tab || 'overview';
  const [section, title] = meta[active] || ['RWEngine', 'RWEngine'];
  if (context) context.textContent = section;
  const pageTitle = document.querySelector('#pageTitle');
  if (pageTitle) pageTitle.textContent = title;

  const syncButton = document.querySelector('#syncIntelButton');
  const refreshButton = document.querySelector('#refreshButton');
  if (syncButton) syncButton.classList.toggle('hidden', active !== 'members');
  if (refreshButton) refreshButton.classList.toggle('hidden', active === 'settings');
}
