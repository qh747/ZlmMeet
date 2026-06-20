// push.js — independent publisher page. Uses the same signaling pipeline as
// the meeting page (mode=solo) so the backend remains the single integration
// point with ZLMediaKit.

import { Signaling } from './signaling.js';
import { publishStream, closePC } from './webrtc.js';

const streamId = sessionStorage.getItem('zlm.streamId') || '';
if (!streamId) {
  location.href = 'index.html';
}

const state = {
  signaling: null,
  pub: null,            // { pc, streamId }
  localStream: null,
  micOn: true,
  camOn: true,
  recording: false,
  joined: false,
};

document.getElementById('streamLabel').textContent = streamId;
document.getElementById('streamNameInfo').textContent = streamId;

const statusEl = document.getElementById('streamState');
const recEl = document.getElementById('recIndicator');
const statusBar = document.getElementById('statusBar');

function setStatus(text, error = false, durationMs = 2500) {
  statusBar.textContent = text;
  statusBar.classList.remove('hidden');
  statusBar.classList.toggle('error', error);
  clearTimeout(setStatus._t);
  if (durationMs > 0) setStatus._t = setTimeout(() => statusBar.classList.add('hidden'), durationMs);
}

function setBtn(id, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('off', 'active', 'recording');
  if (cls) el.classList.add(cls);
}

window.addEventListener('beforeunload', () => leave());

main().catch((err) => {
  console.error(err);
  setStatus('启动失败：' + err.message, true, 0);
});

async function main() {
  // Preview the camera ASAP.
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (err) {
    setStatus('无法访问摄像头/麦克风：' + err.message, true, 0);
    throw err;
  }
  document.getElementById('localVideo').srcObject = state.localStream;

  // Connect signaling.
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.host || 'localhost:8080';
  state.signaling = new Signaling(`${scheme}//${host}/ws`);
  state.signaling.on('record-state', onRecordState);
  state.signaling.on('error', (p) => setStatus('服务器：' + p.message, true));
  state.signaling.on('_close', () => setStatus('信令已断开', true, 0));
  await state.signaling.connect();

  // Solo room: room id == stream id; backend caps at 1 client.
  state.signaling.send('join', {
    room: 'solo_' + streamId,
    nickname: 'publisher',
    mode: 'solo',
  });
  state.joined = true;

  wireToolbar();
  statusEl.textContent = '已就绪，点击「开始推流」';
}

function onRecordState(p) {
  state.recording = !!p.recording;
  recEl.classList.toggle('hidden', !state.recording);
  setBtn('btnRecord', state.recording ? 'recording' : '');
}

function wireToolbar() {
  document.getElementById('btnMic').addEventListener('click', () => {
    state.micOn = !state.micOn;
    for (const t of state.localStream.getAudioTracks()) t.enabled = state.micOn;
    setBtn('btnMic', state.micOn ? '' : 'off');
  });
  document.getElementById('btnCam').addEventListener('click', () => {
    state.camOn = !state.camOn;
    for (const t of state.localStream.getVideoTracks()) t.enabled = state.camOn;
    setBtn('btnCam', state.camOn ? '' : 'off');
  });
  document.getElementById('btnStart').addEventListener('click', toggleStream);
  document.getElementById('btnRecord').addEventListener('click', toggleRecord);
  document.getElementById('btnLeave').addEventListener('click', () => leave({ navigate: true }));
}

async function toggleStream() {
  if (state.pub) {
    // Stop publishing.
    if (state.recording) {
      try { await state.signaling.request('record-stop', { streamId }); } catch (_) {}
    }
    try { state.signaling.send('stream-stopped', { kind: 'solo', streamId }); } catch (_) {}
    try { closePC(state.pub.pc); } catch (_) {}
    state.pub = null;
    statusEl.textContent = '已停止';
    setBtn('btnStart', 'active');
    document.getElementById('btnStart').querySelector('.label').textContent = '开始推流';
    return;
  }
  statusEl.textContent = '推流中…';
  try {
    state.pub = await publishStream({
      signaling: state.signaling,
      stream: state.localStream,
      streamId,
      solo: true,
      onState: (s) => {
        statusEl.textContent = '推流状态：' + s;
        if (s === 'failed') setStatus('推流连接失败，请检查 ZLM 配置', true, 0);
      },
    });
    statusEl.textContent = '推流已建立';
    setBtn('btnStart', '');
    document.getElementById('btnStart').querySelector('.label').textContent = '停止推流';
  } catch (err) {
    setStatus('推流失败：' + err.message, true, 0);
    statusEl.textContent = '失败';
  }
}

async function toggleRecord() {
  if (!state.pub) {
    setStatus('请先开始推流再录制', false);
    return;
  }
  const type = state.recording ? 'record-stop' : 'record-start';
  try {
    const reply = await state.signaling.request(type, { streamId });
    // reply is RecordStatePayload (ack uses same type with reqId).
    onRecordState(reply);
  } catch (err) {
    setStatus('录制操作失败：' + err.message, true);
  }
}

function leave({ navigate = false } = {}) {
  try {
    if (state.pub && state.recording) {
      state.signaling.request('record-stop', { streamId }).catch(() => {});
    }
    if (state.pub) state.signaling.send('stream-stopped', { kind: 'solo', streamId });
    if (state.signaling && state.joined) state.signaling.send('leave', {});
  } catch (_) {}
  if (state.pub) closePC(state.pub.pc);
  if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
  try { state.signaling && state.signaling.close(); } catch (_) {}
  if (navigate) location.href = 'index.html';
}
