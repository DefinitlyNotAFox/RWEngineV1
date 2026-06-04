const ATTACK_STEP_DELAY_MS = 6000;
const WAR_IMPORT_COOLDOWN_MS = 30000;

const state = {
  activeTab: "dashboard",
  sortBy: "ImpactScore",
  sortDirection: "DESC",
  currentUser: null,
  dashboardRows: [],
  dashboardSummary: {},
  matchupChart: null
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
const ownRosterTableBody = document.getElementById("ownRosterTableBody");

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
  state.currentUser = user;

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

      if (button.dataset.tab === "currentWar") {
        loadCurrentWarIntel();
      }
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

    state.dashboardRows = result.rows || [];
    state.dashboardSummary = result.summary || {};

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
   CURRENT WAR / MATCHUP
========================= */

function setupCurrentWar() {
  if (!refreshCurrentWarButton) return;

  refreshCurrentWarButton.addEventListener("click", () => {
    loadCurrentWarIntel();
  });
}

async function loadCurrentWarIntel() {
  setMatchupLoading();

  try {
    const result = await api("getOpponentThreatList");
    renderMatchupOverview(result);
  } catch (error) {
    setMatchupError(error.message);
  }
}

function setMatchupLoading() {
  if (currentWarTableBody) {
    currentWarTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-table">Loading opponent intel...</td>
      </tr>
    `;
  }

  if (ownRosterTableBody) {
    ownRosterTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-table">Loading own faction data...</td>
      </tr>
    `;
  }
}

function setMatchupError(message) {
  if (currentWarTableBody) {
    currentWarTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-table">${escapeHtml(message)}</td>
      </tr>
    `;
  }
}

function renderMatchupOverview(result) {
  const war = result.war || {};
  const opponentRows = result.rows || [];
  const ownRows = getOwnRosterRows(result.ownMembers || {});

  const opponentSummary = buildOpponentSummary(opponentRows);
  const ownSummary = buildOwnSummary(ownRows);

  opponentSummary.name = war.opponentFactionName || "Opponent";
  opponentSummary.factionId = war.opponentFactionId;
  ownSummary.factionId = war.ownFactionId || state.currentUser?.factionId;
  ownSummary.name =
    war.ownFactionName ||
    state.currentUser?.factionName ||
    "Your Faction";

  opponentSummary.bannerUrl = result.opponentBannerUrl || getFactionBannerUrl(war.opponentFactionId);
  ownSummary.bannerUrl = result.ownBannerUrl || getFactionBannerUrl(war.ownFactionId || state.currentUser?.factionId);

  const win = calculateWinProbability(ownSummary, opponentSummary);
  const projection = buildProjectionData(war, ownSummary, opponentSummary, win);

  applyFactionIdentity("opponent", opponentSummary, "#3b82f6");
  applyFactionIdentity("own", ownSummary, "#ff4545");

  renderMatchupHero(war, ownSummary, opponentSummary, win);
  renderTopLists(ownRows, opponentRows);
  renderWarInformation(war, result.reportIds || []);
  renderProjectionChart(projection, ownSummary.name, opponentSummary.name);
  renderOpponentRoster(opponentRows);
  renderOwnRoster(ownRows);
}

function getOwnRosterRows(currentMembers = {}) {
  const currentMemberMap = new Map(
    Object.values(currentMembers || {}).map(member => [String(member.playerId), member])
  );

  return (state.dashboardRows || [])
    .filter(row => row["Is Member"] === "ACTIVE")
    .filter(row => {
      if (!currentMemberMap.size) return true;
      return currentMemberMap.has(String(row["Player_ID"]));
    })
    .map(row => {
      const currentMember = currentMemberMap.get(String(row["Player_ID"])) || {};

      return {
        playerId: row["Player_ID"],
        playerName: currentMember.playerName || row["Members"],
        status: row["Is Member"],
        warsSeen: Number(row["Wars"] || 0),
        hits: Number(row["Hits"] || 0),
        score: Number(row["Sum Score up"] || 0),
        avgScorePerHit: Number(row["Avg R/hit"] || 0),
        impactScore: Number(row["ImpactScore"] || 0),
        level: currentMember.level || null,
        position: currentMember.position || ""
      };
    })
    .sort((a, b) => Number(b.impactScore || 0) - Number(a.impactScore || 0));
}

function buildOpponentSummary(rows) {
  const count = rows.length;
  const totalHits = rows.reduce((sum, row) => sum + Number(row.hits || 0), 0);
  const totalScore = rows.reduce((sum, row) => sum + Number(row.score || 0), 0);
  const levelRows = rows.filter(row => Number(row.level || 0) > 0);
  const avgLevel =
    levelRows.length > 0
      ? levelRows.reduce((sum, row) => sum + Number(row.level || 0), 0) / levelRows.length
      : 0;

  return {
    name: "Opponent",
    activeMembers: count,
    avgLevel,
    totalHits,
    totalScore,
    avgScorePerHit: totalHits > 0 ? totalScore / totalHits : 0,
    topPlayerScore: rows.length ? Number(rows[0].score || 0) : 0,
    strength: 0
  };
}

function buildOwnSummary(rows) {
  const count = rows.length;
  const totalHits = rows.reduce((sum, row) => sum + Number(row.hits || 0), 0);
  const totalScore = rows.reduce((sum, row) => sum + Number(row.score || 0), 0);
  const levelRows = rows.filter(row => Number(row.level || 0) > 0);
  const avgLevel =
    levelRows.length > 0
      ? levelRows.reduce((sum, row) => sum + Number(row.level || 0), 0) / levelRows.length
      : 0;

  return {
    name: state.currentUser?.factionName || "Your Faction",
    activeMembers: count,
    avgLevel,
    totalHits,
    totalScore,
    avgScorePerHit: totalHits > 0 ? totalScore / totalHits : 0,
    topPlayerScore: rows.length ? Number(rows[0].score || 0) : 0,
    strength: 0
  };
}

function calculateWinProbability(own, opponent) {
  const ownStrength = calculateFactionStrength(own);
  const opponentStrength = calculateFactionStrength(opponent);
  const total = ownStrength + opponentStrength;

  if (!total) {
    return {
      ownChance: 50,
      opponentChance: 50,
      confidence: "Low"
    };
  }

  const ownChance = Math.round((ownStrength / total) * 100);
  const opponentChance = 100 - ownChance;
  const gap = Math.abs(ownChance - opponentChance);

  return {
    ownChance,
    opponentChance,
    confidence: gap >= 30 ? "High" : gap >= 12 ? "Medium" : "Low"
  };
}

function calculateFactionStrength(summary) {
  return (
    Number(summary.totalScore || 0) * 0.65 +
    Number(summary.totalHits || 0) * 4 +
    Number(summary.activeMembers || 0) * 45 +
    Number(summary.avgLevel || 0) * 30 +
    Number(summary.topPlayerScore || 0) * 0.35
  );
}

function buildProjectionData(war, own, opponent, win) {
  const target = Number(war.target || 2400);
  const ownFinish = Math.max(target, Math.round(target * (win.ownChance / 50)));
  const opponentFinish = Math.max(target, Math.round(target * (win.opponentChance / 50)));

  return [
    { label: "Start", own: 0, opponent: 0 },
    { label: "25%", own: Math.round(ownFinish * 0.28), opponent: Math.round(opponentFinish * 0.25) },
    { label: "50%", own: Math.round(ownFinish * 0.55), opponent: Math.round(opponentFinish * 0.50) },
    { label: "75%", own: Math.round(ownFinish * 0.80), opponent: Math.round(opponentFinish * 0.76) },
    { label: "Finish", own: ownFinish, opponent: opponentFinish }
  ];
}

function renderMatchupHero(war, own, opponent, win) {
  setText("matchupWarId", war.warId ? `Ranked War #${war.warId}` : "Ranked War");
  setText("opponentName", opponent.name);
  setText("ownName", own.name);

  setText("opponentMembers", formatNumber(opponent.activeMembers));
  setText("ownMembers", formatNumber(own.activeMembers));

  setText("opponentAvgLevel", opponent.avgLevel ? formatNumber(opponent.avgLevel || 0, 1) : "-");
  setText("ownAvgLevel", own.avgLevel ? formatNumber(own.avgLevel, 1) : "-");

  setText("opponentScoreNow", formatNumber(war.opponentScore || 0));
  setText("ownScoreNow", formatNumber(war.ownScore || 0));

  setText("opponentChance", `${win.opponentChance}%`);
  setText("ownChance", `${win.ownChance}%`);
  setText("matchupConfidence", `Confidence: ${win.confidence}`);

  const hero = document.getElementById("matchupHero");
  if (hero) {
    hero.style.setProperty("--opponent-share", `${win.opponentChance}%`);
  }

  const opponentBar = document.getElementById("opponentWinBar");
  const ownBar = document.getElementById("ownWinBar");

  if (opponentBar) opponentBar.style.width = `${win.opponentChance}%`;
  if (ownBar) ownBar.style.width = `${win.ownChance}%`;

  const badge = document.getElementById("matchupStatusBadge");
  if (badge) {
    badge.textContent = war.isActive ? "Ongoing" : "Pending";
    badge.className = `match-status ${war.isActive ? "ongoing" : "pending"}`;
  }

  const warInfoInline = document.getElementById("warInfoInline");
  if (warInfoInline) {
    const start = war.startTimestamp ? formatUnixTimestamp(war.startTimestamp) : "-";
    const target = war.target ? formatNumber(war.target) : "-";
    warInfoInline.textContent = `Start: ${start} · Target: ${target} · Score: ${formatNumber(war.opponentScore || 0)} - ${formatNumber(war.ownScore || 0)}`;
  }
}

function renderTopLists(ownRows, opponentRows) {
  renderTopPlayerList(
    "topThreatsList",
    opponentRows.slice(0, 6),
    "opponent",
    row => Number(row.score || 0)
  );

  renderTopPlayerList(
    "topAssetsList",
    ownRows.slice(0, 6),
    "own",
    row => Number(row.score || 0)
  );
}

function renderTopPlayerList(elementId, rows, color, valueGetter) {
  const el = document.getElementById(elementId);
  if (!el) return;

  if (!rows.length) {
    el.innerHTML = `<div class="empty-state">No data loaded.</div>`;
    return;
  }

  el.innerHTML = rows
    .map((row, index) => {
      return `
        <div class="top-player-row">
          <span>${index + 1}</span>
          <strong>${escapeHtml(row.playerName)}</strong>
          <em class="${color}-color-text">${formatNumber(valueGetter(row), 0)}</em>
        </div>
      `;
    })
    .join("");
}

function renderWarInformation(war, reportIds) {
  const el = document.getElementById("warInformation");
  if (!el) return;

  const rows = [
    ["War ID", war.warId || "-"],
    ["Status", war.isActive ? "Ongoing" : "Pending"],
    ["Start", war.startTimestamp ? formatUnixTimestamp(war.startTimestamp) : "-"],
    ["Target", war.target ? formatNumber(war.target) : "-"],
    ["Own Score", formatNumber(war.ownScore || 0)],
    ["Opponent Score", formatNumber(war.opponentScore || 0)],
    ["Known reports", formatNumber(reportIds.length || 0)]
  ];

  el.innerHTML = rows
    .map(([label, value]) => `
      <div class="war-info-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `)
    .join("");
}

function renderProjectionChart(data, ownName, opponentName) {
  const canvas = document.getElementById("matchupProjectionChart");
  if (!canvas || !window.Chart) return;

  if (state.matchupChart) {
    state.matchupChart.destroy();
  }

  const ctx = canvas.getContext("2d");
  const styles = getComputedStyle(document.documentElement);
  const opponentColor = styles.getPropertyValue("--opponent-primary").trim() || "#3b82f6";
  const ownColor = styles.getPropertyValue("--own-primary").trim() || "#ff4545";

  state.matchupChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map(row => row.label),
      datasets: [
        {
          label: `${opponentName} projected`,
          data: data.map(row => row.opponent),
          borderColor: opponentColor,
          backgroundColor: hexToRgba(opponentColor, 0.16),
          tension: 0.35,
          pointRadius: 2
        },
        {
          label: `${ownName} projected`,
          data: data.map(row => row.own),
          borderColor: ownColor,
          backgroundColor: hexToRgba(ownColor, 0.16),
          tension: 0.35,
          pointRadius: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#d8d8d8",
            boxWidth: 10,
            font: { size: 10 }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#a5a5a5", font: { size: 10 } },
          grid: { color: "rgba(255,255,255,0.06)" }
        },
        y: {
          ticks: { color: "#a5a5a5", font: { size: 10 } },
          grid: { color: "rgba(255,255,255,0.06)" }
        }
      }
    }
  });
}

function renderOpponentRoster(rows) {
  if (!currentWarTableBody) return;

  if (!rows.length) {
    currentWarTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-table">No current opponent members with report data found.</td>
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
              ${roleSymbol}${escapeHtml(row.playerName)}
            </a>
          </td>
          <td>${row.level ? formatNumber(row.level) : "-"}</td>
          <td>${formatNumber(row.warsSeen || 0)}</td>
          <td>${formatNumber(row.hits || 0)}</td>
          <td>${formatNumber(row.avgScorePerHit || 0, 1)}</td>
          <td>${formatNumber(row.score || 0, 0)}</td>
          <td><span class="threat-pill ${getThreatClass(row.tag)}">${escapeHtml(row.tag || "-")}</span></td>
        </tr>
      `;
    })
    .join("");
}

function renderOwnRoster(rows) {
  if (!ownRosterTableBody) return;

  if (!rows.length) {
    ownRosterTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-table">No current own faction members found.</td>
      </tr>
    `;
    return;
  }

  ownRosterTableBody.innerHTML = rows
    .map((row, index) => {
      const memberUrl = `https://www.torn.com/profiles.php?XID=${encodeURIComponent(row.playerId)}`;
      const roleSymbol = getFactionRoleSymbol(row.position);

      return `
        <tr>
          <td>${index + 1}</td>
          <td>
            <a class="member-link" href="${memberUrl}" target="_blank" rel="noopener noreferrer">
              ${roleSymbol}${escapeHtml(row.playerName)}
            </a>
          </td>
          <td>${row.level ? formatNumber(row.level) : "-"}</td>
          <td>${formatNumber(row.warsSeen || 0)}</td>
          <td>${formatNumber(row.hits || 0)}</td>
          <td>${formatNumber(row.avgScorePerHit || 0, 1)}</td>
          <td>${formatNumber(row.score || 0, 0)}</td>
          <td>${formatNumber(row.impactScore || 0, 1)}</td>
        </tr>
      `;
    })
    .join("");
}

function applyFactionIdentity(side, summary, fallbackColor) {
  const banner = document.getElementById(`${side}Banner`);
  const factionId = side === "opponent"
    ? summary?.factionId
    : state.currentUser?.factionId;
  const bannerUrl = summary.bannerUrl || getFactionBannerUrl(factionId);
  const fallback = deriveFactionColor(summary.name || side, fallbackColor);

  setFactionColor(side, fallback);

  if (!banner) return;

  if (!bannerUrl) {
    banner.removeAttribute("src");
    banner.closest(".faction-banner")?.classList.add("empty-banner");
    return;
  }

  banner.crossOrigin = "anonymous";
  banner.onload = () => {
    banner.closest(".faction-banner")?.classList.remove("empty-banner");
    const extracted = extractImageAccentColor(banner);
    if (extracted) {
      setFactionColor(side, extracted);
      if (state.matchupChart) {
        const styles = getComputedStyle(document.documentElement);
        const opponentColor = styles.getPropertyValue("--opponent-primary").trim() || "#3b82f6";
        const ownColor = styles.getPropertyValue("--own-primary").trim() || "#ff4545";
        state.matchupChart.data.datasets[0].borderColor = opponentColor;
        state.matchupChart.data.datasets[0].backgroundColor = hexToRgba(opponentColor, 0.16);
        state.matchupChart.data.datasets[1].borderColor = ownColor;
        state.matchupChart.data.datasets[1].backgroundColor = hexToRgba(ownColor, 0.16);
        state.matchupChart.update("none");
      }
    }
  };
  banner.onerror = () => {
    banner.closest(".faction-banner")?.classList.add("empty-banner");
  };
  banner.src = bannerUrl;
}

function getFactionBannerUrl(factionId) {
  const id = Number(factionId || 0);
  if (!id) return "";
  return `https://factionimages.torn.com/${encodeURIComponent(id)}.jpg`;
}

function deriveFactionColor(name, fallbackColor) {
  const text = String(name || "");
  if (!text) return fallbackColor;

  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }

  const hue = hash % 360;
  return hslToHex(hue, 78, 58);
}

function extractImageAccentColor(img) {
  try {
    const canvas = document.createElement("canvas");
    const size = 32;
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);

    const data = ctx.getImageData(0, 0, size, size).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;

    for (let i = 0; i < data.length; i += 16) {
      const alpha = data[i + 3];
      if (alpha < 80) continue;

      const rr = data[i];
      const gg = data[i + 1];
      const bb = data[i + 2];
      const brightness = (rr + gg + bb) / 3;
      if (brightness < 25 || brightness > 235) continue;

      r += rr;
      g += gg;
      b += bb;
      count += 1;
    }

    if (!count) return "";

    return rgbToHex(
      Math.round(r / count),
      Math.round(g / count),
      Math.round(b / count)
    );
  } catch {
    return "";
  }
}

function setFactionColor(side, color) {
  document.documentElement.style.setProperty(`--${side}-primary`, color);
  document.documentElement.style.setProperty(`--${side}-soft`, hexToRgba(color, 0.22));
  document.documentElement.style.setProperty(`--${side}-dark`, hexToRgba(color, 0.42));
}

function hexToRgba(hex, alpha) {
  const clean = String(hex || "").replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return `rgba(255,255,255,${alpha})`;

  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b]
    .map(value => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0"))
    .join("");
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return rgbToHex(
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255)
  );
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

function getThreatClass(tag) {
  const text = String(tag || "").toLowerCase();

  if (text.includes("priority") || text.includes("very")) return "very-high";
  if (text.includes("high")) return "high";
  if (text.includes("watch")) return "medium";
  if (text.includes("active")) return "medium";
  return "low";
}

function createFactionTag(name) {
  const clean = String(name || "")
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim();

  if (!clean) return "TAG";

  const words = clean.split(/\s+/).filter(Boolean);

  if (words.length >= 2) {
    return words.map(word => word[0]).join("").slice(0, 5).toUpperCase();
  }

  return clean.slice(0, 5).toUpperCase();
}

function formatComparisonValue(value) {
  if (value === "-" || value === null || value === undefined) return "-";

  const number = Number(value);

  if (!Number.isFinite(number)) return String(value);

  if (Math.abs(number) >= 1000) return formatNumber(number, 0);
  if (number % 1 !== 0) return formatNumber(number, 1);

  return formatNumber(number, 0);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value;
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
