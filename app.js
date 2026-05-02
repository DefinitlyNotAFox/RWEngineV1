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

const logoutButton = document.getElementById("logoutButton");

const navButtons = document.querySelectorAll(".nav-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

const graphPanel = document.getElementById("graphPanel");
const graphBody = document.getElementById("graphBody");
const graphCollapseButton = document.getElementById("graphCollapseButton");

init();

function init() {
  setupAuthSwitch();
  setupFakeAuth();
  setupTabs();
  setupGraphCollapse();
}

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

function setupFakeAuth() {
  loginForm.addEventListener("submit", event => {
    event.preventDefault();

    showApp({
      playerName: "Test User",
      playerId: "123456",
      factionName: "Test Faction",
      isAdmin: true
    });
  });

  registerForm.addEventListener("submit", event => {
    event.preventDefault();

    const password = document.getElementById("registerPasswordInput").value;
    const confirmPassword = document.getElementById("registerPasswordConfirmInput").value;

    if (password !== confirmPassword) {
      showLoginError("Passwords do not match.");
      return;
    }

    showApp({
      playerName: "Registered User",
      playerId: "123456",
      factionName: "Test Faction",
      isAdmin: false
    });
  });

  logoutButton.addEventListener("click", () => {
    appPage.classList.add("hidden");
    loginPage.classList.remove("hidden");
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
    user.factionName;

  const adminBadge = document.getElementById("adminBadge");

  if (user.isAdmin) {
    adminBadge.classList.remove("hidden");
  } else {
    adminBadge.classList.add("hidden");
  }

  setApiStatus("pending", "?", "Not checked", "API key verification is not implemented yet.");
}

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

function setupGraphCollapse() {
  graphCollapseButton.addEventListener("click", () => {
    const isCollapsed = graphPanel.classList.toggle("collapsed");

    graphBody.classList.toggle("hidden", isCollapsed);
    graphCollapseButton.textContent = isCollapsed ? "▾" : "▴";
    graphCollapseButton.setAttribute("aria-expanded", String(!isCollapsed));
    graphCollapseButton.title = isCollapsed ? "Expand graph" : "Collapse graph";
  });
}

function showLoginError(message) {
  loginError.textContent = message;
  loginError.className = "form-message error";
}

function hideLoginMessage() {
  loginError.textContent = "";
  loginError.className = "form-message error hidden";
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
