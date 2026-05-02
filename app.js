const state = {
  activeTab: "dashboard",
  sortBy: "ImpactScore",
  sortDirection: "DESC"
};

const loginPage = document.getElementById("loginPage");
const appPage = document.getElementById("appPage");

const authLoginModeButton = document.getElementById("authLoginModeButton");
const authRegisterModeButton = document.getElementById("authRegisterModeButton");

const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const loginError = document.getElementById("loginError");

const loginPlayerIdInput = document.getElementById("loginPlayerIdInput");
const loginPasswordInput = document.getElementById("loginPasswordInput");

const registerApiKeyInput = document.getElementById("registerApiKeyInput");
const registerPasswordInput = document.getElementById("registerPasswordInput");
const registerPasswordConfirmInput = document.getElementById("registerPasswordConfirmInput");

const logoutButton = document.getElementById("logoutButton");
const testApiButton = document.getElementById("testApiButton");

const navButtons = document.querySelectorAll(".nav-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

const graphPanel = document.getElementById("graphPanel");
const graphBody = document.getElementById("graphBody");
const graphCollapseButton = document.getElementById("graphCollapseButton");

const refreshDashboardButton = document.getElementById("refreshDashboardButton");

const fromWarSelect = document.getElementById("fromWar");
const toWarSelect = document.getElementById("toWar");
const termedFilterSelect = document.getElementById("termedFilter");
const memberFilterSelect = document.getElementById("memberFilter");
const memberSearchInput = document.getElementById("memberSearch");

const dashboardTableBody = document.getElementById("dashboardTableBody");

const summaryMembers = document.getElementById("summaryMembers");
const summaryHits = document.getElementById("summaryHits");
const summaryAvgRespect = document.getElementById("summaryAvgRespect");
const summaryNetScore = document.getElementById("summaryNetScore");

const importForm = document.getElementById("importForm");
const rankIdInput = document.getElementById("rankIdInput");
const importStatus = document.getElementById("importStatus");

const importProgressPanel = document.getElementById("importProgressPanel");
const importProgressStage = document.getElementById("importProgressStage");
const importProgressCount = document.getElementById("importProgressCount");
const importProgressBarFill = document.getElementById("importProgressBarFill");
const importProgressCurrentWar = document.getElementById("importProgressCurrentWar");
const importProgressCurrentStatus = document.getElementById("importProgressCurrentStatus");
const importProgressList = document.getElementById("importProgressList");

const importAddedCount = document.getElementById("importAddedCount");
const importAddedList = document.getElementById("importAddedList");

init();

function init() {
  setupAuthSwitch();
  setupAuthForms();
  setupTabs();
  setupGraphCollapse();
  setupBackendTest();
  setupDashboard();
  setupImport();
  restoreSession();
}

/* =========================
   API
========================= */

async function api(action, payload = {}) {
  const response = await fetch("/api", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action,
      ...payload
    })
  });

  const text = await response.text();

  if (!text) {
    throw new Error(
      `Server returned an empty response. HTTP status: ${response.status}.`
    );
  }

  let result;

  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(
      `Server returned invalid JSON. HTTP status: ${response.status}. Response: ${text}`
    );
  }

  if (!response.ok || !result.success) {
    throw new Error(result.message || "Request failed.");
  }

  return result;
}

async function restoreSession() {
  try {
    const result = await api("me");

    showApp(result.user);

    setApiStatus(
      "pending",
      "?",
      "Not checked",
      "API key status has not been checked this session."
    );
  } catch {
    // No active session. Stay on login page.
  }
}

/* =========================
   AUTH UI
========================= */

function setupAuthSwitch() {
  if (!authLoginModeButton || !authRegisterModeButton) return;

  authLoginModeButton.addEventListener("click", () => {
    authLoginModeButton.classList.add("active");
    authRegisterModeButton.classList.remove("active");

    loginForm.classList.remove("hidden");
    registerForm.classList.add("hidden");

    hideLoginMessage();
  });

  authRegisterModeButton.addEventListener("click", () => {
    authRegisterModeButton.classList.add("active");
    authLoginModeButton.classList.remove("active");

    registerForm.classList.remove("hidden");
    loginForm.classList.add("hidden");

    hideLoginMessage();
  });
}

function setupAuthForms() {
  if (loginForm) {
    loginForm.addEventListener("submit", async event => {
      event.preventDefault();

      hideLoginMessage();

      const playerId = loginPlayerIdInput.value.trim();
      const password = loginPasswordInput.value;

      if (!playerId) {
        showLoginError("Missing Torn player ID.");
        return;
      }

      if (!password) {
        showLoginError("Missing password.");
        return;
      }

      const submitButton = loginForm.querySelector("button[type='submit']");
      const originalButtonText = submitButton.textContent;

      submitButton.disabled = true;
      submitButton.textContent = "Logging in...";

      try {
        const result = await api("login", {
          playerId,
          password
        });

        showApp(result.user);

        setApiStatus(
          "pending",
          "?",
          "Not checked",
          "API key status has not been checked this session."
        );
      } catch (error) {
        showLoginError(error.message);
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText;
      }
    });
  }

  if (registerForm) {
    registerForm.addEventListener("submit", async event => {
      event.preventDefault();

      hideLoginMessage();

      const apiKey = registerApiKeyInput.value.trim();
      const password = registerPasswordInput.value;
      const confirmPassword = registerPasswordConfirmInput.value;

      if (!apiKey) {
        showLoginError("Missing Torn API key.");
        return;
      }

      if (!password || password.length < 8) {
        showLoginError("Password must be at least 8 characters.");
        return;
      }

      if (password !== confirmPassword) {
        showLoginError("Passwords do not match.");
        return;
      }

      const submitButton = registerForm.querySelector("button[type='submit']");
      const originalButtonText = submitButton.textContent;

      submitButton.disabled = true;
      submitButton.textContent = "Creating account...";

      try {
        const result = await api("register", {
          apiKey,
          password,
          confirmPassword
        });

        showApp(result.user);

        setApiStatus(
          "valid",
          "✓",
          "API key stored",
          "Your Torn API key was verified and stored encrypted."
        );

        registerApiKeyInput.value = "";
        registerPasswordInput.value = "";
        registerPasswordConfirmInput.value = "";
      } catch (error) {
        showLoginError(error.message);
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText;
      }
    });
  }

  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      try {
        await api("logout");
      } catch {
        // Ignore logout API errors on the frontend.
      }

      appPage.classList.add("hidden");
      loginPage.classList.remove("hidden");

      loginPasswordInput.value = "";
      registerPasswordInput.value = "";
      registerPasswordConfirmInput.value = "";

      renderDashboard([], {
        membersShown: 0,
        totalHits: 0,
        avgRespect: 0,
        totalNetScore: 0
      });
    });
  }
}

function showApp(user) {
  loginPage.classList.add("hidden");
  appPage.classList.remove("hidden");

  document.getElementById("userChip").textContent =
    `${user.playerName} [${user.playerId}]`;

  document.getElementById("settingsUser").value =
    `${user.playerName} [${user.playerId}]`;

  document.getElementById("settingsFaction").value =
    user.factionName || "No faction";

  document.getElementById("dashboardFactionName").textContent =
    user.factionName ? `${user.factionName} Dashboard` : "Faction Dashboard";

  const adminBadge = document.getElementById("adminBadge");

  if (user.isAdmin) {
    adminBadge.classList.remove("hidden");
  } else {
    adminBadge.classList.add("hidden");
  }

  loadDashboardData();
  loadImportedWars();
}

function showLoginError(message) {
  loginError.textContent = message;
  loginError.className = "form-message error";
}

function hideLoginMessage() {
  loginError.textContent = "";
  loginError.className = "form-message error hidden";
}

/* =========================
   TABS
========================= */

function setupTabs() {
  navButtons.forEach(button => {
    button.addEventListener("click", () => {
      setActiveTab(button.dataset.tab);
    });
  });
}

function setActiveTab(tabName) {
  state.activeTab = tabName;
  document.body.dataset.activeTab = tabName;

  navButtons.forEach(button => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });

  tabPanels.forEach(panel => {
    panel.classList.remove("active");
  });

  const activePanel = document.getElementById(`${tabName}Tab`);

  if (activePanel) {
    activePanel.classList.add("active");
  }
}

/* =========================
   GRAPH
========================= */

function setupGraphCollapse() {
  if (!graphCollapseButton || !graphPanel || !graphBody) return;

  graphCollapseButton.addEventListener("click", () => {
    const isCollapsed = graphPanel.classList.toggle("collapsed");

    graphBody.classList.toggle("hidden", isCollapsed);
    graphCollapseButton.textContent = isCollapsed ? "▾" : "▴";
    graphCollapseButton.setAttribute("aria-expanded", String(!isCollapsed));
    graphCollapseButton.title = isCollapsed ? "Expand graph" : "Collapse graph";
  });
}

/* =========================
   DASHBOARD
========================= */

function setupDashboard() {
  if (refreshDashboardButton) {
    refreshDashboardButton.addEventListener("click", () => {
      loadDashboardData();
    });
  }

  if (termedFilterSelect) {
    termedFilterSelect.addEventListener("change", () => {
      loadDashboardData();
    });
  }

  if (memberFilterSelect) {
    memberFilterSelect.addEventListener("change", () => {
      loadDashboardData();
    });
  }

  if (memberSearchInput) {
    memberSearchInput.addEventListener("input", debounce(() => {
      loadDashboardData();
    }, 250));
  }

  document.querySelectorAll("th[data-sort]").forEach(header => {
    header.addEventListener("click", () => {
      const sortKey = header.dataset.sort;

      if (state.sortBy === sortKey) {
        state.sortDirection = state.sortDirection === "ASC" ? "DESC" : "ASC";
      } else {
        state.sortBy = sortKey;
        state.sortDirection = "DESC";
      }

      loadDashboardData();
    });
  });
}

async function loadDashboardData() {
  if (!dashboardTableBody) return;

  try {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="11" class="empty-table">Loading dashboard...</td>
      </tr>
    `;

    const result = await api("getDashboardData", {
      filters: {
        fromWar: fromWarSelect ? fromWarSelect.value : "ALL",
        toWar: toWarSelect ? toWarSelect.value : "ALL",
        termedFilter: termedFilterSelect ? termedFilterSelect.value : "ALL",
        memberFilter: memberFilterSelect ? memberFilterSelect.value : "ALL",
        search: memberSearchInput ? memberSearchInput.value : ""
      },
      sortBy: state.sortBy,
      sortDirection: state.sortDirection
    });

    renderDashboard(result.rows || [], result.summary || {});
  } catch (error) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="11" class="empty-table">${escapeHtml(error.message)}</td>
      </tr>
    `;

    renderDashboardSummary({
      membersShown: 0,
      totalHits: 0,
      avgRespect: 0,
      totalNetScore: 0
    });
  }
}

function renderDashboard(rows, summary) {
  renderDashboardSummary(summary);

  if (!dashboardTableBody) return;

  if (!rows.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="11" class="empty-table">No dashboard data found.</td>
      </tr>
    `;
    return;
  }

  dashboardTableBody.innerHTML = rows
    .map(row => {
      const memberUrl = `https://www.torn.com/profiles.php?XID=${encodeURIComponent(row["Player_ID"])}`;
      const statusClass = row["Is Member"] === "ACTIVE" ? "active" : "left";

      return `
        <tr>
          <td>
            <a class="member-link" href="${memberUrl}" target="_blank" rel="noopener noreferrer">
              ${escapeHtml(row["Members"])} [${escapeHtml(row["Player_ID"])}]
            </a>
          </td>
          <td>
            <span class="status-pill ${statusClass}">
              ${escapeHtml(row["Is Member"])}
            </span>
          </td>
          <td>${formatNumber(row["Wars"])}</td>
          <td>${formatNumber(row["Hits"])}</td>
          <td>${formatNumber(row["Outside Hits"])}</td>
          <td>${formatNumber(row["Assists"])}</td>
          <td>${formatNumber(row["Sum Score up"], 2)}</td>
          <td>${formatNumber(row["Sum Score down"], 2)}</td>
          <td>${formatNumber(row["Net Score"], 2)}</td>
          <td>${formatNumber(row["ImpactScore"], 2)}</td>
          <td>${formatNumber(row["Avg R/hit"], 2)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderDashboardSummary(summary) {
  if (summaryMembers) {
    summaryMembers.textContent = formatNumber(summary.membersShown || 0);
  }

  if (summaryHits) {
    summaryHits.textContent = formatNumber(summary.totalHits || 0);
  }

  if (summaryAvgRespect) {
    summaryAvgRespect.textContent = formatNumber(summary.avgRespect || 0, 2);
  }

  if (summaryNetScore) {
    summaryNetScore.textContent = formatNumber(summary.totalNetScore || 0, 2);
  }
}

/* =========================
   IMPORT
========================= */

function setupImport() {
  if (!importForm) return;

  importForm.addEventListener("submit", async event => {
    event.preventDefault();

    const rankIds = parseRankIds(rankIdInput.value);

    if (!rankIds.length) {
      showImportStatus("error", "Enter at least one ranked war report ID.");
      return;
    }

    if (importProgressPanel) {
      importProgressPanel.classList.remove("hidden");
    }

    if (importProgressList) {
      importProgressList.innerHTML = "";
    }

    updateImportProgress(0, rankIds.length, "Starting import.", "-", "-");

    let successCount = 0;
    let failedCount = 0;

    const submitButton = importForm.querySelector("button[type='submit']");
    const originalButtonText = submitButton.textContent;

    submitButton.disabled = true;
    submitButton.textContent = "Importing...";

    for (let index = 0; index < rankIds.length; index += 1) {
      const rankId = rankIds[index];

      updateImportProgress(
        index,
        rankIds.length,
        "Importing ranked war reports.",
        rankId,
        "Importing..."
      );

      addImportProgressRow(rankId, "active", "Importing", "Fetching report from Torn.");

      try {
        const result = await api("importRankedWarReport", {
          rankId
        });

        successCount += 1;

        updateImportProgressRow(
          rankId,
          "success",
          "Imported",
          result.message || "Import successful."
        );
      } catch (error) {
        failedCount += 1;

        updateImportProgressRow(
          rankId,
          "failed",
          "Failed",
          error.message
        );
      }

      updateImportProgress(
        index + 1,
        rankIds.length,
        "Importing ranked war reports.",
        rankId,
        "Done"
      );
    }

    submitButton.disabled = false;
    submitButton.textContent = originalButtonText;

    showImportStatus(
      failedCount ? "error" : "success",
      `Import finished. Successful: ${successCount}. Failed: ${failedCount}.`
    );

    rankIdInput.value = "";

    await loadImportedWars();
    await loadDashboardData();
  });
}

function parseRankIds(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map(id => id.trim())
    .filter(Boolean);
}

function updateImportProgress(done, total, stage, currentWar, currentStatus) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  if (importProgressStage) {
    importProgressStage.textContent = stage;
  }

  if (importProgressCount) {
    importProgressCount.textContent = `${done} / ${total}`;
  }

  if (importProgressBarFill) {
    importProgressBarFill.style.width = `${percent}%`;
  }

  if (importProgressCurrentWar) {
    importProgressCurrentWar.textContent = currentWar || "-";
  }

  if (importProgressCurrentStatus) {
    importProgressCurrentStatus.textContent = currentStatus || "-";
  }
}

function addImportProgressRow(rankId, stateName, status, message) {
  if (!importProgressList) return;

  const row = document.createElement("div");

  row.className = `import-progress-row is-${stateName}`;
  row.dataset.rankId = rankId;

  row.innerHTML = `
    <span class="import-progress-war">${escapeHtml(rankId)}</span>
    <span class="import-progress-state">${escapeHtml(status)}</span>
    <span class="import-progress-message">${escapeHtml(message)}</span>
    <span></span>
  `;

  importProgressList.appendChild(row);
}

function updateImportProgressRow(rankId, stateName, status, message) {
  if (!importProgressList) return;

  const row = importProgressList.querySelector(`[data-rank-id="${cssEscape(rankId)}"]`);

  if (!row) {
    addImportProgressRow(rankId, stateName, status, message);
    return;
  }

  row.className = `import-progress-row is-${stateName}`;

  row.innerHTML = `
    <span class="import-progress-war">${escapeHtml(rankId)}</span>
    <span class="import-progress-state">${escapeHtml(status)}</span>
    <span class="import-progress-message">${escapeHtml(message)}</span>
    <span></span>
  `;
}

async function loadImportedWars() {
  if (!importAddedList || !importAddedCount) return;

  try {
    const result = await api("getImportedWars");
    renderImportedWars(result.wars || []);
  } catch (error) {
    importAddedCount.textContent = "0";
    importAddedList.innerHTML = `
      <div class="empty-state">${escapeHtml(error.message)}</div>
    `;
  }
}

function renderImportedWars(wars) {
  if (!importAddedList || !importAddedCount) return;

  importAddedCount.textContent = String(wars.length);

  if (!wars.length) {
    importAddedList.innerHTML = `
      <div class="empty-state">No imported reports found.</div>
    `;
    return;
  }

  importAddedList.innerHTML = wars
    .map(war => {
      const opponent = war.opponent_faction_name || "Unknown opponent";
      const reportId = war.report_id || war.war_id;

      return `
        <div class="import-added-item">
          <div class="import-added-item-header">
            <span class="import-added-war">${escapeHtml(reportId)}</span>
            <span class="import-added-badge imported">Imported</span>
          </div>

          <div class="import-added-opponent">
            ${escapeHtml(opponent)}
          </div>

          <div class="import-added-id">
            War ID: ${escapeHtml(war.war_id)}
          </div>

          <div class="import-added-message">
            Imported at ${formatUnixTimestamp(war.imported_at)}
          </div>
        </div>
      `;
    })
    .join("");
}

function showImportStatus(type, message) {
  if (!importStatus) return;

  importStatus.textContent = message;
  importStatus.className = `form-message ${type}`;
}

function formatUnixTimestamp(timestamp) {
  const number = Number(timestamp || 0);

  if (!number) {
    return "-";
  }

  return new Date(number * 1000).toLocaleString();
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(String(value));
  }

  return String(value).replaceAll('"', '\\"');
}

/* =========================
   BACKEND TEST
========================= */

function setupBackendTest() {
  if (!testApiButton) return;

  testApiButton.addEventListener("click", async () => {
    try {
      setApiStatus(
        "pending",
        "?",
        "Checking...",
        "Testing backend and database connection."
      );

      const result = await api("dbTest");

      setApiStatus(
        "valid",
        "✓",
        "Connected",
        result.message
      );
    } catch (error) {
      setApiStatus(
        "invalid",
        "✕",
        "Connection failed",
        error.message
      );
    }
  });
}

function setApiStatus(status, icon, title, text) {
  const box = document.getElementById("apiKeyStatusBox");
  const iconEl = document.getElementById("apiKeyStatusIcon");
  const titleEl = document.getElementById("apiKeyStatusTitle");
  const textEl = document.getElementById("apiKeyStatusText");

  if (!box || !iconEl || !titleEl || !textEl) return;

  box.className = `api-status-box ${status}`;
  iconEl.textContent = icon;
  titleEl.textContent = title;
  textEl.textContent = text;
}

/* =========================
   FORMAT HELPERS
========================= */

function formatNumber(value, decimals = 0) {
  const number = Number(value || 0);

  return number.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function debounce(callback, delay = 250) {
  let timeoutId;

  return (...args) => {
    clearTimeout(timeoutId);

    timeoutId = setTimeout(() => {
      callback(...args);
    }, delay);
  };
}
