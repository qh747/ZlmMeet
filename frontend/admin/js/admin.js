(function () {
  const TOKEN_KEY = 'zlmeetkit_admin_token';
  const LOGIN_AT_KEY = 'zlmeetkit_admin_login_at';
  const REFRESH_MS = 10000;

  const loginView = document.getElementById('loginView');
  const appView = document.getElementById('appView');
  const loginForm = document.getElementById('loginForm');
  const loginToken = document.getElementById('loginToken');
  const loginSubmit = document.getElementById('loginSubmit');
  const logoutBtn = document.getElementById('logoutBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const dashboardTab = document.getElementById('dashboardTab');
  const lastRefresh = document.getElementById('lastRefresh');
  const sessionDuration = document.getElementById('sessionDuration');
  const roomCards = document.getElementById('roomCards');

  let refreshTimer = null;
  let sessionTimer = null;
  let loginAlertDialog = null;
  let loginAlertTitle = null;
  let loginAlertMessage = null;

  function ensureLoginAlert() {
    if (loginAlertDialog) return;

    loginAlertDialog = document.createElement('dialog');
    loginAlertDialog.className = 'app-alert-dialog admin-login-alert-dialog';
    loginAlertDialog.innerHTML =
      '<div class="app-alert-head">' +
        '<span class="app-alert-icon" aria-hidden="true">!</span>' +
        '<h2 class="app-alert-title"></h2>' +
      '</div>' +
      '<p class="app-alert-message"></p>' +
      '<div class="app-alert-actions">' +
        '<button type="button" class="primary app-alert-ok">确定</button>' +
      '</div>';

    document.body.appendChild(loginAlertDialog);
    loginAlertTitle = loginAlertDialog.querySelector('.app-alert-title');
    loginAlertMessage = loginAlertDialog.querySelector('.app-alert-message');

    loginAlertDialog.querySelector('.app-alert-ok').addEventListener('click', function () {
      loginAlertDialog.close();
    });
    loginAlertDialog.addEventListener('click', function (e) {
      if (e.target === loginAlertDialog) loginAlertDialog.close();
    });
  }

  function showLoginAlert(message, title) {
    ensureLoginAlert();
    loginAlertTitle.textContent = title || '登录失败';
    loginAlertMessage.textContent = message;

    if (typeof loginAlertDialog.showModal === 'function') {
      loginAlertDialog.showModal();
    } else {
      loginAlertDialog.setAttribute('open', '');
    }
  }

  const ROOM_TYPES = [
    {
      key: 'meeting',
      label: '会议房间',
      desc: '多人视频会议',
      icon: '◫',
    },
    {
      key: 'call',
      label: '1v1 通话房间',
      desc: '双人实时通话',
      icon: '◎',
    },
    {
      key: 'solo',
      label: '推/拉流房间',
      desc: '单向推流或拉流',
      icon: '▷',
    },
  ];

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  }

  function showLogin() {
    loginView.classList.add('is-active');
    loginView.setAttribute('aria-hidden', 'false');
    appView.classList.remove('is-active');
    appView.setAttribute('aria-hidden', 'true');
    stopAutoRefresh();
    stopSessionTimer();
    loginSubmit.disabled = false;
    loginSubmit.textContent = '登录';
  }

  function showApp() {
    loginView.classList.remove('is-active');
    loginView.setAttribute('aria-hidden', 'true');
    appView.classList.add('is-active');
    appView.setAttribute('aria-hidden', 'false');
    beginSession();
    startAutoRefresh();
  }

  function getLoginAt() {
    const raw = sessionStorage.getItem(LOGIN_AT_KEY);
    if (!raw) return null;
    const ts = Number(raw);
    return Number.isFinite(ts) ? ts : null;
  }

  function beginSession() {
    if (!getLoginAt()) {
      sessionStorage.setItem(LOGIN_AT_KEY, String(Date.now()));
    }
    startSessionTimer();
  }

  function endSession() {
    sessionStorage.removeItem(LOGIN_AT_KEY);
    stopSessionTimer();
    if (sessionDuration) sessionDuration.textContent = '00:00:00';
  }

  function stopSessionTimer() {
    if (sessionTimer) {
      clearInterval(sessionTimer);
      sessionTimer = null;
    }
  }

  function startSessionTimer() {
    stopSessionTimer();
    updateSessionDuration();
    sessionTimer = setInterval(updateSessionDuration, 1000);
  }

  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return (
      String(h).padStart(2, '0') + ':' +
      String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0')
    );
  }

  function updateSessionDuration() {
    if (!sessionDuration) return;
    const loginAt = getLoginAt();
    sessionDuration.textContent = formatDuration(loginAt ? Date.now() - loginAt : 0);
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(loadDashboard, REFRESH_MS);
  }

  function formatTime() {
    const d = new Date();
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  async function apiLogin(token) {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return res.json();
  }

  async function apiDashboard(token) {
    const res = await fetch('/api/admin/dashboard', {
      headers: { 'X-Admin-Token': token },
    });
    if (res.status === 401) {
      return { unauthorized: true };
    }
    if (!res.ok) {
      throw new Error('请求失败 HTTP ' + res.status);
    }
    return res.json();
  }

  function applyDashboard(data) {
    renderRoomCards(data.hub || {});
    lastRefresh.textContent = '更新于 ' + formatTime();
  }

  function renderRoomCards(hub) {
    const byMode = hub.roomsByMode || {};
    const clientsByMode = hub.clientsByMode || {};

    roomCards.innerHTML = ROOM_TYPES.map(function (type) {
      const rooms = byMode[type.key] || 0;
      const clients = clientsByMode[type.key] || 0;
      return (
        '<article class="admin-room-card admin-room-card--' + type.key + '">' +
          '<div class="admin-room-card-icon" aria-hidden="true">' + type.icon + '</div>' +
          '<div class="admin-room-card-body">' +
            '<h3 class="admin-room-card-label">' + type.label + '</h3>' +
            '<p class="admin-room-card-desc">' + type.desc + '</p>' +
          '</div>' +
          '<div class="admin-room-card-stats">' +
            '<div class="admin-room-card-value">' + rooms + '</div>' +
            '<div class="admin-room-card-sub">' + clients + ' 人在线</div>' +
          '</div>' +
        '</article>'
      );
    }).join('');
  }

  async function loadDashboard() {
    const token = getToken();
    if (!token) {
      showLogin();
      return null;
    }

    try {
      const data = await apiDashboard(token);
      if (data.unauthorized) {
        setToken('');
        endSession();
        showLogin();
        showLoginAlert('登录已过期，请重新输入令牌', '登录已过期');
        return null;
      }
      applyDashboard(data);
      return data;
    } catch (e) {
      lastRefresh.textContent = '刷新失败';
      console.error(e);
      return null;
    }
  }

  async function tryRestoreSession() {
    const token = getToken();
    if (!token) {
      showLogin();
      return;
    }

    loginSubmit.disabled = true;
    loginSubmit.textContent = '验证中…';

    try {
      const data = await apiDashboard(token);
      if (data.unauthorized) {
        setToken('');
        endSession();
        showLogin();
        return;
      }
      showApp();
      applyDashboard(data);
    } catch (e) {
      setToken('');
      endSession();
      showLogin();
      showLoginAlert('无法验证登录状态，请重新登录');
      console.error(e);
    } finally {
      loginSubmit.disabled = false;
      loginSubmit.textContent = '登录';
    }
  }

  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const token = loginToken.value.trim();
    if (!token) {
      showLoginAlert('请输入登录令牌');
      return;
    }

    loginSubmit.disabled = true;
    loginSubmit.textContent = '登录中…';

    try {
      const res = await apiLogin(token);
      if (!res.ok) {
        showLoginAlert(res.message || '登录失败，请检查令牌是否正确');
        return;
      }

      setToken(token);
      loginToken.value = '';
      sessionStorage.setItem(LOGIN_AT_KEY, String(Date.now()));

      const data = await apiDashboard(token);
      if (data.unauthorized) {
        setToken('');
        endSession();
        showLoginAlert('令牌校验失败，请检查后重试');
        return;
      }

      showApp();
      applyDashboard(data);
    } catch (err) {
      showLoginAlert('网络错误，请稍后重试');
      console.error(err);
    } finally {
      loginSubmit.disabled = false;
      loginSubmit.textContent = '登录';
    }
  });

  logoutBtn.addEventListener('click', function () {
    setToken('');
    endSession();
    loginToken.value = '';
    showLogin();
  });

  refreshBtn.addEventListener('click', loadDashboard);

  if (dashboardTab) {
    dashboardTab.addEventListener('click', function () {
      document.querySelectorAll('.admin-nav-item').forEach(function (el) {
        el.classList.toggle('active', el === dashboardTab);
      });
      loadDashboard();
    });
  }

  tryRestoreSession();
})();
