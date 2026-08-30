import './admin-workspace.js?v=1';
import './admin-key-selector.js?v=1';
import './admin-import-enable.js?v=2';
import './sync-router.js?v=2';
import './member-table.js?v=4';
import './range-controls.js?v=4';
import './member-detail-redesign.js?v=6';
import './performance-table.js?v=6';

const syncStatus = document.querySelector('#syncStatus');

if (syncStatus) {
  let updating = false;

  const updatePresentation = () => {
    if (updating) return;
    updating = true;

    try {
      const text = syncStatus.textContent || '';

      if (/Last sync completed/i.test(text)) {
        syncStatus.classList.add('hidden');
        return;
      }

      const firstColumn = syncStatus.firstElementChild;
      const detailLine = firstColumn
        ? [...firstColumn.children].find(element => element.tagName === 'DIV' && !element.classList.contains('sync-progress'))
        : null;

      if (!detailLine) return;

      let description = 'Preparing the next faction API request.';

      if (/Reading the current faction roster/i.test(text)) {
        description = 'Pulling the current roster and member status data.';
      } else if (/Collecting member snapshots/i.test(text)) {
        description = 'Pulling daily member totals: time played, Xanax taken and OC count; verified battle stats are added where a member has their own RWE API key.';
      } else if (/Sync failed/i.test(text)) {
        description = 'The current API pull stopped before all requested data was collected.';
      }

      if (detailLine.textContent !== description) detailLine.textContent = description;
    } finally {
      updating = false;
    }
  };

  const observer = new MutationObserver(updatePresentation);
  observer.observe(syncStatus, { childList: true, subtree: true, characterData: true });
  updatePresentation();
}
