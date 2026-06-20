// app.js — main meeting flow.
//
// Responsibilities:
//   - Read room/nickname from sessionStorage, redirect to index if missing.
//   - Connect signaling, join room, capture mic+cam, publish.
//   - On peer-joined / existing peers, pull their `cam` and (if present) `screen`.
//   - Wire toolbar buttons: mic toggle, cam toggle, screen share, chat, leave.
//   - Render UI updates via MeetingUI.

import { Signaling } from './signaling.js';
import { publishStream, playStream, closePC } from './webrtc.js';
import { MeetingUI } from './ui.js';
import {
  getStoredQuality,
  getVideoConstraints,
  getQualityLabel,
  replaceVideoTrackInPC,
  swapStreamVideoTrack,
  wireQualityUI,
} from './quality.js';

// Resolve mode: meeting.html uses 'meeting'; call.html uses 'call'.
const urlParams = new URLSearchParams(location.search);
const MODE = (urlParams.get('mode') || document.body.dataset.mode || 'meeting').toLowerCase();
const IS_CALL = MODE === 'call';

const ui = new MeetingUI();
const state = {
  mode: MODE,
  signaling: null,
  myUserId: null,
  myNickname: sessionStorage.getItem('zlm.nickname') || '',
  room: sessionStorage.getItem('zlm.room') || '',
  micOn: true,
  camOn: true,
  quality: getStoredQuality(),

  localCamStream: null,     // MediaStream from getUserMedia
  camPub: null,             // { pc, streamId }
  camRecording: false,

  localScreenStream: null,
  screenPub: null,
  screenRecording: false,

  // peers keyed by userId. Each: { nickname, cam: {pc}, screen: {pc} }
  peers: new Map(),
};

// Recording preview overlay (shared with push page markup).
const previewOverlay = document.getElementById('previewOverlay');
const previewVideo = document.getElementById('previewVideo');
const previewTitle = document.getElementById('previewTitle');
const previewClose = document.getElementById('previewClose');
const previewCloseBtn = document.getElementById('previewCloseBtn');
const previewDownload = document.getElementById('previewDownload');
let pendingRecordFileUrl = null;
let pendingRecordKind = 'cam';

if (!state.room || !state.myNickname) {
  location.href = 'index.html';
}

// Apply 1:1 layout tweaks for call mode.
if (IS_CALL) {
  document.body.classList.add('call-layout');
  const btnScreen = document.getElementById('btnScreen');
  if (btnScreen) btnScreen.style.display = 'none';
}

ui.setRoomLabel(state.room);
ui.setMyLabel(state.myNickname);

window.addEventListener('beforeunload', () => leave({ navigate: false }));

main().catch((err) => {
  console.error(err);
  ui.showStatus('启动失败：' + err.message, { error: true, durationMs: 0 });
});

async function main() {
  // First-frame latency budget: we run the slow paths in parallel so a fresh
  // joiner can start pulling existing peers' video while their own camera is
  // still warming up.
  //
  //   ┌── getUserMedia (200~1500ms on cold start)
  //   └── WebSocket connect → send 'join' → 'joined' → playStream(peer.*) ──┐
  //                                                                         │
  //                 once getUserMedia resolves: upsert self tile, publish ──┘

  // (1) Start signaling + media in parallel.
  const wsURL = buildWsURL();
  state.signaling = new Signaling(wsURL);
  wireSignalHandlers(state.signaling); // listeners must be registered before connect() resolves

  // Capture promise — no await yet, so connect() can race with it.
  const mediaPromise = navigator.mediaDevices
    .getUserMedia({
      audio: true,
      video: getVideoConstraints(state.quality),
    })
    .catch((err) => {
      ui.showStatus('无法访问摄像头/麦克风：' + err.message, { error: true, durationMs: 0 });
      throw err;
    });

  // (2) Connect WS, then send `join`. The server immediately replies with
  //     `joined` (handled by wireSignalHandlers), which kicks off pulling
  //     existing peers' streams — all of this happens before getUserMedia
  //     resolves on slow devices.
  try {
    await state.signaling.connect();
  } catch (err) {
    ui.showStatus('信令连接失败：' + err.message, { error: true, durationMs: 0 });
    throw err;
  }
  state.signaling.send('join', {
    room: state.room,
    nickname: state.myNickname,
    mode: state.mode,
  });

  // (3) Local media ready → publish first so existing peers can pull ASAP,
  //     then render self tile and wire toolbar.
  const localStream = await mediaPromise;
  state.localCamStream = localStream;

  const publishPromise = publishStream({
    signaling: state.signaling,
    stream: localStream,
    kind: 'cam',
    onState: (s) => {
      if (s === 'failed' || s === 'disconnected') {
        ui.showStatus('上行连接异常，请检查 ZLM WebRTC 配置', { error: true, durationMs: 0 });
      }
    },
  }).then((result) => {
    state.camPub = result;
  }).catch((err) => {
    ui.showStatus('推流失败：' + err.message, { error: true, durationMs: 0 });
    throw err;
  });

  ui.upsertTile('self', { nickname: state.myNickname + '（我）', isSelf: true, stream: localStream });
  wireToolbar();

  await publishPromise;
}

function buildWsURL() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // When opening the page directly (file://), default to localhost:8080.
  const host = location.host || 'localhost:8080';
  return `${scheme}//${host}/ws`;
}

// === Signaling event handlers ================================================

function wireSignalHandlers(sig) {
  sig.on('joined', (p) => {
    state.myUserId = p.userId;
    ui.appendSystem(`已加入房间 ${p.room}`);
    // For each existing peer, register them and start pulling each of their streams.
    for (const peer of p.peers || []) {
      ensurePeer(peer.userId, peer.nickname);
      ui.updateBadges(`peer-${peer.userId}-cam`, { micOn: peer.micOn, camOn: peer.camOn });
      for (const s of peer.streams || []) {
        startPullingPeerStream(peer.userId, peer.nickname, s.kind);
      }
    }
  });

  sig.on('peer-joined', (p) => {
    ensurePeer(p.userId, p.nickname);
    ui.appendSystem(`${p.nickname} 加入了`);
    // Preemptively pull cam while the joiner is still opening camera/publish.
    startPullingPeerStream(p.userId, p.nickname, 'cam', { preemptive: true });
  });

  sig.on('peer-left', (p) => {
    const peer = state.peers.get(p.userId);
    if (peer) {
      if (peer.cam) closePC(peer.cam.pc);
      if (peer.screen) closePC(peer.screen.pc);
      ui.appendSystem(`${peer.nickname} 离开了`);
    }
    state.peers.delete(p.userId);
    ui.removeTile(`peer-${p.userId}-cam`);
    ui.removeTile(`peer-${p.userId}-screen`);
  });

  sig.on('peer-state', (p) => {
    ui.updateBadges(`peer-${p.userId}-cam`, { micOn: p.micOn, camOn: p.camOn });
  });

  sig.on('peer-stream-started', (p) => {
    const peer = ensurePeer(p.userId);
    startPullingPeerStream(p.userId, peer.nickname, p.kind);
  });

  sig.on('peer-stream-stopped', (p) => {
    const peer = state.peers.get(p.userId);
    if (peer && peer[p.kind]) {
      closePC(peer[p.kind].pc);
      delete peer[p.kind];
    }
    ui.removeTile(`peer-${p.userId}-${p.kind}`);
  });

  sig.on('chat', (p) => {
    const isMe = p.from === state.myUserId;
    ui.appendChat({ nickname: p.nickname, text: p.text, ts: p.ts, isMe });
  });

  sig.on('record-state', (p) => {
    // Broadcasts from peers (self ack is handled by toggleRecord via request()).
    if (p.userId === state.myUserId) {
      applyRecordState(p);
      return;
    }
    // Peer record-state: highlight the tile.
    const tileKey = `peer-${p.userId}-${p.kind}`;
    ui.upsertTile(tileKey, { recording: p.recording });
  });

  sig.on('error', (p) => {
    console.warn('[server error]', p.message);
    ui.showStatus('服务器：' + p.message, { error: true });
  });

  sig.on('_close', () => {
    ui.showStatus('信令已断开', { error: true, durationMs: 0 });
  });
}

function ensurePeer(userId, nickname) {
  let peer = state.peers.get(userId);
  if (!peer) {
    peer = { nickname: nickname || userId.slice(0, 6) };
    state.peers.set(userId, peer);
  } else if (nickname) {
    peer.nickname = nickname;
  }
  return peer;
}

async function startPullingPeerStream(userId, nickname, kind, { preemptive = false } = {}) {
  const peer = ensurePeer(userId, nickname);
  if (peer[kind]) return;
  const inflightKey = `${kind}Pulling`;
  if (peer[inflightKey]) return peer[inflightKey];

  const tileKey = `peer-${userId}-${kind}`;
  ui.upsertTile(tileKey, {
    nickname: peer.nickname,
    isScreen: kind === 'screen',
  });

  peer[inflightKey] = pullPeerStreamWithRetry(userId, nickname, kind, tileKey, preemptive)
    .finally(() => { delete peer[inflightKey]; });
  return peer[inflightKey];
}

async function pullPeerStreamWithRetry(userId, nickname, kind, tileKey, preemptive) {
  const peer = ensurePeer(userId, nickname);
  const maxAttempts = preemptive ? 25 : 1;
  const retryDelayMs = 180;
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (peer[kind]) return;
    try {
      const result = await playStream({
        signaling: state.signaling,
        targetUserId: userId,
        kind,
        onTrack: (stream) => {
          ui.upsertTile(tileKey, { stream });
        },
        onState: (s) => {
          if (s === 'failed') {
            ui.showStatus(`拉取 ${peer.nickname}/${kind} 失败`, { error: true });
          }
        },
      });
      peer[kind] = result;
      return;
    } catch (err) {
      lastErr = err;
      if (attempt + 1 >= maxAttempts) break;
      await sleep(retryDelayMs);
    }
  }

  console.warn(`[pull ${userId}/${kind}]`, lastErr);
  if (!preemptive) {
    ui.showStatus(`拉流失败：${lastErr.message}`, { error: true });
  }
  if (!peer[kind]) {
    ui.removeTile(tileKey);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// === Toolbar wiring ==========================================================

function wireToolbar() {
  document.getElementById('btnMic').addEventListener('click', toggleMic);
  document.getElementById('btnCam').addEventListener('click', toggleCam);
  const btnScreen = document.getElementById('btnScreen');
  if (btnScreen) btnScreen.addEventListener('click', toggleScreen);
  document.getElementById('btnChat').addEventListener('click', () => {
    const visible = document.getElementById('chatPanel').classList.contains('hidden');
    ui.setChatVisible(visible);
    ui.setButtonState('btnChat', visible ? 'active' : '');
  });
  const btnRecord = document.getElementById('btnRecord');
  if (btnRecord) btnRecord.addEventListener('click', () => toggleRecord('cam'));
  const btnRecordScreen = document.getElementById('btnRecordScreen');
  if (btnRecordScreen) btnRecordScreen.addEventListener('click', () => toggleRecord('screen'));
  document.getElementById('btnLeave').addEventListener('click', () => leave({ navigate: true }));
  document.getElementById('chatClose').addEventListener('click', () => {
    ui.setChatVisible(false);
    ui.setButtonState('btnChat', '');
  });
  document.getElementById('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const txt = ui.chatInput.value.trim();
    if (!txt) return;
    state.signaling.send('chat', { text: txt });
    ui.chatInput.value = '';
  });

  // Reflect initial state.
  ui.setButtonState('btnMic', state.micOn ? '' : 'off');
  ui.setButtonState('btnCam', state.camOn ? '' : 'off');

  if (previewClose) previewClose.addEventListener('click', closePreview);
  if (previewCloseBtn) previewCloseBtn.addEventListener('click', closePreview);
  if (previewDownload) previewDownload.addEventListener('click', downloadPreview);

  wireQualityUI({
    isCamOn: () => state.camOn,
    getCurrent: () => state.quality,
    onApply: applyQuality,
  });
}

function applyRecordState(p) {
  if (!p) return;
  if (p.kind === 'cam') {
    state.camRecording = !!p.recording;
    ui.upsertTile('self', { recording: p.recording });
    ui.setButtonState('btnRecord', p.recording ? 'recording' : '');
  } else if (p.kind === 'screen') {
    state.screenRecording = !!p.recording;
    ui.upsertTile('self-screen', { recording: p.recording });
    ui.setButtonState('btnRecordScreen', p.recording ? 'recording' : '');
  }
  if (!p.recording && p.recordFileUrl) {
    pendingRecordFileUrl = p.recordFileUrl;
    pendingRecordKind = p.kind || 'cam';
    showPreview(p.recordFileUrl, pendingRecordKind);
  } else if (!p.recording && !p.recordFileUrl) {
    ui.showStatus('录制已停止，但未获取到文件地址', { error: true });
  }
}

function showPreview(url, kind) {
  if (!previewOverlay || !previewVideo) return;
  const label = kind === 'screen' ? '屏幕录制预览' : '录制预览';
  if (previewTitle) previewTitle.textContent = label;
  previewVideo.src = '/api/record-file?url=' + encodeURIComponent(url) + '&mode=preview';
  previewOverlay.classList.remove('hidden');
  previewVideo.play().catch(() => {});
}

function closePreview() {
  if (!previewOverlay || !previewVideo) return;
  previewVideo.pause();
  previewVideo.src = '';
  previewOverlay.classList.add('hidden');
  pendingRecordFileUrl = null;
}

function downloadPreview() {
  if (!pendingRecordFileUrl) return;
  const prefix = pendingRecordKind === 'screen' ? 'screen' : 'cam';
  const filename = `${state.room}_${prefix}_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.mp4`;
  const proxyURL = '/api/record-file?url=' + encodeURIComponent(pendingRecordFileUrl)
    + '&mode=download&filename=' + encodeURIComponent(filename);
  const a = document.createElement('a');
  a.href = proxyURL;
  a.download = filename;
  a.click();
}

async function toggleRecord(kind) {
  const inFlightFlag = kind === 'cam' ? 'camRecording' : 'screenRecording';
  const isOn = state[inFlightFlag];
  const type = isOn ? 'record-stop' : 'record-start';
  if (kind === 'screen' && !state.screenPub) {
    ui.showStatus('请先开启屏幕共享', { error: false });
    return;
  }
  try {
    const reply = await state.signaling.request(type, { kind });
    applyRecordState(reply);
  } catch (err) {
    ui.showStatus(`录制操作失败：${err.message}`, { error: true });
  }
}

function toggleMic() {
  state.micOn = !state.micOn;
  if (state.localCamStream) {
    for (const t of state.localCamStream.getAudioTracks()) t.enabled = state.micOn;
  }
  ui.setButtonState('btnMic', state.micOn ? '' : 'off');
  state.signaling.send('media-state', { micOn: state.micOn, camOn: state.camOn });
}

function toggleCam() {
  state.camOn = !state.camOn;
  if (state.localCamStream) {
    for (const t of state.localCamStream.getVideoTracks()) t.enabled = state.camOn;
  }
  ui.setButtonState('btnCam', state.camOn ? '' : 'off');
  state.signaling.send('media-state', { micOn: state.micOn, camOn: state.camOn });
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
    ui.showStatus('画质切换失败：' + err.message, { error: true });
    return false;
  }

  const newVideoTrack = videoOnly.getVideoTracks()[0];
  if (!newVideoTrack) {
    videoOnly.getTracks().forEach((t) => t.stop());
    return false;
  }
  newVideoTrack.enabled = state.camOn;

  swapStreamVideoTrack(state.localCamStream, newVideoTrack);
  ui.upsertTile('self', { stream: state.localCamStream });

  if (state.camPub?.pc) {
    try {
      await replaceVideoTrackInPC(state.camPub.pc, newVideoTrack);
    } catch (err) {
      console.warn('[quality replaceTrack]', err);
      ui.showStatus('画质切换失败：' + err.message, { error: true });
      return false;
    }
  }

  state.quality = qualityKey;
  ui.showStatus('画质已切换为' + getQualityLabel(qualityKey));
  return true;
}

async function toggleScreen() {
  if (state.screenPub) {
    if (state.screenRecording) {
      try {
        const reply = await state.signaling.request('record-stop', { kind: 'screen' });
        applyRecordState(reply);
      } catch (_) {}
    }
    // Stop sharing.
    try { closePC(state.screenPub.pc); } catch (_) {}
    if (state.localScreenStream) {
      state.localScreenStream.getTracks().forEach((t) => t.stop());
    }
    state.signaling.send('stream-stopped', {
      kind: 'screen',
      streamId: state.screenPub.streamId,
    });
    state.screenPub = null;
    state.localScreenStream = null;
    ui.removeTile('self-screen');
    ui.setButtonState('btnScreen', '');
    return;
  }

  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    ui.showStatus('屏幕共享取消：' + err.message, { error: false });
    return;
  }
  state.localScreenStream = display;
  ui.upsertTile('self-screen', {
    nickname: state.myNickname + '（我，屏幕）',
    isSelf: true,
    isScreen: true,
    stream: display,
  });
  ui.setButtonState('btnScreen', 'active');

  // If user stops sharing via the browser UI, treat as toggle off.
  display.getVideoTracks()[0].addEventListener('ended', () => {
    if (state.screenPub) toggleScreen();
  });

  try {
    state.screenPub = await publishStream({
      signaling: state.signaling,
      stream: display,
      kind: 'screen',
    });
  } catch (err) {
    ui.showStatus('屏幕推流失败：' + err.message, { error: true });
    display.getTracks().forEach((t) => t.stop());
    state.localScreenStream = null;
    ui.removeTile('self-screen');
    ui.setButtonState('btnScreen', '');
  }
}

function leave({ navigate }) {
  try {
    if (state.signaling) state.signaling.send('leave', {});
  } catch (_) {}
  if (state.camPub) closePC(state.camPub.pc);
  if (state.screenPub) closePC(state.screenPub.pc);
  for (const peer of state.peers.values()) {
    if (peer.cam) closePC(peer.cam.pc);
    if (peer.screen) closePC(peer.screen.pc);
  }
  if (state.localCamStream) state.localCamStream.getTracks().forEach((t) => t.stop());
  if (state.localScreenStream) state.localScreenStream.getTracks().forEach((t) => t.stop());
  try { state.signaling && state.signaling.close(); } catch (_) {}
  if (navigate) location.href = 'index.html';
}
