// ui.js — DOM helpers for the meeting page: video tiles, chat log, status bar.

import { shouldMirrorVideo } from './video-flip.js';

const MEETING_ASPECT = 16 / 9;
const FOCUS_COL_GAP = 3;
const FOCUS_THUMB_GAP = 4;
const FOCUS_INSET_X = 16;
const FOCUS_INSET_Y = 10;
const FOCUS_MAX_THUMB_W = 308;
const FOCUS_THUMB_MIN_W = 168;
const FOCUS_MANY_SIDEBAR = 5;
const FOCUS_MAX_THUMB_W_MANY = 352;
const FOCUS_THUMB_MIN_W_MANY = 196;
const FOCUS_THUMB_MIN_H_MANY = 96;
const FOCUS_MAIN_WIDTH_RATIO = 0.96;
const FOCUS_MAIN_HEIGHT_RATIO = 0.94;

function attachStreamToVideo(video, stream) {
  video.srcObject = stream;
  if (!stream || stream.getVideoTracks().length === 0) return;
  const play = () => { video.play().catch(() => {}); };
  play();
  // Late video track (republish) or iOS autoplay policy — retry when track arrives.
  stream.addEventListener('addtrack', (ev) => {
    if (ev.track?.kind === 'video') play();
  });
}

/** Phone: ≤3 tiles 1 col · >3 tiles 2 cols · tablet 2 · desktop 3 */
function meetingCols(gridW, count = 1) {
  const root = document.documentElement;
  const isPhone = root.classList.contains('device-mobile') && !root.classList.contains('device-tablet');
  if (isPhone) return count > 3 ? 2 : 1;
  if (gridW <= 768) return 2;
  return 3;
}

function focusLayoutParams(gridW) {
  if (gridW <= 480) {
    return {
      insetX: 6,
      insetY: 4,
      colGap: 2,
      thumbGap: 3,
      maxThumbW: 112,
      minThumbW: 88,
      minThumbH: 56,
      maxThumbWMany: 128,
      minThumbWMany: 96,
      minThumbHMany: 56,
      maxStackRatio: 0.72,
      maxStackRatioMany: 0.78,
      mainWidthRatio: 0.98,
      mainHeightRatio: 0.96,
    };
  }
  if (gridW <= 720) {
    return {
      insetX: 10,
      insetY: 6,
      colGap: 2,
      thumbGap: 3,
      maxThumbW: 180,
      minThumbW: 120,
      minThumbH: 72,
      maxThumbWMany: 220,
      minThumbWMany: 140,
      minThumbHMany: 80,
      maxStackRatio: 0.68,
      maxStackRatioMany: 0.8,
      mainWidthRatio: 0.97,
      mainHeightRatio: 0.95,
    };
  }
  return {
    insetX: FOCUS_INSET_X,
    insetY: FOCUS_INSET_Y,
    colGap: FOCUS_COL_GAP,
    thumbGap: FOCUS_THUMB_GAP,
    maxThumbW: FOCUS_MAX_THUMB_W,
    minThumbW: FOCUS_THUMB_MIN_W,
    minThumbH: 84,
    maxThumbWMany: FOCUS_MAX_THUMB_W_MANY,
    minThumbWMany: FOCUS_THUMB_MIN_W_MANY,
    minThumbHMany: FOCUS_THUMB_MIN_H_MANY,
    maxStackRatio: 0.66,
    maxStackRatioMany: 0.84,
    mainWidthRatio: FOCUS_MAIN_WIDTH_RATIO,
    mainHeightRatio: FOCUS_MAIN_HEIGHT_RATIO,
  };
}

export class MeetingUI {
  constructor() {
    this.grid = document.getElementById('videoGrid');
    this.chatPanel = document.getElementById('chatPanel');
    this.chatLog = document.getElementById('chatLog');
    this.chatInput = document.getElementById('chatInput');
    this.chatBtn = document.getElementById('btnChat');
    this.statusBar = document.getElementById('statusBar');
    this.tiles = new Map(); // key -> { tile, video }
    this.focusedKey = null;
    this.isMeetingLayout = document.body.dataset.mode === 'meeting';
    this.isCallLayout = document.body.dataset.mode === 'call';
    this.callPipKey = 'self';
    this.pipPosition = null;
    this._pipDrag = null;
    this._suppressPipClickUntil = 0;

    if (this.isMeetingLayout && this.grid) {
      this.grid.classList.add('meeting-grid');
      this._onResize = () => this.refreshGridLayout();
      window.addEventListener('resize', this._onResize);
      if (typeof ResizeObserver !== 'undefined') {
        this._resizeObserver = new ResizeObserver(this._onResize);
        this._resizeObserver.observe(this.grid);
      }
    }
    if (this.isCallLayout && this.grid) {
      this._onCallResize = () => {
        if (this.pipPosition) {
          this._clampPipPosition();
          this._applyPipPosition(this._getPipTile());
        }
      };
      window.addEventListener('resize', this._onCallResize);
      if (typeof ResizeObserver !== 'undefined') {
        this._callResizeObserver = new ResizeObserver(this._onCallResize);
        this._callResizeObserver.observe(this.grid);
      }
    }
  }

  setRoomLabel(room) { document.getElementById('roomName').textContent = room; }
  setMyLabel(name) { document.getElementById('myName').textContent = name; }

  /**
   * Create or update a tile.
   *  key:  unique id, e.g. `self`, `peer-<userId>-cam`, `peer-<userId>-screen`
   *  opts: { nickname, isSelf, isScreen, stream }
   */
  upsertTile(key, opts) {
    let entry = this.tiles.get(key);
    if (!entry) {
      const tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.dataset.key = key;
      if (opts.isSelf) tile.classList.add('is-self');
      if (opts.isScreen) tile.classList.add('is-screen');

      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      if (opts.isSelf) video.muted = true; // never echo our own mic

      const mirror = shouldMirrorVideo({
        isSelf: !!opts.isSelf,
        isScreen: !!opts.isScreen,
        sourcePlatform: opts.sourcePlatform,
      });
      if (mirror) {
        const mirrorWrap = document.createElement('div');
        mirrorWrap.className = 'video-flip-x';
        mirrorWrap.appendChild(video);
        tile.appendChild(mirrorWrap);
      } else {
        tile.appendChild(video);
      }

      const nameTag = document.createElement('div');
      nameTag.className = 'name-tag';
      tile.appendChild(nameTag);

      const badges = document.createElement('div');
      badges.className = 'badges';
      tile.appendChild(badges);

      const rec = document.createElement('div');
      rec.className = 'rec-indicator hidden';
      rec.innerHTML = '<span class="rec-dot"></span>REC';
      tile.appendChild(rec);

      if (this.isMeetingLayout) {
        tile.addEventListener('dblclick', (e) => {
          // touchend 双击已处理时屏蔽 iOS 额外合成的 dblclick，防止二次触发
          if (Date.now() < (this._suppressFocusClickUntil || 0)) { e.preventDefault(); return; }
          e.preventDefault();
          this.toggleTileFocus(key);
        });
        // iPad / iOS：dblclick 由触摸合成时不可靠，补充 touchend 双击检测
        tile.addEventListener('touchend', (e) => {
          const touch = e.changedTouches[0];
          if (!touch) return;
          const now  = Date.now();
          const last = tile._lastTap;
          if (last && now - last.time < 350 &&
              Math.abs(touch.clientX - last.x) < 40 &&
              Math.abs(touch.clientY - last.y) < 40) {
            e.preventDefault();
            tile._lastTap = null;
            // 屏蔽随后可能由浏览器合成的 dblclick，避免 toggleTileFocus 被调用两次
            this._suppressFocusClickUntil = Date.now() + 500;
            this.toggleTileFocus(key);
          } else {
            tile._lastTap = { time: now, x: touch.clientX, y: touch.clientY };
          }
        }, { passive: false });
      }
      if (this.isCallLayout) {
        tile.addEventListener('dblclick', (e) => {
          if (Date.now() < this._suppressPipClickUntil) {
            e.preventDefault();
            return;
          }
          e.preventDefault();
          this.toggleCallPip(key);
        });
        // iPad / iOS：dblclick 由触摸合成时不可靠，补充 touchend 双击检测
        tile.addEventListener('touchend', (e) => {
          // 只在真正拖动过时忽略（moved=false 表示仅点按，不应跳过）
          if (this._pipDrag?.moved) return;
          if (Date.now() < this._suppressPipClickUntil) return;
          const touch = e.changedTouches[0];
          const now   = Date.now();
          const last  = tile._lastTap;
          if (last && now - last.time < 300 &&
              Math.abs(touch.clientX - last.x) < 30 &&
              Math.abs(touch.clientY - last.y) < 30) {
            e.preventDefault();
            tile._lastTap = null;
            // 阻止后续可能触发的 dblclick 事件重复执行
            this._suppressPipClickUntil = Date.now() + 350;
            this.toggleCallPip(key);
          } else {
            tile._lastTap = { time: now, x: touch.clientX, y: touch.clientY };
          }
        }, { passive: false });
        this._bindPipDrag(tile);
      }

      this.grid.appendChild(tile);
      entry = { tile, video, nameTag, badges, rec };
      this.tiles.set(key, entry);
    }
    if (opts.nickname !== undefined) {
      entry.nameTag.textContent = opts.nickname + (opts.isScreen ? '（屏幕）' : '');
    }
    if (opts.stream !== undefined) {
      if (opts.stream && opts.stream.getVideoTracks().length > 0) {
        entry.tile.classList.remove('no-video');
      }
      attachStreamToVideo(entry.video, opts.stream);
    }
    if (opts.recording !== undefined) {
      entry.rec.classList.toggle('hidden', !opts.recording);
    }
    if (this.isMeetingLayout) this.refreshGridLayout();
    else if (this.isCallLayout) this.refreshCallLayout();
    return entry;
  }

  removeTile(key) {
    const entry = this.tiles.get(key);
    if (!entry) return;
    if (this.focusedKey === key) this.focusedKey = null;
    if (this.callPipKey === key) this.callPipKey = 'self';
    try { entry.video.srcObject = null; } catch (_) {}
    entry.tile.remove();
    this.tiles.delete(key);
    if (this.isMeetingLayout) this.refreshGridLayout();
    else if (this.isCallLayout) this.refreshCallLayout();
  }

  toggleCallPip(clickedKey) {
    if (!this.isCallLayout || !this.tiles.has(clickedKey)) return;
    const camKeys = this._callCamKeys();
    if (camKeys.length < 2 || !camKeys.includes(clickedKey)) return;
    const otherKey = camKeys.find((k) => k !== clickedKey);
    this.callPipKey = otherKey;
    this.refreshCallLayout();
  }

  _callCamKeys() {
    return [...this.tiles.keys()].filter(
      (k) => k === 'self' || (k.startsWith('peer-') && k.endsWith('-cam')),
    );
  }

  refreshCallLayout() {
    if (!this.isCallLayout || !this.grid) return;
    const camKeys = this._callCamKeys();
    if (!camKeys.includes(this.callPipKey)) {
      this.callPipKey = camKeys.includes('self') ? 'self' : (camKeys[0] || 'self');
    }
    for (const [, entry] of this.tiles) {
      entry.tile.classList.remove('is-pip', 'is-pip-custom', 'is-pip-dragging');
      entry.tile.style.left = '';
      entry.tile.style.top = '';
      entry.tile.style.right = '';
      entry.tile.style.bottom = '';
    }
    for (const [key, entry] of this.tiles) {
      const isCam = camKeys.includes(key);
      if (isCam && key === this.callPipKey) {
        entry.tile.classList.add('is-pip');
        this._applyPipPosition(entry.tile);
      }
    }
  }

  _getPipTile() {
    for (const [, entry] of this.tiles) {
      if (entry.tile.classList.contains('is-pip')) return entry.tile;
    }
    return null;
  }

  _bindPipDrag(tile) {
    if (tile.dataset.pipDragBound) return;
    tile.dataset.pipDragBound = '1';
    tile.addEventListener('pointerdown', (e) => this._onPipPointerDown(e, tile));
    tile.addEventListener('pointermove', this._onPipPointerMove);
    tile.addEventListener('pointerup', this._onPipPointerUp);
    tile.addEventListener('pointercancel', this._onPipPointerUp);
  }

  _onPipPointerDown(e, tile) {
    if (!tile.classList.contains('is-pip') || e.button !== 0) return;
    const gridRect = this.grid.getBoundingClientRect();
    if (!this.pipPosition) {
      const rect = tile.getBoundingClientRect();
      this.pipPosition = {
        left: rect.left - gridRect.left,
        top: rect.top - gridRect.top,
      };
      this._applyPipPosition(tile);
    }
    this._pipDrag = {
      tile,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: this.pipPosition.left,
      origTop: this.pipPosition.top,
      moved: false,
    };
    tile.setPointerCapture(e.pointerId);
  }

  _onPipPointerMove = (e) => {
    if (!this._pipDrag || e.pointerId !== this._pipDrag.pointerId) return;
    const dx = e.clientX - this._pipDrag.startX;
    const dy = e.clientY - this._pipDrag.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this._pipDrag.moved = true;
    this.pipPosition = {
      left: this._pipDrag.origLeft + dx,
      top: this._pipDrag.origTop + dy,
    };
    this._clampPipPosition();
    this._applyPipPosition(this._pipDrag.tile);
    if (this._pipDrag.moved) {
      this._pipDrag.tile.classList.add('is-pip-dragging');
    }
  };

  _onPipPointerUp = (e) => {
    if (!this._pipDrag || e.pointerId !== this._pipDrag.pointerId) return;
    const { tile, moved } = this._pipDrag;
    tile.classList.remove('is-pip-dragging');
    try { tile.releasePointerCapture(e.pointerId); } catch (_) {}
    if (moved) this._suppressPipClickUntil = Date.now() + 350;
    this._pipDrag = null;
  };

  _applyPipPosition(tile) {
    if (!tile) return;
    if (!this.pipPosition) {
      tile.classList.remove('is-pip-custom');
      tile.style.left = '';
      tile.style.top = '';
      tile.style.right = '';
      tile.style.bottom = '';
      return;
    }
    tile.classList.add('is-pip-custom');
    tile.style.right = 'auto';
    tile.style.bottom = 'auto';
    tile.style.left = `${this.pipPosition.left}px`;
    tile.style.top = `${this.pipPosition.top}px`;
  }

  _clampPipPosition() {
    if (!this.pipPosition || !this.grid) return;
    const tile = this._getPipTile();
    if (!tile) return;
    const margin = 8;
    const toolbarReserve = window.innerWidth <= 480 ? 64 : 72;
    const gridW = this.grid.clientWidth;
    const gridH = this.grid.clientHeight;
    const tileW = tile.offsetWidth || Math.min(360, gridW - margin * 2);
    const tileH = tile.offsetHeight || Math.floor(tileW * 9 / 16);
    this.pipPosition.left = Math.max(margin, Math.min(this.pipPosition.left, gridW - tileW - margin));
    this.pipPosition.top = Math.max(margin, Math.min(this.pipPosition.top, gridH - tileH - toolbarReserve));
  }

  toggleTileFocus(key) {
    if (!this.isMeetingLayout || !this.tiles.has(key)) return;
    if (this.tiles.size <= 1) return;
    this.focusedKey = this.focusedKey === key ? null : key;
    this.refreshGridLayout();
  }

  /** Meeting layout: max 3 columns, wrap rows; focus mode puts one tile large on the left. */
  refreshGridLayout() {
    if (!this.isMeetingLayout || !this.grid) return;

    const keys = [...this.tiles.keys()];
    const count = keys.length;

    for (const [, entry] of this.tiles) {
      entry.tile.classList.remove('is-focused', 'is-sidebar');
      entry.tile.style.gridColumn = '';
      entry.tile.style.gridRow = '';
      entry.tile.style.width = '';
      entry.tile.style.height = '';
      entry.tile.style.justifySelf = '';
      entry.tile.style.alignSelf = '';
    }

    this.grid.classList.toggle('focus-mode', !!this.focusedKey && count > 1);
    this.grid.style.gridTemplateColumns = '';
    this.grid.style.gridTemplateRows = '';
    this.grid.style.justifyContent = '';
    this.grid.style.alignContent = '';
    this.grid.style.width = '';
    this.grid.style.height = '';
    this.grid.style.gap = '';
    this.grid.style.rowGap = '';
    this.grid.style.columnGap = '';
    this.grid.style.margin = '';
    this.grid.style.padding = '';

    if (count === 0) return;

    if (this.focusedKey && this.tiles.has(this.focusedKey) && count > 1) {
      this._applyFocusLayout(keys);
      return;
    }

    if (this.focusedKey && !this.tiles.has(this.focusedKey)) {
      this.focusedKey = null;
      this.grid.classList.remove('focus-mode');
    }

    this._applyUniformGridLayout(count);
  }

  _applyUniformGridLayout(count) {
    const { gridW } = this._gridInnerMetrics();
    const cols = meetingCols(gridW, count);
    const rows = Math.ceil(count / cols);
    const { w, h } = this._computeUniformTileSize(rows, cols);

    this.grid.style.justifyContent = 'center';
    this.grid.style.alignContent = 'center';
    this.grid.style.gridTemplateColumns = `repeat(${cols}, ${w}px)`;
    this.grid.style.gridTemplateRows = `repeat(${rows}, ${h}px)`;
    this._setAllTileSizes(w, h);
  }

  _applyFocusLayout(keys) {
    const sidebarKeys = keys.filter((k) => k !== this.focusedKey);
    const sidebarCount = sidebarKeys.length;
    const { gridW, gridH } = this._gridInnerMetrics();
    const fp = focusLayoutParams(gridW);
    const innerW = Math.max(0, gridW - fp.insetX * 2);
    const innerH = Math.max(0, gridH - fp.insetY * 2);

    if (sidebarCount === 0) {
      this._applyFocusMainOnly(innerW, innerH);
      this.grid.style.margin = `${fp.insetY}px ${fp.insetX}px`;
      return;
    }

    const layout = this._computeFocusLayout(sidebarCount, innerW, innerH, fp);

    const rowTracks = [
      ...Array(sidebarCount).fill(`${layout.thumbH}px`),
      'minmax(0, 1fr)',
    ].join(' ');
    const totalRows = sidebarCount + 1;

    this.grid.style.rowGap = `${fp.thumbGap}px`;
    this.grid.style.columnGap = `${fp.colGap}px`;
    this.grid.style.width = `${innerW}px`;
    this.grid.style.height = `${innerH}px`;
    this.grid.style.margin = `${fp.insetY}px ${fp.insetX}px`;
    this.grid.style.justifyContent = 'start';
    this.grid.style.alignContent = 'start';
    this.grid.style.gridTemplateColumns = `minmax(0, 1fr) ${layout.sidebarW}px`;
    this.grid.style.gridTemplateRows = rowTracks;

    const mainEntry = this.tiles.get(this.focusedKey);
    mainEntry.tile.classList.add('is-focused');
    mainEntry.tile.style.gridColumn = '1';
    mainEntry.tile.style.gridRow = `1 / span ${totalRows}`;
    mainEntry.tile.style.width = `${layout.mainDisplayW}px`;
    mainEntry.tile.style.height = `${layout.mainDisplayH}px`;
    mainEntry.tile.style.justifySelf = 'end';
    mainEntry.tile.style.alignSelf = 'start';

    sidebarKeys.forEach((key, index) => {
      const entry = this.tiles.get(key);
      entry.tile.classList.add('is-sidebar');
      entry.tile.style.gridColumn = '2';
      entry.tile.style.gridRow = String(index + 1);
      entry.tile.style.width = `${layout.thumbW}px`;
      entry.tile.style.height = `${layout.thumbH}px`;
      entry.tile.style.justifySelf = 'start';
      entry.tile.style.alignSelf = 'start';
    });
  }

  _applyFocusMainOnly(innerW, innerH) {
    this.grid.style.gap = '0';
    this.grid.style.width = `${innerW}px`;
    this.grid.style.height = `${innerH}px`;
    this.grid.style.justifyContent = 'center';
    this.grid.style.alignContent = 'center';
    this.grid.style.gridTemplateColumns = `${innerW}px`;
    this.grid.style.gridTemplateRows = `${innerH}px`;

    const mainEntry = this.tiles.get(this.focusedKey);
    mainEntry.tile.classList.add('is-focused');
    mainEntry.tile.style.gridColumn = '1';
    mainEntry.tile.style.gridRow = '1';
    mainEntry.tile.style.width = '100%';
    mainEntry.tile.style.height = '100%';
  }

  /** Sidebar thumbs ~16:9; larger thumbs when 5+ other participants in focus mode. */
  _computeFocusLayout(sidebarCount, innerW, innerH, fp = focusLayoutParams(innerW)) {
    const many = sidebarCount >= FOCUS_MANY_SIDEBAR;
    const maxThumbW = many ? fp.maxThumbWMany : fp.maxThumbW;
    const minThumbW = many ? fp.minThumbWMany : fp.minThumbW;
    const minThumbH = many ? fp.minThumbHMany : fp.minThumbH;
    const maxStackRatio = many ? fp.maxStackRatioMany : fp.maxStackRatio;
    const stackGap = (sidebarCount - 1) * fp.thumbGap;
    const maxStackH = innerH * maxStackRatio;

    let thumbH = Math.floor((maxStackH - stackGap) / sidebarCount);
    thumbH = Math.max(minThumbH, thumbH);
    let thumbW = Math.floor(thumbH * MEETING_ASPECT);

    if (thumbW > maxThumbW) {
      thumbW = maxThumbW;
      thumbH = Math.floor(thumbW / MEETING_ASPECT);
    }
    thumbW = Math.max(minThumbW, thumbW);
    thumbH = Math.floor(thumbW / MEETING_ASPECT);

    if (!many && sidebarCount * thumbH + stackGap > maxStackH) {
      thumbH = Math.max(minThumbH, Math.floor((maxStackH - stackGap) / sidebarCount));
      thumbW = Math.floor(thumbH * MEETING_ASPECT);
      if (thumbW > maxThumbW) {
        thumbW = maxThumbW;
        thumbH = Math.floor(thumbW / MEETING_ASPECT);
      }
    }

    const sidebarW = thumbW;
    const mainDisplayW = Math.max(
      0,
      Math.floor((innerW - fp.colGap - sidebarW) * fp.mainWidthRatio),
    );
    const mainDisplayH = Math.max(0, Math.floor(innerH * fp.mainHeightRatio));
    return { thumbW, thumbH, sidebarW, mainDisplayW, mainDisplayH };
  }

  _gridInnerMetrics() {
    const styles = getComputedStyle(this.grid);
    const gap = parseFloat(styles.gap) || 6;
    const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    return {
      gap,
      gridW: Math.max(0, this.grid.clientWidth - padX),
      gridH: Math.max(0, this.grid.clientHeight - padY),
    };
  }

  _fitAspectSize(maxW, maxH, aspect = MEETING_ASPECT) {
    let w = maxW;
    let h = w / aspect;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    return { w: Math.floor(w), h: Math.floor(h) };
  }

  _computeUniformTileSize(rows, cols = meetingCols(this._gridInnerMetrics().gridW)) {
    const { gridW, gridH, gap } = this._gridInnerMetrics();
    if (gridW <= 0 || gridH <= 0) return { w: 0, h: 0 };
    const maxW = (gridW - gap * (cols - 1)) / cols;
    const maxH = (gridH - gap * (rows - 1)) / rows;
    return this._fitAspectSize(maxW, maxH);
  }

  _setAllTileSizes(w, h) {
    for (const [, entry] of this.tiles) {
      entry.tile.style.width = `${w}px`;
      entry.tile.style.height = `${h}px`;
    }
  }

  updateBadges(key, { micOn, camOn }) {
    const entry = this.tiles.get(key);
    if (!entry) return;
    entry.badges.innerHTML = '';
    if (micOn === false) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = '🔇';
      entry.badges.appendChild(b);
    }
    if (camOn === false) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = '🚫📹';
      entry.badges.appendChild(b);
      entry.tile.classList.add('no-video');
      entry.tile.dataset.fallback = entry.nameTag.textContent || '';
    } else {
      entry.tile.classList.remove('no-video');
    }
  }

  isChatOpen() {
    return this.chatPanel && !this.chatPanel.classList.contains('hidden');
  }

  setChatUnread(unread) {
    if (!this.chatBtn) return;
    this.chatBtn.classList.toggle('has-unread', !!unread);
  }

  setChatVisible(visible) {
    this.chatPanel.classList.toggle('hidden', !visible);
    if (visible) {
      this.chatInput.focus();
      this.setChatUnread(false);
    }
    if (this.isMeetingLayout) {
      requestAnimationFrame(() => this.refreshGridLayout());
    }
  }

  appendChat({ nickname, text, ts, isMe }) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg' + (isMe ? ' me' : '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = ts ? new Date(ts) : new Date();
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    meta.textContent = `${nickname} · ${hh}:${mm}`;
    const body = document.createElement('div');
    body.textContent = text;
    wrap.appendChild(meta);
    wrap.appendChild(body);
    this.chatLog.appendChild(wrap);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  appendSystem(text) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg';
    const body = document.createElement('div');
    body.style.color = 'var(--muted)';
    body.style.fontStyle = 'italic';
    body.textContent = text;
    wrap.appendChild(body);
    this.chatLog.appendChild(wrap);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  showStatus(message, { error = false, durationMs = 2500 } = {}) {
    this.statusBar.textContent = message;
    this.statusBar.classList.remove('hidden');
    this.statusBar.classList.toggle('error', error);
    clearTimeout(this._statusTimer);
    if (durationMs > 0) {
      this._statusTimer = setTimeout(() => this.statusBar.classList.add('hidden'), durationMs);
    }
  }

  setButtonState(buttonId, state) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    btn.classList.toggle('off', state === 'off');
    btn.classList.toggle('active', state === 'active');
    btn.classList.toggle('recording', state === 'recording');
  }
}
