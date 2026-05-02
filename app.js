const state = {
  activeTab: "dashboard"
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

init();

function init() {
  setupAuthSwitch();
  setupAuthForms();
  setupTabs();
  setupGraphCollapse();
  setupBackendTest();
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
