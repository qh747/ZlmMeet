import { Signaling } from '/js/signaling.js';
import { playStream, closePC, attachMediaStreamToVideo } from '/js/webrtc.js';
import { shouldMirrorVideo } from '/js/video-flip.js';

const PAGE_SIZE_OPTIONS = [5, 10, 20];
const MAX_TILES = 16;
const CAROUSEL_INTERVAL_MIN = 5;
const CAROUSEL_INTERVAL_MAX = 60;
const CAROUSEL_INTERVAL_DEFAULT = 5;
const LAYOUTS = {
  '2x2': { cols: 2, rows: 2, capacity: 4 },
  '2x3': { cols: 2, rows: 3, capacity: 6 },
  '3x2': { cols: 3, rows: 2, capacity: 6 },
  '3x3': { cols: 3, rows: 3, capacity: 9 },
  '4x4': { cols: 4, rows: 4, capacity: 16 },
};
const BIZ_LABEL = { meeting: '视频会议', call: '1v1 通话', push: '推流', pull: '拉流' };

const WATCH_CTRL_ICON = {
  audioOn:
    '<svg class="admin-watch-ctrl-icon admin-watch-ctrl-icon--on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
      '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>' +
      '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>' +
    '</svg>',
  audioOff:
    '<svg class="admin-watch-ctrl-icon admin-watch-ctrl-icon--off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
      '<line x1="23" y1="9" x2="17" y2="15"/>' +
      '<line x1="17" y1="9" x2="23" y2="15"/>' +
    '</svg>',
  videoOn:
    '<svg class="admin-watch-ctrl-icon admin-watch-ctrl-icon--on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M23 7l-7 5 7 5V7z"/>' +
      '<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>' +
    '</svg>',
  videoOff:
    '<svg class="admin-watch-ctrl-icon admin-watch-ctrl-icon--off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>' +
      '<path d="M17 5h2a2 2 0 0 1 2 2v9.34"/>' +
      '<line x1="1" y1="1" x2="23" y2="23"/>' +
    '</svg>',
  pinOn:
    '<svg class="admin-watch-ctrl-icon admin-watch-ctrl-icon--on" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">' +
      '<path d="M16 3v4l-1.5 1.5 4 4L22 11V3h-6zM8.5 7.5L4 12v8h6v-4.5l1.5-1.5-3-3z"/>' +
    '</svg>',
  pinOff:
    '<svg class="admin-watch-ctrl-icon admin-watch-ctrl-icon--off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 2v5l-2 2v3l-5 5v3h10v-3l-2-2"/>' +
      '<path d="M19 3l-4 4"/>' +
      '<path d="M15 7l4-4"/>' +
    '</svg>',
  fitCover:
    '<svg class="admin-watch-ctrl-icon admin-watch-ctrl-icon--on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 7V5a2 2 0 0 1 2-2h2"/>' +
      '<path d="M17 3h2a2 2 0 0 1 2 2v2"/>' +
      '<path d="M21 17v2a2 2 0 0 1-2 2h-2"/>' +
      '<path d="M7 21H5a2 2 0 0 1-2-2v-2"/>' +
      '<path d="M8 12h8"/>' +
      '<path d="M12 8v8"/>' +
    '</svg>',
  fitContain:
    '<svg class="admin-watch-ctrl-icon admin-watch-ctrl-icon--off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="4" y="6" width="16" height="12" rx="1"/>' +
      '<rect x="7" y="9" width="10" height="6" rx="0.5"/>' +
    '</svg>',
};

let getTokenFn = () => '';
let showToastFn = (msg) => window.alert(msg);
let onSessionEndFn = () => {};

const roomSessions = new Map();
const tiles = new Map();
const watchOrder = [];
const roomEndScheduled = new Set();
let slots = [];
let latestHub = null;
let pendingRoom = null;
let appliedSearch = '';
let appliedTypeFilter = '';
let appliedMemberSearch = '';
let appliedMemberRoomSearch = '';
let appliedMemberTypeFilter = '';
let currentPage = 1;
let pageSize = 10;
let memberCurrentPage = 1;
let memberPageSize = 10;
let latestMembers = [];
let membersLoading = false;
let currentMonitorTab = 'rooms';
let pointerDrag = { active: false, sourceIndex: null, pointerId: null };
let currentLayoutKey = '2x2';
let carouselIntervalSec = CAROUSEL_INTERVAL_DEFAULT;
let carouselTimer = null;
let carouselBatchIndex = 0;

const els = {};

export function initAdminMonitor(deps) {
  getTokenFn = deps.getToken;
  showToastFn = deps.showToast;
  onSessionEndFn = deps.onSessionEnd || (() => {});

  els.tableBody = document.getElementById('monitorTableBody');
  els.empty = document.getElementById('monitorEmpty');
  els.search = document.getElementById('monitorSearch');
  els.typeFilter = document.getElementById('monitorTypeFilter');
  els.memberTypeFilter = document.getElementById('monitorMemberTypeFilter');
  els.memberRoomSearch = document.getElementById('monitorMemberRoomSearch');
  els.memberSearchBtn = document.getElementById('monitorMemberSearchBtn');
  els.liveCount = document.getElementById('liveCount');
  els.watchGrid = document.getElementById('watchGrid');
  els.layoutPicker = document.getElementById('watchLayoutPicker');
  els.carouselInterval = document.getElementById('watchCarouselInterval');
  els.roomsPanel = document.getElementById('monitorRoomsPanel');
  els.membersPanel = document.getElementById('monitorMembersPanel');
  els.listPanels = document.getElementById('monitorListPanels');
  els.memberSearch = document.getElementById('monitorMemberSearch');
  els.memberTableBody = document.getElementById('monitorMemberTableBody');
  els.memberEmpty = document.getElementById('monitorMemberEmpty');
  els.memberPagination = document.getElementById('monitorMemberPagination');
  els.memberPageInfo = document.getElementById('monitorMemberPageInfo');
  els.memberPagePrev = document.getElementById('monitorMemberPagePrev');
  els.memberPageNext = document.getElementById('monitorMemberPageNext');
  els.memberPageInput = document.getElementById('monitorMemberPageInput');
  els.memberPageGo = document.getElementById('monitorMemberPageGo');
  els.memberPageSize = document.getElementById('monitorMemberPageSize');
  els.confirmDialog = document.getElementById('adminConfirmDialog');
  els.confirmTitle = document.getElementById('adminConfirmTitle');
  els.confirmMessage = document.getElementById('adminConfirmMessage');
  els.confirmOk = document.getElementById('adminConfirmOk');
  els.confirmCancel = document.getElementById('adminConfirmCancel');
  els.livePanel = document.getElementById('monitorLivePanel');
  els.memberDialog = document.getElementById('memberPickDialog');
  els.memberList = document.getElementById('memberPickList');
  els.memberRoom = document.getElementById('memberPickRoom');
  els.memberCancel = document.getElementById('memberPickCancel');
  els.roomViewDialog = document.getElementById('roomViewDialog');
  els.roomViewRoom = document.getElementById('roomViewRoom');
  els.roomViewList = document.getElementById('roomViewList');
  els.roomViewEmpty = document.getElementById('roomViewEmpty');
  els.roomViewClose = document.getElementById('roomViewClose');
  els.searchBtn = document.getElementById('monitorSearchBtn');
  els.monitorPage = document.getElementById('monitorPage');
  els.pagination = document.getElementById('monitorPagination');
  els.pageInfo = document.getElementById('monitorPageInfo');
  els.pagePrev = document.getElementById('monitorPagePrev');
  els.pageNext = document.getElementById('monitorPageNext');
  els.pageInput = document.getElementById('monitorPageInput');
  els.pageGo = document.getElementById('monitorPageGo');
  els.pageSize = document.getElementById('monitorPageSize');

  document.querySelectorAll('[data-monitor-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchMonitorTab(btn.dataset.monitorTab));
  });

  if (els.searchBtn) {
    els.searchBtn.addEventListener('click', applyRoomFilters);
  }
  if (els.search) {
    els.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyRoomFilters();
      }
    });
  }
  if (els.typeFilter) {
    els.typeFilter.addEventListener('change', applyRoomFilters);
  }
  if (els.memberSearchBtn) {
    els.memberSearchBtn.addEventListener('click', applyMemberFilters);
  }
  if (els.memberSearch) {
    els.memberSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyMemberFilters();
      }
    });
  }
  if (els.memberRoomSearch) {
    els.memberRoomSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyMemberFilters();
      }
    });
  }
  if (els.memberTypeFilter) {
    els.memberTypeFilter.addEventListener('change', applyMemberFilters);
  }
  if (els.memberCancel) {
    els.memberCancel.addEventListener('click', () => els.memberDialog?.close());
  }
  if (els.roomViewClose) {
    els.roomViewClose.addEventListener('click', () => els.roomViewDialog?.close());
  }
  if (els.pagePrev) {
    els.pagePrev.addEventListener('click', () => {
      if (els.pagePrev.disabled || els.pagePrev.classList.contains('is-disabled')) return;
      goToPage(currentPage - 1);
    });
  }
  if (els.pageNext) {
    els.pageNext.addEventListener('click', () => {
      if (els.pageNext.disabled || els.pageNext.classList.contains('is-disabled')) return;
      goToPage(currentPage + 1);
    });
  }
  if (els.pageGo) {
    els.pageGo.addEventListener('click', jumpToPageInput);
  }
  if (els.pageInput) {
    els.pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        jumpToPageInput();
      }
    });
  }
  if (els.pageSize) {
    els.pageSize.value = String(pageSize);
    els.pageSize.addEventListener('change', () => {
      const next = Number(els.pageSize.value);
      if (!PAGE_SIZE_OPTIONS.includes(next)) return;
      pageSize = next;
      currentPage = 1;
      renderRoomTable();
    });
  }

  if (els.memberPagePrev) {
    els.memberPagePrev.addEventListener('click', () => {
      if (els.memberPagePrev.disabled || els.memberPagePrev.classList.contains('is-disabled')) return;
      goToMemberPage(memberCurrentPage - 1);
    });
  }
  if (els.memberPageNext) {
    els.memberPageNext.addEventListener('click', () => {
      if (els.memberPageNext.disabled || els.memberPageNext.classList.contains('is-disabled')) return;
      goToMemberPage(memberCurrentPage + 1);
    });
  }
  if (els.memberPageGo) {
    els.memberPageGo.addEventListener('click', jumpToMemberPageInput);
  }
  if (els.memberPageInput) {
    els.memberPageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        jumpToMemberPageInput();
      }
    });
  }
  if (els.memberPageSize) {
    els.memberPageSize.value = String(memberPageSize);
    els.memberPageSize.addEventListener('change', () => {
      const next = Number(els.memberPageSize.value);
      if (!PAGE_SIZE_OPTIONS.includes(next)) return;
      memberPageSize = next;
      memberCurrentPage = 1;
      renderMemberTable();
    });
  }
  if (els.confirmCancel) {
    els.confirmCancel.addEventListener('click', () => {
      els.confirmDialog?.close();
      if (els.confirmDialog?._reject) {
        els.confirmDialog._reject();
        els.confirmDialog._reject = null;
      }
    });
  }
  if (els.confirmDialog) {
    els.confirmDialog.addEventListener('cancel', () => {
      if (els.confirmDialog._reject) {
        els.confirmDialog._reject();
        els.confirmDialog._reject = null;
      }
    });
  }
  if (els.confirmOk) {
    els.confirmOk.addEventListener('click', () => {
      els.confirmDialog?.close();
      if (els.confirmDialog?._resolve) {
        els.confirmDialog._resolve(true);
        els.confirmDialog._resolve = null;
      }
    });
  }

  if (els.layoutPicker) {
    els.layoutPicker.querySelectorAll('.admin-watch-layout-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        setLayoutKey(btn.dataset.layout);
      });
    });
    updateLayoutPickerUI();
  }
  if (els.carouselInterval) {
    els.carouselInterval.value = String(carouselIntervalSec);
    els.carouselInterval.addEventListener('change', onCarouselIntervalChange);
    els.carouselInterval.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onCarouselIntervalChange();
      }
    });
  }

  applyGridLayoutClass();
  renderWatchSlots();
  setupGridDragDrop();
  switchMonitorTab('rooms');
}

function getLayoutCapacity() {
  return LAYOUTS[currentLayoutKey]?.capacity ?? 4;
}

function needsCarousel() {
  return tiles.size > getLayoutCapacity();
}

function applyGridLayoutClass() {
  if (!els.watchGrid) return;
  Object.keys(LAYOUTS).forEach((key) => {
    els.watchGrid.classList.remove('admin-watch-grid--' + key);
  });
  els.watchGrid.classList.add('admin-watch-grid--' + currentLayoutKey);
}

function setLayoutKey(layoutKey) {
  if (!LAYOUTS[layoutKey] || layoutKey === currentLayoutKey) return;
  currentLayoutKey = layoutKey;
  clearAllPins();
  carouselBatchIndex = 0;
  applyGridLayoutClass();
  updateLayoutPickerUI();
  renderWatchSlots();
  redistributeSlots();
}

function updateLayoutPickerUI() {
  if (!els.layoutPicker) return;
  els.layoutPicker.querySelectorAll('.admin-watch-layout-btn').forEach((btn) => {
    const active = btn.dataset.layout === currentLayoutKey;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function onCarouselIntervalChange() {
  const raw = Number(els.carouselInterval?.value);
  if (!Number.isFinite(raw)) {
    showToastFn('请输入有效的轮播间隔');
    if (els.carouselInterval) els.carouselInterval.value = String(carouselIntervalSec);
    return;
  }
  const next = Math.min(CAROUSEL_INTERVAL_MAX, Math.max(CAROUSEL_INTERVAL_MIN, Math.trunc(raw)));
  if (next !== raw) {
    showToastFn('轮播间隔范围为 5–60 秒');
  }
  carouselIntervalSec = next;
  if (els.carouselInterval) els.carouselInterval.value = String(next);
  if (needsCarousel()) {
    stopCarouselTimer();
    startCarouselTimer();
  }
}

function startCarouselTimer() {
  stopCarouselTimer();
  if (!needsCarousel()) return;
  carouselTimer = setInterval(() => {
    if (!needsCarousel()) {
      stopCarouselTimer();
      return;
    }
    carouselBatchIndex++;
    applyCarouselBatch();
  }, carouselIntervalSec * 1000);
}

function stopCarouselTimer() {
  if (carouselTimer) {
    clearInterval(carouselTimer);
    carouselTimer = null;
  }
}

function clearAllPins() {
  slots.forEach((slot) => {
    slot.pinned = false;
    slot.pinnedTileKey = null;
    slot.el?.classList.remove('admin-watch-slot--pinned');
  });
  tiles.forEach((tile) => {
    tile.pinnedSlotIndex = null;
  });
}

function getUnpinnedTileKeys() {
  return watchOrder.filter((key) => {
    const tile = tiles.get(key);
    return tile && tile.pinnedSlotIndex === null;
  });
}

function getCarouselSlotIndices() {
  return slots.map((_, i) => i).filter((i) => !slots[i].pinned);
}

function createTileVideo({ sourcePlatform = 'desktop', isScreen = false } = {}) {
  const video = document.createElement('video');
  video.className = 'admin-watch-video admin-watch-video--fit-contain';
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;

  if (!shouldMirrorVideo({ sourcePlatform, isScreen })) {
    return video;
  }

  const wrap = document.createElement('div');
  wrap.className = 'admin-watch-video-flip';
  wrap.appendChild(video);
  return video;
}

function tileVideoMount(tile) {
  return tile?.video?.closest?.('.admin-watch-video-flip') || tile?.video;
}

function applyVideoFit(tile) {
  if (!tile?.video) return;
  const cover = tile.videoFit !== 'contain';
  tile.video.classList.toggle('admin-watch-video--fit-cover', cover);
  tile.video.classList.toggle('admin-watch-video--fit-contain', !cover);
}

function applyRoomFilters() {
  appliedSearch = (els.search?.value || '').trim().toLowerCase();
  appliedTypeFilter = els.typeFilter?.value || '';
  currentPage = 1;
  renderRoomTable();
}

function applyMemberFilters() {
  appliedMemberRoomSearch = (els.memberRoomSearch?.value || '').trim().toLowerCase();
  appliedMemberSearch = (els.memberSearch?.value || '').trim().toLowerCase();
  appliedMemberTypeFilter = els.memberTypeFilter?.value || '';
  memberCurrentPage = 1;
  renderMemberTable();
}

function applyFilters() {
  applyRoomFilters();
  applyMemberFilters();
}

function showConfirm(title, message) {
  return new Promise((resolve, reject) => {
    if (!els.confirmDialog) {
      resolve(window.confirm(message));
      return;
    }
    if (els.confirmTitle) els.confirmTitle.textContent = title || '请确认';
    if (els.confirmMessage) els.confirmMessage.textContent = message || '';
    els.confirmDialog._resolve = resolve;
    els.confirmDialog._reject = () => reject(new Error('cancelled'));
    if (typeof els.confirmDialog.showModal === 'function') {
      els.confirmDialog.showModal();
    } else {
      resolve(window.confirm(message));
    }
  });
}

async function adminApiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': getTokenFn(),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || ('请求失败 HTTP ' + res.status));
  }
  return data;
}

async function loadMembers() {
  if (membersLoading) return;
  membersLoading = true;
  try {
    const res = await fetch('/api/admin/members', {
      headers: { 'X-Admin-Token': getTokenFn() },
    });
    if (res.status === 401) {
      window.__adminHandleNetworkFailure?.();
      return;
    }
    const data = await res.json();
    latestMembers = data.members || [];
    if (data.zlmError) {
      console.warn('getMediaList:', data.zlmError);
    }
    renderMemberTable();
  } catch (err) {
    console.error(err);
    showToastFn(err.message || '加载成员列表失败');
  } finally {
    membersLoading = false;
  }
}

function filterMembers() {
  return latestMembers.filter((row) => {
    if (appliedMemberTypeFilter && row.biz !== appliedMemberTypeFilter) return false;
    if (appliedMemberRoomSearch && !String(row.roomDisplay || row.roomId || '').toLowerCase().includes(appliedMemberRoomSearch)) {
      return false;
    }
    if (appliedMemberSearch && !String(row.nickname || '').toLowerCase().includes(appliedMemberSearch)) {
      return false;
    }
    return true;
  });
}

function renderMemberTable() {
  if (!els.memberTableBody) return;
  const rows = filterMembers();
  const totalPages = Math.max(1, Math.ceil(rows.length / memberPageSize) || 1);
  if (memberCurrentPage > totalPages) memberCurrentPage = totalPages;
  if (memberCurrentPage < 1) memberCurrentPage = 1;

  const start = (memberCurrentPage - 1) * memberPageSize;
  const pageRows = rows.slice(start, start + memberPageSize);

  if (els.memberEmpty) els.memberEmpty.hidden = rows.length > 0;
  els.memberTableBody.innerHTML = pageRows.map((row) => {
    const status = row.streamId
      ? (row.streamOnline ? '在线' : '离线')
      : '—';
    return (
      '<tr>' +
        '<td>' + escapeHtml(BIZ_LABEL[row.biz] || row.biz) + '</td>' +
        '<td>' + escapeHtml(row.roomDisplay || row.roomId) + '</td>' +
        '<td>' + escapeHtml(row.nickname) + '</td>' +
        '<td>' + escapeHtml(row.streamLabel || '—') + '</td>' +
        '<td>' + status + '</td>' +
        '<td>' + (row.recording ? '录制中' : '—') + '</td>' +
        '<td class="admin-monitor-actions">' +
          '<button type="button" class="admin-action-btn admin-action-btn--watch" ' +
            'data-watch-room="' + escapeAttr(row.roomId) + '" ' +
            'data-watch-user="' + escapeAttr(row.userId) + '" ' +
            'data-watch-biz="' + escapeAttr(row.biz) + '" ' +
            'data-watch-kind="' + escapeAttr(row.streamKind || '') + '" ' +
            'data-watch-stream="' + escapeAttr(row.streamId || '') + '" ' +
            'data-watch-name="' + escapeAttr(row.nickname) + '">观看</button>' +
          '<button type="button" class="admin-action-btn admin-action-btn--danger" ' +
            'data-kick-room="' + escapeAttr(row.roomId) + '" ' +
            'data-kick-user="' + escapeAttr(row.userId) + '" ' +
            'data-kick-name="' + escapeAttr(row.nickname) + '">踢出</button>' +
        '</td>' +
      '</tr>'
    );
  }).join('');

  els.memberTableBody.querySelectorAll('[data-kick-room]').forEach((btn) => {
    btn.addEventListener('click', () => {
      onKickMember(btn.dataset.kickRoom, btn.dataset.kickUser, btn.dataset.kickName);
    });
  });
  els.memberTableBody.querySelectorAll('[data-watch-room]').forEach((btn) => {
    btn.addEventListener('click', () => {
      onWatchMemberRow({
        roomId: btn.dataset.watchRoom,
        userId: btn.dataset.watchUser,
        biz: btn.dataset.watchBiz,
        streamKind: btn.dataset.watchKind,
        streamId: btn.dataset.watchStream,
        nickname: btn.dataset.watchName,
      });
    });
  });

  renderMemberPagination(rows.length, totalPages);
}

function renderMemberPagination(total, totalPages) {
  if (!els.memberPagination) return;
  els.memberPagination.hidden = total <= 0;
  if (total <= 0) return;
  if (els.memberPageInfo) {
    els.memberPageInfo.textContent = '共 ' + total + ' 条，第 ' + memberCurrentPage + ' / ' + totalPages + ' 页';
  }
  if (els.memberPageSize) els.memberPageSize.value = String(memberPageSize);
  setPageNavBtnState(els.memberPagePrev, memberCurrentPage <= 1);
  setPageNavBtnState(els.memberPageNext, memberCurrentPage >= totalPages);
  if (els.memberPageInput) {
    els.memberPageInput.min = '1';
    els.memberPageInput.max = String(totalPages);
    els.memberPageInput.value = String(memberCurrentPage);
  }
}

function goToMemberPage(page) {
  const rows = filterMembers();
  const totalPages = Math.max(1, Math.ceil(rows.length / memberPageSize) || 1);
  const next = Math.min(Math.max(1, page), totalPages);
  if (next === memberCurrentPage) return;
  memberCurrentPage = next;
  renderMemberTable();
}

function jumpToMemberPageInput() {
  if (!els.memberPageInput) return;
  const rows = filterMembers();
  const totalPages = Math.max(1, Math.ceil(rows.length / memberPageSize) || 1);
  const raw = Number(els.memberPageInput.value);
  if (!Number.isFinite(raw)) {
    showToastFn('请输入有效页码');
    return;
  }
  goToMemberPage(Math.min(Math.max(1, Math.trunc(raw)), totalPages));
}

async function onKickMember(roomId, userId, nickname) {
  try {
    await showConfirm('踢出成员', '确定将成员「' + (nickname || userId) + '」从房间「' + roomId + '」踢出吗？');
  } catch (_) {
    return;
  }
  try {
    await adminApiPost('/api/admin/rooms/kick', { room: roomId, userId });
    stopTilesForMember(roomId, userId);
    showToastFn('已踢出成员');
    await loadMembers();
  } catch (err) {
    showToastFn(err.message || '踢出失败');
  }
}

function stopTilesForMember(roomId, userId) {
  let changed = false;
  for (const key of [...tiles.keys()]) {
    if (key.startsWith(roomId + ':' + userId + ':')) {
      stopTile(key, false);
      changed = true;
    }
  }
  if (changed) updateLiveCount();
}

function findHubRoom(roomId) {
  return latestHub?.rooms?.find((r) => r.id === roomId);
}

function openRoomMembersView(room) {
  const biz = roomBizType(room);
  if (els.roomViewRoom) {
    els.roomViewRoom.innerHTML =
      '<span class="admin-member-dialog-room-label">房间</span>' +
      '<span class="admin-member-dialog-room-name">' + escapeHtml(roomDisplayName(room, biz)) + '</span>';
  }
  const members = (room.clients || []).filter((c) => !c.isObserver);
  if (els.roomViewEmpty) els.roomViewEmpty.hidden = members.length > 0;
  if (!els.roomViewList) return;

  if (!members.length) {
    els.roomViewList.innerHTML = '';
  } else {
    els.roomViewList.innerHTML = members.map((c) => {
      const lines = describeMemberStreams(c, biz);
      return (
        '<li class="admin-member-pick-row">' +
          '<div class="admin-member-pick-item admin-member-pick-item--static">' +
            '<span class="admin-member-pick-avatar" aria-hidden="true">' + escapeHtml(memberInitial(c.nickname)) + '</span>' +
            '<span class="admin-member-pick-meta">' +
              '<span class="admin-member-pick-name">' + escapeHtml(c.nickname || c.userId) + '</span>' +
              '<span class="admin-member-pick-kind">' + escapeHtml(lines) + '</span>' +
            '</span>' +
          '</div>' +
        '</li>'
      );
    }).join('');
  }

  if (typeof els.roomViewDialog.showModal === 'function') {
    els.roomViewDialog.showModal();
  }
}

function describeMemberStreams(client, biz) {
  if (biz === 'push') {
    if (client.soloRole === 'play') {
      return '拉流成员';
    }
    const solo = (client.streams || []).find((s) => s.kind === 'solo');
    const sid = solo?.streamId || client.plannedStreamId || '';
    return sid ? '推流 · ' + sid : '推流成员';
  }
  const parts = [];
  for (const s of client.streams || []) {
    if (s.kind === 'cam') parts.push('摄像头');
    else if (s.kind === 'screen') parts.push('屏幕共享');
    else if (s.kind === 'solo') parts.push('推流 · ' + s.streamId);
    else parts.push(s.kind);
  }
  if (!parts.length) {
    if (client.camOn) parts.push('摄像头（未推流）');
    return parts.length ? parts.join('、') : '在线';
  }
  return parts.join('、');
}

async function onWatchMemberRow(row) {
  const room = findHubRoom(row.roomId);
  if (!room) {
    showToastFn('房间不存在或已结束');
    return;
  }
  if (row.biz === 'pull') {
    if (!row.streamId) {
      showToastFn('该成员尚未拉流');
      return;
    }
    await startPushTile(room, row.streamId, row.nickname, row.clientPlatform);
    return;
  }
  if (row.biz === 'push') {
    if (!row.streamId) {
      showToastFn('当前没有可观看的推流');
      return;
    }
    await startPushTile(room, row.streamId, row.nickname, row.clientPlatform);
    return;
  }
  if (row.streamKind === 'cam' || row.streamKind === 'screen') {
    const label = row.streamKind === 'screen' ? '屏幕共享' : '摄像头';
    await startMemberTile(room, row.userId, row.streamKind, label, row.clientPlatform);
    return;
  }
  showToastFn('暂无可观看的画面');
}

async function onDissolveRoom(room) {
  const biz = roomBizType(room);
  const name = roomDisplayName(room, biz);
  try {
    await showConfirm('解散房间', '确定解散房间「' + name + '」吗？将踢出全部成员并结束业务。');
  } catch (_) {
    return;
  }
  try {
    await adminApiPost('/api/admin/rooms/dissolve', { room: room.id });
    showToastFn('房间已解散');
    await loadMembers();
  } catch (err) {
    showToastFn(err.message || '解散失败');
  }
}

export function updateMonitorHub(hub) {
  latestHub = hub;
  renderRoomTable();
  syncTilesWithHub(hub);
}

export async function stopAllWatching() {
  stopCarouselTimer();
  roomEndScheduled.clear();
  for (const key of [...tiles.keys()]) {
    stopTile(key, false);
  }
  watchOrder.length = 0;
  for (const [roomId, session] of roomSessions.entries()) {
    try {
      session.sig?.send('observe-leave', {});
    } catch (_) {}
    session.sig?.close();
    roomSessions.delete(roomId);
  }
  updateLiveCount();
}

function roomBizType(room) {
  if ((room.realMembers ?? room.members) < 1) return null;
  if (room.mode === 'meeting') return 'meeting';
  if (room.mode === 'call') return 'call';
  if (room.mode === 'solo') {
    const hasPush = (room.clients || []).some(
      (c) => !c.isObserver && c.soloRole === 'push',
    );
    return hasPush ? 'push' : null;
  }
  return null;
}

function pushStreamName(room) {
  const pusher = (room.clients || []).find((c) => !c.isObserver && c.soloRole === 'push');
  if (!pusher) return '';
  const live = (pusher.streams || []).find((s) => s.kind === 'solo');
  return live?.streamId || pusher.plannedStreamId || '';
}

function roomDisplayName(room, biz) {
  if (biz !== 'push') return room.id;
  const streamName = pushStreamName(room);
  return streamName ? room.id + '/' + streamName : room.id;
}

function filterRooms() {
  if (!latestHub?.rooms) return [];
  return latestHub.rooms.filter((room) => {
    const biz = roomBizType(room);
    if (!biz) return false;
    if (appliedTypeFilter && biz !== appliedTypeFilter) return false;
    if (appliedSearch && !roomDisplayName(room, biz).toLowerCase().includes(appliedSearch)) return false;
    return true;
  });
}

function roomOnlineCount(room, biz) {
  const clients = (room.clients || []).filter((c) => !c.isObserver);
  if (biz === 'push') {
    return clients.filter((c) => c.soloRole === 'play').length;
  }
  return room.realMembers ?? clients.length;
}

function renderRoomTable() {
  if (!els.tableBody) return;
  const rooms = filterRooms();
  const totalPages = Math.max(1, Math.ceil(rooms.length / pageSize) || 1);
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const start = (currentPage - 1) * pageSize;
  const pageRooms = rooms.slice(start, start + pageSize);

  if (els.empty) els.empty.hidden = rooms.length > 0;
  els.tableBody.innerHTML = pageRooms.map((room) => {
    const biz = roomBizType(room);
    return (
      '<tr>' +
        '<td>' + escapeHtml(BIZ_LABEL[biz] || biz) + '</td>' +
        '<td>' + escapeHtml(roomDisplayName(room, biz)) + '</td>' +
        '<td>' + roomOnlineCount(room, biz) + '</td>' +
        '<td class="admin-monitor-actions">' +
          '<button type="button" class="admin-action-btn admin-action-btn--watch" data-view-room-id="' + escapeAttr(room.id) + '">查看</button>' +
          '<button type="button" class="admin-watch-btn" data-room-id="' + escapeAttr(room.id) + '">观看</button>' +
          '<button type="button" class="admin-action-btn admin-action-btn--danger" data-dissolve-room="' + escapeAttr(room.id) + '">解散</button>' +
        '</td>' +
      '</tr>'
    );
  }).join('');

  els.tableBody.querySelectorAll('.admin-watch-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const room = latestHub.rooms.find((r) => r.id === btn.dataset.roomId);
      if (room) onWatchRoom(room);
    });
  });
  els.tableBody.querySelectorAll('[data-view-room-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const room = latestHub?.rooms?.find((r) => r.id === btn.dataset.viewRoomId);
      if (room) openRoomMembersView(room);
    });
  });
  els.tableBody.querySelectorAll('[data-dissolve-room]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const room = latestHub.rooms.find((r) => r.id === btn.dataset.dissolveRoom);
      if (room) onDissolveRoom(room);
    });
  });

  renderPagination(rooms.length, totalPages);
}

function setPageNavBtnState(btn, disabled) {
  if (!btn) return;
  btn.disabled = disabled;
  btn.classList.toggle('is-disabled', disabled);
  btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
}

function renderPagination(total, totalPages) {
  if (!els.pagination) return;
  els.pagination.hidden = total <= 0;
  if (total <= 0) return;

  if (els.pageInfo) {
    els.pageInfo.textContent = '共 ' + total + ' 条，第 ' + currentPage + ' / ' + totalPages + ' 页';
  }
  if (els.pageSize) {
    els.pageSize.value = String(pageSize);
  }
  setPageNavBtnState(els.pagePrev, currentPage <= 1);
  setPageNavBtnState(els.pageNext, currentPage >= totalPages);
  if (els.pageInput) {
    els.pageInput.min = '1';
    els.pageInput.max = String(totalPages);
    els.pageInput.value = String(currentPage);
  }
}

function goToPage(page) {
  const rooms = filterRooms();
  const totalPages = Math.max(1, Math.ceil(rooms.length / pageSize) || 1);
  const next = Math.min(Math.max(1, page), totalPages);
  if (next === currentPage) return;
  currentPage = next;
  renderRoomTable();
}

function jumpToPageInput() {
  if (!els.pageInput) return;
  const rooms = filterRooms();
  const totalPages = Math.max(1, Math.ceil(rooms.length / pageSize) || 1);
  const raw = Number(els.pageInput.value);
  if (!Number.isFinite(raw)) {
    showToastFn('请输入有效页码');
    return;
  }
  const page = Math.min(Math.max(1, Math.trunc(raw)), totalPages);
  if (page !== raw) {
    showToastFn('页码范围为 1–' + totalPages);
  }
  goToPage(page);
}

function onWatchRoom(room) {
  if (tiles.size >= MAX_TILES) {
    showToastFn('已达 16 路上限，请先停止观看某路画面');
    return;
  }
  const biz = roomBizType(room);
  if (biz === 'push') {
    const pusher = (room.clients || []).find(
      (c) => !c.isObserver && c.soloRole === 'push',
    );
    const stream = pusher?.streams?.find((s) => s.kind === 'solo');
    if (!stream) {
      showToastFn('当前没有可观看的推流');
      return;
    }
    startPushTile(room, stream.streamId, pusher.nickname, pusher.clientPlatform);
    return;
  }
  openMemberPicker(room);
}

function openMemberPicker(room) {
  pendingRoom = room;
  if (els.memberRoom) {
    const biz = roomBizType(room);
    els.memberRoom.innerHTML =
      '<span class="admin-member-dialog-room-label">房间</span>' +
      '<span class="admin-member-dialog-room-name">' + escapeHtml(roomDisplayName(room, biz)) + '</span>';
  }
  const options = buildMemberOptions(room);
  if (!options.length) {
    showToastFn('暂无可观看的成员画面');
    return;
  }
  els.memberList.innerHTML = options.map((opt) => {
    const kindClass = opt.kind === 'screen' ? 'admin-member-pick-kind--screen' : 'admin-member-pick-kind--cam';
    return (
      '<li class="admin-member-pick-row">' +
        '<button type="button" class="admin-member-pick-item" ' +
          'data-user-id="' + escapeAttr(opt.userId) + '" ' +
          'data-kind="' + escapeAttr(opt.kind) + '" ' +
          'data-label="' + escapeAttr(opt.label) + '" ' +
          'data-platform="' + escapeAttr(opt.clientPlatform || 'desktop') + '">' +
          '<span class="admin-member-pick-avatar" aria-hidden="true">' + escapeHtml(memberInitial(opt.nickname)) + '</span>' +
          '<span class="admin-member-pick-meta">' +
            '<span class="admin-member-pick-name">' + escapeHtml(opt.nickname) + '</span>' +
            '<span class="admin-member-pick-kind ' + kindClass + '">' + escapeHtml(opt.label) + '</span>' +
          '</span>' +
          '<span class="admin-member-pick-go" aria-hidden="true">›</span>' +
        '</button>' +
      '</li>'
    );
  }).join('');

  els.memberList.querySelectorAll('.admin-member-pick-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      els.memberDialog?.close();
      startMemberTile(
        pendingRoom,
        btn.dataset.userId,
        btn.dataset.kind,
        btn.dataset.label,
        btn.dataset.platform,
      );
    });
  });

  if (typeof els.memberDialog.showModal === 'function') {
    els.memberDialog.showModal();
  }
}

function buildMemberOptions(room) {
  const opts = [];
  for (const c of room.clients || []) {
    if (c.isObserver) continue;
    const hasCam = (c.streams || []).some((s) => s.kind === 'cam') || c.camOn;
    const hasScreen = (c.streams || []).some((s) => s.kind === 'screen');
    if (hasCam) {
      opts.push({
        userId: c.userId,
        nickname: c.nickname,
        kind: 'cam',
        label: '摄像头',
        clientPlatform: c.clientPlatform,
      });
    }
    if (hasScreen) {
      opts.push({
        userId: c.userId,
        nickname: c.nickname,
        kind: 'screen',
        label: '屏幕共享',
        clientPlatform: c.clientPlatform,
      });
    }
  }
  return opts;
}

function tileKeyMember(roomId, userId, kind) {
  return roomId + ':' + userId + ':' + kind;
}

function tileKeyPush(roomId, streamId) {
  return roomId + ':push:' + streamId;
}

function promptAlreadyWatching(key) {
  switchMonitorTab('live');
  highlightTile(key);
  showToastFn('该路画面正在观看中，无需重复选择');
}

async function startMemberTile(room, userId, kind, kindLabel, sourcePlatform) {
  const key = tileKeyMember(room.id, userId, kind);
  if (tiles.has(key)) {
    promptAlreadyWatching(key);
    return;
  }
  if (tiles.size >= MAX_TILES) {
    showToastFn('已达 16 路上限，请先停止观看某路画面');
    return;
  }
  const member = (room.clients || []).find((c) => c.userId === userId);
  const auditDetail = member?.nickname || userId;
  await startTile(key, room, {
    sourcePlatform: sourcePlatform || 'desktop',
    isScreen: kind === 'screen',
    title: room.id + ' · ' + auditDetail + ' · ' + kindLabel,
    auditDetail,
    play: async (sig) => playStream({
      signaling: sig,
      targetUserId: userId,
      kind,
      onTrack: (stream) => attachStream(key, stream),
    }),
  });
}

async function startPushTile(room, streamId, nickname, sourcePlatform) {
  const key = tileKeyPush(room.id, streamId);
  if (tiles.has(key)) {
    promptAlreadyWatching(key);
    return;
  }
  await startTile(key, room, {
    sourcePlatform: sourcePlatform || 'desktop',
    title: room.id + ' · 推流 · ' + (nickname || ''),
    auditDetail: nickname || streamId,
    play: async (sig) => playStream({
      signaling: sig,
      streamId,
      solo: true,
      onTrack: (stream) => attachStream(key, stream),
    }),
  });
}

async function startTile(key, room, opts) {
  if (tiles.size >= MAX_TILES) {
    showToastFn('已达 16 路上限，请先停止观看某路画面');
    return;
  }

  const video = createTileVideo({
    sourcePlatform: opts.sourcePlatform,
    isScreen: opts.isScreen,
  });
  tiles.set(key, {
    roomId: room.id,
    pc: null,
    video,
    audioOn: false,
    videoOn: true,
    videoFit: 'contain',
    title: opts.title,
    auditDetail: opts.auditDetail || '',
    statusText: '连接中…',
    pinnedSlotIndex: null,
    displaySlotIndex: null,
  });
  watchOrder.push(key);

  try {
    const session = await ensureRoomSession(room);
    session.refCount++;
    const { pc } = await opts.play(session.sig);
    const tile = tiles.get(key);
    if (tile) {
      tile.pc = pc;
      tile.statusText = '观看中';
    }
    redistributeSlots();
    switchMonitorTab('live');
    updateLiveCount();
  } catch (err) {
    console.error(err);
    const roomId = tiles.get(key)?.roomId;
    removeTileEntry(key);
    if (roomId) {
      const session = roomSessions.get(roomId);
      if (session) {
        session.refCount = Math.max(0, session.refCount - 1);
        if (session.refCount === 0 && !roomEndScheduled.has(roomId)) {
          cleanupRoomSession(roomId);
        }
      }
    }
    showToastFn(err.message || '观看失败');
  }
}

function removeTileEntry(key) {
  const idx = watchOrder.indexOf(key);
  if (idx >= 0) watchOrder.splice(idx, 1);
  const tile = tiles.get(key);
  if (tile) {
    if (tile.displaySlotIndex !== null) {
      clearSlotDisplay(tile.displaySlotIndex);
    }
    closePC(tile.pc);
    tile.video.srcObject = null;
  }
  slots.forEach((slot) => {
    if (slot.pinnedTileKey === key) {
      slot.pinned = false;
      slot.pinnedTileKey = null;
      slot.el?.classList.remove('admin-watch-slot--pinned');
    }
  });
  tiles.delete(key);
  redistributeSlots();
  updateLiveCount();
}

async function ensureRoomSession(room) {
  let session = roomSessions.get(room.id);
  if (session?.joined) return session;

  const token = getTokenFn();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host + '/api/admin/observe/ws?token=' + encodeURIComponent(token);
  const sig = new Signaling(url);
  sig.on('_close', () => {
    if (!sig.isClosedByUser?.()) {
      window.__adminHandleNetworkFailure?.();
    }
  });
  await sig.connect();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('加入旁观超时')), 15000);
    const onJoined = () => {
      cleanup();
      resolve();
    };
    const onErr = (p) => {
      cleanup();
      reject(new Error(p.message || '加入旁观失败'));
    };
    const onEnded = (p) => {
      cleanup();
      reject(new Error(p.message || '业务已结束'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      sig.off('observe-joined', onJoined);
      sig.off('observe-error', onErr);
      sig.off('observe-ended', onEnded);
    };
    sig.on('observe-joined', onJoined);
    sig.on('observe-error', onErr);
    sig.on('observe-ended', onEnded);
    sig.send('observe-join', { room: room.id, mode: room.mode });
  });

  session = { sig, refCount: 0, joined: true };
  roomSessions.set(room.id, session);
  wireRoomSessionEvents(session, room.id);
  return session;
}

function wireRoomSessionEvents(session, roomId) {
  if (session.eventsWired) return;
  session.eventsWired = true;
  session.sig.on('observe-ended', (p) => {
    scheduleRoomEnd(roomId, p?.message || '业务已结束');
  });
}

function scheduleRoomEnd(roomId, message, delayMs = 1500) {
  if (roomEndScheduled.has(roomId)) return;
  roomEndScheduled.add(roomId);

  for (const tile of tiles.values()) {
    if (tile.roomId !== roomId) continue;
    tile.statusText = message;
    if (tile.displaySlotIndex !== null) {
      const statusEl = slots[tile.displaySlotIndex]?.el.querySelector('.admin-watch-status');
      if (statusEl) statusEl.textContent = message;
    }
  }

  setTimeout(() => {
    roomEndScheduled.delete(roomId);
    for (const key of [...tiles.keys()]) {
      const tile = tiles.get(key);
      if (tile?.roomId === roomId) stopTile(key, true);
    }
    cleanupRoomSession(roomId);
  }, delayMs);
}

function cleanupRoomSession(roomId) {
  const session = roomSessions.get(roomId);
  if (!session) return;
  try { session.sig?.send('observe-leave', {}); } catch (_) {}
  try { session.sig?.close(); } catch (_) {}
  roomSessions.delete(roomId);
}

function attachStream(key, stream) {
  const tile = tiles.get(key);
  if (!tile) return;
  attachMediaStreamToVideo(tile.video, stream);
}

function renderWatchSlots() {
  if (!els.watchGrid) return;
  els.watchGrid.innerHTML = '';
  slots = [];
  const capacity = getLayoutCapacity();
  for (let i = 0; i < capacity; i++) {
    const el = document.createElement('div');
    el.className = 'admin-watch-slot admin-watch-slot--empty';
    el.dataset.slotIndex = String(i);
    el.innerHTML =
      '<div class="admin-watch-slot-head">' +
        '<span class="admin-watch-drag" draggable="false" title="拖动换位" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" focusable="false">' +
            '<circle cx="9" cy="6" r="1.5" fill="currentColor"/>' +
            '<circle cx="15" cy="6" r="1.5" fill="currentColor"/>' +
            '<circle cx="9" cy="12" r="1.5" fill="currentColor"/>' +
            '<circle cx="15" cy="12" r="1.5" fill="currentColor"/>' +
            '<circle cx="9" cy="18" r="1.5" fill="currentColor"/>' +
            '<circle cx="15" cy="18" r="1.5" fill="currentColor"/>' +
          '</svg>' +
        '</span>' +
        '<span class="admin-watch-title"></span>' +
        '<div class="admin-watch-tools">' +
          '<button type="button" class="admin-watch-ctrl admin-watch-ctrl--audio" title="开启声音" aria-label="开启声音" aria-pressed="false">' +
            WATCH_CTRL_ICON.audioOn + WATCH_CTRL_ICON.audioOff +
          '</button>' +
          '<button type="button" class="admin-watch-ctrl admin-watch-ctrl--video" title="关闭画面" aria-label="关闭画面" aria-pressed="true">' +
            WATCH_CTRL_ICON.videoOn + WATCH_CTRL_ICON.videoOff +
          '</button>' +
          '<button type="button" class="admin-watch-ctrl admin-watch-ctrl--fit" title="铺满窗格" aria-label="铺满窗格" aria-pressed="false">' +
            WATCH_CTRL_ICON.fitCover + WATCH_CTRL_ICON.fitContain +
          '</button>' +
          '<button type="button" class="admin-watch-ctrl admin-watch-ctrl--pin" title="固定窗口" aria-label="固定窗口" aria-pressed="false">' +
            WATCH_CTRL_ICON.pinOn + WATCH_CTRL_ICON.pinOff +
          '</button>' +
        '</div>' +
        '<button type="button" class="admin-watch-stop" title="停止观看">×</button>' +
      '</div>' +
      '<div class="admin-watch-video-wrap">' +
      '</div>' +
      '<div class="admin-watch-status"></div>';
    const stopBtn = el.querySelector('.admin-watch-stop');
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = el.dataset.tileKey;
      if (key) stopTile(key, true);
    });
    const audioBtn = el.querySelector('.admin-watch-ctrl--audio');
    audioBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = el.dataset.tileKey;
      if (key) toggleTileAudio(key);
    });
    const videoBtn = el.querySelector('.admin-watch-ctrl--video');
    videoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = el.dataset.tileKey;
      if (key) toggleTileVideo(key);
    });
    const fitBtn = el.querySelector('.admin-watch-ctrl--fit');
    fitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = el.dataset.tileKey;
      if (key) toggleTileVideoFit(key);
    });
    const pinBtn = el.querySelector('.admin-watch-ctrl--pin');
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePinSlot(i);
    });
    els.watchGrid.appendChild(el);
    slots.push({
      el,
      index: i,
      pinned: false,
      pinnedTileKey: null,
      displayedTileKey: null,
    });
  }
  setupTouchSlotDrag();
  updateSlotDragState();
}

function assignTileToSlot(key, slotIndex) {
  const tile = tiles.get(key);
  if (!tile || !slots[slotIndex]) return;

  if (tile.displaySlotIndex !== null && tile.displaySlotIndex !== slotIndex) {
    const oldIdx = tile.displaySlotIndex;
    if (slots[oldIdx]?.displayedTileKey === key) {
      clearSlotDisplay(oldIdx);
    } else {
      tile.displaySlotIndex = null;
    }
  }

  const slot = slots[slotIndex];
  const displacedKey = slot.displayedTileKey;
  if (displacedKey && displacedKey !== key) {
    const displaced = tiles.get(displacedKey);
    if (displaced && displaced.displaySlotIndex === slotIndex) {
      displaced.displaySlotIndex = null;
    }
  }

  const wrap = slot.el.querySelector('.admin-watch-video-wrap');
  wrap.innerHTML = '';
  wrap.appendChild(tileVideoMount(tile));

  slot.displayedTileKey = key;
  tile.displaySlotIndex = slotIndex;

  applySlotPresentation(slotIndex);
}

function applySlotPresentation(slotIndex) {
  const slot = slots[slotIndex];
  if (!slot) return;

  const key = slot.displayedTileKey;
  if (!key) {
    clearSlotDisplay(slotIndex);
    return;
  }

  const tile = tiles.get(key);
  if (!tile) {
    clearSlotDisplay(slotIndex);
    return;
  }

  slot.el.classList.remove('admin-watch-slot--empty');
  slot.el.dataset.tileKey = key;
  slot.el.querySelector('.admin-watch-title').textContent = tile.title;
  const statusEl = slot.el.querySelector('.admin-watch-status');
  if (statusEl) statusEl.textContent = tile.statusText || '';

  tile.video.classList.toggle('admin-watch-video--hidden', !tile.videoOn);
  slot.el.classList.toggle('admin-watch-slot--unmuted', tile.audioOn);
  slot.el.classList.toggle('admin-watch-slot--video-off', !tile.videoOn);
  slot.el.classList.toggle('admin-watch-slot--fit-contain', tile.videoFit === 'contain');

  applyVideoFit(tile);
  syncTileControls(key);
  syncPinControl(slotIndex);
}

function clearSlotDisplay(slotIndex) {
  const slot = slots[slotIndex];
  if (!slot) return;

  const key = slot.displayedTileKey;
  if (key) {
    const tile = tiles.get(key);
    if (tile && tile.displaySlotIndex === slotIndex) {
      tile.displaySlotIndex = null;
    }
  }

  const wrap = slot.el.querySelector('.admin-watch-video-wrap');
  wrap.innerHTML = '';

  slot.displayedTileKey = null;
  slot.el.dataset.tileKey = '';
  slot.el.classList.add('admin-watch-slot--empty');
  slot.el.classList.remove(
    'admin-watch-slot--active',
    'admin-watch-slot--unmuted',
    'admin-watch-slot--video-off',
    'admin-watch-slot--carousel',
    'admin-watch-slot--fit-contain',
  );
  slot.el.querySelector('.admin-watch-title').textContent = '';
  slot.el.querySelector('.admin-watch-status').textContent = '';
  slot.el.querySelectorAll('.admin-watch-ctrl').forEach((btn) => {
    btn.classList.remove('is-active');
    btn.setAttribute('aria-pressed', 'false');
  });
  syncPinControl(slotIndex);
}

function redistributeSlots() {
  stopCarouselTimer();

  slots.forEach((slot, i) => {
    if (slot.pinned && slot.pinnedTileKey && tiles.has(slot.pinnedTileKey)) {
      assignTileToSlot(slot.pinnedTileKey, i);
    } else {
      if (slot.pinned) {
        slot.pinned = false;
        slot.pinnedTileKey = null;
        slot.el.classList.remove('admin-watch-slot--pinned');
      }
      clearSlotDisplay(i);
    }
  });

  if (!needsCarousel()) {
    carouselBatchIndex = 0;
    const freeSlots = slots.map((_, i) => i).filter((i) => !slots[i].pinned);
    const unpinned = getUnpinnedTileKeys();
    unpinned.forEach((key, idx) => {
      if (idx < freeSlots.length) {
        assignTileToSlot(key, freeSlots[idx]);
      }
    });
    updateSlotDragState();
    updateCarouselSlotMarkers();
    return;
  }

  carouselBatchIndex = 0;
  applyCarouselBatch();
  startCarouselTimer();
  updateSlotDragState();
  updateCarouselSlotMarkers();
}

function applyCarouselBatch() {
  const carouselSlots = getCarouselSlotIndices();
  const unpinned = getUnpinnedTileKeys();
  if (!carouselSlots.length || !unpinned.length) return;

  carouselSlots.forEach((i) => clearSlotDisplay(i));

  const batchSize = carouselSlots.length;
  const start = (carouselBatchIndex * batchSize) % unpinned.length;

  for (let j = 0; j < batchSize; j++) {
    const key = unpinned[(start + j) % unpinned.length];
    assignTileToSlot(key, carouselSlots[j]);
  }
  updateCarouselSlotMarkers();
}

function updateCarouselSlotMarkers() {
  const carouselActive = needsCarousel();
  slots.forEach((slot) => {
    slot.el.classList.toggle(
      'admin-watch-slot--carousel',
      carouselActive && !slot.pinned && !!slot.displayedTileKey,
    );
  });
}

function syncPinControl(slotIndex) {
  const slot = slots[slotIndex];
  if (!slot) return;
  const pinBtn = slot.el.querySelector('.admin-watch-ctrl--pin');
  if (!pinBtn) return;
  const hasTile = !!slot.displayedTileKey;
  pinBtn.hidden = !hasTile;
  pinBtn.classList.toggle('is-active', slot.pinned);
  pinBtn.title = slot.pinned ? '取消固定' : '固定窗口';
  pinBtn.setAttribute('aria-label', pinBtn.title);
  pinBtn.setAttribute('aria-pressed', slot.pinned ? 'true' : 'false');
  slot.el.classList.toggle('admin-watch-slot--pinned', slot.pinned);
}

function togglePinSlot(slotIndex) {
  const slot = slots[slotIndex];
  const key = slot.displayedTileKey;
  if (!key) return;

  if (slot.pinned) {
    slot.pinned = false;
    slot.pinnedTileKey = null;
    const tile = tiles.get(key);
    if (tile) tile.pinnedSlotIndex = null;
    // Keep tile in the current slot; do not run redistributeSlots (it reassigns by watchOrder).
    syncPinControl(slotIndex);
    updateSlotDragState();
    updateCarouselSlotMarkers();
    if (needsCarousel()) {
      startCarouselTimer();
    }
    return;
  }

  if (needsCarousel()) {
    const pinnedCount = slots.filter((s) => s.pinned).length;
    if (pinnedCount >= getLayoutCapacity() - 1) {
      showToastFn('画面数超出布局容量，至少保留一个窗口用于轮播，无法固定更多窗口');
      return;
    }
  }

  slot.pinned = true;
  slot.pinnedTileKey = key;
  const tile = tiles.get(key);
  if (tile) tile.pinnedSlotIndex = slotIndex;
  slot.el.classList.add('admin-watch-slot--pinned');
  redistributeSlots();
}

function clearDragMarkers() {
  els.watchGrid?.querySelectorAll('.admin-watch-slot--dragging').forEach((el) => {
    el.classList.remove('admin-watch-slot--dragging');
  });
  els.watchGrid?.querySelectorAll('.admin-watch-slot--drop-target').forEach((el) => {
    el.classList.remove('admin-watch-slot--drop-target');
  });
}

function setupTouchSlotDrag() {
  if (!els.watchGrid || els.watchGrid.dataset.touchDragWired === '1') return;
  els.watchGrid.dataset.touchDragWired = '1';

  els.watchGrid.addEventListener('pointerdown', (e) => {
    if (needsCarousel()) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const handle = e.target.closest('.admin-watch-drag');
    if (!handle) return;
    const slotEl = handle.closest('.admin-watch-slot');
    if (!slotEl?.dataset.tileKey) return;
    const slotIndex = Number(slotEl.dataset.slotIndex);
    if (!Number.isFinite(slotIndex) || !canDragSlot(slotIndex)) return;

    e.preventDefault();
    pointerDrag.active = true;
    pointerDrag.sourceIndex = slotIndex;
    pointerDrag.pointerId = e.pointerId;
    slotEl.classList.add('admin-watch-slot--dragging');
    handle.setPointerCapture(e.pointerId);
  });

  els.watchGrid.addEventListener('pointermove', (e) => {
    if (!pointerDrag.active || e.pointerId !== pointerDrag.pointerId) return;
    e.preventDefault();
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const slotEl = hit?.closest?.('.admin-watch-slot');
    els.watchGrid.querySelectorAll('.admin-watch-slot--drop-target').forEach((el) => {
      el.classList.remove('admin-watch-slot--drop-target');
    });
    if (slotEl) slotEl.classList.add('admin-watch-slot--drop-target');
  });

  const finishPointerDrag = (e) => {
    if (!pointerDrag.active || e.pointerId !== pointerDrag.pointerId) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const slotEl = hit?.closest?.('.admin-watch-slot');
    if (slotEl && pointerDrag.sourceIndex !== null) {
      const targetIndex = Number(slotEl.dataset.slotIndex);
      if (Number.isFinite(targetIndex)) {
        swapSlots(pointerDrag.sourceIndex, targetIndex);
      }
    }
    pointerDrag.active = false;
    pointerDrag.sourceIndex = null;
    pointerDrag.pointerId = null;
    clearDragMarkers();
  };

  els.watchGrid.addEventListener('pointerup', finishPointerDrag);
  els.watchGrid.addEventListener('pointercancel', finishPointerDrag);
}

function setupGridDragDrop() {
  if (!els.watchGrid) return;
  // Slot reorder uses pointer events (setupTouchSlotDrag); disable native HTML5 drag.
  els.watchGrid.addEventListener('dragstart', (e) => {
    if (e.target.closest('.admin-watch-drag')) {
      e.preventDefault();
    }
  });
}

function swapSlots(indexA, indexB) {
  if (indexA === indexB) return;
  if (indexA < 0 || indexB < 0 || indexA >= slots.length || indexB >= slots.length) return;
  if (slots[indexA].pinned || slots[indexB].pinned) return;
  if (needsCarousel()) return;

  const slotA = slots[indexA];
  const slotB = slots[indexB];
  const keyA = slotA.displayedTileKey;
  const keyB = slotB.displayedTileKey;

  if (!keyA && !keyB) return;

  slotA.displayedTileKey = keyB;
  slotB.displayedTileKey = keyA;

  const tileA = keyA ? tiles.get(keyA) : null;
  const tileB = keyB ? tiles.get(keyB) : null;
  if (tileA) tileA.displaySlotIndex = keyB ? indexB : null;
  if (tileB) tileB.displaySlotIndex = keyA ? indexA : null;

  const wrapA = slotA.el.querySelector('.admin-watch-video-wrap');
  const wrapB = slotB.el.querySelector('.admin-watch-video-wrap');
  wrapA.innerHTML = '';
  wrapB.innerHTML = '';
  if (tileB) wrapA.appendChild(tileVideoMount(tileB));
  if (tileA) wrapB.appendChild(tileVideoMount(tileA));

  if (!keyB) clearSlotDisplay(indexA);
  else applySlotPresentation(indexA);
  if (!keyA) clearSlotDisplay(indexB);
  else applySlotPresentation(indexB);

  updateSlotDragState();
}

function canDragSlot(slotIndex) {
  if (needsCarousel()) return false;
  const slot = slots[slotIndex];
  return !!slot?.displayedTileKey && !slot.pinned;
}

function updateSlotDragState() {
  slots.forEach((slot, i) => {
    const drag = slot.el.querySelector('.admin-watch-drag');
    if (!drag) return;
    const canDrag = canDragSlot(i);
    drag.draggable = false;
    slot.el.classList.toggle('admin-watch-slot--draggable', canDrag);
  });
}

function reportObserveStop(roomId, detail) {
  const session = roomSessions.get(roomId);
  if (!session?.sig || !detail) return;
  session.sig.send('observe-watch-stop', { detail });
}

function stopTile(key, updateCount) {
  const tile = tiles.get(key);
  if (!tile) return;

  const roomId = tile.roomId;
  if (tile.auditDetail) {
    reportObserveStop(roomId, tile.auditDetail);
  }
  removeTileEntry(key);

  const session = roomSessions.get(roomId);
  if (session) {
    session.refCount = Math.max(0, session.refCount - 1);
    if (session.refCount === 0 && !roomEndScheduled.has(roomId)) {
      cleanupRoomSession(roomId);
    }
  }

  if (updateCount) updateLiveCount();
}

function updateLiveCount() {
  if (els.liveCount) els.liveCount.textContent = tiles.size + '/' + MAX_TILES;
}

function switchMonitorTab(tab) {
  currentMonitorTab = tab;
  const isRooms = tab === 'rooms';
  const isMembers = tab === 'members';
  const isListTab = isRooms || isMembers;
  const mainEl = document.querySelector('.admin-main');
  if (mainEl) {
    mainEl.classList.toggle('admin-main--monitor-live', tab === 'live');
  }
  if (els.monitorPage) {
    els.monitorPage.classList.toggle('admin-monitor-page--rooms', isListTab);
    els.monitorPage.classList.toggle('admin-monitor-page--live', tab === 'live');
  }
  document.querySelectorAll('[data-monitor-tab]').forEach((btn) => {
    const active = btn.dataset.monitorTab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (els.listPanels) {
    els.listPanels.hidden = !isListTab;
  }
  if (els.roomsPanel) {
    els.roomsPanel.classList.toggle('active', isRooms);
    els.roomsPanel.hidden = !isRooms;
  }
  if (els.membersPanel) {
    els.membersPanel.classList.toggle('active', isMembers);
    els.membersPanel.hidden = !isMembers;
    if (isMembers) loadMembers();
  }
  if (els.livePanel) {
    els.livePanel.classList.toggle('active', tab === 'live');
    els.livePanel.hidden = tab !== 'live';
    els.livePanel.setAttribute('aria-hidden', tab === 'live' ? 'false' : 'true');
  }
}

function highlightTile(key) {
  const tile = tiles.get(key);
  if (!tile || tile.displaySlotIndex === null) return;
  const slot = slots[tile.displaySlotIndex];
  if (!slot) return;
  slot.el.classList.add('admin-watch-slot--active');
  setTimeout(() => slot.el.classList.remove('admin-watch-slot--active'), 1200);
}

function syncTileControls(key) {
  const tile = tiles.get(key);
  if (!tile || tile.displaySlotIndex === null) return;
  const slotEl = slots[tile.displaySlotIndex].el;
  const audioBtn = slotEl.querySelector('.admin-watch-ctrl--audio');
  const videoBtn = slotEl.querySelector('.admin-watch-ctrl--video');
  const fitBtn = slotEl.querySelector('.admin-watch-ctrl--fit');
  if (audioBtn) {
    audioBtn.classList.toggle('is-active', tile.audioOn);
    audioBtn.setAttribute('aria-pressed', tile.audioOn ? 'true' : 'false');
    audioBtn.title = tile.audioOn ? '关闭声音' : '开启声音';
    audioBtn.setAttribute('aria-label', audioBtn.title);
  }
  if (videoBtn) {
    videoBtn.classList.toggle('is-active', tile.videoOn);
    videoBtn.setAttribute('aria-pressed', tile.videoOn ? 'true' : 'false');
    videoBtn.title = tile.videoOn ? '关闭画面' : '开启画面';
    videoBtn.setAttribute('aria-label', videoBtn.title);
  }
  if (fitBtn) {
    const cover = tile.videoFit !== 'contain';
    fitBtn.classList.toggle('is-active', cover);
    fitBtn.setAttribute('aria-pressed', cover ? 'true' : 'false');
    fitBtn.title = cover ? '按比例显示' : '铺满窗格';
    fitBtn.setAttribute('aria-label', fitBtn.title);
  }
}

function toggleTileAudio(key) {
  const tile = tiles.get(key);
  if (!tile) return;
  tile.audioOn = !tile.audioOn;
  tile.video.muted = !tile.audioOn;
  if (tile.displaySlotIndex !== null) {
    slots[tile.displaySlotIndex].el.classList.toggle('admin-watch-slot--unmuted', tile.audioOn);
  }
  syncTileControls(key);
}

function toggleTileVideo(key) {
  const tile = tiles.get(key);
  if (!tile) return;
  tile.videoOn = !tile.videoOn;
  tile.video.classList.toggle('admin-watch-video--hidden', !tile.videoOn);
  if (tile.displaySlotIndex !== null) {
    slots[tile.displaySlotIndex].el.classList.toggle('admin-watch-slot--video-off', !tile.videoOn);
  }
  syncTileControls(key);
}

function toggleTileVideoFit(key) {
  const tile = tiles.get(key);
  if (!tile) return;
  tile.videoFit = tile.videoFit === 'contain' ? 'cover' : 'contain';
  applyVideoFit(tile);
  if (tile.displaySlotIndex !== null) {
    slots[tile.displaySlotIndex].el.classList.toggle(
      'admin-watch-slot--fit-contain',
      tile.videoFit === 'contain',
    );
  }
  syncTileControls(key);
}

function syncTilesWithHub(hub) {
  const roomsById = new Map((hub.rooms || []).map((r) => [r.id, r]));
  const endedRooms = new Set();

  for (const key of [...tiles.keys()]) {
    const tile = tiles.get(key);
    if (!tile) continue;
    const room = roomsById.get(tile.roomId);
    if (!room || !roomBizType(room)) {
      endedRooms.add(tile.roomId);
      continue;
    }
    if (key.includes(':push:')) continue;
    const prefix = tile.roomId + ':';
    if (!key.startsWith(prefix)) continue;
    const userId = key.slice(prefix.length).split(':')[0];
    if (!userId) continue;
    const stillMember = (room.clients || []).some(
      (c) => !c.isObserver && c.userId === userId,
    );
    if (!stillMember) {
      stopTile(key, false);
    }
  }

  for (const tile of tiles.values()) {
    const room = roomsById.get(tile.roomId);
    if (!room || !roomBizType(room)) {
      endedRooms.add(tile.roomId);
    }
  }

  for (const roomId of endedRooms) {
    scheduleRoomEnd(roomId, '业务已结束');
  }
  updateLiveCount();
}

function memberInitial(nickname) {
  const text = String(nickname || '').trim();
  if (!text) return '?';
  return text.slice(0, 1).toUpperCase();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

initAdminMonitor({
  getToken: () => window.__adminGetToken?.() || '',
  showToast: (msg) => window.__adminShowToast?.(msg),
});

window.AdminMonitor = { updateMonitorHub, stopAllWatching, refreshMembers: loadMembers };
