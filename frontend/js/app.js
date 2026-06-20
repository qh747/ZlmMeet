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

  localCamStream: null,     // MediaStream from getUserMedia
  camPub: null,             // { pc, streamId }
  camRecording: false,

  localScreenStream: null,
  screenPub: null,
  screenRecording: false,

  // peers keyed by userId. Each: { nickname, cam: {pc}, screen: {pc} }
  peers: new Map(),
};

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
  // 1) Local capture first so the user sees themselves immediately.
  let localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (err) {
    ui.showStatus('无法访问摄像头/麦克风：' + err.message, { error: true, durationMs: 0 });
    throw err;
  }
  state.localCamStream = localStream;
  ui.upsertTile('self', { nickname: state.myNickname + '（我）', isSelf: true, stream: localStream });

  // 2) Connect WebSocket signaling.
  const wsURL = buildWsURL();
  state.signaling = new Signaling(wsURL);
  wireSignalHandlers(state.signaling);
  try {
    await state.signaling.connect();
  } catch (err) {
    ui.showStatus('信令连接失败：' + err.message, { error: true, durationMs: 0 });
    throw err;
  }

  // 3) Join the room and wait for the `joined` reply (it's fire-and-forget but
  //    the server will respond with a `joined` message handled below).
  state.signaling.send('join', { room: state.room, nickname: state.myNickname, mode: state.mode });

  // 4) Publish our cam+mic.
  try {
    state.camPub = await publishStream({
      signaling: state.signaling,
      stream: localStream,
      kind: 'cam',
      onState: (s) => {
        if (s === 'failed' || s === 'disconnected') {
          ui.showStatus('上行连接异常，请检查 ZLM WebRTC 配置', { error: true, durationMs: 0 });
        }
      },
    });
  } catch (err) {
    ui.showStatus('推流失败：' + err.message, { error: true, durationMs: 0 });
    throw err;
  }

  wireToolbar();
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
    // Server broadcasts when any peer toggles recording, including self ack.
    if (p.userId === state.myUserId || !p.userId) {
      // Self ack: update the relevant local tile + button.
      if (p.kind === 'cam') {
        state.camRecording = p.recording;
        ui.upsertTile('self', { recording: p.recording });
        ui.setButtonState('btnRecord', p.recording ? 'recording' : '');
      } else if (p.kind === 'screen') {
        state.screenRecording = p.recording;
        ui.upsertTile('self-screen', { recording: p.recording });
        ui.setButtonState('btnRecordScreen', p.recording ? 'recording' : '');
      }
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

async function startPullingPeerStream(userId, nickname, kind) {
  const peer = ensurePeer(userId, nickname);
  if (peer[kind]) return; // already pulling
  const tileKey = `peer-${userId}-${kind}`;
  ui.upsertTile(tileKey, {
    nickname: peer.nickname,
    isScreen: kind === 'screen',
  });

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
  } catch (err) {
    console.warn(`[pull ${userId}/${kind}]`, err);
    ui.showStatus(`拉流失败：${err.message}`, { error: true });
    ui.removeTile(tileKey);
  }
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
    // The ack arrives as type=record-state with our reqId; signaling.request
    // intercepts it so the listener never fires. Apply the same state update
    // here so the toolbar reflects the change immediately.
    if (reply) {
      if (reply.kind === 'cam') {
        state.camRecording = !!reply.recording;
        ui.upsertTile('self', { recording: reply.recording });
        ui.setButtonState('btnRecord', reply.recording ? 'recording' : '');
      } else if (reply.kind === 'screen') {
        state.screenRecording = !!reply.recording;
        ui.upsertTile('self-screen', { recording: reply.recording });
        ui.setButtonState('btnRecordScreen', reply.recording ? 'recording' : '');
      }
    }
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

async function toggleScreen() {
  if (state.screenPub) {
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
