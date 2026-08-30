import './admin-workspace.js?v=1';

const syncStatus = document.querySelector('#syncStatus');

if (syncStatus) {
  const updateVisibility = () => {
    const text = syncStatus.textContent || '';
    if (/Last sync completed/i.test(text)) {
      syncStatus.classList.add('hidden');
    }
  };

  const observer = new MutationObserver(updateVisibility);
  observer.observe(syncStatus, { childList: true, subtree: true });
  updateVisibility();
}
