// app.js — main meeting flow.
//
// Responsibilities:
//   - Read room/nickname from sessionStorage, redirect to index if missing.
//   - Connect signaling, join room, capture mic+cam, publish.
//   - On peer-joined / existing peers, pull their `cam` and (if present) `screen`.
//   - Wire toolbar buttons: mic toggle, cam toggle, screen share, chat, leave.
//   - Render UI updates via MeetingUI.

import { Signaling } from './signaling.js';
import { publishStream, playStream, closePC, closePublishPC, publishOrUpdateStream } from './webrtc.js';
import { MeetingUI } from './ui.js';
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
  token: sessionStorage.getItem('zlm.token') || '',
  micOn: sessionStorage.getItem('zlm.micOn') !== 'false',
  camOn: sessionStorage.getItem('zlm.camOn') !== 'false',
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

syncQualityButtonLabel(() => state.quality);

// Recording preview overlay (shared with push page markup).
const previewOverlay = document.getElementById('previewOverlay');
const previewVideo = document.getElementById('previewVideo');
const previewTitle = document.getElementById('previewTitle');
const previewClose = document.getElementById('previewClose');
const previewCloseBtn = document.getElementById('previewCloseBtn');
const previewDownload = document.getElementById('previewDownload');
let pendingRecordFileUrl = null;
let pendingRecordKind = 'cam';
let mediaToggleBusy = false;

function camPublishOpts() {
  return {
    signaling: state.signaling,
    kind: 'cam',
    onState: (s) => {
      if (s === 'failed' || s === 'disconnected') {
        ui.showStatus('上行连接异常，请检查 ZLM WebRTC 配置', { error: true, durationMs: 0 });
      }
    },
  };
}

function ensureLocalCamStream() {
  if (!state.localCamStream) state.localCamStream = new MediaStream();
  return state.localCamStream;
}

async function ensureCamPublish() {
  const stream = state.localCamStream;
  if (!stream || stream.getTracks().length === 0) return;

  const prevPub = state.camPub;
  if (prevPub?.pc) {
    const prevKinds = new Set(
      prevPub.pc.getSenders().filter((s) => s.track).map((s) => s.track.kind),
    );
    const newKinds = new Set(stream.getTracks().map((t) => t.kind));
    const needsRepublish = [...newKinds].some((k) => !prevKinds.has(k))
      || [...prevKinds].some((k) => !newKinds.has(k));
    if (needsRepublish && prevPub.streamId) {
      try {
        state.signaling.send('stream-stopped', { kind: 'cam', streamId: prevPub.streamId });
      } catch (_) {}
    }
  }

  state.camPub = await publishOrUpdateStream({
    existingPub: state.camPub,
    stream,
    publishOpts: camPublishOpts(),
  });
  notifyCamStreamStarted();
}

function notifyCamStreamStarted() {
  if (!state.camPub?.streamId || !state.signaling) return;
  try {
    state.signaling.send('stream-started', { kind: 'cam', streamId: state.camPub.streamId });
  } catch (_) {}
}

async function acquireLocalTrack(kind) {
  const stream = ensureLocalCamStream();
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

// Wire toolbar immediately so Leave / toggles work even if camera or signaling fails.
wireToolbar();

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
  const mediaPromise = (state.micOn || state.camOn)
    ? navigator.mediaDevices
      .getUserMedia({
        audio: state.micOn,
        video: state.camOn ? getVideoConstraints(state.quality) : false,
      })
      .catch((err) => {
        // Camera / mic unavailable — fall back so signaling and toolbar still work.
        state.micOn = false;
        state.camOn = false;
        ui.setButtonState('btnMic', 'off');
        ui.setButtonState('btnCam', 'off');
        ui.showStatus('无法访问摄像头/麦克风：' + err.message, { error: true, durationMs: 6000 });
        return new MediaStream();
      })
    : Promise.resolve(new MediaStream());

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
    token: state.token,
    micOn: state.micOn,
    camOn: state.camOn,
  });

  // (3) Local media ready → publish first so existing peers can pull ASAP,
  //     then render self tile and wire toolbar.
  const localStream = await mediaPromise;
  state.localCamStream = localStream;
  for (const t of localStream.getAudioTracks()) t.enabled = state.micOn;
  for (const t of localStream.getVideoTracks()) t.enabled = state.camOn;

  const hasLocalTracks = localStream.getTracks().length > 0;
  const publishPromise = hasLocalTracks
    ? publishStream({
      ...camPublishOpts(),
      stream: localStream,
    }).then((result) => {
      state.camPub = result;
    }).catch((err) => {
      ui.showStatus('推流失败：' + err.message, { error: true, durationMs: 0 });
      throw err;
    })
    : Promise.resolve();

  ui.upsertTile('self', {
    nickname: state.myNickname + '（我）',
    isSelf: true,
    stream: hasLocalTracks ? localStream : null,
  });
  state.signaling.send('media-state', { micOn: state.micOn, camOn: state.camOn });
  if (!hasLocalTracks) {
    ui.showStatus('已加入，当前未开启麦克风或摄像头');
  }

  await publishPromise;
}

function buildWsURL() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // When opening the page directly (file://), default to localhost:8080.
  const host = location.host || 'localhost:8080';
  return `${scheme}//${host}/ws`;
}

// === Signaling event handlers ================================================

function ensurePeerPlaceholderTile(userId, nickname, { micOn, camOn } = {}) {
  const peer = ensurePeer(userId, nickname);
  const tileKey = `peer-${userId}-cam`;
  ui.upsertTile(tileKey, { nickname: peer.nickname });
  if (micOn !== undefined || camOn !== undefined) {
    ui.updateBadges(tileKey, {
      micOn: micOn !== undefined ? micOn : true,
      camOn: camOn !== undefined ? camOn : true,
    });
  }
  return peer;
}

function wireSignalHandlers(sig) {
  sig.on('joined', (p) => {
    state.myUserId = p.userId;
    ui.appendSystem(`已加入房间 ${p.room}`);
    for (const peer of p.peers || []) {
      ensurePeerPlaceholderTile(peer.userId, peer.nickname, {
        micOn: peer.micOn,
        camOn: peer.camOn,
      });
      for (const s of peer.streams || []) {
        startPullingPeerStream(peer.userId, peer.nickname, s.kind);
      }
    }
  });

  sig.on('peer-joined', (p) => {
    ensurePeerPlaceholderTile(p.userId, p.nickname, {
      micOn: p.micOn,
      camOn: p.camOn,
    });
    ui.appendSystem(`${p.nickname} 加入了`);
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
    ensurePeerPlaceholderTile(p.userId, null, { micOn: p.micOn, camOn: p.camOn });
  });

  sig.on('peer-stream-started', (p) => {
    const peer = ensurePeer(p.userId);
    startPullingPeerStream(p.userId, peer.nickname, p.kind, { preemptive: true, force: true });
  });

  sig.on('peer-stream-stopped', (p) => {
    const peer = state.peers.get(p.userId);
    if (peer && peer[p.kind]) {
      closePC(peer[p.kind].pc);
      delete peer[p.kind];
    }
    if (p.kind === 'cam' && peer) {
      ensurePeerPlaceholderTile(p.userId, peer.nickname);
      ui.upsertTile(`peer-${p.userId}-cam`, { stream: null });
    } else {
      ui.removeTile(`peer-${p.userId}-${p.kind}`);
    }
  });

  sig.on('chat', (p) => {
    const isMe = p.from === state.myUserId;
    ui.appendChat({ nickname: p.nickname, text: p.text, ts: p.ts, isMe });
    if (!isMe && !ui.isChatOpen()) {
      ui.setChatUnread(true);
    }
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

  sig.on('error', async (p) => {
    console.warn('[server error]', p.message);
    if (isTokenError(p.message)) {
      await showTokenErrorAlert();
      location.href = 'index.html';
      return;
    }
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

function stopPeerPull(peer, kind) {
  if (!peer || !peer[kind]) return;
  closePC(peer[kind].pc);
  delete peer[kind];
}

async function startPullingPeerStream(userId, nickname, kind, { preemptive = false, force = false } = {}) {
  const peer = ensurePeer(userId, nickname);
  const inflightKey = `${kind}Pulling`;

  if (force) {
    stopPeerPull(peer, kind);
    delete peer[inflightKey];
  }

  if (peer[kind] && !force) return;
  if (peer[inflightKey] && !force) return peer[inflightKey];

  const tileKey = `peer-${userId}-${kind}`;
  ui.upsertTile(tileKey, {
    nickname: peer.nickname,
    isScreen: kind === 'screen',
  });

  const pullGen = (peer[`${kind}PullGen`] || 0) + 1;
  peer[`${kind}PullGen`] = pullGen;

  peer[inflightKey] = pullPeerStreamWithRetry(userId, nickname, kind, tileKey, preemptive, pullGen)
    .finally(() => { delete peer[inflightKey]; });
  return peer[inflightKey];
}

async function pullPeerStreamWithRetry(userId, nickname, kind, tileKey, preemptive, pullGen) {
  const peer = ensurePeer(userId, nickname);
  const maxAttempts = preemptive ? 30 : 3;
  const retryDelayMs = 200;
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (peer[`${kind}PullGen`] !== pullGen) return;
    if (peer[kind]) return;
    try {
      let pullResult = null;
      pullResult = await playStream({
        signaling: state.signaling,
        targetUserId: userId,
        kind,
        onTrack: (stream) => {
          if (peer[`${kind}PullGen`] !== pullGen) return;
          ui.upsertTile(tileKey, { stream });
        },
        onState: (s) => {
          if (s !== 'failed' && s !== 'disconnected') return;
          if (peer[`${kind}PullGen`] !== pullGen) return;
          if (peer[kind]?.pc !== pullResult?.pc) return;
          const retries = (peer[`${kind}FailRetries`] || 0) + 1;
          peer[`${kind}FailRetries`] = retries;
          stopPeerPull(peer, kind);
          if (retries >= 4) {
            ui.showStatus(`拉取 ${peer.nickname}/${kind} 失败`, { error: true });
            return;
          }
          ui.showStatus(`拉取 ${peer.nickname}/${kind} 失败，正在重试…`, { error: false });
          startPullingPeerStream(userId, nickname, kind, { preemptive: true, force: true });
        },
      });
      if (peer[`${kind}PullGen`] !== pullGen) {
        closePC(pullResult.pc);
        return;
      }
      peer[`${kind}FailRetries`] = 0;
      peer[kind] = pullResult;
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
  // Keep the placeholder tile when the peer has not published yet.
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
    showRecordHookErrorAlert();
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
    await showAppAlert('请先开启屏幕共享后再录屏', { title: '无法录屏' });
    return;
  }
  try {
    const reply = await state.signaling.request(type, { kind });
    applyRecordState(reply);
  } catch (err) {
    ui.showStatus(`录制操作失败：${err.message}`, { error: true });
  }
}

async function toggleMic() {
  if (mediaToggleBusy) return;
  mediaToggleBusy = true;
  const targetOn = !state.micOn;
  try {
    if (targetOn && ensureLocalCamStream().getAudioTracks().length === 0) {
      state.micOn = true;
      await acquireLocalTrack('audio');
      await ensureCamPublish();
      ui.upsertTile('self', { stream: state.localCamStream });
    } else {
      state.micOn = targetOn;
      if (state.localCamStream) {
        for (const t of state.localCamStream.getAudioTracks()) t.enabled = state.micOn;
      }
      if (state.micOn && state.localCamStream?.getAudioTracks().length > 0 && !state.camPub) {
        await ensureCamPublish();
        ui.upsertTile('self', { stream: state.localCamStream });
      }
    }
    ui.setButtonState('btnMic', state.micOn ? '' : 'off');
    state.signaling.send('media-state', { micOn: state.micOn, camOn: state.camOn });
  } catch (err) {
    ui.showStatus(err.message, { error: true });
  } finally {
    mediaToggleBusy = false;
  }
}

async function toggleCam() {
  if (mediaToggleBusy) return;
  mediaToggleBusy = true;
  const targetOn = !state.camOn;
  try {
    if (targetOn && ensureLocalCamStream().getVideoTracks().length === 0) {
      state.camOn = true;
      await acquireLocalTrack('video');
      await ensureCamPublish();
      ui.upsertTile('self', { stream: state.localCamStream });
    } else {
      state.camOn = targetOn;
      if (state.localCamStream) {
        for (const t of state.localCamStream.getVideoTracks()) t.enabled = state.camOn;
      }
      if (state.camOn && state.localCamStream?.getVideoTracks().length > 0 && !state.camPub) {
        await ensureCamPublish();
        ui.upsertTile('self', { stream: state.localCamStream });
      }
    }
    ui.setButtonState('btnCam', state.camOn ? '' : 'off');
    state.signaling.send('media-state', { micOn: state.micOn, camOn: state.camOn });
  } catch (err) {
    ui.showStatus(err.message, { error: true });
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

async function leave({ navigate }) {
  if (navigate && (state.camRecording || state.screenRecording)) {
    await showAppAlert('请先关闭录制再退出', { title: '无法退出' });
    return;
  }
  try {
    if (state.signaling) state.signaling.send('leave', {});
  } catch (_) {}
  if (state.camPub) closePublishPC(state.camPub.pc);
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
