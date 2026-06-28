// push.js — independent publisher page. Uses the same signaling pipeline as
// the meeting page (mode=solo) so the backend remains the single integration
// point with ZLMediaKit.

import { Signaling } from './signaling.js';
import { getClientPlatform } from './video-flip.js';
import { publishStream, closePublishPC, publishOrUpdateStream } from './webrtc.js';
import {
  getStoredQuality,
  getVideoConstraints,
  getQualityLabel,
  replaceVideoTrackInPC,
  swapStreamVideoTrack,
  wireQualityUI,
  syncQualityButtonLabel,
} from './quality.js';
import { showAppAlert, isTokenError, showTokenErrorAlert, showRecordHookErrorAlert } from './ui-alert.js';
import { handleServiceDisconnect } from './network-error.js';

import { initSoloLayout } from './solo-layout.js';
import { wireSoloChat } from './solo-chat.js';

const room = sessionStorage.getItem('zlm.room') || '';
const streamId = sessionStorage.getItem('zlm.streamId') || '';
const token = sessionStorage.getItem('zlm.token') || '';
if (!room || !streamId) {
  location.href = 'index.html';
}

const state = {
  signaling: null,
  pub: null,            // { pc, streamId }
  localStream: null,
  micOn: sessionStorage.getItem('zlm.micOn') !== 'false',
  camOn: sessionStorage.getItem('zlm.camOn') !== 'false',
  quality: getStoredQuality(),
  recording: false,
  joined: false,
  myUserId: '',
};

syncQualityButtonLabel(() => state.quality);

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
let mediaToggleBusy = false;

function soloPublishOpts() {
  return {
    signaling: state.signaling,
    streamId,
    solo: true,
    onState: (s) => {
      // 翻译 WebRTC connectionState → 中文，确保状态点颜色正确
      const PUSH_STATE_MAP = {
        new:          '初始化中',
        connecting:   '连接中…',
        connected:    '推流中',
        disconnected: '连接已断开',
        failed:       '连接失败',
        closed:       '已关闭',
      };
      statusEl.textContent = PUSH_STATE_MAP[s] ?? ('推流状态：' + s);
      if (s === 'failed') setStatus('推流连接失败，请检查 ZLM 配置', true, 0);
    },
  };
}

function ensureLocalStream() {
  if (!state.localStream) state.localStream = new MediaStream();
  return state.localStream;
}

async function acquireLocalTrack(kind) {
  const stream = ensureLocalStream();
  const constraints = kind === 'audio'
    ? { audio: true, video: false }
    : { audio: false, video: getVideoConstraints(state.quality) };
  let fresh;
  try {
    fresh = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    const label = kind === 'audio' ? '麦克风' : '摄像头';
    throw new Error(`无法访问${label}：${err.message}`);
  }
  const track = fresh.getTracks()[0];
  if (!track) {
    fresh.getTracks().forEach((t) => t.stop());
    throw new Error(kind === 'audio' ? '无法获取麦克风' : '无法获取摄像头');
  }
  for (const old of (kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks())) {
    stream.removeTrack(old);
    old.stop();
  }
  stream.addTrack(track);
  track.enabled = kind === 'audio' ? state.micOn : state.camOn;
  return track;
}

async function refreshSoloPublish() {
  if (!state.pub?.pc) return;
  state.pub = await publishOrUpdateStream({
    existingPub: state.pub,
    stream: state.localStream,
    publishOpts: soloPublishOpts(),
  });
}

function updateLocalPreview() {
  document.getElementById('localVideo').srcObject = state.localStream;
}

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

initSoloLayout();

// Wire toolbar immediately so buttons (esp. Leave) are always responsive,
// even if camera / signaling setup fails later.
wireToolbar();
setBtn('btnMic', state.micOn ? '' : 'off');
setBtn('btnCam', state.camOn ? '' : 'off');

main().catch(async (err) => {
  console.error(err);
  await handleServiceDisconnect({ biz: 'push', signaling: state.signaling });
});

async function main() {
  // Preview the camera ASAP.  On failure fall back to an empty stream so the
  // rest of the page (signaling, leave button, mic/cam toggles) still works.
  try {
    if (state.micOn || state.camOn) {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        audio: state.micOn,
        video: state.camOn ? getVideoConstraints(state.quality) : false,
      });
      for (const t of state.localStream.getAudioTracks()) t.enabled = state.micOn;
      for (const t of state.localStream.getVideoTracks()) t.enabled = state.camOn;
    } else {
      state.localStream = new MediaStream();
    }
  } catch (err) {
    // Camera / mic unavailable — reset to off and show a recoverable error.
    // The user can re-enable devices via the mic / cam buttons, or leave.
    state.localStream = new MediaStream();
    state.micOn = false;
    state.camOn = false;
    setBtn('btnMic', 'off');
    setBtn('btnCam', 'off');
    setStatus('无法访问摄像头/麦克风：' + err.message, true, 6000);
  }
  document.getElementById('localVideo').srcObject = state.localStream;

  // Connect signaling.
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.host || 'localhost:8080';
  state.signaling = new Signaling(`${scheme}//${host}/ws`);
  state.signaling.on('record-state', onRecordState);
  state.signaling.on('error', async (p) => {
    if (isTokenError(p.message)) {
      await showTokenErrorAlert();
      location.href = 'index.html?biz=push';
      return;
    }
    setStatus('服务器：' + p.message, true);
  });
  state.signaling.on('admin-kicked', async (p) => {
    await showAppAlert(p.message || '您已被管理员移出', { title: '已移出' });
    leave({ navigate: true });
  });
  state.signaling.on('_close', () => {
    void handleServiceDisconnect({ biz: 'push', signaling: state.signaling });
  });
  state.signaling.on('joined', (p) => { state.myUserId = p.userId; });
  try {
    await state.signaling.connect();
  } catch (err) {
    await handleServiceDisconnect({ biz: 'push', signaling: state.signaling });
    return;
  }
  wireSoloChat(state.signaling, () => state.myUserId, {
    canOpenChat: () => !!state.pub,
    chatBlockedMessage: '请先开始推流后再使用聊天',
  });

  // Solo room: the user-supplied room name doubles as the ZLM app, so
  // publishers and players in the same room share the same stream group.
  state.signaling.send('join', {
    room,
    nickname: 'publisher',
    mode: 'solo',
    soloRole: 'push',
    streamId,
    token,
    clientPlatform: getClientPlatform(),
  });
  state.joined = true;

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
  } else if (!state.recording && !p.recordFileUrl) {
    showRecordHookErrorAlert();
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
  document.getElementById('btnMic').addEventListener('click', toggleMic);
  document.getElementById('btnCam').addEventListener('click', toggleCam);
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

async function toggleMic() {
  if (mediaToggleBusy) return;
  mediaToggleBusy = true;
  const targetOn = !state.micOn;
  try {
    if (targetOn && ensureLocalStream().getAudioTracks().length === 0) {
      state.micOn = true;
      await acquireLocalTrack('audio');
    } else {
      state.micOn = targetOn;
      for (const t of state.localStream.getAudioTracks()) t.enabled = state.micOn;
    }
    setBtn('btnMic', state.micOn ? '' : 'off');
    updateLocalPreview();
    if (state.pub) await refreshSoloPublish();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    mediaToggleBusy = false;
  }
}

async function toggleCam() {
  if (mediaToggleBusy) return;
  mediaToggleBusy = true;
  const targetOn = !state.camOn;
  try {
    if (targetOn && ensureLocalStream().getVideoTracks().length === 0) {
      state.camOn = true;
      await acquireLocalTrack('video');
    } else {
      state.camOn = targetOn;
      for (const t of state.localStream.getVideoTracks()) t.enabled = state.camOn;
    }
    setBtn('btnCam', state.camOn ? '' : 'off');
    updateLocalPreview();
    if (state.pub) await refreshSoloPublish();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    mediaToggleBusy = false;
  }
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
    try { closePublishPC(state.pub.pc); } catch (_) {}
    state.pub = null;
    statusEl.textContent = '已停止';
    setBtn('btnStart', 'active');
    document.getElementById('btnStart').querySelector('.label').textContent = '开始推流';
    return;
  }
  statusEl.textContent = '推流中…';
  if (!state.localStream || state.localStream.getTracks().length === 0) {
    setStatus('请至少启用麦克风或摄像头后再推流', false);
    statusEl.textContent = '已就绪，点击「开始推流」';
    return;
  }
  try {
    state.pub = await publishStream({
      ...soloPublishOpts(),
      stream: state.localStream,
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

async function leave({ navigate = false } = {}) {
  if (navigate && state.recording) {
    await showAppAlert('请先关闭录制再退出', { title: '无法退出' });
    return;
  }
  try {
    if (state.pub && state.recording && !navigate) {
      state.signaling.request('record-stop', { streamId }).catch(() => {});
    }
    if (state.pub) state.signaling.send('stream-stopped', { kind: 'solo', streamId });
    if (state.signaling && state.joined) state.signaling.send('leave', {});
  } catch (_) {}
  if (state.pub) closePublishPC(state.pub.pc);
  if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
  try { state.signaling && state.signaling.close(); } catch (_) {}
  if (navigate) location.href = 'index.html';
}
