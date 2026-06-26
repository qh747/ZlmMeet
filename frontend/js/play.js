// play.js — independent player page. Same signaling pipeline (mode=solo).

import { Signaling } from './signaling.js';
import { playStream, closePC } from './webrtc.js';
import { initSoloLayout } from './solo-layout.js';
import { wireSoloChat } from './solo-chat.js';
import { showAppAlert, isTokenError, showTokenErrorAlert } from './ui-alert.js';

const room = sessionStorage.getItem('zlm.room') || '';
const streamId = sessionStorage.getItem('zlm.streamId') || '';
const nickname = sessionStorage.getItem('zlm.nickname') || '';
const token = sessionStorage.getItem('zlm.token') || '';
if (!room || !streamId || !nickname) {
  location.href = 'index.html?biz=play';
}

const state = {
  signaling: null,
  pull: null,
  joined: false,
  myUserId: '',
  nickname,
  pulling: false,
};

document.getElementById('streamLabel').textContent = `${room} / ${streamId}`;
document.getElementById('streamNameInfo').textContent = streamId;
document.getElementById('memberName').textContent = nickname;
document.getElementById('memberNameInfo').textContent = nickname;
const appNameEl = document.getElementById('appName');
if (appNameEl) appNameEl.textContent = room;

const statusEl = document.getElementById('streamState');
const statusBar = document.getElementById('statusBar');
const remoteVideo = document.getElementById('remoteVideo');
const btnStart = document.getElementById('btnStart');

const READY_HINT = '已就绪，点击「开始拉流」';
const PULL_FAIL_HINT = '拉流超时，请确认推流方正在推流';
let pullGen = 0;
let pullErrorShown = false;

function setStatus(text, error = false, durationMs = 2500) {
  statusBar.textContent = text;
  statusBar.classList.remove('hidden');
  statusBar.classList.toggle('error', error);
  clearTimeout(setStatus._t);
  if (durationMs > 0) setStatus._t = setTimeout(() => statusBar.classList.add('hidden'), durationMs);
}

function setReadyUI() {
  statusEl.textContent = READY_HINT;
  btnStart.querySelector('.label').textContent = '开始拉流';
}

function setActivePullUI() {
  btnStart.querySelector('.label').textContent = '停止拉流';
}

function pullErrorMessage(err) {
  const msg = err?.message || '';
  if (msg.includes('WebSocket not open')) {
    return '信令已断开，请刷新页面后重试';
  }
  // Stream missing, server reject, or request timeout — one consistent hint.
  return PULL_FAIL_HINT;
}

async function showPullError(err, { title = '拉流失败' } = {}) {
  if (pullErrorShown) return;
  pullErrorShown = true;
  invalidatePull();
  await showAppAlert(pullErrorMessage(err), { title });
  setReadyUI();
  pullErrorShown = false;
}

function attachRemoteStream(stream) {
  remoteVideo.srcObject = stream;
  remoteVideo.play().catch(() => {});
}

function tearDownPull() {
  if (state.pull) {
    try { closePC(state.pull.pc); } catch (_) {}
    state.pull = null;
  }
  remoteVideo.srcObject = null;
}

function invalidatePull() {
  pullGen += 1;
  tearDownPull();
  state.pulling = false;
}

async function startPull() {
  if (state.pulling) return;
  pullErrorShown = false;
  const gen = ++pullGen;
  state.pulling = true;
  statusEl.textContent = '拉流中…';
  try {
    state.pull = await playStream({
      signaling: state.signaling,
      streamId,
      solo: true,
      onTrack: (stream) => {
        if (gen !== pullGen) return;
        attachRemoteStream(stream);
      },
      onState: (s) => {
        if (gen !== pullGen) return;
        if (s === 'connected') {
          statusEl.textContent = '拉流已建立';
        } else if (s === 'connecting' || s === 'new') {
          statusEl.textContent = '拉流中…';
        } else if (s === 'failed' || s === 'disconnected') {
          onPullDisconnected(gen);
        }
      },
    });
    if (gen !== pullGen) {
      closePC(state.pull.pc);
      state.pull = null;
      return;
    }
    statusEl.textContent = '拉流已建立';
    setActivePullUI();
  } catch (err) {
    if (gen !== pullGen) return;
    await showPullError(err);
    throw err;
  } finally {
    if (gen === pullGen) state.pulling = false;
  }
}

async function restartPull() {
  if (state.pulling) return;
  invalidatePull();
  await startPull();
}

function onPullDisconnected(gen) {
  if (gen !== pullGen || !state.pull) return;
  showPullError(new Error(PULL_FAIL_HINT), { title: '连接断开' });
}

window.addEventListener('beforeunload', () => leave());

initSoloLayout();

// Wire controls before async setup so Leave / pull toggle work if connect fails.
btnStart.addEventListener('click', toggleStream);
document.getElementById('btnLeave').addEventListener('click', () => leave({ navigate: true }));

main().catch((err) => {
  console.error(err);
  setStatus('启动失败：' + err.message, true, 0);
});

async function main() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.host || 'localhost:8080';
  state.signaling = new Signaling(`${scheme}//${host}/ws`);
  // Request-scoped errors (webrtc-offer, record-*) carry reqId and reject the
  // pending promise; ignore fire-and-forget error broadcasts during pull setup.
  state.signaling.on('_close', () => setStatus('信令已断开', true, 0));
  state.signaling.on('error', async (p) => {
    if (isTokenError(p.message)) {
      await showTokenErrorAlert();
      location.href = 'index.html?biz=play';
      return;
    }
    setStatus('服务器：' + p.message, true);
  });
  state.signaling.on('joined', (p) => { state.myUserId = p.userId; });
  state.signaling.on('peer-stream-started', (p) => {
    if (p.streamId !== streamId) return;
    if (state.pull || state.pulling) {
      restartPull().catch(() => {});
    }
  });
  state.signaling.on('peer-stream-stopped', async (p) => {
    if (p.streamId !== streamId) return;
    if (!state.pull) return;
    invalidatePull();
    await showAppAlert('推流方已停止推流', { title: '推流已停止' });
    setReadyUI();
  });
  state.signaling.on('peer-left', async () => {
    if (!state.pull && !state.pulling) return;
    invalidatePull();
    await showAppAlert('推流方已离开', { title: '推流已停止' });
    setReadyUI();
  });
  await state.signaling.connect();
  wireSoloChat(state.signaling, () => state.myUserId, {
    canOpenChat: () => !!state.pull,
    chatBlockedMessage: '请先开始拉流后再使用聊天',
  });

  state.signaling.send('join', {
    room,
    nickname,
    mode: 'solo',
    token,
  });
  state.joined = true;

  setReadyUI();
}

async function toggleStream() {
  if (state.pull) {
    invalidatePull();
    setReadyUI();
    return;
  }
  try {
    await startPull();
  } catch (_) {
    // Error already surfaced via showPullError.
  }
}

function leave({ navigate = false } = {}) {
  invalidatePull();
  try {
    if (state.signaling && state.joined) state.signaling.send('leave', {});
  } catch (_) {}
  try { state.signaling && state.signaling.close(); } catch (_) {}
  if (navigate) location.href = 'index.html';
}
