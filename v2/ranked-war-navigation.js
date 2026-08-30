const rankedWarGroup = document.querySelector('#rankedWarNavGroup');
const rankedWarParent = document.querySelector('.nav-button[data-tab="ranked-war"]');
const pageTitle = document.querySelector('#pageTitle');

const titles = {
  overview: 'Overview',
  members: 'Members',
  'ranked-war': 'Ranked War',
  performance: 'Performance',
  wars: 'War history',
  'current-war': 'Current matchup',
  settings: 'Settings'
};

if (rankedWarGroup && rankedWarParent) {
  rankedWarParent.addEventListener('click', () => {
    rankedWarGroup.classList.toggle('open');
    rankedWarParent.setAttribute('aria-expanded', rankedWarGroup.classList.contains('open') ? 'true' : 'false');
    window.setTimeout(syncNavigationState, 0);
  });

  rankedWarGroup.querySelectorAll('.nav-subbutton').forEach(button => {
    button.addEventListener('click', () => {
      rankedWarGroup.classList.add('open');
      rankedWarParent.setAttribute('aria-expanded', 'true');
      window.setTimeout(syncNavigationState, 0);
    });
  });
}

document.querySelectorAll('.nav-button[data-tab], .jump-button[data-jump]').forEach(button => {
  button.addEventListener('click', () => window.setTimeout(syncNavigationState, 0));
});

syncNavigationState();

let startupChecks = 0;
const startupTimer = window.setInterval(() => {
  startupChecks += 1;
  syncNavigationState();
  if (document.querySelector('#rangeToolbar') || startupChecks >= 24) {
    window.clearInterval(startupTimer);
  }
}, 50);

function syncNavigationState() {
  const activeButton = document.querySelector('.nav-button.active[data-tab]');
  const active = activeButton?.dataset.tab || 'overview';
  const inRankedWar = ['ranked-war', 'performance', 'wars', 'current-war'].includes(active);

  rankedWarGroup?.classList.toggle('section-active', inRankedWar);
  if (['performance', 'wars', 'current-war'].includes(active)) {
    rankedWarGroup?.classList.add('open');
    rankedWarParent?.setAttribute('aria-expanded', 'true');
  }

  if (pageTitle) pageTitle.textContent = titles[active] || 'RWEngine';

  const toolbar = document.querySelector('#rangeToolbar');
  if (toolbar) {
    toolbar.classList.toggle('hidden', ['overview', 'current-war', 'settings'].includes(active));
  }
}
