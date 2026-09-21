import {
  state, on, emit, intelV2Api, syncApi, performanceApi, autoTagsApi,
  canEditFactionView, renderLeadershipMarker,
  formatNumber, formatCompact, formatDecimal, formatPercent, formatSigned,
  formatDuration, formatRelative, escapeHtml, sleep
} from './core.js?v=9';
import { buildAutoTags } from './auto-tag-engine.js?v=4';

const MONTH_DAYS = 30.44;

const factionColumns = [
  'member','stats','xanax','activity','ocs',
  'participation','hits','assists','outsideHits',
  'respect','score','netScore','attention'
];

const columnLabels = {
  member:['Member',''],
  stats:['Battle stats',''],
  xanax:['Xanax / day',''],
  activity:['Activity / day',''],
  ocs:['OCs / month',''],
  participation:['Wars / participation',''],
  hits:['Hits',''],
  assists:['Assists',''],
  outsideHits:['Outside hits',''],
  respect:['Respect + / −',''],
  score:['Score + / −',''],
  netScore:['Net score',''],
  attention:['Notes','']
};

const factionGroups = [
  ['roster','Roster',1],
  ['training','Activity & training',4],
  ['war','War performance',7],
  ['context','Notes',1]
];

const priority = [
  'inactive',
  'low_war_participation',
  'participation_down',
  'activity_down',
  'xanax_down',
  'strong_war_output',
  'activity_up',
  'xanax_up',
  'battle_stats_growth',
  'missing_battle_stats',
  'stale_battle_stats'
];

let overview = null;
let loadedFactionId = null;
let autoTagSettings = null;
let loadedAutoTagFactionId = null;
const activeFilters = new Set();
let intelFilterMenuOpen = false;
let showFormerMembers = restoreBooleanPreference('rwengine.showFormerMembers', false);
let excludeMilestones = restoreBooleanPreference('rwengine.excludeMilestones', false);
let selectedMemberId = null;
let sortKey = 'member';
let sortDirection = 'asc';
let trendDays = 90;
let trendMetric = 'activity';
let loading = false;
let pendingReload = false;
let syncJob = null;
let syncing = false;
const AUTO_SYNC_INTERVAL_SECONDS = 24 * 60 * 60;
let filterMode = restoreFactionMode();
let timelineRange = { from:null, to:null };
let timelinePresetSelection = restoreTimelinePresetSelection();
let draftTimelineRange = null;
let selectedWarIds = new Set();
let draftWarIds = new Set();
let calendarCursor = null;
let calendarAnchor = null;
let filterPanelOpen = false;
let loadedAnalysisKey = '';

let compareOpen = false;
const compareMemberIds = new Set();
let compareMetric = 'activity';
let compareIncludeAverage = true;
let compareData = null;
let compareLoading = false;
let compareError = '';
let compareLoadedKey = '';

const factionPerformance = {
  members:new Map(),
  totalWars:0,
  playersWithAttackDetails:0,
  loadedKey:'',
  loading:false,
  error:''
};

const detailCache = new Map();
const detailLoading = new Set();
const noteEditing = new Set();
const noteDrafts = new Map();
const noteSaving = new Set();
const noteErrors = new Map();

const WORKFLOW_TAGS = ['Recruits', 'Watchlist', 'Mentors', 'Needs Review'];
let tagManageMode = false;
const selectedTagMemberIds = new Set();
let tagDraft = '';
let tagBulkBusy = false;
let tagBulkStatus = '';

export function initIntelV2() {
  renderFilters();
  renderFactionControls();
  ensureTagToolbar();
  renderTagToolbar();

  document.querySelector('#intelSearch')?.addEventListener('input', renderIntelV2);

  document.querySelector('#factionCompareToggle')?.addEventListener('click', async () => {
    compareOpen = !compareOpen;
    compareError = '';

    if (compareOpen) {
      filterPanelOpen = false;
      intelFilterMenuOpen = false;
    }

    renderIntelV2();
    if (compareOpen) await loadMemberComparison(false);
  });

  document.querySelector('#factionComparePanel')?.addEventListener('change', async event => {
    if (event.target.matches('[data-compare-metric]')) {
      compareMetric = String(event.target.value || defaultCompareMetric());
      renderComparePanel();
      return;
    }

    if (event.target.matches('[data-compare-average]')) {
      compareIncludeAverage = event.target.checked === true;
      renderComparePanel();
    }
  });

  document.querySelector('#factionComparePanel')?.addEventListener('input', event => {
    const input = event.target.closest('[data-compare-member-search]');
    if (!input) return;

    const query = String(input.value || '').trim().toLowerCase();
    document.querySelectorAll('#factionComparePanel [data-compare-member-option]').forEach(option => {
      const haystack = String(option.dataset.compareMemberSearch || '').toLowerCase();
      option.classList.toggle('hidden', Boolean(query) && !haystack.includes(query));
    });
  });

  document.querySelector('#factionComparePanel')?.addEventListener('click', async event => {
    const add = event.target.closest('[data-compare-add-member]');
    if (add) {
      const playerId = Number(add.dataset.compareAddMember || 0);
      if (playerId && compareMemberIds.size < 5) {
        compareMemberIds.add(playerId);
        compareLoadedKey = '';
        renderComparePanel();
        await loadMemberComparison(true);
      }
      return;
    }

    const remove = event.target.closest('[data-compare-remove-member]');
    if (!remove) return;
    compareMemberIds.delete(Number(remove.dataset.compareRemoveMember || 0));
    compareLoadedKey = '';
    renderComparePanel();
    await loadMemberComparison(true);
  });

  document.querySelector('#intelHead')?.addEventListener('click', event => {
    const header = event.target.closest('[data-intel2-sort]');
    if (!header) return;
    const key = header.dataset.intel2Sort;
    if (sortKey === key) sortDirection = sortDirection === 'desc' ? 'asc' : 'desc';
    else {
      sortKey = key;
      sortDirection = key === 'member' ? 'asc' : 'desc';
    }
    renderIntelV2();
  });

  document.querySelector('.faction-modes')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-faction-mode]');
    if (!button) return;
    const next = button.dataset.factionMode;
    if (!['timeline','wars'].includes(next) || next === filterMode) return;

    filterMode = next;
    try { localStorage.setItem('rwengine.factionMode', filterMode); } catch (_) {}
    filterPanelOpen = false;
    loadedAnalysisKey = '';
    factionPerformance.loadedKey = '';
    factionPerformance.members.clear();
    ensureFilterState();
    renderFactionControls();
    await loadIntelV2(true);
  });

  document.querySelector('#factionFilterToggle')?.addEventListener('click', () => {
    filterPanelOpen = !filterPanelOpen;
    if (filterPanelOpen) prepareFilterDraft();
    renderFactionControls();
  });

  document.addEventListener('pointerdown', event => {
    if (!filterPanelOpen) return;
    if (event.target.closest('#factionFilterPanel')) return;
    if (event.target.closest('#factionFilterToggle')) return;

    filterPanelOpen = false;
    renderFactionControls();
  });

  document.querySelector('#factionScopePreset')?.addEventListener('change', async event => {
    const preset = String(event.target.value || '');
    if (!preset || preset === 'custom') return;
    await applyTimelinePreset(preset);
  });

  document.querySelector('#factionFilterPanel')?.addEventListener('click', async event => {
    const nav = event.target.closest('[data-calendar-nav]');
    if (nav) {
      moveCalendar(Number(nav.dataset.calendarNav || 0));
      renderFilterPanel();
      return;
    }

    const day = event.target.closest('[data-calendar-day]');
    if (day && !day.disabled) {
      selectCalendarDay(day.dataset.calendarDay);
      renderFilterPanel();
      return;
    }

    const action = event.target.closest('[data-filter-action]');
    if (!action) return;

    const type = action.dataset.filterAction;
    if (type === 'cancel') {
      filterPanelOpen = false;
      renderFactionControls();
      return;
    }

    if (type === 'calendar-apply') {
      await applyTimelineDraft();
      return;
    }

    if (type === 'wars-all') {
      draftWarIds = new Set(sortedWars().map(war => String(warId(war))).filter(Boolean));
      renderFilterPanel();
      return;
    }

    if (type === 'wars-none') {
      draftWarIds.clear();
      renderFilterPanel();
      return;
    }

    if (type === 'wars-apply') await applyWarDraft();
  });

  document.querySelector('#factionFilterPanel')?.addEventListener('change', event => {
    const checkbox = event.target.closest('[data-war-check]');
    if (!checkbox) return;
    const id = String(checkbox.dataset.warCheck || '').trim();
    if (!id) return;
    if (checkbox.checked) draftWarIds.add(id);
    else draftWarIds.delete(id);
    updateWarApplyState();
  });

  document.querySelector('#intelFilters')?.addEventListener('click', event => {
    const clear = event.target.closest('[data-filter-clear]');
    if (clear) {
      activeFilters.clear();
      intelFilterMenuOpen = false;
      selectedMemberId = null;
      renderIntelV2();
      return;
    }

    const toggle = event.target.closest('[data-filter-menu-toggle]');
    if (toggle) {
      intelFilterMenuOpen = !intelFilterMenuOpen;
      renderFilters();
      return;
    }

    const option = event.target.closest('[data-combined-filter]');
    if (option) {
      const key = String(option.dataset.combinedFilter || '');
      if (!key) return;
      if (activeFilters.has(key)) activeFilters.delete(key);
      else activeFilters.add(key);
      selectedMemberId = null;
      renderIntelV2();
      return;
    }

    const remove = event.target.closest('[data-filter-remove]');
    if (remove) {
      activeFilters.delete(String(remove.dataset.filterRemove || ''));
      selectedMemberId = null;
      renderIntelV2();
    }
  });

  document.addEventListener('pointerdown', event => {
    if (!intelFilterMenuOpen) return;
    if (event.target.closest('#intelFilters')) return;
    intelFilterMenuOpen = false;
    renderFilters();
  });

  document.querySelector('#intelViewOptions')?.addEventListener('click', event => {
    const manageTags = event.target.closest('[data-tag-manage]');
    if (manageTags) {
      tagManageMode = !tagManageMode;
      if (!tagManageMode) {
        selectedTagMemberIds.clear();
        tagDraft = '';
        tagBulkStatus = '';
      }
      renderFilters();
      renderIntelV2();
      renderTagToolbar();
      return;
    }

    const option = event.target.closest('[data-intel-option]');
    if (!option) return;

    const key = option.dataset.intelOption;
    if (key === 'former') {
      showFormerMembers = !showFormerMembers;
      storeBooleanPreference('rwengine.showFormerMembers', showFormerMembers);
    } else if (key === 'milestones') {
      excludeMilestones = !excludeMilestones;
      storeBooleanPreference('rwengine.excludeMilestones', excludeMilestones);
    }

    renderFilters();
    renderIntelV2();
  });

  document.querySelector('#intelBody')?.addEventListener('click', async event => {
    const tagSelector = event.target.closest('[data-tag-member-select]');
    if (tagSelector) {
      const playerId = Number(tagSelector.dataset.tagMemberSelect || 0);
      if (!tagManageMode || !canManageTags() || !playerId) return;
      if (selectedTagMemberIds.has(playerId)) selectedTagMemberIds.delete(playerId);
      else selectedTagMemberIds.add(playerId);
      renderIntelV2();
      return;
    }

    const trendButton = event.target.closest('[data-trend-days]');
    if (trendButton) {
      trendDays = Number(trendButton.dataset.trendDays) || 90;
      renderIntelV2();
      return;
    }

    const metricButton = event.target.closest('[data-trend-metric]');
    if (metricButton) {
      trendMetric = metricButton.dataset.trendMetric || 'activity';
      renderIntelV2();
      return;
    }

    const noteAction = event.target.closest('[data-member-note-action]');
    if (noteAction) {
      const playerId = Number(noteAction.dataset.playerId || 0);
      if (!playerId) return;
      const key = detailKey(playerId);

      if (noteAction.dataset.memberNoteAction === 'edit') {
        if (selectedMemberId !== playerId || !detailCache.has(key)) {
          await openMember(playerId);
        }

        const payload = detailCache.get(key);
        const overviewMember = (overview?.members || []).find(row => Number(row.playerId) === playerId);
        const notes = normalizeMemberNotes(payload?.member?.notes || overviewMember?.notes);
        noteDrafts.set(key, {
          noteText:notes.text
        });
        noteErrors.delete(key);
        noteEditing.add(key);
        renderIntelV2();
        requestAnimationFrame(() => {
          document.querySelector(`[data-member-note-form][data-player-id="${playerId}"] textarea`)?.focus();
        });
        return;
      }

      if (noteAction.dataset.memberNoteAction === 'cancel') {
        noteEditing.delete(key);
        noteDrafts.delete(key);
        noteErrors.delete(key);
        renderIntelV2();
        return;
      }
    }

    if (event.target.closest('a, button, input, textarea, label, form, summary')) return;

    const row = event.target.closest('[data-member-id]');
    if (!row) return;
    const playerId = Number(row.dataset.memberId || 0);
    if (!playerId) return;

    if (selectedMemberId === playerId) {
      selectedMemberId = null;
      renderIntelV2();
      return;
    }

    await openMember(playerId);
  });

  document.querySelector('#intelBody')?.addEventListener('input', event => {
    const form = event.target.closest('[data-member-note-form]');
    if (!form) return;
    const playerId = Number(form.dataset.playerId || 0);
    if (!playerId) return;
    noteDrafts.set(detailKey(playerId), {
      noteText:String(form.elements.noteText?.value || '')
    });
  });

  document.querySelector('#intelBody')?.addEventListener('submit', async event => {
    const form = event.target.closest('[data-member-note-form]');
    if (!form) return;
    event.preventDefault();
    await saveMemberNotesForm(form);
  });

  document.querySelector('#intelTagToolbar')?.addEventListener('input', event => {
    if (!event.target.matches('[data-tag-bulk-input]')) return;
    tagDraft = String(event.target.value || '');
  });

  document.querySelector('#intelTagToolbar')?.addEventListener('click', async event => {
    const action = event.target.closest('[data-tag-bulk-action]');
    if (!action) return;

    const type = action.dataset.tagBulkAction;
    if (type === 'clear') {
      selectedTagMemberIds.clear();
      tagBulkStatus = '';
      renderIntelV2();
      return;
    }

    if (type === 'done') {
      tagManageMode = false;
      selectedTagMemberIds.clear();
      tagDraft = '';
      tagBulkStatus = '';
      renderFilters();
      renderIntelV2();
      return;
    }

    if (type === 'add' || type === 'remove') await applyBulkTag(type);
  });

  on('route', route => {
    if (route !== 'intel') return;
    filterMode = restoreFactionMode();
    ensureFilterState();
    ensureSortKey();
    renderFactionControls();
    loadIntelV2(false);
  });

  on('faction', () => resetIntelState());

  on('data', () => {
    if (state.route !== 'intel') return;
    ensureFilterState();
    renderFactionControls();
    loadIntelV2(true);
  });

  on('role-preview', () => renderIntelV2());

  on('tag-settings', payload => {
    const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
    if (Number(payload?.factionId || 0) !== factionId) return;
    autoTagSettings = payload?.settings || null;
    loadedAutoTagFactionId = factionId;
    if (state.route === 'intel') renderIntelV2();
  });

  on('open-member', playerId => {
    const search = document.querySelector('#intelSearch');
    if (search) search.value = '';
    if (state.route === 'intel') openMember(Number(playerId));
  });
}

async function loadAppliedTagSettings(force = false) {
  const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
  if (!factionId) return;
  if (!force && autoTagSettings && Number(loadedAutoTagFactionId) === factionId) return;

  try {
    const result = await autoTagsApi('get');
    autoTagSettings = result?.settings || null;
  } catch (_) {
    autoTagSettings = null;
  }
  loadedAutoTagFactionId = factionId;
}

export async function loadIntelV2(force = false) {
  if (loading) {
    pendingReload = pendingReload || force;
    return;
  }

  const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
  if (!factionId) return;

  loading = true;
  updateFactionTitle();

  try {
    await loadAppliedTagSettings(force);
    ensureFilterState();
    const key = analysisKey();

    if (!force && overview && Number(loadedFactionId) === factionId && loadedAnalysisKey === key) {
      renderIntelV2();
      await loadFactionPerformance(false);
      if (compareOpen) await loadMemberComparison(false);
      return;
    }

    setIntelStatus('Loading faction data…');
    if (!overview) renderIntelV2();

    overview = await intelV2Api('overview', analysisPayload());
    loadedFactionId = factionId;
    loadedAnalysisKey = key;
    updateFactionTitle();
    setIntelStatus('');
    renderIntelV2();
    renderIntelFreshness();
    await refreshSyncStatus();
    await loadFactionPerformance(force);
    if (compareOpen) await loadMemberComparison(force);
  } catch (error) {
    if (!overview) overview = null;
    setIntelStatus(error.message || 'Failed to load faction data.', true);
    renderIntelV2();
  } finally {
    loading = false;
    if (pendingReload) {
      const rerun = pendingReload;
      pendingReload = false;
      queueMicrotask(() => loadIntelV2(Boolean(rerun)));
    }
  }
}


function updateFactionTitle() {
  const title = document.querySelector('#factionTitle');
  if (!title) return;

  const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
  const candidates = [
    overview?.faction?.factionName,
    state.adminFactions?.find(item => Number(item.factionId) === factionId)?.factionName,
    Number(state.user?.factionId || 0) === factionId ? state.user?.factionName : null
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);

  const name = candidates.find(value => !/^Faction\s+\d+(?:\s*\[\d+\])?$/i.test(value)) || '';

  title.textContent = name || (factionId ? `Faction ${factionId}` : 'Faction');
}

async function loadFactionPerformance(force = false) {
  if (factionPerformance.loading) return;

  const key = performanceKey();
  if (!force && factionPerformance.loadedKey === key) {
    renderIntelV2();
    return;
  }

  factionPerformance.loading = true;
  factionPerformance.error = '';
  renderFactionStatus();
  renderIntelV2();

  try {
    const data = await performanceApi(performancePayload());
    factionPerformance.members = new Map(
      (data.members || []).map(member => [Number(member.playerId), member])
    );
    factionPerformance.totalWars = Number(data.totalWars || 0);
    factionPerformance.playersWithAttackDetails = Number(data.playersWithAttackDetails || 0);
    factionPerformance.loadedKey = key;
  } catch (error) {
    factionPerformance.members.clear();
    factionPerformance.totalWars = 0;
    factionPerformance.playersWithAttackDetails = 0;
    factionPerformance.loadedKey = '';
    factionPerformance.error = error.message || 'Failed to load war performance.';
  } finally {
    factionPerformance.loading = false;
    renderFactionStatus();
    renderIntelV2();
  }
}

function renderFilters() {
  const container = document.querySelector('#intelFilters');
  const options = document.querySelector('#intelViewOptions');

  if (container) {
    const activeCount = activeFilters.size;
    const tagOptions = activeTagFilterOptions();
    const chips = [...activeFilters]
      .map(key => ({ key, label:combinedFilterLabel(key) }))
      .filter(item => item.label);

    container.innerHTML = `
      <span class="intel-filter-controls">
        <span class="intel-filter-menu-wrap">
          <button class="intel2-filter intel-filter-menu-toggle${intelFilterMenuOpen || activeCount ? ' active' : ''}" type="button" data-filter-menu-toggle aria-expanded="${intelFilterMenuOpen ? 'true' : 'false'}">
            Filters${activeCount ? ` (${activeCount})` : ''}<span aria-hidden="true">▾</span>
          </button>
          <span class="intel-filter-menu${intelFilterMenuOpen ? '' : ' hidden'}">
            <span class="intel-filter-menu-section">
              <strong>Tags</strong>
              ${tagOptions.length
                ? tagOptions.map(tag => renderCombinedFilterOption(`tag:${tag.key}`, tag.label, tag.count)).join('')
                : '<span class="intel-filter-menu-empty">No tags yet</span>'}
            </span>
          </span>
        </span>
      </span>
      <span class="intel-filter-chips">
        ${chips.map(item => `
          <button class="intel-filter-chip" type="button" data-filter-remove="${escapeHtml(item.key)}">
            ${escapeHtml(item.label)}<span aria-hidden="true">×</span>
          </button>
        `).join('')}
      </span>
    `;
  }

  if (options) {
    options.innerHTML = `
      ${canManageTags() ? `<button class="intel2-filter intel2-option intel-tag-manage${tagManageMode ? ' active' : ''}" type="button" data-tag-manage>${tagManageMode ? 'Done tagging' : 'Manage tags'}</button>` : ''}
      <button class="intel2-filter intel2-option${showFormerMembers ? ' active' : ''}" type="button" data-intel-option="former">Show former members</button>
      <button class="intel2-filter intel2-option${excludeMilestones ? ' active' : ''}" type="button" data-intel-option="milestones">Exclude milestones</button>
    `;
  }
}

function renderCombinedFilterOption(key, label, count = null) {
  const active = activeFilters.has(key);
  return `
    <button class="intel-filter-menu-option${active ? ' active' : ''}" type="button" data-combined-filter="${escapeHtml(key)}" aria-pressed="${active ? 'true' : 'false'}">
      <span class="intel-filter-check" aria-hidden="true">${active ? '✓' : ''}</span>
      <span>${escapeHtml(label)}</span>
      ${count === null ? '' : `<small>${formatNumber(count)}</small>`}
    </button>
  `;
}

function combinedFilterLabel(key) {
  if (String(key).startsWith('tag:')) {
    const tagKeyValue = String(key).slice(4);
    return activeTagFilterOptions().find(tag => tag.key === tagKeyValue)?.label ||
      workflowTagOptions().find(tag => tag.key === tagKeyValue)?.label ||
      tagKeyValue;
  }

  return String(key || '');
}

function renderFactionControls() {
  ensureFilterState();

  document.querySelectorAll('[data-faction-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.factionMode === filterMode);
  });

  const toggle = document.querySelector('#factionFilterToggle');
  if (toggle) {
    toggle.textContent = filterMode === 'timeline'
      ? formatRangeLabel(timelineRange)
      : `${selectedWarIds.size} war${selectedWarIds.size === 1 ? '' : 's'} selected`;
    toggle.classList.toggle('active', filterPanelOpen);
  }

  const preset = document.querySelector('#factionScopePreset');
  if (preset) {
    const options = timelinePresetOptions();
    const selected = timelinePresetSelection || timelinePresetKey(timelineRange);
    preset.innerHTML = options.map(([key,label]) =>
      `<option value="${escapeHtml(key)}"${key === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`
    ).join('') + (selected ? '' : '<option value="custom" selected>Custom</option>');
    preset.classList.toggle('hidden', filterMode !== 'timeline');
  }

  const table = document.querySelector('#intelTable');
  if (table) table.removeAttribute('data-preset');

  renderFilterPanel();
  renderFactionStatus();
}

function renderFilterPanel() {
  const panel = document.querySelector('#factionFilterPanel');
  if (!panel) return;

  panel.dataset.mode = filterMode;
  panel.classList.toggle('hidden', !filterPanelOpen);
  if (!filterPanelOpen) {
    panel.innerHTML = '';
    return;
  }

  panel.innerHTML = filterMode === 'timeline'
    ? renderCalendarPicker()
    : renderWarPicker();

  updateWarApplyState();
}

function renderFactionStatus() {
  const element = document.querySelector('#factionTableStatus');
  if (!element) return;

  if (factionPerformance.loading) {
    element.textContent = filterMode === 'timeline'
      ? `Loading war data for ${formatRangeLabel(timelineRange)}…`
      : `Loading ${selectedWarIds.size} selected ranked wars…`;
    element.classList.remove('hidden','error');
    return;
  }

  if (factionPerformance.error) {
    element.textContent = factionPerformance.error;
    element.classList.remove('hidden');
    element.classList.add('error');
    return;
  }

  element.textContent = '';
  element.classList.remove('error');
  element.classList.add('hidden');
}

function defaultCompareMetric() {
  return filterMode === 'wars' ? 'hits' : 'activity';
}

function compareMetricOptions() {
  return filterMode === 'wars'
    ? [
        ['hits','War hits'],
        ['assists','Assists'],
        ['outsideHits','Outside hits'],
        ['respectPerHit','Respect / hit'],
        ['netScore','Net score']
      ]
    : [
        ['activity','Activity / day'],
        ['xanax','Xanax / day'],
        ['stats','Battle stats']
      ];
}

function comparePayload() {
  return {
    mode:filterMode,
    playerIds:[...compareMemberIds],
    ...(filterMode === 'wars'
      ? { warIds:[...selectedWarIds].sort() }
      : analysisPayload())
  };
}

function compareKey() {
  const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
  const scope = filterMode === 'wars'
    ? [...selectedWarIds].sort().join(',')
    : `${timelineRange?.from || ''}:${timelineRange?.to || ''}`;
  return `${factionId}:${filterMode}:${scope}:${[...compareMemberIds].sort((a,b) => a-b).join(',')}`;
}

async function loadMemberComparison(force = false) {
  if (!compareOpen || compareLoading) return;
  const key = compareKey();
  if (!force && compareData && compareLoadedKey === key) {
    renderComparePanel();
    return;
  }

  compareLoading = true;
  compareError = '';
  renderComparePanel();

  try {
    compareData = await intelV2Api('compare', comparePayload());
    compareLoadedKey = key;
  } catch (error) {
    compareData = null;
    compareLoadedKey = '';
    compareError = error.message || 'Failed to load comparison data.';
  } finally {
    compareLoading = false;
    renderComparePanel();
  }
}

function renderComparePanel() {
  const panel = document.querySelector('#factionComparePanel');
  const toggle = document.querySelector('#factionCompareToggle');
  const grid = document.querySelector('.faction-grid-wrap');
  if (!panel || !toggle || !grid) return;

  toggle.classList.toggle('active', compareOpen);
  toggle.textContent = 'Compare';
  toggle.title = compareOpen ? 'Return to faction table' : 'Compare faction members';
  panel.classList.toggle('hidden', !compareOpen);
  grid.classList.toggle('hidden', compareOpen);
  updateCompareControlAvailability();
  if (!compareOpen) return;

  const members = (overview?.members || [])
    .filter(member => member.current !== false)
    .slice()
    .sort((a,b) => String(a.playerName || '').localeCompare(String(b.playerName || ''), undefined, { sensitivity:'base', numeric:true }));

  const selected = [...compareMemberIds]
    .map(id => members.find(member => Number(member.playerId) === Number(id)))
    .filter(Boolean);

  const options = compareMetricOptions();
  if (!options.some(([key]) => key === compareMetric)) compareMetric = defaultCompareMetric();

  panel.innerHTML = `
    <div class="faction-compare-toolbar">
      <div class="faction-compare-members">
        <span class="faction-compare-label">Members</span>
        <div class="faction-compare-chips">
          ${selected.map(member => `
            <button type="button" class="faction-compare-chip" data-compare-remove-member="${escapeHtml(member.playerId)}">
              ${escapeHtml(member.playerName)}<span aria-hidden="true">×</span>
            </button>
          `).join('')}
          ${compareMemberIds.size >= 5 ? `
            <span class="faction-compare-add-limit">5 members selected</span>
          ` : `
            <details class="faction-compare-member-menu">
              <summary>+ Add member</summary>
              <div class="faction-compare-member-popover">
                <input
                  type="search"
                  placeholder="Search member or ID"
                  aria-label="Search members to compare"
                  data-compare-member-search
                />
                <div class="faction-compare-member-options">
                  ${members
                    .filter(member => !compareMemberIds.has(Number(member.playerId)))
                    .map(member => `
                      <button
                        type="button"
                        data-compare-add-member="${escapeHtml(member.playerId)}"
                        data-compare-member-option
                        data-compare-member-search="${escapeHtml(member.playerName + ' ' + member.playerId)}"
                      >
                        <strong>${escapeHtml(member.playerName)}</strong>
                        <span>[${escapeHtml(member.playerId)}]</span>
                      </button>
                    `).join('')}
                </div>
              </div>
            </details>
          `}
        </div>
      </div>

      <label class="faction-compare-control">
        <span>Metric</span>
        <select data-compare-metric>
          ${options.map(([key,label]) => `<option value="${key}"${compareMetric === key ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
        </select>
      </label>

      <label class="faction-compare-average">
        <input type="checkbox" data-compare-average ${compareIncludeAverage ? 'checked' : ''} />
        <span>Faction average</span>
      </label>
    </div>

    <div class="faction-compare-stage">
      ${compareLoading
        ? '<div class="faction-compare-empty">Loading comparison…</div>'
        : compareError
          ? `<div class="faction-compare-empty error">${escapeHtml(compareError)}</div>`
          : renderComparisonChart()}
    </div>
  `;
}

function updateCompareControlAvailability() {
  const disabled = compareOpen;

  const filterBlock = document.querySelector('.intel-filter-block');
  const optionBlock = document.querySelector('#intelViewOptions');
  const search = document.querySelector('#intelSearch');

  filterBlock?.classList.toggle('compare-disabled', disabled);
  optionBlock?.classList.toggle('compare-disabled', disabled);

  filterBlock?.querySelectorAll('button, input, select').forEach(control => {
    control.disabled = disabled;
  });
  optionBlock?.querySelectorAll('button, input, select').forEach(control => {
    control.disabled = disabled;
  });

  if (search) {
    search.disabled = disabled;
    search.classList.toggle('compare-disabled', disabled);
  }
}

function renderComparisonChart() {
  const data = compareData;
  const lines = Array.isArray(data?.series) ? data.series : [];
  const plotted = [
    ...lines,
    ...(compareIncludeAverage && data?.factionAverage ? [{ ...data.factionAverage, factionAverage:true }] : [])
  ];

  if (!plotted.length) {
    return '<div class="faction-compare-empty">Add members or enable the faction average.</div>';
  }

  const metric = compareMetric;
  const width = 1120;
  const height = 360;
  const left = 66;
  const right = 24;
  const top = 26;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const allPoints = plotted.flatMap(series =>
    (series.points || [])
      .map((point,index) => ({ point, index, value:Number(point?.[metric]) }))
      .filter(item => Number.isFinite(item.value))
  );

  if (!allPoints.length) {
    return '<div class="faction-compare-empty">No data for this metric in the selected range.</div>';
  }

  const rawMin = Math.min(...allPoints.map(item => item.value));
  const rawMax = Math.max(...allPoints.map(item => item.value));
  const positiveOnly = metric !== 'netScore';
  let min = positiveOnly ? 0 : Math.min(0, rawMin);
  let max = Math.max(rawMax, positiveOnly ? 1 : 0);
  if (max === min) max = min + 1;
  const padding = (max - min) * 0.08;
  if (!positiveOnly) min -= padding;
  max += padding;

  const warMode = data?.mode === 'wars';
  const axis = Array.isArray(data?.axis) ? data.axis : [];
  const timelinePoints = plotted.flatMap(series => series.points || []);
  const times = timelinePoints.map(point => Number(point.at || 0)).filter(value => value > 0);
  const minTime = times.length ? Math.min(...times) : 0;
  const maxTime = times.length ? Math.max(...times) : minTime + 1;

  const xFor = (point,index) => {
    if (warMode) {
      const count = Math.max(1, axis.length - 1);
      const axisIndex = Math.max(0, axis.findIndex(item => String(item.key) === String(point.key)));
      return left + (axisIndex / count) * plotWidth;
    }
    const at = Number(point.at || minTime);
    return left + ((at - minTime) / Math.max(1, maxTime - minTime)) * plotWidth;
  };
  const yFor = value => top + (1 - (value - min) / (max - min)) * plotHeight;

  const ticks = Array.from({length:5}, (_,index) => {
    const ratio = index / 4;
    const value = max - ratio * (max - min);
    const y = top + ratio * plotHeight;
    return { value, y };
  });

  const paths = plotted.map((series,seriesIndex) => {
    const valid = (series.points || [])
      .map((point,index) => ({ point,index,value:Number(point?.[metric]) }))
      .filter(item => Number.isFinite(item.value));
    const d = valid.map((item,index) => {
      const x = xFor(item.point,item.index);
      const y = yFor(item.value);
      return `${index ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ');
    const cls = series.factionAverage
      ? 'compare-line faction-average'
      : `compare-line compare-series-${seriesIndex % 5}`;
    const dots = valid.map(item => {
      const x = xFor(item.point,item.index);
      const y = yFor(item.value);
      return `<circle class="${cls}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3"><title>${escapeHtml(series.playerName)} · ${escapeHtml(formatCompareValue(item.value, metric))}</title></circle>`;
    }).join('');
    return `<path class="${cls}" d="${d}"></path>${dots}`;
  }).join('');

  let xLabels = '';
  if (warMode) {
    xLabels = axis.map((item,index) => {
      const x = left + (index / Math.max(1, axis.length - 1)) * plotWidth;
      const label = String(item.label || 'War');
      const short = label.length > 16 ? label.slice(0, 14) + '…' : label;
      return `<text x="${x.toFixed(2)}" y="${height - 20}" text-anchor="middle">${escapeHtml(short)}</text>`;
    }).join('');
  } else {
    const timelineTicks = Array.from({length:5}, (_,index) => {
      const ratio = index / 4;
      const at = minTime + ratio * (maxTime - minTime);
      return {
        x:left + ratio * plotWidth,
        label:new Date(at * 1000).toLocaleDateString(undefined, { month:'short', day:'numeric' })
      };
    });
    xLabels = timelineTicks.map(item =>
      `<text x="${item.x.toFixed(2)}" y="${height - 20}" text-anchor="middle">${escapeHtml(item.label)}</text>`
    ).join('');
  }

  const legend = plotted.map((series,index) => `
    <span class="faction-compare-legend-item${series.factionAverage ? ' faction-average' : ` compare-series-${index % 5}`}">
      <i></i><span>${escapeHtml(series.playerName)}</span>
    </span>
  `).join('');

  return `
    <div class="faction-compare-chart-head">
      <div>
        <strong>${escapeHtml(compareMetricOptions().find(([key]) => key === metric)?.[1] || metric)}</strong>
        <span>${escapeHtml(filterMode === 'wars' ? 'Selected ranked wars' : formatRangeLabel(timelineRange))}</span>
      </div>
      <div class="faction-compare-legend">${legend}</div>
    </div>
    <svg class="faction-compare-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Member comparison chart">
      ${ticks.map(tick => `
        <line class="compare-gridline" x1="${left}" y1="${tick.y.toFixed(2)}" x2="${width-right}" y2="${tick.y.toFixed(2)}"></line>
        <text class="compare-y-label" x="${left-12}" y="${(tick.y+4).toFixed(2)}" text-anchor="end">${escapeHtml(formatCompareValue(tick.value, metric))}</text>
      `).join('')}
      ${paths}
      <g class="compare-x-labels">${xLabels}</g>
    </svg>
  `;
}

function formatCompareValue(value, metric = compareMetric) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (metric === 'activity') return formatDuration(number);
  if (metric === 'xanax' || metric === 'respectPerHit') return formatDecimal(number, 2);
  if (metric === 'stats') return formatCompact(number);
  if (metric === 'netScore') return formatSigned(number, 1);
  return formatNumber(number);
}

function renderIntelV2() {
  ensureSortKey();
  renderFilters();
  renderFactionControls();
  renderHeaders();
  renderTagToolbar();
  renderComparePanel();

  const aggregate = document.querySelector('#intelAggregate');
  const body = document.querySelector('#intelBody');
  if (!aggregate || !body) return;

  if (loading && !overview) {
    aggregate.innerHTML = '';
    body.innerHTML = '<div class="faction-grid-empty">Loading faction data…</div>';
    return;
  }

  const members = Array.isArray(overview?.members) ? overview.members : [];
  const query = String(document.querySelector('#intelSearch')?.value || '').trim().toLowerCase();

  const rows = members
    .filter(matchesFilter)
    .filter(member =>
      !query ||
      String(member.playerName || '').toLowerCase().includes(query) ||
      String(member.playerId || '').includes(query)
    )
    .sort(compareMembers);

  try {
    aggregate.innerHTML = renderFactionTotalRow();
  } catch (error) {
    console.error('Faction aggregate render failed', error);
    aggregate.innerHTML = renderFactionTotalFallback();
  }

  if (!rows.length) {
    body.innerHTML = '<div class="faction-grid-empty">No members match this view.</div>';
    return;
  }

  body.innerHTML = rows.map(member => {
    const selected = Number(selectedMemberId) === Number(member.playerId);

    return `
      <div class="faction-grid-row faction-member-row clickable${selected ? ' selected' : ''}" role="row" data-member-id="${member.playerId}">
        ${factionColumns.map(key => renderFactionCell(member, key)).join('')}
        ${renderMemberTagSelector(member)}
      </div>
      ${selected ? renderDetailRow(member) : ''}
    `;
  }).join('');
}

function renderFactionTotalRow() {
  const current = (overview?.members || []).filter(member => member.current !== false);
  if (!current.length && !factionPerformance.members.size) return '';

  const currentPerformance = current.map(member => performanceMember(member)).filter(Boolean);
  const allPerformance = [...factionPerformance.members.values()].map(adjustedPerformance);
  const totalWars = Number(factionPerformance.totalWars || 0);
  const warLoading = factionPerformance.loading;

  const knownStats = current.map(member => nullable(member.battleStats?.value)).filter(value => value !== null);
  const medianStats = medianNullable(knownStats);
  const avgXanax = averageNullable(current.map(member => member.xanax?.perDay30d));
  const avgActivity = averageNullable(current.map(member => member.activity?.perDay30d));
  const totalOcs = sumNullable(current.map(member => member.ocs || {}), 'total');
  const avgOcsPerMonth = averageNullable(current.map(member => monthlyOcs(member.ocs)));
  const participation = averageNullable(currentPerformance.map(row => row.participation));
  const notes = current.filter(member => memberHasNotes(member)).length;

  const totalHits = sumNullable(allPerformance, 'warHits');
  const hitsPerWar = totalWars > 0 && totalHits !== null ? totalHits / totalWars : null;
  const assists = sumNullable(allPerformance, 'assists');
  const assistsPerWar = totalWars > 0 && assists !== null ? assists / totalWars : null;
  const outsideHits = sumNullable(allPerformance, 'outsideHits');
  const outsidePerWar = totalWars > 0 && outsideHits !== null ? outsideHits / totalWars : null;
  const respectEarned = sumNullable(allPerformance, 'respectEarned');
  const respectLost = sumNullable(allPerformance, 'respectLost');
  const scoreUp = sumNullable(allPerformance, 'scoreUp');
  const scoreDown = sumNullable(allPerformance, 'scoreDown');
  const netScore = sumNullable(allPerformance, 'netScore');
  const netPerWar = totalWars > 0 && netScore !== null ? netScore / totalWars : null;
  const warScope = filterMode === 'timeline'
    ? `${formatNumber(totalWars)} wars in range`
    : `${selectedWarIds.size} selected war${selectedWarIds.size === 1 ? '' : 's'}`;

  return `
    <div class="faction-grid-row faction-total-row" role="row">
      <div role="cell" class="faction-grid-cell col-member">
        <span class="member-name">Faction total</span>
        <span class="member-meta">${formatNumber(current.length)} members</span>
      </div>
      <div role="cell" class="faction-grid-cell col-stats">
        <strong>${tableCellText(formatCompact(medianStats))}</strong>
        <span class="member-meta">median · ${formatNumber(knownStats.length)} known</span>
      </div>
      <div role="cell" class="faction-grid-cell col-xanax">
        <strong>${tableCellText(formatDecimal(avgXanax, 2))}</strong>
        <span class="member-meta">avg / day</span>
      </div>
      <div role="cell" class="faction-grid-cell col-activity">
        <strong>${tableCellText(formatDuration(avgActivity))}</strong>
        <span class="member-meta">avg / day</span>
      </div>
      <div role="cell" class="faction-grid-cell col-ocs">
        ${avgOcsPerMonth === null
          ? '<span class="member-meta member-meta-primary">No data</span>'
          : `<strong>${formatDecimal(avgOcsPerMonth, 2)}</strong>`}
        <span class="member-meta">${totalOcs === null ? '' : `${formatNumber(totalOcs)} total in range`}</span>
      </div>
      <div role="cell" class="faction-grid-cell col-participation">
        <strong>${warLoading ? '…' : formatPercent(participation)}</strong>
        <span class="member-meta">${escapeHtml(warScope)}</span>
      </div>
      <div role="cell" class="faction-grid-cell col-hits">
        <strong>${warLoading ? '…' : formatNumber(totalHits)}</strong>
        <span class="member-meta">${warLoading ? '…' : `${formatDecimal(hitsPerWar, 1)} / war`}</span>
      </div>
      <div role="cell" class="faction-grid-cell col-assists">
        <strong>${warLoading ? '…' : formatNumber(assists)}</strong>
        <span class="member-meta">${warLoading ? '…' : `${formatDecimal(assistsPerWar, 1)} / war`}</span>
      </div>
      <div role="cell" class="faction-grid-cell col-outsideHits">
        <strong>${warLoading ? '…' : formatNumber(outsideHits)}</strong>
        <span class="member-meta">${warLoading ? '…' : `${formatDecimal(outsidePerWar, 1)} / war`}</span>
      </div>
      <div role="cell" class="faction-grid-cell col-respect">
        <strong>${warLoading ? '…' : (respectEarned === null ? '' : `+${formatDecimal(respectEarned, 2)}`)}</strong>
        <span class="member-meta">${warLoading ? '…' : (respectLost === null ? '' : `−${formatDecimal(respectLost, 2)}`)}</span>
      </div>
      <div role="cell" class="faction-grid-cell col-score">
        <strong>${warLoading ? '…' : (scoreUp === null ? '' : `+${formatDecimal(scoreUp, 2)}`)}</strong>
        <span class="member-meta">${warLoading ? '…' : (scoreDown === null ? '' : `−${formatDecimal(scoreDown, 2)}`)}</span>
      </div>
      <div role="cell" class="faction-grid-cell col-netScore">
        <strong>${warLoading ? '…' : formatSigned(netScore, 2)}</strong>
        <span class="member-meta">${warLoading ? '…' : `${formatSigned(netPerWar, 2)} / war`}</span>
      </div>
      <div role="cell" class="faction-grid-cell col-attention">
        <strong>${formatNumber(notes)}</strong>
        <span class="member-meta">with notes</span>
      </div>
    </div>
  `;
}

function renderFactionTotalFallback() {
  const current = (overview?.members || []).filter(member => member.current !== false);
  const count = current.length;
  const cells = factionColumns.map((key,index) => {
    if (index === 0) {
      return `<div role="cell" class="faction-grid-cell col-member"><span class="member-name">Faction total</span><span class="member-meta">${formatNumber(count)} members</span></div>`;
    }
    return `<div role="cell" class="faction-grid-cell col-${key}"><span class="member-meta">aggregate unavailable</span></div>`;
  }).join('');

  return `<div class="faction-grid-row faction-total-row faction-total-fallback" role="row">${cells}</div>`;
}

function sumNullable(rows, key) {
  const values = rows
    .map(row => nullable(row?.[key]))
    .filter(value => value !== null);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function renderIntelFreshness() {
  const element = document.querySelector('#intelFreshness');
  if (!element) return;

  const freshness = overview?.freshness;
  if (!freshness?.observedAt) {
    element.textContent = 'No synced faction data';
    element.classList.remove('stale');
    return;
  }

  element.textContent = freshness.state === 'stale'
    ? `Stale · last snapshot ${formatRelative(freshness.observedAt)}`
    : `Updated ${formatRelative(freshness.observedAt)}`;
  element.classList.toggle('stale', freshness.state === 'stale');
}

function renderHeaders() {
  const head = document.querySelector('#intelHead');
  if (!head) return;

  let cursor = 1;
  const groupRow = factionGroups.map(([key,label,count]) => {
    const start = cursor;
    cursor += Number(count);
    return `<div class="faction-grid-group group-${key}" style="grid-column:${start} / span ${count}">${escapeHtml(label)}</div>`;
  }).join('');

  const columnRow = factionColumns.map(key => {
    const [label, detail] = columnLabels[key] || [key,''];
    const active = key === sortKey;

    return `
      <div role="columnheader" class="faction-grid-header-cell col-${key}${active ? ' sorted' : ''}">
        <button type="button" data-intel2-sort="${key}">
          <span class="sort-label">${escapeHtml(label)}${detail ? ` <small>${escapeHtml(detail)}</small>` : ''}</span>
          <span class="sort-indicator" aria-hidden="true">${active ? (sortDirection === 'desc' ? '↓' : '↑') : ''}</span>
        </button>
      </div>
    `;
  }).join('');

  head.innerHTML = `
    <div class="faction-grid-row faction-group-row" role="row">${groupRow}</div>
    <div class="faction-grid-row faction-column-row" role="row">${columnRow}</div>
  `;
}

function renderMemberTagSelector(member) {
  if (!(tagManageMode && canManageTags())) return '';
  const selected = selectedTagMemberIds.has(Number(member.playerId));
  return `
    <button
      class="member-tag-select tag-row-selector${selected ? ' selected' : ''}"
      type="button"
      data-tag-member-select="${member.playerId}"
      aria-pressed="${selected ? 'true' : 'false'}"
      aria-label="${selected ? 'Deselect' : 'Select'} ${escapeHtml(member.playerName || 'member')} for tagging"
    ><span aria-hidden="true">${selected ? '✓' : ''}</span></button>
  `;
}

function renderFactionCell(member, key) {
  const performance = performanceMember(member);

  if (key === 'member') {
    const profileUrl = `https://www.torn.com/profiles.php?XID=${encodeURIComponent(member.playerId)}`;
    return `<div role="cell" class="faction-grid-cell col-member"><span class="member-cell-main"><span class="member-name"><a class="member-profile-link" href="${profileUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(member.playerName || 'Unknown')}</a>${renderLeadershipMarker(member.leadershipRole)}<span class="entity-id">[${escapeHtml(member.playerId)}]</span></span><span class="member-meta">${escapeHtml(member.position || 'Member')} · Lv ${escapeHtml(member.level ?? '—')}${member.current ? '' : ' · former'}</span></span></div>`;
  }

  if (key === 'stats') {
    return `<div role="cell" class="faction-grid-cell col-stats">${member.battleStats?.value == null ? 'No data' : escapeHtml(formatCompact(member.battleStats.value))}<span class="trend ${trendClass(member.battleStats?.changePct30d)}">${tableBattleStatsTrend(member)}</span></div>`;
  }

  if (key === 'activity') {
    return `<div role="cell" class="faction-grid-cell col-activity">${escapeHtml(tableCellText(formatDuration(member.activity?.perDay30d)))}<span class="trend ${trendClass(member.activity?.changePct)}">${escapeHtml(tableTrendLabel(member.activity?.changePct))}</span></div>`;
  }

  if (key === 'xanax') {
    return `<div role="cell" class="faction-grid-cell col-xanax">${escapeHtml(tableCellText(formatDecimal(member.xanax?.perDay30d, 2)))}<span class="trend ${trendClass(member.xanax?.changePct)}">${escapeHtml(tableTrendLabel(member.xanax?.changePct))}</span></div>`;
  }

  if (key === 'ocs') {
    const total = nullable(member.ocs?.total);
    const perMonth = monthlyOcs(member.ocs);
    return `<div role="cell" class="faction-grid-cell col-ocs">${perMonth === null ? '<span class="member-meta member-meta-primary">No data</span>' : `<strong>${formatDecimal(perMonth, 2)}</strong>`}<span class="member-meta">${total === null ? '' : `${formatNumber(total)} in range`}</span></div>`;
  }

  if (key === 'participation4') {
    return `<div role="cell" class="faction-grid-cell col-participation4">${escapeHtml(formatPercent(member.war?.last4?.participation))}<span class="member-meta">${formatNumber(member.war?.last4?.warsParticipated)}/${formatNumber(member.war?.last4?.warsAvailable)} wars</span></div>`;
  }

  if (key === 'hits4') {
    return `<div role="cell" class="faction-grid-cell col-hits4">${escapeHtml(formatDecimal(member.war?.last4?.hitsPerWar, 1))}</div>`;
  }

  if (key === 'attention') {
    const notes = normalizeMemberNotes(member.notes);
    const visibleTags = notes.tags.slice(0, 2);
    const overflow = notes.tags.length - visibleTags.length;
    const canEditNotes = Boolean(overview?.permissions?.canEditMemberNotes && canEditFactionView());

    return `<div role="cell" class="faction-grid-cell col-attention">
      <div class="member-note-cell">
        ${visibleTags.map(tag => `<span class="member-note-tag">${escapeHtml(tag)}</span>`).join('')}
        ${overflow > 0 ? `<span class="member-note-more">+${overflow}</span>` : ''}
        ${notes.hasText && !visibleTags.length ? '<span class="member-note-mark">Note</span>' : ''}
        ${canEditNotes ? `<button class="member-note-edit" type="button" data-member-note-action="edit" data-player-id="${member.playerId}">Edit</button>` : ''}
      </div>
    </div>`;
  }

  if (!performance) {
    return `<div role="cell" class="faction-grid-cell col-${key}">${factionPerformance.loading ? '…' : 'No data'}</div>`;
  }

  if (key === 'participation') {
    return `<div role="cell" class="faction-grid-cell col-participation"><strong>${formatNumber(performance.wars)} / ${formatNumber(factionPerformance.totalWars)}</strong><span class="member-meta">${formatPercent(performance.participation)}</span></div>`;
  }

  if (key === 'hits') {
    return `<div role="cell" class="faction-grid-cell col-hits"><strong>${formatNumber(performance.warHits)}</strong><span class="member-meta">${formatDecimal(performance.avgHitsPerWar, 1)} / war</span></div>`;
  }

  if (key === 'assists') {
    const perWar = Number(performance.wars) > 0 ? Number(performance.assists || 0) / Number(performance.wars) : null;
    return `<div role="cell" class="faction-grid-cell col-assists"><strong>${formatNumber(performance.assists)}</strong><span class="member-meta">${perWar === null ? '' : `${formatDecimal(perWar, 1)} / war`}</span></div>`;
  }

  if (key === 'outsideHits') return `<div role="cell" class="faction-grid-cell col-outsideHits">${formatNumber(performance.outsideHits)}</div>`;
  if (key === 'respect') {
    return `<div role="cell" class="faction-grid-cell col-respect"><strong>+${formatDecimal(performance.respectEarned, 2)}</strong><span class="member-meta">−${formatDecimal(performance.respectLost, 2)}</span></div>`;
  }

  if (key === 'score') {
    return `<div role="cell" class="faction-grid-cell col-score"><strong>+${formatDecimal(performance.scoreUp, 2)}</strong><span class="member-meta">−${formatDecimal(performance.scoreDown, 2)}</span></div>`;
  }

  if (key === 'netScore') {
    const perWar = Number(performance.wars) > 0 ? Number(performance.netScore || 0) / Number(performance.wars) : null;
    return `<div role="cell" class="faction-grid-cell col-netScore"><strong>${formatSigned(performance.netScore, 2)}</strong><span class="member-meta">${perWar === null ? '' : `${formatSigned(perWar, 2)} / war`}</span></div>`;
  }

  return `<div role="cell" class="faction-grid-cell col-${key}"></div>`;
}

function matchesFilter(member) {
  const memberVisible = member.current !== false || showFormerMembers;
  if (!memberVisible) return false;
  if (!activeFilters.size) return true;

  const memberTagKeys = new Set(
    normalizeMemberNotes(member?.notes).tags.map(tagKey).filter(Boolean)
  );

  for (const autoTag of automaticTags(member)) {
    const key = tagKey(autoTag?.title);
    if (key) memberTagKeys.add(key);
  }

  for (const filterKey of activeFilters) {
    if (!String(filterKey).startsWith('tag:')) continue;
    if (!memberTagKeys.has(String(filterKey).slice(4))) return false;
  }

  return true;
}

function compareMembers(a, b) {
  const direction = sortDirection === 'asc' ? 1 : -1;
  const av = sortValue(a, sortKey);
  const bv = sortValue(b, sortKey);

  if (typeof av === 'string' || typeof bv === 'string') {
    return String(av).localeCompare(String(bv)) * direction;
  }
  if (av === null && bv === null) return String(a.playerName).localeCompare(String(b.playerName));
  if (av === null) return 1;
  if (bv === null) return -1;
  return ((av - bv) * direction) || String(a.playerName).localeCompare(String(b.playerName));
}

function sortValue(member, key) {
  const performance = performanceMember(member);

  if (key === 'member') return member.playerName || '';
  if (key === 'stats') return nullable(member.battleStats?.value);
  if (key === 'activity') return nullable(member.activity?.perDay30d);
  if (key === 'xanax') return nullable(member.xanax?.perDay30d);
  if (key === 'ocs') return monthlyOcs(member.ocs);
  if (key === 'participation4') return nullable(member.war?.last4?.participation);
  if (key === 'hits4') return nullable(member.war?.last4?.hitsPerWar);
  if (key === 'participation') return nullable(performance?.participation);
  if (key === 'hits') return nullable(performance?.warHits);
  if (key === 'assists') return nullable(performance?.assists);
  if (key === 'outsideHits') return nullable(performance?.outsideHits);
  if (key === 'respect') {
    const earned = nullable(performance?.respectEarned);
    const lost = nullable(performance?.respectLost);
    if (earned === null && lost === null) return null;
    return Number(earned || 0) - Number(lost || 0);
  }
  if (key === 'score') {
    const up = nullable(performance?.scoreUp);
    const down = nullable(performance?.scoreDown);
    if (up === null && down === null) return null;
    return Number(up || 0) - Number(down || 0);
  }
  if (key === 'netScore') return nullable(performance?.netScore);
  if (key === 'attention') {
    const notes = normalizeMemberNotes(member.notes);
    return (notes.hasText ? 10 : 0) + notes.tags.length;
  }
  return 0;
}

function performanceMember(member) {
  const row = factionPerformance.members.get(Number(member?.playerId)) || null;
  return adjustedPerformance(row);
}

function adjustedPerformance(row) {
  if (!row || !excludeMilestones) return row;

  const wars = Number(row.wars || 0);
  const milestoneHits = Math.max(0, Number(row.chainBonusHitsOut || 0));
  const warHits = Math.max(0, Number(row.warHits || 0) - milestoneHits);

  const respectEarned = row.respectEarned == null
    ? null
    : Number(row.respectEarned || 0) - Number(row.chainBonusScoreOut || 0);
  const respectLost = row.respectLost == null
    ? null
    : Math.max(0, Number(row.respectLost || 0) - Number(row.chainBonusRespectLostIn || 0));

  const scoreUp = Number(row.scoreUp || 0) - Number(row.chainBonusScoreOut || 0);
  const scoreDown = Math.max(0, Number(row.scoreDown || 0) - Number(row.chainBonusScoreIn || 0));

  return {
    ...row,
    warHits,
    avgHitsPerWar:wars > 0 ? warHits / wars : null,
    respectEarned,
    respectLost,
    scoreUp,
    scoreDown,
    netScore:scoreUp - scoreDown
  };
}

function analysisPayload() {
  ensureFilterState();
  const range = timelineRange;
  return range?.from && range?.to ? { from:range.from, to:range.to } : {};
}

function performancePayload() {
  if (filterMode === 'wars') {
    return { warIds:[...selectedWarIds].sort() };
  }
  return analysisPayload();
}

function analysisKey() {
  const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
  ensureFilterState();
  return `${factionId}:timeline:${timelineRange?.from || ''}:${timelineRange?.to || ''}`;
}

function performanceKey() {
  const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
  if (filterMode === 'wars') {
    return `${factionId}:wars:${[...selectedWarIds].sort().join(',')}`;
  }
  const range = effectiveRange();
  return `${factionId}:timeline:${range?.from || ''}:${range?.to || ''}`;
}

function ensureSortKey() {
  if (factionColumns.includes(sortKey)) return;
  sortKey = 'member';
  sortDirection = 'asc';
}

function restoreBooleanPreference(key, fallback = false) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch (_) {
    return fallback;
  }
}

function storeBooleanPreference(key, value) {
  try { localStorage.setItem(key, value ? 'true' : 'false'); } catch (_) {}
}

function restoreFactionMode() {
  try {
    const stored = localStorage.getItem('rwengine.factionMode');
    if (stored === 'timeline' || stored === 'wars') return stored;
  } catch (_) {}
  return 'timeline';
}

function restoreTimelinePresetSelection() {
  try {
    const stored = String(localStorage.getItem('rwengine.timelinePreset') || '');
    return timelinePresetOptions().some(([key]) => key === stored) ? stored : '';
  } catch (_) {
    return '';
  }
}

function storeTimelinePresetSelection(value) {
  timelinePresetSelection = String(value || '');
  try {
    if (timelinePresetSelection) localStorage.setItem('rwengine.timelinePreset', timelinePresetSelection);
    else localStorage.removeItem('rwengine.timelinePreset');
  } catch (_) {}
}

function ensureFilterState() {
  const bounds = availabilityBounds();

  if (!timelineRange.from || !timelineRange.to) {
    timelineRange = restoreTimelineRange(bounds) || defaultTimelineRange(bounds);
  }

  if (bounds.from && timelineRange.from < bounds.from) timelineRange.from = bounds.from;
  if (bounds.to && timelineRange.to > bounds.to) timelineRange.to = bounds.to;
  if (timelineRange.from > timelineRange.to) timelineRange = defaultTimelineRange(bounds);

  const selectedPresetRange = timelinePresetSelection
    ? timelinePresetRange(timelinePresetSelection)
    : null;
  if (
    !selectedPresetRange ||
    selectedPresetRange.from !== timelineRange.from ||
    selectedPresetRange.to !== timelineRange.to
  ) {
    timelinePresetSelection = timelinePresetKey(timelineRange);
  }

  const validWarIds = new Set(sortedWars().map(war => String(warId(war))).filter(Boolean));
  selectedWarIds = new Set([...selectedWarIds].map(String).filter(id => validWarIds.has(id)));

  if (!selectedWarIds.size) {
    const restored = restoreWarSelection(validWarIds);
    selectedWarIds = restored.size
      ? restored
      : new Set(sortedWars().slice(0,4).map(war => String(warId(war))).filter(Boolean));
  }

  if (!calendarCursor) {
    calendarCursor = monthStart(timelineRange.from || bounds.from || isoToday());
  }
}

function availabilityBounds() {
  const intel = state.freshness?.datasets?.intel;
  return {
    from:intel?.snapshotFirstAt ? isoDate(intel.snapshotFirstAt) : null,
    to:intel?.snapshotObservedAt ? isoDate(intel.snapshotObservedAt) : null
  };
}

function defaultTimelineRange(bounds) {
  if (!bounds?.to) {
    const to = isoToday();
    return { from:addDays(to,-29), to };
  }
  const candidate = addDays(bounds.to,-29);
  return {
    from:bounds.from && candidate < bounds.from ? bounds.from : candidate,
    to:bounds.to
  };
}

function restoreTimelineRange(bounds) {
  try {
    const parsed = JSON.parse(localStorage.getItem('rwengine.timelineRange') || 'null');
    if (!parsed?.from || !parsed?.to) return null;
    if (bounds?.from && parsed.from < bounds.from) return null;
    if (bounds?.to && parsed.to > bounds.to) return null;
    return { from:parsed.from, to:parsed.to };
  } catch (_) {
    return null;
  }
}

function restoreWarSelection(validIds) {
  try {
    const parsed = JSON.parse(localStorage.getItem('rwengine.selectedWarIds') || '[]');
    return new Set(
      (Array.isArray(parsed) ? parsed : [])
        .map(value => String(value || '').trim())
        .filter(id => id && validIds.has(id))
    );
  } catch (_) {
    return new Set();
  }
}

function effectiveRange() {
  ensureFilterState();
  if (filterMode === 'timeline') return timelineRange;
  return rangeForWarIds(selectedWarIds);
}

function prepareFilterDraft() {
  ensureFilterState();
  if (filterMode === 'timeline') {
    draftTimelineRange = { ...timelineRange };
    calendarAnchor = null;
    calendarCursor = monthStart(draftTimelineRange.from || timelineRange.from);
  } else {
    draftWarIds = new Set(selectedWarIds);
  }
}

function timelinePresetOptions() {
  const year = new Date().getUTCFullYear();
  return [
    ['all', 'All Time'],
    ['today', 'Today'],
    ['yesterday', 'Yesterday'],
    ['last7', 'Last 7 Days'],
    ['previous7', 'Previous 7 Days'],
    ['last30', 'Last 30 Days'],
    ['thisMonth', 'This Month'],
    ['lastMonth', 'Last Month'],
    ['year', String(year)]
  ];
}

function timelinePresetRange(key) {
  const today = isoToday();
  const thisMonth = monthStart(today).toISOString().slice(0,10);
  const lastMonth = addMonths(monthStart(today), -1).toISOString().slice(0,10);
  const year = new Date(today + 'T00:00:00Z').getUTCFullYear();

  let range = null;
  if (key === 'all') range = { from:'2022-01-01', to:today };
  if (key === 'today') range = { from:today, to:today };
  if (key === 'yesterday') {
    const day = addDays(today, -1);
    range = { from:day, to:day };
  }
  if (key === 'last7') range = { from:addDays(today, -6), to:today };
  if (key === 'previous7') range = { from:addDays(today, -13), to:addDays(today, -7) };
  if (key === 'last30') range = { from:addDays(today, -29), to:today };
  if (key === 'thisMonth') range = { from:thisMonth, to:today };
  if (key === 'lastMonth') range = { from:lastMonth, to:addDays(thisMonth, -1) };
  if (key === 'year') range = { from:`${year}-01-01`, to:today };
  if (!range) return null;

  const bounds = availabilityBounds();
  const from = bounds.from && range.from < bounds.from ? bounds.from : range.from;
  const to = bounds.to && range.to > bounds.to ? bounds.to : range.to;
  return from <= to ? { from, to } : null;
}

function timelinePresetKey(range) {
  if (!range?.from || !range?.to) return '';
  for (const [key] of timelinePresetOptions()) {
    const candidate = timelinePresetRange(key);
    if (candidate && candidate.from === range.from && candidate.to === range.to) return key;
  }
  return '';
}

async function applyTimelinePreset(key) {
  const range = timelinePresetRange(key);
  if (!range) return;

  filterPanelOpen = false;
  timelineRange = range;
  storeTimelinePresetSelection(key);
  draftTimelineRange = { ...range };
  calendarAnchor = null;
  calendarCursor = monthStart(range.from);
  try { localStorage.setItem('rwengine.timelineRange', JSON.stringify(timelineRange)); } catch (_) {}

  loadedAnalysisKey = '';
  factionPerformance.loadedKey = '';
  factionPerformance.members.clear();
  renderFactionControls();
  await loadIntelV2(true);
}

function areAllWarsSelected() {
  const ids = sortedWars().map(war => String(warId(war))).filter(Boolean);
  return Boolean(ids.length) && ids.every(id => selectedWarIds.has(id)) && selectedWarIds.size === ids.length;
}

async function applyTimelineDraft() {
  if (!draftTimelineRange?.from || !draftTimelineRange?.to) return;
  timelineRange = { ...draftTimelineRange };
  storeTimelinePresetSelection(timelinePresetKey(timelineRange));
  try { localStorage.setItem('rwengine.timelineRange', JSON.stringify(timelineRange)); } catch (_) {}
  filterPanelOpen = false;
  loadedAnalysisKey = '';
  factionPerformance.loadedKey = '';
  factionPerformance.members.clear();
  renderFactionControls();
  await loadIntelV2(true);
}

async function applyWarDraft() {
  if (!draftWarIds.size) return;
  selectedWarIds = new Set(draftWarIds);
  try { localStorage.setItem('rwengine.selectedWarIds', JSON.stringify([...selectedWarIds])); } catch (_) {}
  filterPanelOpen = false;
  loadedAnalysisKey = '';
  factionPerformance.loadedKey = '';
  factionPerformance.members.clear();
  renderFactionControls();
  await loadIntelV2(true);
}

function renderCalendarPicker() {
  const bounds = availabilityBounds();
  const first = calendarCursor || monthStart(timelineRange.from || bounds.from || isoToday());
  const second = addMonths(first, 1);
  const range = draftTimelineRange || timelineRange;

  return `
    <div class="calendar-picker">
      <header class="filter-panel-head">
        <div>
          <strong>Timeline</strong>
          <span>${escapeHtml(formatRangeLabel(range))}</span>
        </div>
        <div class="calendar-nav">
          <button type="button" data-calendar-nav="-1" aria-label="Previous month">←</button>
          <button type="button" data-calendar-nav="1" aria-label="Next month">→</button>
        </div>
      </header>
      <div class="calendar-months">
        ${renderCalendarMonth(first, bounds, range)}
        ${renderCalendarMonth(second, bounds, range)}
      </div>
      <footer class="filter-panel-foot">
        <span><i class="calendar-legend-war"></i> Imported ranked war</span>
        <span class="filter-spacer"></span>
        <button type="button" class="text-action" data-filter-action="cancel">Cancel</button>
        <button type="button" class="action primary" data-filter-action="calendar-apply">Apply range</button>
      </footer>
    </div>
  `;
}

function renderCalendarMonth(month, bounds, range) {
  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  const title = month.toLocaleString(undefined, { month:'long', year:'numeric', timeZone:'UTC' });
  const firstWeekday = (new Date(Date.UTC(year, monthIndex, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cells = [];

  for (let i = 0; i < firstWeekday; i++) cells.push('<span class="calendar-day empty"></span>');

  for (let day = 1; day <= days; day++) {
    const date = `${year}-${String(monthIndex + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const available = (!bounds.from || date >= bounds.from) && (!bounds.to || date <= bounds.to);
    const warNames = warsOnDate(date);
    const selected = range?.from && range?.to && date >= range.from && date <= range.to;
    const edge = date === range?.from || date === range?.to;
    const classes = [
      'calendar-day',
      available ? '' : 'unavailable',
      warNames.length ? 'has-war' : '',
      selected ? 'selected' : '',
      edge ? 'edge' : ''
    ].filter(Boolean).join(' ');

    cells.push(`<button type="button" class="${classes}" data-calendar-day="${date}"${available ? '' : ' disabled'} title="${escapeHtml(warNames.join(' · '))}"><span>${day}</span>${warNames.length ? '<i></i>' : ''}</button>`);
  }

  return `
    <section class="calendar-month">
      <header>${escapeHtml(title)}</header>
      <div class="calendar-weekdays">${['M','T','W','T','F','S','S'].map(day => `<span>${day}</span>`).join('')}</div>
      <div class="calendar-grid">${cells.join('')}</div>
    </section>
  `;
}

function renderWarPicker() {
  const wars = sortedWars();

  return `
    <div class="war-picker">
      <header class="filter-panel-head">
        <div>
          <strong>Ranked wars</strong>
          <span>${draftWarIds.size} selected</span>
        </div>
        <div class="war-picker-actions">
          <button type="button" class="text-action" data-filter-action="wars-all">All</button>
          <button type="button" class="text-action" data-filter-action="wars-none">None</button>
        </div>
      </header>
      <div class="war-picker-list">
        ${wars.length ? wars.map(war => {
          const id = String(warId(war));
          const checked = draftWarIds.has(id);
          return `
            <label class="war-picker-row">
              <input type="checkbox" data-war-check="${id}"${checked ? ' checked' : ''}>
              <span>
                <strong>${escapeHtml(warOpponent(war))}<small class="entity-id">#${escapeHtml(id)}</small></strong>
                <small>${escapeHtml(formatWarDate(war))}</small>
              </span>
            </label>
          `;
        }).join('') : '<p class="status-line">No imported ranked wars.</p>'}
      </div>
      <footer class="filter-panel-foot">
        <span class="filter-spacer"></span>
        <button type="button" class="text-action" data-filter-action="cancel">Cancel</button>
        <button id="warSelectionApply" type="button" class="action primary" data-filter-action="wars-apply"${draftWarIds.size ? '' : ' disabled'}>Apply wars</button>
      </footer>
    </div>
  `;
}

function updateWarApplyState() {
  const button = document.querySelector('#warSelectionApply');
  if (button) button.disabled = !draftWarIds.size;
}

function selectCalendarDay(date) {
  if (!calendarAnchor) {
    calendarAnchor = date;
    draftTimelineRange = { from:date, to:date };
    return;
  }

  draftTimelineRange = date < calendarAnchor
    ? { from:date, to:calendarAnchor }
    : { from:calendarAnchor, to:date };
  calendarAnchor = null;
}

function moveCalendar(offset) {
  calendarCursor = addMonths(calendarCursor || monthStart(isoToday()), offset);
}

function rangeForWarIds(ids) {
  const selected = sortedWars().filter(war => ids.has(String(warId(war))));
  if (!selected.length) return timelineRange;

  const starts = selected.map(war => warStartDate(war)).filter(Boolean).sort();
  const ends = selected.map(war => warEndDate(war)).filter(Boolean).sort();

  return {
    from:starts[0] || ends[0] || timelineRange.from,
    to:ends[ends.length - 1] || starts[starts.length - 1] || timelineRange.to
  };
}

function sortedWars() {
  return [...(state.wars || [])].sort((a,b) => warStamp(b) - warStamp(a));
}

function warStamp(war) {
  return Number(war?.endTimestamp || war?.end_timestamp || war?.startTimestamp || war?.start_timestamp || war?.importedAt || war?.imported_at || 0);
}

function warId(war) {
  return war?.warId ?? war?.war_id ?? war?.id ?? 0;
}

function warOpponent(war) {
  return war?.opponentFactionName || war?.opponent_faction_name || war?.opponentName || war?.opponent_name || 'Unknown opponent';
}

function warStartDate(war) {
  const stamp = Number(war?.startTimestamp || war?.start_timestamp || war?.endTimestamp || war?.end_timestamp || war?.importedAt || war?.imported_at || 0);
  return stamp ? isoDate(stamp) : null;
}

function warEndDate(war) {
  const stamp = Number(war?.endTimestamp || war?.end_timestamp || war?.startTimestamp || war?.start_timestamp || war?.importedAt || war?.imported_at || 0);
  return stamp ? isoDate(stamp) : null;
}

function formatWarDate(war) {
  const start = warStartDate(war);
  const end = warEndDate(war);
  if (!start && !end) return 'Date unavailable';
  if (!start || start === end) return humanDate(end || start);
  return `${humanDate(start)} – ${humanDate(end)}`;
}

function warsOnDate(date) {
  return sortedWars()
    .filter(war => {
      const start = warStartDate(war);
      const end = warEndDate(war);
      if (!start && !end) return false;
      return date >= (start || end) && date <= (end || start);
    })
    .map(war => warOpponent(war));
}

function formatRangeLabel(range) {
  if (!range?.from || !range?.to) return 'No available range';
  if (range.from === range.to) return humanDate(range.from);
  return `${humanDate(range.from)} – ${humanDate(range.to)}`;
}

function humanDate(value) {
  if (!value) return '—';
  const date = new Date(value + 'T00:00:00Z');
  return date.toLocaleDateString(undefined, {
    day:'2-digit',
    month:'short',
    year:date.getUTCFullYear() === new Date().getUTCFullYear() ? undefined : 'numeric',
    timeZone:'UTC'
  });
}

function isoDate(timestamp) {
  return new Date(Number(timestamp) * 1000).toISOString().slice(0,10);
}

function isoToday() {
  return new Date().toISOString().slice(0,10);
}

function addDays(value, days) {
  const date = new Date(value + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0,10);
}

function monthStart(value) {
  const date = value instanceof Date ? value : new Date(String(value) + 'T00:00:00Z');
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(value, months) {
  const date = value instanceof Date ? value : monthStart(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + Number(months || 0), 1));
}

function averageNullable(values) {
  const valid = values.map(nullable).filter(value => value !== null);
  if (!valid.length) return null;
  return valid.reduce((sum,value) => sum + value, 0) / valid.length;
}

function medianNullable(values) {
  const valid = values.map(nullable).filter(value => value !== null).sort((a,b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

function tableCellText(value) {
  if (value === null || value === undefined || value === '' || value === '—') return 'No data';
  return String(value);
}

function tableTrendLabel(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const pct = Math.round(number * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

function tableBattleStatsTrend(member) {
  const value = member?.battleStats?.changePct30d;
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const pct = Math.round(number * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

function tableSignalLabel(signal, member) {
  if (!signal) return '—';
  if (signal.code === 'low_war_participation') return 'Low participation';
  if (signal.code === 'participation_down') return 'Participation declining';
  if (signal.code === 'activity_down') return 'Activity declining';
  if (signal.code === 'activity_up') return 'Activity improving';
  if (signal.code === 'xanax_down') return 'Xanax declining';
  if (signal.code === 'xanax_up') return 'Xanax improving';
  if (signal.code === 'strong_war_output') return 'Strong war output';
  if (signal.code === 'missing_battle_stats') return 'Stats missing';
  if (signal.code === 'stale_battle_stats') return 'Stats stale';
  if (signal.code === 'battle_stats_growth') return 'Stats growing';
  return signalLabel(signal, member);
}

function automaticTags(member) {
  return buildAutoTags(
    member,
    performanceMember(member),
    autoTagSettings,
    Math.floor(Date.now() / 1000)
  );
}

function topSignal(member) {
  const applied = automaticTags(member);
  if (applied.length) return applied[0];

  const insights = Array.isArray(member.insights) ? member.insights : [];
  if (!insights.length) return null;
  return insights.sort((a,b) => priorityIndex(a.code) - priorityIndex(b.code))[0];
}

function priorityIndex(code) {
  const index = priority.indexOf(code);
  return index < 0 ? 999 : index;
}

function signalLabel(signal, member) {
  if (signal.code === 'inactive') {
    const seconds = Number(signal.value || 0);
    const days = Math.max(1, Math.floor(seconds / 86400));
    return `inactive ${days}d`;
  }
  if (signal.code === 'low_war_participation') {
    return `${member.war?.last4?.warsParticipated ?? 0}/${member.war?.last4?.warsAvailable ?? 0} wars`;
  }
  if (signal.code === 'participation_down') return 'participation ↓';
  if (signal.code === 'activity_down') return `activity ${signedPct(member.activity?.changePct)}`;
  if (signal.code === 'activity_up') return `activity ${signedPct(member.activity?.changePct)}`;
  if (signal.code === 'xanax_down') return `xanax ${signedPct(member.xanax?.changePct)}`;
  if (signal.code === 'xanax_up') return `xanax ${signedPct(member.xanax?.changePct)}`;
  if (signal.code === 'missing_battle_stats') return 'stats missing';
  if (signal.code === 'stale_battle_stats') return 'stats stale';
  if (signal.code === 'battle_stats_growth') return `stats ${signedPct(member.battleStats?.changePct30d)}`;
  if (signal.code === 'strong_war_output') return 'war output +';
  return String(signal.code || '').replaceAll('_', ' ');
}

function tagKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function workflowTagOptions() {
  const tags = new Map();

  for (const label of WORKFLOW_TAGS) {
    tags.set(tagKey(label), { key:tagKey(label), label, count:0, standard:true });
  }

  for (const member of overview?.members || []) {
    for (const rawTag of normalizeMemberNotes(member.notes).tags) {
      const key = tagKey(rawTag);
      if (!key) continue;
      const existing = tags.get(key);
      if (existing) existing.count += 1;
      else tags.set(key, { key, label:rawTag, count:1, standard:false });
    }
  }

  const standard = WORKFLOW_TAGS.map(label => tags.get(tagKey(label))).filter(Boolean);
  const custom = [...tags.values()]
    .filter(tag => !tag.standard)
    .sort((a,b) => a.label.localeCompare(b.label, undefined, { sensitivity:'base', numeric:true }));

  return [...standard, ...custom];
}

function activeTagFilterOptions() {
  const tags = new Map();

  for (const member of overview?.members || []) {
    if (member.current === false && !showFormerMembers) continue;

    const memberTagLabels = new Map();

    for (const rawTag of normalizeMemberNotes(member.notes).tags) {
      const key = tagKey(rawTag);
      if (key && !memberTagLabels.has(key)) memberTagLabels.set(key, rawTag);
    }

    for (const autoTag of automaticTags(member)) {
      const label = String(autoTag?.title || '').trim();
      const key = tagKey(label);
      if (key && !memberTagLabels.has(key)) memberTagLabels.set(key, label);
    }

    for (const [key,label] of memberTagLabels) {
      const existing = tags.get(key);
      if (existing) existing.count += 1;
      else tags.set(key, { key, label, count:1 });
    }
  }

  return [...tags.values()]
    .filter(tag => tag.count > 0)
    .sort((a,b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity:'base', numeric:true })
    );
}

function canManageTags() {
  return Boolean(overview?.permissions?.canEditMemberNotes && canEditFactionView());
}

function ensureTagToolbar() {
  if (document.querySelector('#intelTagToolbar')) return;
  const statusStack = document.querySelector('#factionStatusStack');
  if (!statusStack) return;

  const toolbar = document.createElement('section');
  toolbar.id = 'intelTagToolbar';
  toolbar.className = 'intel-tag-toolbar hidden';
  toolbar.setAttribute('aria-label', 'Member tag tools');
  statusStack.appendChild(toolbar);
}

function renderTagToolbar() {
  ensureTagToolbar();
  const toolbar = document.querySelector('#intelTagToolbar');
  if (!toolbar) return;

  const visible = tagManageMode && canManageTags();
  toolbar.classList.toggle('hidden', !visible);
  if (!visible) {
    toolbar.innerHTML = '';
    return;
  }

  const selectedCount = selectedTagMemberIds.size;
  const suggestions = workflowTagOptions();
  toolbar.innerHTML = `
    <div class="intel-tag-toolbar-summary">
      <strong>Tag members</strong>
      <span>${formatNumber(selectedCount)} selected</span>
    </div>
    <div class="intel-tag-toolbar-actions">
      <input data-tag-bulk-input list="intelTagBulkOptions" maxlength="24" value="${escapeHtml(tagDraft)}" placeholder="Tag name" aria-label="Tag name" ${tagBulkBusy ? 'disabled' : ''} />
      <datalist id="intelTagBulkOptions">
        ${suggestions.map(tag => `<option value="${escapeHtml(tag.label)}"></option>`).join('')}
      </datalist>
      <button type="button" data-tag-bulk-action="add" ${tagBulkBusy || !selectedCount ? 'disabled' : ''}>Add</button>
      <button type="button" data-tag-bulk-action="remove" ${tagBulkBusy || !selectedCount ? 'disabled' : ''}>Remove</button>
      <button type="button" data-tag-bulk-action="clear" ${tagBulkBusy || !selectedCount ? 'disabled' : ''}>Clear selection</button>
      <button type="button" data-tag-bulk-action="done" ${tagBulkBusy ? 'disabled' : ''}>Done</button>
    </div>
    <span class="intel-tag-toolbar-status${tagBulkStatus.startsWith('Failed') ? ' error' : ''}" role="status">${escapeHtml(tagBulkStatus)}</span>
  `;
}

async function applyBulkTag(mode) {
  if (tagBulkBusy || !canManageTags() || !selectedTagMemberIds.size) return;

  const tag = String(tagDraft || '').replace(/\s+/g, ' ').trim();
  if (!tag) {
    tagBulkStatus = 'Enter a tag name.';
    renderTagToolbar();
    return;
  }
  if (tag.length > 24) {
    tagBulkStatus = 'Tags are limited to 24 characters.';
    renderTagToolbar();
    return;
  }

  const wantedKey = tagKey(tag);
  const members = (overview?.members || [])
    .filter(member => selectedTagMemberIds.has(Number(member.playerId)));

  tagBulkBusy = true;
  tagBulkStatus = mode === 'add' ? 'Adding tag…' : 'Removing tag…';
  renderTagToolbar();

  let changed = 0;
  let skipped = 0;
  let failed = 0;

  for (const member of members) {
    const notes = normalizeMemberNotes(member.notes);
    const existingKeys = new Set(notes.tags.map(tagKey));
    let nextTags = notes.tags.slice();

    if (mode === 'add') {
      if (existingKeys.has(wantedKey)) {
        skipped += 1;
        continue;
      }
      if (nextTags.length >= 8) {
        failed += 1;
        continue;
      }
      nextTags.push(tag);
    } else {
      const filtered = nextTags.filter(existing => tagKey(existing) !== wantedKey);
      if (filtered.length === nextTags.length) {
        skipped += 1;
        continue;
      }
      nextTags = filtered;
    }

    try {
      const result = await intelV2Api('saveMemberNotes', {
        playerId:Number(member.playerId),
        noteText:notes.text,
        tags:nextTags
      });
      member.notes = result.notes;

      const key = detailKey(member.playerId);
      const detail = detailCache.get(key);
      if (detail?.member) detail.member.notes = result.notes;
      changed += 1;
    } catch (_) {
      failed += 1;
    }
  }

  if (overview?.summary) {
    overview.summary.membersWithNotes = (overview.members || [])
      .filter(row => row.current !== false && memberHasNotes(row)).length;
  }

  tagBulkBusy = false;
  const verb = mode === 'add' ? 'Added' : 'Removed';
  tagBulkStatus = `${verb} “${tag}” for ${formatNumber(changed)} member${changed === 1 ? '' : 's'}${skipped ? ` · ${formatNumber(skipped)} unchanged` : ''}${failed ? ` · ${formatNumber(failed)} failed` : ''}.`;
  renderFilters();
  renderIntelV2();
}

function normalizeMemberNotes(value) {
  const text = String(value?.text || '').trim();
  const tags = Array.isArray(value?.tags)
    ? value.tags.map(tag => String(tag || '').trim()).filter(Boolean)
    : [];

  return {
    text,
    hasText:Boolean(value?.hasText || text),
    tags,
    updatedAt:nullable(value?.updatedAt),
    updatedBy:value?.updatedBy || null
  };
}

function memberHasNotes(member) {
  const notes = normalizeMemberNotes(member?.notes);
  return notes.hasText || notes.tags.length > 0;
}

async function saveMemberNotesForm(form) {
  if (!canEditFactionView()) return;
  const playerId = Number(form?.dataset?.playerId || 0);
  if (!playerId) return;

  const key = detailKey(playerId);
  if (noteSaving.has(key)) return;

  const draft = {
    noteText:String(form.elements.noteText?.value || '')
  };
  noteDrafts.set(key, draft);
  noteErrors.delete(key);
  noteSaving.add(key);
  renderIntelV2();

  try {
    const detailPayload = detailCache.get(key);
    const overviewMember = (overview?.members || []).find(row => Number(row.playerId) === playerId);
    const existingNotes = normalizeMemberNotes(detailPayload?.member?.notes || overviewMember?.notes);
    const result = await intelV2Api('saveMemberNotes', {
      playerId,
      noteText:draft.noteText,
      tags:existingNotes.tags
    });

    if (detailPayload?.member) detailPayload.member.notes = result.notes;
    if (overviewMember) overviewMember.notes = result.notes;
    if (overview?.summary) {
      overview.summary.membersWithNotes = (overview.members || [])
        .filter(row => row.current !== false && memberHasNotes(row)).length;
    }

    noteEditing.delete(key);
    noteDrafts.delete(key);
    noteErrors.delete(key);
  } catch (error) {
    noteErrors.set(key, error.message || 'Failed to save member notes.');
  } finally {
    noteSaving.delete(key);
    if (selectedMemberId === playerId) renderIntelV2();
  }
}

async function openMember(playerId) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) return;

  if (!overview) await loadIntelV2(false);
  selectedMemberId = playerId;
  renderIntelV2();

  const key = detailKey(playerId);
  if (detailCache.has(key) || detailLoading.has(key)) return;

  detailLoading.add(key);
  renderIntelV2();

  try {
    const payload = await intelV2Api('member', { playerId });
    detailCache.set(key, payload);
  } catch (error) {
    detailCache.set(key, { error:error.message || 'Failed to load member detail.' });
  } finally {
    detailLoading.delete(key);
    if (selectedMemberId === playerId) renderIntelV2();
  }
}

function renderDetailRow(member) {
  const key = detailKey(member.playerId);
  const payload = detailCache.get(key);

  if (detailLoading.has(key)) {
    return `<div class="intel2-detail-row faction-grid-detail" role="row"><div class="faction-grid-detail-cell" role="cell"><section class="intel2-detail"><p class="status-line">Loading member history…</p></section></div></div>`;
  }

  if (payload?.error) {
    return `<div class="intel2-detail-row faction-grid-detail" role="row"><div class="faction-grid-detail-cell" role="cell"><section class="intel2-detail"><p class="status-line error">${escapeHtml(payload.error)}</p></section></div></div>`;
  }

  if (!payload?.member) {
    return `<div class="intel2-detail-row faction-grid-detail" role="row"><div class="faction-grid-detail-cell" role="cell"><section class="intel2-detail"><p class="status-line">Loading member history…</p></section></div></div>`;
  }

  const detailMember = payload.member;
  const history = normalizeHistory(payload.history);
  const tagsPanel = renderMemberTagsPanel(detailMember, member);
  const notesPanel = renderMemberNotesPanel(detailMember, payload);
  return `
    <div class="intel2-detail-row faction-grid-detail" role="row">
      <div class="faction-grid-detail-cell" role="cell">
        <section class="intel2-detail">
          <div class="intel2-detail-layout">
            ${tagsPanel}

            <section class="intel2-history">
              <header class="intel2-history-head">
                <div class="intel2-history-titlebar">
                  <span class="intel2-history-kicker">History &amp; trends</span>
                  <div class="intel2-history-metrics" aria-label="Trend metric">
                    ${[
                      ['stats','BS'],
                      ['activity','Activity'],
                      ['xanax','Xanax'],
                      ['ocs','OCs']
                    ].map(([key,label]) => `<button type="button" data-trend-metric="${key}" class="${trendMetric === key ? 'active' : ''}">${label}</button>`).join('')}
                  </div>
                </div>
                <div class="intel2-history-window" aria-label="History window">
                  ${[30,60,90].map(days => `<button type="button" data-trend-days="${days}" class="${trendDays === days ? 'active' : ''}">${days}d</button>`).join('')}
                </div>
              </header>

              <div class="intel2-trend-stage">
                ${renderSelectedTrend(history)}
              </div>
            </section>

            <section class="intel2-wars">
              <header>
                <strong>Recent wars</strong>
                <span>${history.wars.length} available</span>
              </header>
              ${renderWarHistory(history.wars)}
            </section>

            ${notesPanel}
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderMemberTagsPanel(member, scopedMember = null) {
  const insights = automaticTags(scopedMember || member);
  const positives = insights.filter(item => item.kind === 'positive');
  const concerns = insights.filter(item => item.kind === 'attention');
  const notes = normalizeMemberNotes(member.notes);
  const hasAutomaticTags = positives.length + concerns.length > 0;
  const hasManualTags = notes.tags.length > 0;

  if (!hasAutomaticTags && !hasManualTags) {
    return '<section class="intel2-member-tags"></section>';
  }

  return `
    <section class="intel2-member-tags">
      ${hasManualTags ? `
        <div class="intel2-note-tags intel2-member-manual-tags">
          ${notes.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}
        </div>
      ` : ''}
      ${hasAutomaticTags ? `
        <div class="intel2-context-grid">
          ${renderTraitGroup('positive', '+', 'Positive', positives, member, 'None')}
          ${renderTraitGroup('attention', '−', 'Concerns', concerns, member, 'None')}
        </div>
      ` : ''}
    </section>
  `;
}

function renderMemberNotesPanel(member, payload) {
  const notes = normalizeMemberNotes(member.notes);
  const key = detailKey(member.playerId);
  const canEdit = Boolean(
    (payload?.permissions?.canEditMemberNotes || overview?.permissions?.canEditMemberNotes) &&
    canEditFactionView()
  );
  const editing = noteEditing.has(key) && canEdit;
  const saving = noteSaving.has(key);
  const draft = noteDrafts.get(key) || {
    noteText:notes.text
  };
  const error = noteErrors.get(key) || '';

  return `
    <section class="intel2-context intel2-notes">
      ${editing ? `
        <form class="intel2-note-form" data-member-note-form data-player-id="${member.playerId}">
          <label>
            <span>Note</span>
            <textarea name="noteText" maxlength="2000" rows="5" placeholder="Add context for faction leadership…">${escapeHtml(draft.noteText)}</textarea>
          </label>
          ${error ? `<p class="intel2-note-error">${escapeHtml(error)}</p>` : ''}
          <footer>
            <button type="button" data-member-note-action="cancel" data-player-id="${member.playerId}"${saving ? ' disabled' : ''}>Cancel</button>
            <button class="primary" type="submit"${saving ? ' disabled' : ''}>${saving ? 'Saving…' : 'Save'}</button>
          </footer>
        </form>
      ` : `
        <div class="intel2-note-view">
          <p class="${notes.hasText ? '' : 'empty'}">${notes.hasText ? escapeHtml(notes.text) : 'No member note yet.'}</p>
          ${notes.updatedAt ? `<small>Updated ${escapeHtml(formatRelative(notes.updatedAt))}${notes.updatedBy?.playerName ? ` by ${escapeHtml(notes.updatedBy.playerName)}` : ''}</small>` : ''}
        </div>
      `}
    </section>
  `;
}

function renderTraitGroup(kind, symbol, label, items, member, emptyLabel) {
  return `
    <section class="intel2-trait-group ${kind}">
      <header><span>${symbol}</span><strong>${label}</strong></header>
      <div class="intel2-trait-list">
        ${items.length ? items.map(item => `
          <div class="intel2-trait auto-tag tier-${escapeHtml(item.tier || 'neutral')}">
            <b class="auto-tag-name">${escapeHtml(traitTitle(item, member))}</b>
          </div>
        `).join('') : '<span class="intel2-trait-empty auto-tag-empty">—</span>'}
      </div>
    </section>
  `;
}

function traitTitle(item, member) {
  if (item?.title) return item.title;
  if (item.code === 'inactive') return 'Inactive';
  if (item.code === 'low_war_participation') return 'Low war participation';
  if (item.code === 'participation_down') return 'Participation declining';
  if (item.code === 'activity_down') return 'Activity declining';
  if (item.code === 'activity_up') return 'Activity improving';
  if (item.code === 'xanax_down') return 'Xanax use declining';
  if (item.code === 'xanax_up') return 'Xanax use improving';
  if (item.code === 'missing_battle_stats') return 'Battle stats unavailable';
  if (item.code === 'stale_battle_stats') return 'Battle stats stale';
  if (item.code === 'battle_stats_growth') return 'Battle stats growing';
  if (item.code === 'strong_war_output') return 'Strong war output';
  return signalLabel(item, member);
}

function normalizeHistory(history = {}) {
  const snapshots = Array.isArray(history.snapshots) ? history.snapshots : [];

  const stats = snapshots
    .filter(point => hasNumber(point.battleStatsValue))
    .map(point => ({ at:Number(point.at), value:Number(point.battleStatsValue) }));

  const activityStored = snapshots
    .filter(point =>
      hasNumber(point.activityPerDaySeconds) &&
      Number(point.activityPerDaySeconds) >= 0 &&
      Number(point.activityPerDaySeconds) <= 86400
    )
    .map(point => ({ at:Number(point.at), value:Number(point.activityPerDaySeconds) }));

  const xanaxStored = snapshots
    .filter(point =>
      hasNumber(point.xanaxPerDay) &&
      Number(point.xanaxPerDay) >= 0 &&
      Number(point.xanaxPerDay) <= 10
    )
    .map(point => ({ at:Number(point.at), value:Number(point.xanaxPerDay) }));

  return {
    stats,
    activity:activityStored.length >= 2
      ? activityStored
      : deriveRateSeries(snapshots, 'activityTotalSeconds'),
    xanax:xanaxStored.length >= 2
      ? xanaxStored
      : deriveRateSeries(snapshots, 'xanaxTakenTotal'),
    ocs:deriveRateSeries(snapshots, 'organizedCrimesTotal')
      .map(point => ({ ...point, value:point.value * MONTH_DAYS })),
    wars:Array.isArray(history.wars) ? history.wars : []
  };
}

function deriveRateSeries(snapshots, key) {
  const rows = snapshots
    .filter(point => hasNumber(point.at) && hasNumber(point[key]))
    .sort((a,b) => Number(a.at) - Number(b.at));

  const maxPerDay = key === 'activityTotalSeconds'
    ? 86400
    : key === 'xanaxTakenTotal'
      ? 10
      : key === 'organizedCrimesTotal'
        ? 50
        : Infinity;

  const series = [];
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1];
    const current = rows[index];
    const elapsed = (Number(current.at) - Number(previous.at)) / 86400;
    const delta = Number(current[key]) - Number(previous[key]);
    const perDay = elapsed > 0 ? delta / elapsed : null;

    if (
      elapsed >= 0.5 &&
      delta >= 0 &&
      Number.isFinite(perDay) &&
      perDay <= maxPerDay
    ) {
      series.push({ at:Number(current.at), value:perDay });
    }
  }
  return series;
}

function trendBlock(title, series, formatter) {
  const filtered = filterSeries(series, trendDays);
  const valid = filtered.filter(point =>
    point.value !== null &&
    point.value !== undefined &&
    point.value !== '' &&
    Number.isFinite(Number(point.value))
  );
  const latest = valid.length ? valid[valid.length - 1].value : null;
  const availableDays = valid.length > 1
    ? Math.max(1, Math.round(
        (Number(valid[valid.length - 1].at) - Number(valid[0].at)) / 86400
      ))
    : 0;
  const windowLabel = valid.length
    ? (availableDays > 0
      ? (availableDays < trendDays ? `${availableDays}d available` : `${trendDays}d`)
      : '1 point available')
    : 'No data';
  const latestLabel = latest === null || latest === undefined ? '' : formatter(latest);

  const body = valid.length === 0
    ? '<div class="intel2-trend-empty">No data</div>'
    : valid.length === 1
      ? '<div class="intel2-trend-empty">Not enough history</div>'
      : sparkline(filtered);

  return `
    <section class="intel2-trend">
      <header>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(latestLabel ? `${windowLabel} · ${latestLabel}` : windowLabel)}</span>
      </header>
      ${body}
    </section>
  `;
}

function renderSelectedTrend(history) {
  if (trendMetric === 'stats') {
    return trendBlock('Battle stats', history.stats, value => value == null ? '' : formatCompact(value));
  }
  if (trendMetric === 'xanax') {
    return trendBlock('Xanax / day', history.xanax, value => formatDecimal(value, 2));
  }
  if (trendMetric === 'ocs') {
    return trendBlock('OCs / month', history.ocs, value => formatDecimal(value, 2));
  }
  return trendBlock('Activity / day', history.activity, formatDuration);
}

function filterSeries(series, days) {
  if (!series.length) return [];
  const newest = Math.max(...series.map(point => Number(point.at) || 0));
  const cutoff = newest - days * 86400;
  return series.filter(point => (Number(point.at) || 0) >= cutoff);
}

function sparkline(series) {
  const valid = series
    .map((point,index) => ({ index, value:Number(point.value) }))
    .filter(point => Number.isFinite(point.value));

  if (valid.length < 2) return '<div class="sparkline"></div>';

  const min = Math.min(...valid.map(point => point.value));
  const max = Math.max(...valid.map(point => point.value));
  const spread = max - min || 1;

  const points = valid.map(point => {
    const x = (point.index / Math.max(1, series.length - 1)) * 100;
    const y = 48 - ((point.value - min) / spread) * 42;
    return [x,y];
  });

  const path = points
    .map(([x,y],index) => index === 0
      ? `M ${x.toFixed(2)} ${y.toFixed(2)}`
      : `L ${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ');

  return `<svg class="sparkline" viewBox="0 0 100 54" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="50" x2="100" y2="50"></line><path d="${path}"></path></svg>`;
}

function renderWarHistory(wars) {
  if (!wars.length) return '<div class="intel2-war-empty">No data</div>';

  return `
    <div class="intel2-war-table" role="table" aria-label="Recent ranked wars">
      <div class="intel2-war intel2-war-head" role="row">
        <span role="columnheader">War</span>
        <span role="columnheader">Hits</span>
        <span role="columnheader">Assists</span>
        <span role="columnheader">Outside</span>
        <span role="columnheader">Net</span>
      </div>
      ${wars.map(war => `
        <div class="intel2-war" role="row">
          <div class="intel2-war-name" role="cell">
            <strong>${escapeHtml(war.opponentFactionName || war.opponent || 'Unknown opponent')}</strong>
            <small>#${escapeHtml(war.warId)}</small>
          </div>
          <span role="cell">${formatNumber(war.hits)}</span>
          <span role="cell">${formatNumber(war.assists)}</span>
          <span role="cell">${formatNumber(war.outsideHits)}</span>
          <span role="cell" class="intel2-war-net">${formatSignedLocal(war.netScore)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

async function refreshSyncStatus() {
  try {
    const result = await syncApi('getSyncStatus');
    syncJob = result.job || null;
  } catch (_) {
    syncJob = null;
  }
  renderSync();

  if (shouldRunAutomaticSync(syncJob)) {
    queueMicrotask(() => runSync());
  }
}

function shouldRunAutomaticSync(job) {
  if (syncing) return false;
  if (job && ['queued','running'].includes(job.status)) return true;

  const lastAt = Number(job?.finishedAt || job?.updatedAt || 0);
  if (!lastAt) return true;
  return Math.floor(Date.now() / 1000) - lastAt >= AUTO_SYNC_INTERVAL_SECONDS;
}

async function runSync() {
  if (syncing) return;
  syncing = true;

  try {
    const started = await syncApi('startSync');
    syncJob = started.job || null;
    renderSync();

    let safety = 0;
    while (syncJob && !['completed','failed'].includes(syncJob.status) && safety < 500) {
      const result = await syncApi('syncStep', { jobId:syncJob.jobId });
      syncJob = result.job || syncJob;
      renderSync();

      if (syncJob.status === 'failed') {
        throw new Error(syncJob.error || 'Faction sync failed.');
      }

      if (!['completed','failed'].includes(syncJob.status)) {
        await sleep(result.busy ? 1200 : 300);
      }
      safety += 1;
    }

    if (safety >= 500) throw new Error('Faction sync exceeded the safety limit.');

    emit('request-refresh', { source:'sync' });
  } catch (error) {
    syncJob = { status:'failed', error:error.message || 'Faction sync failed.' };
    renderSync();
  } finally {
    syncing = false;
  }
}

function renderSync() {
  const element = document.querySelector('#syncLine');
  if (!element) return;

  if (!syncJob || syncJob.status === 'completed') {
    element.classList.add('hidden');
    element.textContent = '';
    return;
  }

  element.classList.remove('hidden');
  element.classList.toggle('error', syncJob.status === 'failed');

  if (syncJob.status === 'failed') {
    element.textContent = syncJob.error || 'Faction sync failed.';
    return;
  }

  const done = Number(syncJob.tasksCompleted || 0);
  const total = Number(syncJob.tasksTotal || 0);
  const phase = syncJob.phase || syncJob.status || 'syncing';
  element.textContent = total > 0
    ? `Syncing faction · ${phase} · ${done}/${total}`
    : `Syncing faction · ${phase}`;
}

function setIntelStatus(message, error = false) {
  const element = document.querySelector('#syncLine');
  if (!element || syncJob) return;
  element.textContent = message || '';
  element.classList.toggle('hidden', !message);
  element.classList.toggle('error', error);
}

function battleStatsTrend(member) {
  if (member.battleStats?.value == null) return 'No estimate';
  if (!member.battleStats?.trendReliable) {
    return member.battleStats?.source ? String(member.battleStats.source) : 'No comparison';
  }
  return trendLabel(member.battleStats.changePct30d, '30d');
}

function trendLabel(value, suffix) {
  const number = nullable(value);
  if (number === null) return 'No comparison';
  const pct = Math.round(number * 100);
  return `${pct > 0 ? '+' : ''}${pct}% ${suffix}`;
}

function trendClass(value) {
  const number = nullable(value);
  if (number === null || Math.abs(number) < 0.1) return '';
  return number > 0 ? 'up' : 'down';
}

function signedPct(value) {
  const number = nullable(value);
  if (number === null) return '—';
  const pct = Math.round(number * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

function formatSignedLocal(value) {
  const number = nullable(value);
  if (number === null) return '—';
  const formatted = formatDecimal(number, 2);
  return number > 0 ? `+${formatted}` : formatted;
}

function hasNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function nullable(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function monthlyOcs(ocs) {
  const stored = nullable(ocs?.perMonth);
  if (stored !== null) return stored;
  const legacyPerDay = nullable(ocs?.perDay);
  return legacyPerDay === null ? null : legacyPerDay * MONTH_DAYS;
}

function detailKey(playerId) {
  const factionId = Number(state.selectedFactionId || state.user?.factionId || 0);
  return `${factionId}:${playerId}`;
}

function resetIntelState() {
  overview = null;
  loadedFactionId = null;
  pendingReload = false;
  autoTagSettings = null;
  loadedAutoTagFactionId = null;
  loadedAnalysisKey = '';
  selectedMemberId = null;
  detailCache.clear();
  detailLoading.clear();
  noteEditing.clear();
  noteDrafts.clear();
  noteSaving.clear();
  noteErrors.clear();
  syncJob = null;
  activeFilters.clear();
  intelFilterMenuOpen = false;
  trendDays = 90;
  trendMetric = 'activity';

  timelineRange = { from:null, to:null };
  timelinePresetSelection = restoreTimelinePresetSelection();
  draftTimelineRange = null;
  selectedWarIds = new Set();
  draftWarIds = new Set();
  calendarCursor = null;
  calendarAnchor = null;
  filterPanelOpen = false;

  compareOpen = false;
  compareMemberIds.clear();
  compareMetric = 'activity';
  compareIncludeAverage = true;
  compareData = null;
  compareLoading = false;
  compareError = '';
  compareLoadedKey = '';

  factionPerformance.members.clear();
  factionPerformance.totalWars = 0;
  factionPerformance.playersWithAttackDetails = 0;
  factionPerformance.loadedKey = '';
  factionPerformance.loading = false;
  factionPerformance.error = '';

  const search = document.querySelector('#intelSearch');
  if (search) search.value = '';

  tagManageMode = false;
  selectedTagMemberIds.clear();
  tagDraft = '';
  tagBulkBusy = false;
  tagBulkStatus = '';

  updateFactionTitle();
  renderFilters();
  renderFactionControls();
  renderTagToolbar();
  renderSync();
}
