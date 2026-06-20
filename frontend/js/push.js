// push.js — independent publisher page. Uses the same signaling pipeline as
// the meeting page (mode=solo) so the backend remains the single integration
// point with ZLMediaKit.

import { Signaling } from './signaling.js';
import { publishStream, closePC } from './webrtc.js';
import {
  getStoredQuality,
  getVideoConstraints,
  getQualityLabel,
  replaceVideoTrackInPC,
  swapStreamVideoTrack,
  wireQualityUI,
} from './quality.js';

const room = sessionStorage.getItem('zlm.room') || '';
const streamId = sessionStorage.getItem('zlm.streamId') || '';
if (!room || !streamId) {
  location.href = 'index.html';
}

const state = {
  signaling: null,
  pub: null,            // { pc, streamId }
  localStream: null,
  micOn: true,
  camOn: true,
  quality: getStoredQuality(),
  recording: false,
  joined: false,
};

document.getElementById('streamLabel').textContent = `${room} / ${streamId}`;
document.getElementById('streamNameInfo').textContent = streamId;
const appNameEl = document.getElementById('appName');
if (appNameEl) appNameEl.textContent = room;

const statusEl = document.getElementById('streamState');
const recEl = document.getElementById('recIndicator');
const statusBar = document.getElementById('statusBar');

// Preview overlay elements.
const previewOverlay = document.getElementById('previewOverlay');
const previewVideo = document.getElementById('previewVideo');
const previewClose = document.getElementById('previewClose');
const previewCloseBtn = document.getElementById('previewCloseBtn');
const previewDownload = document.getElementById('previewDownload');

let pendingRecordFileUrl = null; // set when record-stop ack arrives

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
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: getVideoConstraints(state.quality),
    });
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

  // Solo room: the user-supplied room name doubles as the ZLM app, so
  // publishers and players in the same room share the same stream group.
  state.signaling.send('join', {
    room,
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
  // If we just stopped recording and have a file URL, show the preview.
  if (!state.recording && p.recordFileUrl) {
    pendingRecordFileUrl = p.recordFileUrl;
    showPreview(p.recordFileUrl);
  }
}

// ── Recording preview ──────────────────────────────────────────────────────────

function showPreview(url) {
  const proxyURL = '/api/record-file?url=' + encodeURIComponent(url) + '&mode=preview';
  previewVideo.src = proxyURL;
  previewOverlay.classList.remove('hidden');
  // Auto-play the preview.
  previewVideo.play().catch(() => {});
}

function closePreview() {
  previewVideo.pause();
  previewVideo.src = '';
  previewOverlay.classList.add('hidden');
  pendingRecordFileUrl = null;
}

function downloadPreview() {
  if (!pendingRecordFileUrl) return;
  // Derive a friendly filename from the streamId.
  const filename = streamId + '_' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.mp4';
  const proxyURL = '/api/record-file?url=' + encodeURIComponent(pendingRecordFileUrl) + '&mode=download&filename=' + encodeURIComponent(filename);
  const a = document.createElement('a');
  a.href = proxyURL;
  a.download = filename;
  a.click();
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
  // Preview overlay buttons.
  previewClose.addEventListener('click', closePreview);
  previewCloseBtn.addEventListener('click', closePreview);
  previewDownload.addEventListener('click', downloadPreview);

  wireQualityUI({
    isCamOn: () => state.camOn,
    getCurrent: () => state.quality,
    onApply: applyQuality,
  });
}

async function applyQuality(qualityKey) {
  if (!state.camOn) return false;
  if (qualityKey === state.quality) return true;

  let videoOnly;
  try {
    videoOnly = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: getVideoConstraints(qualityKey),
    });
  } catch (err) {
    console.warn('[quality]', err);
    setStatus('画质切换失败：' + err.message, true);
    return false;
  }

  const newVideoTrack = videoOnly.getVideoTracks()[0];
  if (!newVideoTrack) {
    videoOnly.getTracks().forEach((t) => t.stop());
    return false;
  }
  newVideoTrack.enabled = state.camOn;

  swapStreamVideoTrack(state.localStream, newVideoTrack);
  document.getElementById('localVideo').srcObject = state.localStream;

  if (state.pub?.pc) {
    try {
      await replaceVideoTrackInPC(state.pub.pc, newVideoTrack);
    } catch (err) {
      console.warn('[quality replaceTrack]', err);
      setStatus('画质切换失败：' + err.message, true);
      return false;
    }
  }

  state.quality = qualityKey;
  setStatus('画质已切换为' + getQualityLabel(qualityKey));
  return true;
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
