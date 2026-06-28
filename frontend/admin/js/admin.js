(function () {
  const TOKEN_KEY = 'zlmeetkit_admin_token';
  const LOGIN_AT_KEY = 'zlmeetkit_admin_login_at';
  const NETWORK_ERROR_TITLE = '网络异常';
  const NETWORK_ERROR_MESSAGE = '网络异常，服务连接已断开，请稍后重试';

  const loginView = document.getElementById('loginView');
  const appView = document.getElementById('appView');
  const loginForm = document.getElementById('loginForm');
  const loginUsername = document.getElementById('loginUsername');
  const loginPassword = document.getElementById('loginPassword');
  const loginSubmit = document.getElementById('loginSubmit');
  const logoutBtn = document.getElementById('logoutBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const totalRoomsEl = document.getElementById('totalRooms');
  const totalClientsEl = document.getElementById('totalClients');
  const dashboardTab = document.getElementById('dashboardTab');
  const monitorTab = document.getElementById('monitorTab');
  const auditTab = document.getElementById('auditTab');
  const dashboardPage = document.getElementById('dashboardPage');
  const monitorPage = document.getElementById('monitorPage');
  const auditPage = document.getElementById('auditPage');
  const auditTableBody = document.getElementById('auditTableBody');
  const auditEmpty = document.getElementById('auditEmpty');
  const auditRefreshBtn = document.getElementById('auditRefreshBtn');
  const auditClearBtn = document.getElementById('auditClearBtn');
  const auditPagination = document.getElementById('auditPagination');
  const auditPageInfo = document.getElementById('auditPageInfo');
  const auditPagePrev = document.getElementById('auditPagePrev');
  const auditPageNext = document.getElementById('auditPageNext');
  const auditPageInput = document.getElementById('auditPageInput');
  const auditPageGo = document.getElementById('auditPageGo');
  const auditPageSizeEl = document.getElementById('auditPageSize');
  const confirmDialog = document.getElementById('adminConfirmDialog');
  const confirmTitle = document.getElementById('adminConfirmTitle');
  const confirmMessage = document.getElementById('adminConfirmMessage');
  const sessionDuration = document.getElementById('sessionDuration');
  const serviceCards = document.getElementById('serviceCards');
  const roomCards = document.getElementById('roomCards');

  const DASHBOARD_POLL_MS = 5000;
  let dashboardPollTimer = null;
  let lastMediaSnapshot = null;

  let dashboardWs = null;
  let wsManualClose = false;
  let sessionTimer = null;
  let auditLoading = false;
  let networkFailureHandled = false;
  const AUDIT_PAGE_SIZE_OPTIONS = [5, 10, 20];
  let auditEntries = [];
  let auditCurrentPage = 1;
  let auditPageSize = 10;
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
      icon: '👥',
      statKind: 'rooms-online',
    },
    {
      key: 'call',
      label: '1v1 通话房间',
      desc: '双人实时通话',
      icon: '📞',
      statKind: 'rooms-online',
    },
    {
      key: 'solo',
      label: '推/拉流房间',
      desc: '单向推流或拉流',
      statKind: 'push-play',
    },
  ];

  function renderRoomIcon(type) {
    if (type.key === 'solo') {
      return (
        '<div class="admin-room-card-icon admin-room-card-icon--stream" aria-hidden="true">' +
          '<svg class="admin-room-card-stream-svg" viewBox="0 0 24 24" focusable="false">' +
            '<path class="admin-room-card-stream-up" d="M12 5v4.5M8.5 9L12 5.5 15.5 9" />' +
            '<path class="admin-room-card-stream-divider" d="M6 12h12" />' +
            '<path class="admin-room-card-stream-down" d="M12 19v-4.5M8.5 15L12 18.5 15.5 15" />' +
          '</svg>' +
        '</div>'
      );
    }
    return '<div class="admin-room-card-icon" aria-hidden="true">' + type.icon + '</div>';
  }

  function soloPushPullCounts(hub) {
    var push = 0;
    var pull = 0;
    (hub.rooms || []).forEach(function (room) {
      if (room.mode !== 'solo') return;
      (room.clients || []).forEach(function (client) {
        if (client.soloRole === 'play') pull++;
        else push++;
      });
    });
    return { push: push, pull: pull };
  }

  function renderStatBlock(value, label, extraClass) {
    return (
      '<div class="admin-room-card-stat' + (extraClass ? ' ' + extraClass : '') + '">' +
        '<div class="admin-room-card-value">' + value + '</div>' +
        '<div class="admin-room-card-sub">' + label + '</div>' +
      '</div>'
    );
  }

  function renderCardStats(type, hub, byMode, clientsByMode) {
    if (type.statKind === 'push-play') {
      var solo = soloPushPullCounts(hub);
      return (
        '<div class="admin-room-card-stats admin-room-card-stats--dual">' +
          renderStatBlock(solo.push, '推流', 'admin-room-card-stat--push') +
          renderStatBlock(solo.pull, '拉流', 'admin-room-card-stat--play') +
        '</div>'
      );
    }

    var rooms = byMode[type.key] || 0;
    var clients = clientsByMode[type.key] || 0;
    return (
      '<div class="admin-room-card-stats admin-room-card-stats--dual">' +
        renderStatBlock(rooms, '房间') +
        renderStatBlock(clients, '人在线') +
      '</div>'
    );
  }

  function showToast(message) {
    showLoginAlert(message, '提示');
  }

  function handleNetworkFailure(message, title) {
    if (networkFailureHandled) return;
    if (!appView.classList.contains('is-active')) return;

    networkFailureHandled = true;
    wsManualClose = true;
    stopWatchingAll();
    stopDashboardWs(true);
    setToken('');
    endSession();
    showLogin();
    showLoginAlert(message || NETWORK_ERROR_MESSAGE, title || NETWORK_ERROR_TITLE);
  }

  function resetNetworkFailureGuard() {
    networkFailureHandled = false;
  }

  window.__adminHandleNetworkFailure = handleNetworkFailure;

  window.__adminGetToken = getToken;
  window.__adminShowToast = showToast;

  function stopWatchingAll() {
    if (window.AdminMonitor?.stopAllWatching) {
      window.AdminMonitor.stopAllWatching();
    }
  }

  function isDashboardActive() {
    return dashboardPage && dashboardPage.classList.contains('active');
  }

  function startDashboardPoll() {
    stopDashboardPoll();
    if (!isDashboardActive() || !appView.classList.contains('is-active')) return;
    dashboardPollTimer = setInterval(requestDashboardRefresh, DASHBOARD_POLL_MS);
  }

  function stopDashboardPoll() {
    if (dashboardPollTimer) {
      clearInterval(dashboardPollTimer);
      dashboardPollTimer = null;
    }
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = n;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
    return value.toFixed(digits) + ' ' + units[unit];
  }

  function formatPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(1) + '%';
  }

  function formatUptime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return days + '天 ' + hours + '小时';
    if (hours > 0) return hours + '小时 ' + minutes + '分';
    return minutes + '分';
  }

  function renderMetricBar(label, percent, valueText) {
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    return (
      '<div class="admin-service-metric">' +
        '<span class="admin-service-metric-label">' + label + '</span>' +
        '<div class="admin-service-bar" aria-hidden="true">' +
          '<div class="admin-service-bar-fill" style="width:' + pct + '%"></div>' +
        '</div>' +
        '<span class="admin-service-metric-value">' + valueText + '</span>' +
      '</div>'
    );
  }

  function renderPlainMetric(label, valueText) {
    return (
      '<div class="admin-service-metric">' +
        '<span class="admin-service-metric-label">' + label + '</span>' +
        '<span class="admin-service-metric-value" style="grid-column: 2 / -1">' + valueText + '</span>' +
      '</div>'
    );
  }

  function renderServiceIcon(kind) {
    if (kind === 'signaling') {
      return (
        '<div class="admin-service-card-icon" aria-hidden="true">' +
          '<svg class="admin-service-card-svg" viewBox="0 0 24 24" focusable="false">' +
            '<path class="admin-service-icon-stroke" d="M4 9h5l2 3-2 3H4" />' +
            '<path class="admin-service-icon-stroke" d="M20 9h-5l-2 3 2 3h5" />' +
            '<circle class="admin-service-icon-dot" cx="12" cy="12" r="1.75" />' +
          '</svg>' +
        '</div>'
      );
    }
    return (
      '<div class="admin-service-card-icon" aria-hidden="true">' +
        '<svg class="admin-service-card-svg" viewBox="0 0 24 24" focusable="false">' +
          '<path class="admin-service-icon-stroke" d="M12 4v4.5" />' +
          '<path class="admin-service-icon-stroke" d="M8 8.5L12 5l4 3.5" />' +
          '<path class="admin-service-icon-stroke admin-service-icon-fan" d="M6 17l3-2" />' +
          '<path class="admin-service-icon-stroke admin-service-icon-fan" d="M12 19v-3" />' +
          '<path class="admin-service-icon-stroke admin-service-icon-fan" d="M18 17l-3-2" />' +
          '<path class="admin-service-icon-stroke" d="M9 14h6" />' +
        '</svg>' +
      '</div>'
    );
  }

  function renderServiceHead(title, statusClass, statusText, iconKind) {
    return (
      '<div class="admin-service-card-head">' +
        '<div class="admin-service-card-brand">' +
          renderServiceIcon(iconKind) +
          '<h3 class="admin-service-card-title">' + title + '</h3>' +
        '</div>' +
        '<span class="' + statusClass + '">' + statusText + '</span>' +
      '</div>'
    );
  }

  function renderSignalingCard(signaling) {
    const data = signaling || {};
    const supported = data.supported !== false;
    const cpu = supported ? formatPercent(data.cpuUsagePercent) : '—';
    const procCpu = supported ? formatPercent(data.processCpuUsagePercent) : '—';
    const memUsed = supported ? formatBytes(data.memUsedBytes) : '—';
    const memTotal = supported ? formatBytes(data.memTotalBytes) : '—';
    const memPct = supported ? Number(data.memUsagePercent) || 0 : 0;
    const memText = supported ? (memUsed + ' / ' + memTotal) : '本机指标不可用';
    const rss = supported ? formatBytes(data.processRssBytes) : '—';
    const heap = formatBytes(data.goHeapBytes);
    const goroutines = data.goroutineCount != null ? String(data.goroutineCount) : '—';
    const fds = supported && data.openFdCount != null ? String(data.openFdCount) : '—';
    const uptime = formatUptime(data.uptimeSeconds);

    return (
      '<article class="admin-service-card admin-service-card--signaling">' +
        renderServiceHead('信令服务', 'admin-service-status', '运行中', 'signaling') +
        '<div class="admin-service-metrics">' +
          renderMetricBar('整机 CPU', data.cpuUsagePercent, cpu) +
          renderMetricBar('整机内存', memPct, memText) +
          renderMetricBar('进程 CPU', data.processCpuUsagePercent, procCpu) +
          renderPlainMetric('进程内存', rss) +
          renderPlainMetric('Go 堆内存', heap) +
          renderPlainMetric('Goroutine', goroutines) +
          renderPlainMetric('打开 FD', fds) +
          renderPlainMetric('运行时长', uptime) +
        '</div>' +
      '</article>'
    );
  }

  function renderMediaCard(media) {
    const data = media || {};
    const online = data.status === 'online';
    const statusClass = online ? 'admin-service-status' : 'admin-service-status admin-service-status--offline';
    const statusText = online ? '正常' : '不可达';
    const threadAvg = online ? formatPercent(data.threadLoadAvg) : '—';
    const netLoad = online ? formatPercent(data.networkThreadLoad) : '—';
    const workLoad = online ? formatPercent(data.workThreadLoad) : '—';
    const stat = data.statistic || {};
    const version = data.version || {};
    const versionText = version.branchName
      ? (version.branchName + (version.commitHash ? ' · ' + version.commitHash : ''))
      : '—';

    let body =
      '<div class="admin-service-metrics">' +
        renderMetricBar('线程负载', data.threadLoadAvg, threadAvg) +
        renderPlainMetric('网络线程', netLoad + ' · ' + (data.networkThreadCount || 0) + ' 个') +
        renderPlainMetric('工作线程', workLoad + ' · ' + (data.workThreadCount || 0) + ' 个') +
        renderPlainMetric('MediaSource', String(stat.mediaSource != null ? stat.mediaSource : '—')) +
        renderPlainMetric('Socket', String(stat.socket != null ? stat.socket : '—')) +
      '</div>' +
      '<p class="admin-service-meta">版本 ' + escapeAudit(versionText) + '</p>';

    if (!online && data.error) {
      body += '<p class="admin-service-error">' + escapeAudit(data.error) + '</p>';
    } else if (data.apiBase) {
      body += '<p class="admin-service-meta">API ' + escapeAudit(data.apiBase) + '</p>';
    }

    return (
      '<article class="admin-service-card admin-service-card--media">' +
        renderServiceHead('媒体服务', statusClass, statusText, 'media') +
        body +
      '</article>'
    );
  }

  function renderServiceCards(signaling, media) {
    if (!serviceCards) return;
    serviceCards.innerHTML = renderSignalingCard(signaling) + renderMediaCard(media);
  }

  function switchAppPage(page) {
    const isDashboard = page === 'dashboard';
    const isMonitor = page === 'monitor';
    const isAudit = page === 'audit';
    document.querySelectorAll('.admin-nav-item[data-page]').forEach(function (el) {
      el.classList.toggle('active', el.dataset.page === page);
    });
    if (dashboardPage) {
      dashboardPage.classList.toggle('active', isDashboard);
      dashboardPage.setAttribute('aria-hidden', isDashboard ? 'false' : 'true');
    }
    if (monitorPage) {
      monitorPage.classList.toggle('active', isMonitor);
      monitorPage.setAttribute('aria-hidden', isMonitor ? 'false' : 'true');
    }
    if (auditPage) {
      auditPage.classList.toggle('active', isAudit);
      auditPage.setAttribute('aria-hidden', isAudit ? 'false' : 'true');
    }
    const monitorLivePanel = document.getElementById('monitorLivePanel');
    if (monitorLivePanel && !isMonitor) {
      monitorLivePanel.hidden = true;
      monitorLivePanel.classList.remove('active');
      monitorLivePanel.setAttribute('aria-hidden', 'true');
    }
    const mainEl = document.querySelector('.admin-main');
    if (mainEl) {
      mainEl.classList.toggle('admin-main--monitor', isMonitor);
      mainEl.classList.toggle('admin-main--audit', isAudit);
      if (isDashboard || isAudit) {
        mainEl.classList.remove('admin-main--monitor-live');
      }
    }
    if (isDashboard) {
      startDashboardPoll();
    } else {
      stopDashboardPoll();
    }
  }

  const AUDIT_ACTION_LABEL = {
    logout: '退出登录',
    observe_start: '开始旁观',
    observe_stop: '停止旁观',
    kick_member: '踢出成员',
    dissolve_room: '解散房间',
  };

  function formatAuditTime(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    );
  }

  function setAuditPageNavBtnState(btn, disabled) {
    if (!btn) return;
    btn.disabled = disabled;
    btn.classList.toggle('is-disabled', disabled);
    btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  function renderAuditPagination(total, totalPages) {
    if (!auditPagination) return;
    auditPagination.hidden = total <= 0;
    if (total <= 0) return;

    if (auditPageInfo) {
      auditPageInfo.textContent = '共 ' + total + ' 条，第 ' + auditCurrentPage + ' / ' + totalPages + ' 页';
    }
    if (auditPageSizeEl) {
      auditPageSizeEl.value = String(auditPageSize);
    }
    setAuditPageNavBtnState(auditPagePrev, auditCurrentPage <= 1);
    setAuditPageNavBtnState(auditPageNext, auditCurrentPage >= totalPages);
    if (auditPageInput) {
      auditPageInput.min = '1';
      auditPageInput.max = String(totalPages);
      auditPageInput.value = String(auditCurrentPage);
    }
  }

  function goToAuditPage(page) {
    const total = auditEntries.length;
    const totalPages = Math.max(1, Math.ceil(total / auditPageSize) || 1);
    const next = Math.min(Math.max(1, page), totalPages);
    if (next === auditCurrentPage) {
      renderAuditTable();
      return;
    }
    auditCurrentPage = next;
    renderAuditTable();
  }

  function jumpToAuditPageInput() {
    if (!auditPageInput) return;
    const totalPages = Math.max(1, Math.ceil(auditEntries.length / auditPageSize) || 1);
    const raw = Number(auditPageInput.value);
    if (!Number.isFinite(raw)) {
      showToast('请输入有效页码');
      return;
    }
    const page = Math.min(Math.max(1, Math.trunc(raw)), totalPages);
    if (page !== raw) {
      showToast('页码范围为 1–' + totalPages);
    }
    goToAuditPage(page);
  }

  function renderAuditTable() {
    if (!auditTableBody) return;

    const total = auditEntries.length;
    const totalPages = Math.max(1, Math.ceil(total / auditPageSize) || 1);
    if (auditCurrentPage > totalPages) auditCurrentPage = totalPages;
    if (auditCurrentPage < 1) auditCurrentPage = 1;

    const reversed = auditEntries.slice().reverse();
    const start = (auditCurrentPage - 1) * auditPageSize;
    const pageEntries = reversed.slice(start, start + auditPageSize);

    if (auditEmpty) auditEmpty.hidden = total > 0;
    auditTableBody.innerHTML = pageEntries.map(function (entry) {
      const action = AUDIT_ACTION_LABEL[entry.action] || entry.action || '—';
      return (
        '<tr>' +
          '<td>' + formatAuditTime(entry.time) + '</td>' +
          '<td>' + escapeAudit(entry.username) + '</td>' +
          '<td>' + escapeAudit(action) + '</td>' +
          '<td>' + escapeAudit(entry.room || '—') + '</td>' +
          '<td>' + escapeAudit(entry.detail || '—') + '</td>' +
        '</tr>'
      );
    }).join('');

    renderAuditPagination(total, totalPages);
  }

  function renderAuditLog(entries) {
    auditEntries = Array.isArray(entries) ? entries : [];
    if (auditCurrentPage > 1 && auditEntries.length <= (auditCurrentPage - 1) * auditPageSize) {
      auditCurrentPage = 1;
    }
    renderAuditTable();
  }

  function escapeAudit(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showConfirm(title, message) {
    return new Promise(function (resolve, reject) {
      if (!confirmDialog) {
        resolve(window.confirm(message));
        return;
      }
      if (confirmTitle) confirmTitle.textContent = title || '请确认';
      if (confirmMessage) confirmMessage.textContent = message || '';
      confirmDialog._resolve = resolve;
      confirmDialog._reject = function () { reject(new Error('cancelled')); };
      if (typeof confirmDialog.showModal === 'function') {
        confirmDialog.showModal();
      } else {
        resolve(window.confirm(message));
      }
    });
  }

  async function loadAuditLog() {
    if (auditLoading) return;
    auditLoading = true;
    try {
      const res = await fetch('/api/admin/audit-log', {
        headers: { 'X-Admin-Token': getToken() },
      });
      if (res.status === 401) {
        handleSessionExpired();
        return;
      }
      if (!res.ok) {
        throw new Error('加载失败 HTTP ' + res.status);
      }
      const data = await res.json();
      renderAuditLog(data.entries || []);
    } catch (err) {
      showToast(err.message || '加载操作日志失败');
    } finally {
      auditLoading = false;
    }
  }

  async function clearAuditLog() {
    try {
      await showConfirm('清空操作日志', '确定清空全部操作记录吗？此操作不可恢复。');
    } catch (_) {
      return;
    }
    try {
      const res = await fetch('/api/admin/audit-log', {
        method: 'DELETE',
        headers: { 'X-Admin-Token': getToken() },
      });
      const data = await res.json().catch(function () { return {}; });
      if (res.status === 401) {
        handleSessionExpired();
        return;
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data.message || ('清空失败 HTTP ' + res.status));
      }
      renderAuditLog([]);
      auditCurrentPage = 1;
      showToast('已清空操作日志');
    } catch (err) {
      showToast(err.message || '清空操作日志失败');
    }
  }

  window.__adminRefreshAudit = function () {
    loadAuditLog();
  };

  function handleSessionExpired(message, title) {
    stopWatchingAll();
    setToken('');
    endSession();
    showLogin();
    showLoginAlert(message || '登录已失效，请重新登录', title || '登录已失效');
  }

  function handleKick(data) {
    wsManualClose = true;
    handleSessionExpired(data.message || '账号已在其它地方登录', '已下线');
  }

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  }

  function showLogin() {
    stopWatchingAll();
    lastMediaSnapshot = null;
    loginView.classList.add('is-active');
    loginView.setAttribute('aria-hidden', 'false');
    appView.classList.remove('is-active');
    appView.setAttribute('aria-hidden', 'true');
    stopDashboardWs(true);
    stopDashboardPoll();
    stopSessionTimer();
    loginSubmit.disabled = false;
    loginSubmit.textContent = '登录';
  }

  function showApp() {
    resetNetworkFailureGuard();
    loginView.classList.remove('is-active');
    loginView.setAttribute('aria-hidden', 'true');
    appView.classList.add('is-active');
    appView.setAttribute('aria-hidden', 'false');
    beginSession();
    connectDashboardWs();
    startDashboardPoll();
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

  function dashboardWsUrl(token) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/api/admin/ws?token=' + encodeURIComponent(token);
  }

  function stopDashboardWs(manual) {
    wsManualClose = manual;
    if (dashboardWs) {
      dashboardWs.close();
      dashboardWs = null;
    }
    wsManualClose = false;
  }

  function connectDashboardWs() {
    const token = getToken();
    if (!token || !appView.classList.contains('is-active')) return;

    stopDashboardWs(true);
    wsManualClose = false;

    const ws = new WebSocket(dashboardWsUrl(token));
    dashboardWs = ws;

    ws.onmessage = function (event) {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.error(e);
        return;
      }
      if (data.type === 'kick') {
        handleKick(data);
        return;
      }
      if (data.type === 'audit') {
        renderAuditLog(data.entries || []);
        return;
      }
      if (data.type === 'dashboard') {
        applyDashboard(data);
        if (window.AdminMonitor?.refreshMembers) {
          window.AdminMonitor.refreshMembers();
        }
      }
    };

    ws.onclose = function () {
      if (dashboardWs === ws) dashboardWs = null;
      if (!wsManualClose && getToken() && appView.classList.contains('is-active')) {
        handleNetworkFailure();
      }
    };
  }

  function requestDashboardRefresh() {
    if (dashboardWs && dashboardWs.readyState === WebSocket.OPEN) {
      dashboardWs.send(JSON.stringify({ type: 'refresh' }));
      return;
    }
    loadDashboard();
  }

  function applyDashboard(data) {
    const hub = data.hub || {};
    if (totalRoomsEl) totalRoomsEl.textContent = hub.totalRooms != null ? hub.totalRooms : 0;
    if (totalClientsEl) totalClientsEl.textContent = hub.totalClients != null ? hub.totalClients : 0;
    if (data.media) {
      lastMediaSnapshot = data.media;
    }
    renderServiceCards(data.signaling, lastMediaSnapshot);
    renderRoomCards(hub);
    if (window.AdminMonitor?.updateMonitorHub) {
      window.AdminMonitor.updateMonitorHub(hub);
    }
    if (data.audit) {
      renderAuditLog(data.audit);
    }
  }

  async function apiLogin(username, password) {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password }),
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

  function renderRoomCards(hub) {
    const byMode = hub.roomsByMode || {};
    const clientsByMode = hub.clientsByMode || {};

    roomCards.innerHTML = ROOM_TYPES.map(function (type) {
      return (
        '<article class="admin-room-card admin-room-card--' + type.key + '">' +
          '<div class="admin-room-card-head">' +
            renderRoomIcon(type) +
            '<h3 class="admin-room-card-label">' + type.label + '</h3>' +
          '</div>' +
          '<p class="admin-room-card-desc">' + type.desc + '</p>' +
          renderCardStats(type, hub, byMode, clientsByMode) +
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
        handleSessionExpired('登录已失效，请重新登录');
        return null;
      }
      applyDashboard(data);
      return data;
    } catch (e) {
      console.error(e);
      if (appView.classList.contains('is-active')) {
        handleNetworkFailure();
      }
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
    const username = loginUsername.value.trim();
    const password = loginPassword.value;
    if (!username) {
      showLoginAlert('请输入管理员名称');
      return;
    }
    if (!password) {
      showLoginAlert('请输入密码');
      return;
    }

    loginSubmit.disabled = true;
    loginSubmit.textContent = '登录中…';

    try {
      const res = await apiLogin(username, password);
      if (!res.ok) {
        showLoginAlert(res.message || '登录失败，请检查管理员名称和密码');
        return;
      }

      setToken(res.token);
      loginPassword.value = '';
      sessionStorage.setItem(LOGIN_AT_KEY, String(Date.now()));
      showApp();
    } catch (err) {
      showLoginAlert('网络错误，请稍后重试');
      console.error(err);
    } finally {
      loginSubmit.disabled = false;
      loginSubmit.textContent = '登录';
    }
  });

  logoutBtn.addEventListener('click', async function () {
    const token = getToken();
    stopWatchingAll();
    if (token) {
      try {
        await fetch('/api/admin/logout', {
          method: 'POST',
          headers: { 'X-Admin-Token': token },
        });
      } catch (e) {
        console.error(e);
      }
    }
    setToken('');
    endSession();
    loginPassword.value = '';
    showLogin();
  });

  refreshBtn.addEventListener('click', requestDashboardRefresh);

  if (dashboardTab) {
    dashboardTab.addEventListener('click', function () {
      switchAppPage('dashboard');
      requestDashboardRefresh();
    });
  }

  if (monitorTab) {
    monitorTab.addEventListener('click', function () {
      switchAppPage('monitor');
      requestDashboardRefresh();
    });
  }

  if (auditTab) {
    auditTab.addEventListener('click', function () {
      switchAppPage('audit');
      loadAuditLog();
    });
  }

  if (auditRefreshBtn) {
    auditRefreshBtn.addEventListener('click', loadAuditLog);
  }

  if (auditClearBtn) {
    auditClearBtn.addEventListener('click', clearAuditLog);
  }

  if (auditPagePrev) {
    auditPagePrev.addEventListener('click', function () {
      if (auditPagePrev.disabled || auditPagePrev.classList.contains('is-disabled')) return;
      goToAuditPage(auditCurrentPage - 1);
    });
  }
  if (auditPageNext) {
    auditPageNext.addEventListener('click', function () {
      if (auditPageNext.disabled || auditPageNext.classList.contains('is-disabled')) return;
      goToAuditPage(auditCurrentPage + 1);
    });
  }
  if (auditPageGo) {
    auditPageGo.addEventListener('click', jumpToAuditPageInput);
  }
  if (auditPageInput) {
    auditPageInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        jumpToAuditPageInput();
      }
    });
  }
  if (auditPageSizeEl) {
    auditPageSizeEl.value = String(auditPageSize);
    auditPageSizeEl.addEventListener('change', function () {
      const next = Number(auditPageSizeEl.value);
      if (!AUDIT_PAGE_SIZE_OPTIONS.includes(next)) return;
      auditPageSize = next;
      auditCurrentPage = 1;
      renderAuditTable();
    });
  }

  tryRestoreSession();
})();
