const ATTACK_STEP_DELAY_MS = 6000;
const WAR_IMPORT_COOLDOWN_MS = 30000;

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

const refreshCurrentWarButton = document.getElementById("refreshCurrentWarButton");
const currentWarTableBody = document.getElementById("currentWarTableBody");

init();

function init() {
  setupCurrentWar();
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
  state.dashboardRows = rows || [];
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
   CURRENT WAR / MATCHUP
========================= */

let matchupChart = null;

function setupCurrentWar() {
  if (!refreshCurrentWarButton) return;

  refreshCurrentWarButton.addEventListener("click", () => {
    loadCurrentWarIntel();
  });
}

async function loadCurrentWarIntel() {
  if (!currentWarTableBody) return;

  setMatchupLoadingState("Loading matchup overview...");

  try {
    const result = await api("getOpponentThreatList");

    let dashboardRows = state.dashboardRows || [];

    try {
      const dashboardResult = await api("getDashboardData", {
        filters: {
          fromWar: "ALL",
          toWar: "ALL",
          termedFilter: "ALL",
          memberFilter: "ACTIVE",
          search: ""
        },
        sortBy: "ImpactScore",
        sortDirection: "DESC"
      });

      dashboardRows = dashboardResult.rows || dashboardRows;
    } catch {
      // Keep the matchup page usable even if the dashboard query fails.
    }

    hydrateMatchupResult(result, dashboardRows);
    renderMatchupOverview(result);
  } catch (error) {
    setMatchupLoadingState(error.message, true);
  }
}

function setMatchupLoadingState(message, isError = false) {
  const status = document.getElementById("matchupStatusText");

  if (status) {
    status.textContent = message;
    status.classList.toggle("error", Boolean(isError));
  }

  if (currentWarTableBody) {
    currentWarTableBody.innerHTML = `
      <tr>
        <td colspan="9" class="empty-table">${escapeHtml(message)}</td>
      </tr>
    `;
  }
}


function hydrateMatchupResult(result, dashboardRows) {
  const war = result.war || {};
  const opponentRows = result.rows || [];
  const reportIds = result.reportIds || [];

  if (!result.ownFaction) {
    result.ownFaction = buildOwnFactionFromDashboard(war, dashboardRows || []);
  }

  if (!result.opponentFaction) {
    result.opponentFaction = buildOpponentFactionFromRows(war, opponentRows, reportIds);
  }

  if (!result.winChance) {
    result.winChance = calculateClientWinChance(result.ownFaction, result.opponentFaction);
  }

  if (!result.projection) {
    result.projection = buildClientProjection(war, result.winChance);
  }
}

function buildOwnFactionFromDashboard(war, dashboardRows) {
  const rows = dashboardRows || [];
  const activeRows = rows.filter(row => row["Is Member"] === "ACTIVE");
  const sourceRows = activeRows.length ? activeRows : rows;

  const activeMembers = sourceRows.length;
  const historicalHits = sourceRows.reduce((sum, row) => sum + Number(row["Hits"] || 0), 0);
  const historicalScore = sourceRows.reduce((sum, row) => sum + Number(row["Sum Score up"] || 0), 0);
  const avgScorePerHit = historicalHits > 0 ? historicalScore / historicalHits : 0;
  const topPlayerScore = sourceRows.reduce((max, row) => Math.max(max, Number(row["Sum Score up"] || 0)), 0);

  const topPlayers = [...sourceRows]
    .sort((a, b) => Number(b["ImpactScore"] || 0) - Number(a["ImpactScore"] || 0))
    .slice(0, 5)
    .map(row => ({
      playerId: row["Player_ID"],
      playerName: row["Members"],
      score: Number(row["Sum Score up"] || 0),
      hits: Number(row["Hits"] || 0),
      position: ""
    }));

  return {
    factionId: war.ownFactionId,
    factionName: war.ownFactionName || "Your faction",
    activeMembers,
    avgLevel: 0,
    historicalHits,
    historicalScore,
    avgScorePerHit,
    topPlayerScore,
    topPlayers
  };
}

function buildOpponentFactionFromRows(war, rows, reportIds) {
  const activeMembers = rows.length;
  const historicalHits = rows.reduce((sum, row) => sum + Number(row.hits || 0), 0);
  const historicalScore = rows.reduce((sum, row) => sum + Number(row.score || 0), 0);
  const avgLevel = activeMembers > 0
    ? rows.reduce((sum, row) => sum + Number(row.level || 0), 0) / activeMembers
    : 0;
  const avgScorePerHit = historicalHits > 0 ? historicalScore / historicalHits : 0;
  const topPlayerScore = rows.reduce((max, row) => Math.max(max, Number(row.score || 0)), 0);

  return {
    factionId: war.opponentFactionId,
    factionName: war.opponentFactionName || "Opponent",
    activeMembers,
    avgLevel,
    historicalHits,
    historicalScore,
    avgScorePerHit,
    topPlayerScore,
    reports: (reportIds || []).length,
    topPlayers: rows.slice(0, 5)
  };
}

function calculateClientWinChance(ownFaction, opponentFaction) {
  const ownStrength = calculateClientFactionStrength(ownFaction);
  const opponentStrength = calculateClientFactionStrength(opponentFaction);
  const total = ownStrength + opponentStrength;

  let own = total > 0 ? Math.round((ownStrength / total) * 100) : 50;
  own = Math.max(5, Math.min(95, own));

  const gap = Math.abs(own - 50);

  return {
    own,
    opponent: 100 - own,
    confidence: gap >= 25 ? "High" : gap >= 12 ? "Medium" : "Low"
  };
}

function calculateClientFactionStrength(faction) {
  const members = Number(faction.activeMembers || 0);
  const hits = Number(faction.historicalHits || 0);
  const score = Number(faction.historicalScore || 0);
  const avgLevel = Number(faction.avgLevel || 0);
  const avgScorePerHit = Number(faction.avgScorePerHit || 0);
  const topPlayerScore = Number(faction.topPlayerScore || 0);

  return (
    members * 30 +
    Math.sqrt(Math.max(0, hits)) * 45 +
    Math.sqrt(Math.max(0, score)) * 35 +
    avgLevel * 12 +
    avgScorePerHit * 180 +
    Math.sqrt(Math.max(0, topPlayerScore)) * 30
  );
}

function buildClientProjection(war, winChance) {
  const target = Number(war.target || 2400) || 2400;
  const ownFinish = Math.round(target * (0.82 + Number(winChance.own || 50) / 125));
  const opponentFinish = Math.round(target * (0.82 + Number(winChance.opponent || 50) / 125));

  return [
    { stage: "Start", own: 0, opponent: 0 },
    { stage: "25%", own: Math.round(ownFinish * 0.24), opponent: Math.round(opponentFinish * 0.24) },
    { stage: "50%", own: Math.round(ownFinish * 0.50), opponent: Math.round(opponentFinish * 0.50) },
    { stage: "75%", own: Math.round(ownFinish * 0.77), opponent: Math.round(opponentFinish * 0.77) },
    { stage: "Finish", own: ownFinish, opponent: opponentFinish }
  ];
}

function renderMatchupOverview(result) {
  const war = result.war || null;
  const ownFaction = result.ownFaction || null;
  const opponentFaction = result.opponentFaction || null;
  const winChance = result.winChance || { own: 50, opponent: 50, confidence: "Low" };
  const projection = result.projection || [];
  const rows = result.rows || [];

  if (!war || !ownFaction || !opponentFaction) {
    setMatchupLoadingState("No matchup data found.");
    return;
  }

  setText("matchupStatusText", result.message || "Matchup overview loaded.");
  setText("matchupWarId", `Ranked War #${war.warId || "-"}`);
  setText("matchupStatusBadge", war.isActive ? "ONGOING" : "UPCOMING");
  setText("matchupOwnName", ownFaction.factionName || "Your faction");
  setText("matchupOpponentName", opponentFaction.factionName || "Opponent");
  setText("matchupOwnTag", `[${shortFactionTag(ownFaction.factionName)}]`);
  setText("matchupOpponentTag", `[${shortFactionTag(opponentFaction.factionName)}]`);

  setText("matchupOwnMembers", formatNumber(ownFaction.activeMembers || 0));
  setText("matchupOpponentMembers", formatNumber(opponentFaction.activeMembers || 0));
  setText("matchupOwnAvgLevel", formatNumber(ownFaction.avgLevel || 0, 1));
  setText("matchupOpponentAvgLevel", formatNumber(opponentFaction.avgLevel || 0, 1));
  setText("matchupOwnRank", "#?");
  setText("matchupOpponentRank", "#?");

  setText("matchupOwnChance", `${formatNumber(winChance.own || 0)}%`);
  setText("matchupOpponentChance", `${formatNumber(winChance.opponent || 0)}%`);
  setText("matchupConfidence", `Confidence: ${winChance.confidence || "Low"}`);

  const ownBar = document.getElementById("matchupChanceOwnBar");
  const opponentBar = document.getElementById("matchupChanceOpponentBar");

  if (ownBar) {
    ownBar.style.width = `${Math.max(0, Math.min(100, Number(winChance.own || 0)))}%`;
  }

  if (opponentBar) {
    opponentBar.style.width = `${Math.max(0, Math.min(100, Number(winChance.opponent || 0)))}%`;
  }

  const hero = document.getElementById("matchupHero");

  if (hero) {
    hero.style.setProperty("--own-share", `${Math.max(10, Math.min(90, Number(winChance.own || 50)))}%`);
  }

  renderTopPlayers("topAssetsList", ownFaction.topPlayers || [], "own");
  renderTopPlayers("topThreatsList", opponentFaction.topPlayers || [], "opponent");
  renderTeamComparison(ownFaction, opponentFaction);
  renderWarInformation(war, result.reportIds || []);
  renderProjectionChart(projection, ownFaction.factionName, opponentFaction.factionName);
  renderCurrentWarIntel(rows, war);
}

function renderTopPlayers(elementId, players, side) {
  const element = document.getElementById(elementId);
  if (!element) return;

  if (!players.length) {
    element.innerHTML = `<div class="mini-empty">No player data.</div>`;
    return;
  }

  element.innerHTML = players.slice(0, 5).map((player, index) => {
    const memberUrl = `https://www.torn.com/profiles.php?XID=${encodeURIComponent(player.playerId)}`;
    const symbol = getFactionRoleSymbol(player.position);

    return `
      <a class="star-player ${side}" href="${memberUrl}" target="_blank" rel="noopener noreferrer">
        <span class="star-rank">${index + 1}</span>
        <span class="star-name">${symbol}${escapeHtml(player.playerName)}</span>
        <strong>${formatNumber(player.score || 0, 0)}</strong>
      </a>
    `;
  }).join("");
}

function renderTeamComparison(ownFaction, opponentFaction) {
  const body = document.getElementById("teamComparisonBody");
  if (!body) return;

  const rows = [
    ["Active Members", ownFaction.activeMembers, opponentFaction.activeMembers, 0],
    ["Average Level", ownFaction.avgLevel, opponentFaction.avgLevel, 1],
    ["Historical Hits", ownFaction.historicalHits, opponentFaction.historicalHits, 0],
    ["Historical Score", ownFaction.historicalScore, opponentFaction.historicalScore, 0],
    ["Avg Score / Hit", ownFaction.avgScorePerHit, opponentFaction.avgScorePerHit, 2],
    ["Top Player Score", ownFaction.topPlayerScore, opponentFaction.topPlayerScore, 0]
  ];

  body.innerHTML = rows.map(([label, ownValue, opponentValue, decimals]) => `
    <tr>
      <td class="compare-own">${formatNumber(ownValue || 0, decimals)}</td>
      <td class="compare-label">${escapeHtml(label)}</td>
      <td class="compare-opponent">${formatNumber(opponentValue || 0, decimals)}</td>
    </tr>
  `).join("");
}

function renderWarInformation(war, reportIds) {
  const body = document.getElementById("warInfoBody");
  if (!body) return;

  const rows = [
    ["War ID", war.warId || "-"],
    ["Status", war.isActive ? "Ongoing" : "Upcoming"],
    ["Target", formatNumber(war.target || 0)],
    ["Own Score", formatNumber(war.ownScore || 0)],
    ["Opponent Score", formatNumber(war.opponentScore || 0)],
    ["Historical Reports", formatNumber((reportIds || []).length)],
    ["Starts", war.startTimestamp ? formatUnixTimestamp(war.startTimestamp) : "-"]
  ];

  body.innerHTML = rows.map(([label, value]) => `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td>${escapeHtml(value)}</td>
    </tr>
  `).join("");
}

function renderProjectionChart(projection, ownName, opponentName) {
  const canvas = document.getElementById("matchupProjectionChart");
  if (!canvas || typeof Chart === "undefined") return;

  if (matchupChart) {
    matchupChart.destroy();
  }

  matchupChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: projection.map(point => point.stage),
      datasets: [
        {
          label: ownName || "Your faction",
          data: projection.map(point => point.own),
          tension: 0.35,
          borderColor: "#b83a3a",
          backgroundColor: "rgba(184,58,58,0.12)",
          borderWidth: 2,
          pointRadius: 3
        },
        {
          label: opponentName || "Opponent",
          data: projection.map(point => point.opponent),
          tension: 0.35,
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59,130,246,0.12)",
          borderWidth: 2,
          pointRadius: 3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#d7d7d7",
            boxWidth: 12
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#a5a5a5" },
          grid: { color: "rgba(255,255,255,0.06)" }
        },
        y: {
          ticks: { color: "#a5a5a5" },
          grid: { color: "rgba(255,255,255,0.06)" }
        }
      }
    }
  });
}

function renderCurrentWarIntel(rows, war) {
  if (!currentWarTableBody) return;

  if (!rows.length) {
    currentWarTableBody.innerHTML = `
      <tr>
        <td colspan="9" class="empty-table">
          No opponent roster analysis found.
        </td>
      </tr>
    `;
    return;
  }

  currentWarTableBody.innerHTML = rows
    .map((row, index) => {
      const memberUrl = `https://www.torn.com/profiles.php?XID=${encodeURIComponent(row.playerId)}`;
      const roleSymbol = getFactionRoleSymbol(row.position);

      return `
        <tr>
          <td>${index + 1}</td>
          <td>
            <a class="member-link" href="${memberUrl}" target="_blank" rel="noopener noreferrer">
              ${roleSymbol}${escapeHtml(row.playerName)} [${escapeHtml(row.playerId)}]
            </a>
          </td>
          <td>${row.level ? formatNumber(row.level) : "-"}</td>
          <td>${formatNumber(row.warsSeen || 0)}</td>
          <td>${formatNumber(row.hits || 0)}</td>
          <td>${formatNumber(row.avgHitsPerWar || 0, 2)}</td>
          <td>${formatNumber(row.score || 0, 0)}</td>
          <td>${formatNumber(row.threatScore || 0, 1)}</td>
          <td><span class="threat-pill threat-${slugify(row.tag || "low")}">${escapeHtml(row.tag || "-")}</span></td>
        </tr>
      `;
    })
    .join("");
}

function getFactionRoleSymbol(position) {
  const text = String(position || "").toLowerCase();

  if (text.includes("leader") && !text.includes("co")) {
    return "♛ ";
  }

  if (
    text.includes("co-leader") ||
    text.includes("co leader") ||
    text.includes("coleader")
  ) {
    return "♜ ";
  }

  return "";
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
  }
}

function shortFactionTag(name) {
  return String(name || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 6)
    .toUpperCase() || "TAG";
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
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
    let skippedCount = 0;
    let overwrittenCount = 0;

    const submitButton = importForm.querySelector("button[type='submit']");
    const originalButtonText = submitButton.textContent;

    submitButton.disabled = true;
    submitButton.textContent = "Importing...";

    for (let index = 0; index < rankIds.length; index += 1) {
      const rankId = rankIds[index];
      let usedTornApi = false;

      updateImportProgress(
        index,
        rankIds.length,
        "Checking ranked war report.",
        rankId,
        "Checking..."
      );

      addImportProgressRow(
        rankId,
        "active",
        "Checking",
        "Checking whether this report already exists."
      );

      try {
        const status = await api("checkImportStatus", {
          rankId
        });

        let overwrite = false;

        if (status.exists) {
          overwrite = await askImportDecision(rankId, status.war);

          if (!overwrite) {
            skippedCount += 1;

            updateImportProgressRow(
              rankId,
              "skipped",
              "Skipped",
              "Already imported. Skipped by user."
            );

            updateImportProgress(
              index + 1,
              rankIds.length,
              "Importing ranked war reports.",
              rankId,
              "Skipped"
            );

            continue;
          }

          overwrittenCount += 1;

          updateImportProgressRow(
            rankId,
            "active",
            "Overwrite",
            "Existing report will be overwritten."
          );
        }

        updateImportProgress(
          index,
          rankIds.length,
          "Importing ranked war report.",
          rankId,
          overwrite ? "Overwriting..." : "Importing..."
        );

        const importResult = await api("importRankedWarReport", {
          rankId,
          overwrite
        });

        usedTornApi = true;

        if (importResult.skipped) {
          skippedCount += 1;

          updateImportProgressRow(
            rankId,
            "skipped",
            "Skipped",
            importResult.message || "Already imported. Skipped."
          );

          updateImportProgress(
            index + 1,
            rankIds.length,
            "Importing ranked war reports.",
            rankId,
            "Skipped"
          );

          continue;
        }

        updateImportProgressRow(
          rankId,
          "active",
          "Attack summary",
          "Ranked war report imported. Fetching attack logs in limited steps."
        );

        const attackSummary = await applyAttackSummary(
          importResult.war.warId,
          rankId,
          index,
          rankIds.length
        );

        successCount += 1;

        updateImportProgressRow(
          rankId,
          "success",
          "Complete",
          `${importResult.message} Attack summary: checked ${attackSummary.checked}, windows ${attackSummary.windowsFetched}, outside hits ${attackSummary.outsideHits}, assists ${attackSummary.assists}, score down ${formatNumber(attackSummary.scoreDown, 2)}.`
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

      if (usedTornApi && index < rankIds.length - 1) {
        updateImportProgress(
          index + 1,
          rankIds.length,
          "Cooldown before next report.",
          rankId,
          `Waiting ${Math.round(WAR_IMPORT_COOLDOWN_MS / 1000)} seconds...`
        );

        await delay(WAR_IMPORT_COOLDOWN_MS);
      }
    }

    submitButton.disabled = false;
    submitButton.textContent = originalButtonText;

    showImportStatus(
      failedCount ? "error" : "success",
      `Import finished. Successful: ${successCount}. Failed: ${failedCount}. Skipped: ${skippedCount}. Overwritten: ${overwrittenCount}.`
    );

    rankIdInput.value = "";

    await loadImportedWars();
    await loadDashboardData();
  });
}

async function askImportDecision(rankId, war) {
  return new Promise(resolve => {
    const opponent = war?.opponent_faction_name || "Unknown opponent";
    const importedAt = war?.imported_at ? formatUnixTimestamp(war.imported_at) : "-";

    const actionsHtml = `
      <button class="secondary-btn small" type="button" data-import-decision="skip">
        Skip
      </button>
      <button class="primary-btn small" type="button" data-import-decision="overwrite">
        Overwrite
      </button>
    `;

    updateImportProgressRow(
      rankId,
      "decision",
      "Already imported",
      `Against ${opponent}. Imported at ${importedAt}.`,
      actionsHtml
    );

    const row = importProgressList.querySelector(`[data-rank-id="${cssEscape(rankId)}"]`);

    if (!row) {
      resolve(false);
      return;
    }

    const skipButton = row.querySelector('[data-import-decision="skip"]');
    const overwriteButton = row.querySelector('[data-import-decision="overwrite"]');

    skipButton.addEventListener("click", () => resolve(false), { once: true });
    overwriteButton.addEventListener("click", () => resolve(true), { once: true });
  });
}

async function applyAttackSummary(warId, rankId, reportIndex, totalReports) {
  let reset = true;
  let latestSummary = null;

  for (let step = 0; step < 300; step += 1) {
    const result = await api("applyAttackSummary", {
      warId,
      reset
    });

    reset = false;

    latestSummary = result.summary || {};

    updateImportProgress(
      reportIndex,
      totalReports,
      `Applying attack summary. Checked ${latestSummary.checked || 0} attacks. Windows ${latestSummary.windowsFetched || 0}. Pending ${result.pendingWindows || 0}.`,
      rankId,
      result.done ? "Applying summary..." : "Waiting before next batch..."
    );

    updateImportProgressRow(
      rankId,
      "active",
      "Attack summary",
      `Checked ${latestSummary.checked || 0}; windows ${latestSummary.windowsFetched || 0}; pending ${result.pendingWindows || 0}; saturated ${latestSummary.saturatedLeafWindows || 0}.`
    );

    if (result.done) {
      return latestSummary;
    }

    await delay(ATTACK_STEP_DELAY_MS);
  }

  throw new Error("Attack summary did not finish within the frontend safety limit.");
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

function addImportProgressRow(rankId, stateName, status, message, actionsHtml = "") {
  if (!importProgressList) return;

  const row = document.createElement("div");

  row.className = `import-progress-row is-${stateName}`;
  row.dataset.rankId = rankId;

  row.innerHTML = `
    <span class="import-progress-war">${escapeHtml(rankId)}</span>
    <span class="import-progress-state">${escapeHtml(status)}</span>
    <span class="import-progress-message">${escapeHtml(message)}</span>
    <span class="import-progress-actions">${actionsHtml}</span>
  `;

  importProgressList.appendChild(row);
}

function updateImportProgressRow(rankId, stateName, status, message, actionsHtml = "") {
  if (!importProgressList) return;

  const row = importProgressList.querySelector(`[data-rank-id="${cssEscape(rankId)}"]`);

  if (!row) {
    addImportProgressRow(rankId, stateName, status, message, actionsHtml);
    return;
  }

  row.className = `import-progress-row is-${stateName}`;

  row.innerHTML = `
    <span class="import-progress-war">${escapeHtml(rankId)}</span>
    <span class="import-progress-state">${escapeHtml(status)}</span>
    <span class="import-progress-message">${escapeHtml(message)}</span>
    <span class="import-progress-actions">${actionsHtml}</span>
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

function debounce(callback, delayMs = 250) {
  let timeoutId;

  return (...args) => {
    clearTimeout(timeoutId);

    timeoutId = setTimeout(() => {
      callback(...args);
    }, delayMs);
  };
}

function delay(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
