// ui.js — DOM helpers for the meeting page: video tiles, chat log, status bar.

export class MeetingUI {
  constructor() {
    this.grid = document.getElementById('videoGrid');
    this.chatPanel = document.getElementById('chatPanel');
    this.chatLog = document.getElementById('chatLog');
    this.chatInput = document.getElementById('chatInput');
    this.statusBar = document.getElementById('statusBar');
    this.tiles = new Map(); // key -> { tile, video }
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
    return entry;
  }

  removeTile(key) {
    const entry = this.tiles.get(key);
    if (!entry) return;
    try { entry.video.srcObject = null; } catch (_) {}
    entry.tile.remove();
    this.tiles.delete(key);
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

  setChatVisible(visible) {
    this.chatPanel.classList.toggle('hidden', !visible);
    if (visible) this.chatInput.focus();
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
