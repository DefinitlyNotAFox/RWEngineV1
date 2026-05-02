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

init();

function init() {
  setupAuthSwitch();
  setupAuthForms();
  setupTabs();
  setupGraphCollapse();
  setupBackendTest();
  setupDashboard();
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

  let result;

  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("Server returned invalid JSON: " + text);
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
  });
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
    memberSearchInput.addEventListener("input", () => {
      loadDashboardData();
    });
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
  summaryMembers.textContent = formatNumber(summary.membersShown || 0);
  summaryHits.textContent = formatNumber(summary.totalHits || 0);
  summaryAvgRespect.textContent = formatNumber(summary.avgRespect || 0, 2);
  summaryNetScore.textContent = formatNumber(summary.totalNetScore || 0, 2);
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
