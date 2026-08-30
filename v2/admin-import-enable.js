const importPanel = document.querySelector('.war-import');

if (importPanel) {
  let applying = false;

  const unlockAdminImport = () => {
    if (applying) return;
    const select = document.querySelector('#adminFactionSelect');
    if (!select || !Number(select.value || 0)) return;

    applying = true;
    try {
      importPanel.classList.remove('admin-import-disabled');
      importPanel.querySelector('.admin-import-note')?.remove();
      importPanel.querySelectorAll('textarea, input, button').forEach(control => {
        if (control.disabled) control.disabled = false;
      });

      const helper = importPanel.querySelector('summary small');
      const factionName = select.selectedOptions?.[0]?.textContent?.trim();
      if (helper && factionName) {
        helper.textContent = `Add finished ranked wars to ${factionName}.`;
      }
    } finally {
      applying = false;
    }
  };

  const observer = new MutationObserver(unlockAdminImport);
  observer.observe(importPanel, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'class'] });

  const selectorObserver = new MutationObserver(unlockAdminImport);
  selectorObserver.observe(document.body, { subtree: true, childList: true });

  unlockAdminImport();
}
