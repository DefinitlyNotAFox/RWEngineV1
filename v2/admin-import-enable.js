const importPanel = document.querySelector('.war-import');

if (importPanel) {
  // Admin workspace may initially apply the old "alternate faction" restriction.
  // Remove it after admin context has had a chance to render, without observing
  // the same attributes we mutate (which caused a feedback loop in Firefox).
  for (const delay of [0, 150, 500, 1200]) {
    window.setTimeout(enableAdminImport, delay);
  }

  document.addEventListener('change', event => {
    if (event.target?.id === 'adminFactionSelect') {
      window.setTimeout(enableAdminImport, 0);
    }
  });
}

function enableAdminImport() {
  if (!importPanel) return;

  const select = document.querySelector('#adminFactionSelect');
  const factionId = Number(select?.value || 0);
  if (!factionId) return;

  importPanel.classList.remove('admin-import-disabled');
  importPanel.querySelector('.admin-import-note')?.remove();

  importPanel.querySelectorAll('textarea, input, button').forEach(control => {
    control.disabled = false;
  });

  const helper = importPanel.querySelector('summary small');
  const factionName = select?.selectedOptions?.[0]?.textContent?.trim();
  if (helper && factionName) {
    helper.textContent = `Add finished ranked wars to ${factionName}.`;
  }
}
