// ui.js — DOM helpers for the meeting page: video tiles, chat log, status bar.

const MEETING_COLS = 3;
const MEETING_ASPECT = 16 / 9;
const FOCUS_GAP = 6;
const FOCUS_THUMB_GAP = 4;
const FOCUS_INSET_X = 16;
const FOCUS_INSET_Y = 10;
const FOCUS_MAX_THUMB_W = 192;

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

    if (this.isMeetingLayout && this.grid) {
      this.grid.classList.add('meeting-grid');
      this._onResize = () => this.refreshGridLayout();
      window.addEventListener('resize', this._onResize);
      if (typeof ResizeObserver !== 'undefined') {
        this._resizeObserver = new ResizeObserver(this._onResize);
        this._resizeObserver.observe(this.grid);
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
      tile.appendChild(video);

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
          e.preventDefault();
          this.toggleTileFocus(key);
        });
      }
      if (this.isCallLayout) {
        tile.addEventListener('dblclick', (e) => {
          e.preventDefault();
          this.toggleCallPip(key);
        });
      }

      this.grid.appendChild(tile);
      entry = { tile, video, nameTag, badges, rec };
      this.tiles.set(key, entry);
    }
    if (opts.nickname !== undefined) {
      entry.nameTag.textContent = opts.nickname + (opts.isScreen ? '（屏幕）' : '');
    }
    if (opts.stream !== undefined) {
      if (entry.video.srcObject !== opts.stream) {
        entry.video.srcObject = opts.stream;
      }
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
    for (const [key, entry] of this.tiles) {
      const isCam = camKeys.includes(key);
      entry.tile.classList.toggle('is-pip', isCam && key === this.callPipKey);
    }
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
    const rows = Math.ceil(count / MEETING_COLS);
    const { w, h } = this._computeUniformTileSize(rows);

    this.grid.style.justifyContent = 'center';
    this.grid.style.alignContent = 'center';
    this.grid.style.gridTemplateColumns = `repeat(${MEETING_COLS}, ${w}px)`;
    this.grid.style.gridTemplateRows = `repeat(${rows}, ${h}px)`;
    this._setAllTileSizes(w, h);
  }

  _applyFocusLayout(keys) {
    const sidebarKeys = keys.filter((k) => k !== this.focusedKey);
    const sidebarCount = sidebarKeys.length;
    const { gridW, gridH } = this._gridInnerMetrics();
    const innerW = Math.max(0, gridW - FOCUS_INSET_X * 2);
    const innerH = Math.max(0, gridH - FOCUS_INSET_Y * 2);

    if (sidebarCount === 0) {
      this._applyFocusMainOnly(innerW, innerH);
      this.grid.style.margin = `${FOCUS_INSET_Y}px ${FOCUS_INSET_X}px`;
      return;
    }

    const layout = this._computeFocusLayout(sidebarCount, innerW, innerH);

    const rowTracks = [
      ...Array(sidebarCount).fill(`${layout.thumbH}px`),
      'minmax(0, 1fr)',
    ].join(' ');
    const totalRows = sidebarCount + 1;

    this.grid.style.rowGap = `${FOCUS_THUMB_GAP}px`;
    this.grid.style.columnGap = `${FOCUS_GAP}px`;
    this.grid.style.width = `${innerW}px`;
    this.grid.style.height = `${innerH}px`;
    this.grid.style.margin = `${FOCUS_INSET_Y}px ${FOCUS_INSET_X}px`;
    this.grid.style.justifyContent = 'start';
    this.grid.style.alignContent = 'start';
    this.grid.style.gridTemplateColumns = `${layout.mainW}px ${layout.sidebarW}px`;
    this.grid.style.gridTemplateRows = rowTracks;

    const mainEntry = this.tiles.get(this.focusedKey);
    mainEntry.tile.classList.add('is-focused');
    mainEntry.tile.style.gridColumn = '1';
    mainEntry.tile.style.gridRow = `1 / span ${totalRows}`;
    mainEntry.tile.style.width = '100%';
    mainEntry.tile.style.height = '100%';

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

  /** Sidebar thumbs 16:9, stacked at top; bottom row absorbs remaining height. */
  _computeFocusLayout(sidebarCount, innerW, innerH) {
    let thumbW = FOCUS_MAX_THUMB_W;
    let thumbH = Math.floor(thumbW / MEETING_ASPECT);

    const maxStackH = innerH * 0.52;
    const stackH = sidebarCount * thumbH + (sidebarCount - 1) * FOCUS_THUMB_GAP;
    if (stackH > maxStackH) {
      thumbH = Math.floor((maxStackH - (sidebarCount - 1) * FOCUS_THUMB_GAP) / sidebarCount);
      thumbW = Math.floor(thumbH * MEETING_ASPECT);
    }

    thumbW = Math.max(112, thumbW);
    thumbH = Math.max(63, thumbH);
    const sidebarW = thumbW;
    const mainW = Math.max(0, innerW - FOCUS_GAP - sidebarW);
    return { mainW, sidebarW, thumbW, thumbH };
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

  _computeUniformTileSize(rows) {
    const { gridW, gridH, gap } = this._gridInnerMetrics();
    if (gridW <= 0 || gridH <= 0) return { w: 0, h: 0 };
    const maxW = (gridW - gap * (MEETING_COLS - 1)) / MEETING_COLS;
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
