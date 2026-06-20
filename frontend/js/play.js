// play.js — independent player page. Same signaling pipeline (mode=solo).

import { Signaling } from './signaling.js';
import { playStream, closePC } from './webrtc.js';

const streamId = sessionStorage.getItem('zlm.streamId') || '';
if (!streamId) {
  location.href = 'index.html';
}

const state = {
  signaling: null,
  pull: null,
  joined: false,
};

document.getElementById('streamLabel').textContent = streamId;
document.getElementById('streamNameInfo').textContent = streamId;

const statusEl = document.getElementById('streamState');
const statusBar = document.getElementById('statusBar');
const remoteVideo = document.getElementById('remoteVideo');

function setStatus(text, error = false, durationMs = 2500) {
  statusBar.textContent = text;
  statusBar.classList.remove('hidden');
  statusBar.classList.toggle('error', error);
  clearTimeout(setStatus._t);
  if (durationMs > 0) setStatus._t = setTimeout(() => statusBar.classList.add('hidden'), durationMs);
}

window.addEventListener('beforeunload', () => leave());

main().catch((err) => {
  console.error(err);
  setStatus('启动失败：' + err.message, true, 0);
});

async function main() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.host || 'localhost:8080';
  state.signaling = new Signaling(`${scheme}//${host}/ws`);
  state.signaling.on('error', (p) => setStatus('服务器：' + p.message, true));
  state.signaling.on('_close', () => setStatus('信令已断开', true, 0));
  await state.signaling.connect();

  // Each player joins its own solo room so backend can track membership; the
  // room id is namespaced separately from publishers.
  state.signaling.send('join', {
    room: 'player_' + streamId + '_' + Math.random().toString(36).slice(2, 8),
    nickname: 'player',
    mode: 'solo',
  });
  state.joined = true;

  document.getElementById('btnStart').addEventListener('click', toggleStream);
  document.getElementById('btnLeave').addEventListener('click', () => leave({ navigate: true }));
  statusEl.textContent = '已就绪，点击「开始拉流」';
}

async function toggleStream() {
  if (state.pull) {
    try { closePC(state.pull.pc); } catch (_) {}
    state.pull = null;
    remoteVideo.srcObject = null;
    statusEl.textContent = '已停止';
    document.getElementById('btnStart').querySelector('.label').textContent = '开始拉流';
    return;
  }
  statusEl.textContent = '拉流中…';
  try {
    state.pull = await playStream({
      signaling: state.signaling,
      streamId,
      solo: true,
      onTrack: (s) => { remoteVideo.srcObject = s; },
      onState: (s) => {
        statusEl.textContent = '连接状态：' + s;
        if (s === 'failed') setStatus('拉流连接失败', true, 0);
      },
    });
    statusEl.textContent = '拉流已建立';
    document.getElementById('btnStart').querySelector('.label').textContent = '停止拉流';
  } catch (err) {
    setStatus('拉流失败：' + err.message, true, 0);
    statusEl.textContent = '失败';
  }
}

function leave({ navigate = false } = {}) {
  try {
    if (state.signaling && state.joined) state.signaling.send('leave', {});
  } catch (_) {}
  if (state.pull) closePC(state.pull.pc);
  try { state.signaling && state.signaling.close(); } catch (_) {}
  if (navigate) location.href = 'index.html';
}
