const root = document.documentElement;
const loginView = document.querySelector('#loginView');
const appView = document.querySelector('#appView');
const memberMetric = document.querySelector('#metricMembers');

let settleTimer = null;
let hardTimeout = null;
let appVisibleAt = 0;

const observer = new MutationObserver(scheduleCheck);
observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
  attributeFilter: ['class']
});

hardTimeout = window.setTimeout(() => finishBoot(), 5000);
scheduleCheck();

function scheduleCheck() {
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(checkReady, 220);
}

function checkReady() {
  if (!root.classList.contains('rwe-booting')) return;

  const loginVisible = loginView && !loginView.classList.contains('hidden');
  const appVisible = appView && !appView.classList.contains('hidden');

  if (loginVisible) {
    finishBoot();
    return;
  }

  if (!appVisible) return;
  if (!appVisibleAt) appVisibleAt = Date.now();

  const firstDataRendered = memberMetric && memberMetric.textContent.trim() !== '—';
  const adminSwitcher = document.querySelector('#adminFactionSwitcher');
  const adminSwitcherVisible = adminSwitcher && !adminSwitcher.classList.contains('hidden');
  const adminOptionsReady = !adminSwitcherVisible || Boolean(document.querySelector('#adminFactionSelect option'));
  const minimumVisibleDelayPassed = Date.now() - appVisibleAt >= 500;

  if (firstDataRendered && adminOptionsReady && minimumVisibleDelayPassed) {
    finishBoot();
  }
}

function finishBoot() {
  window.clearTimeout(settleTimer);
  window.clearTimeout(hardTimeout);
  observer.disconnect();
  root.classList.remove('rwe-booting');
}
