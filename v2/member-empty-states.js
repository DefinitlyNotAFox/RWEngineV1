const membersBody = document.querySelector('#membersBody');
const warsMetric = document.querySelector('#metricWars');

if (membersBody) {
  const update = () => {
    const hasWars = Number(String(warsMetric?.textContent || '0').replace(/[^0-9.-]/g, '')) > 0;

    for (const row of membersBody.querySelectorAll('tr.member-row[data-member-id]')) {
      const cells = row.cells;
      if (cells.length < 9) continue;

      replaceUnavailable(cells[3], 'No stat source');
      replaceUnavailable(cells[4], 'Needs 2 snapshots');
      replaceUnavailable(cells[5], 'Needs 2 snapshots');
      replaceUnavailable(cells[6], 'Not tracked yet');
      if (!hasWars) {
        replaceUnavailable(cells[7], 'No wars');
        replaceUnavailable(cells[8], 'No wars');
      }
    }
  };

  const observer = new MutationObserver(update);
  observer.observe(membersBody, { childList: true, subtree: true });
  if (warsMetric) observer.observe(warsMetric, { childList: true, characterData: true, subtree: true });
  update();
}

function replaceUnavailable(cell, replacement) {
  if (!cell) return;
  const text = cell.textContent.trim();
  if (text !== 'Unavailable') return;

  const marker = cell.querySelector('.unavailable');
  if (marker) marker.textContent = replacement;
  else cell.textContent = replacement;

  cell.classList.add('metric-not-ready');
  cell.title = replacement;
}
