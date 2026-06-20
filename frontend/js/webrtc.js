// webrtc.js — thin wrappers around RTCPeerConnection for publish and play
// against ZLMediaKit. All SDP exchange goes through the signaling server.

const DEFAULT_RTC_CONFIG = {
  // Public STUN keeps local-network testing working. For LAN-only the default
  // host candidates from `iceTransportPolicy: 'all'` are usually enough.
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  bundlePolicy: 'max-bundle',
};

/**
 * Publish a local MediaStream to ZLM via the signaling server.
 *
 * @param {object} opts
 * @param {Signaling} opts.signaling
 * @param {MediaStream} opts.stream      local audio/video stream to publish
 * @param {'cam'|'screen'} [opts.kind]   meeting/call mode
 * @param {string} [opts.streamId]       solo mode: explicit stream name
 * @param {boolean} [opts.solo]          set true to use publish-solo mode
 * @param {(state: string)=>void} [opts.onState]   called on connectionstate change
 * @returns {Promise<{pc: RTCPeerConnection, streamId: string}>}
 */
export async function publishStream({ signaling, stream, kind, streamId, solo, onState }) {
  const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);

  // Add transceivers (send-only) so SDP m-line ordering matches ZLM expectations.
  for (const track of stream.getTracks()) {
    pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
  }

  if (onState) {
    pc.addEventListener('connectionstatechange', () => onState(pc.connectionState));
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // Wait for ICE gathering to complete so the SDP has all candidates inline.
  await waitIceGathering(pc);

  const reqPayload = solo
    ? { mode: 'publish-solo', streamId, sdp: pc.localDescription.sdp }
    : { mode: 'publish', kind, sdp: pc.localDescription.sdp };
  const reply = await signaling.request('webrtc-offer', reqPayload);
  await pc.setRemoteDescription({ type: 'answer', sdp: reply.sdp });

  // Notify other peers (room modes only; solo rooms get a no-op broadcast on the server).
  if (!solo) {
    signaling.send('stream-started', { kind, streamId: reply.streamId });
  } else {
    signaling.send('stream-started', { kind: 'solo', streamId: reply.streamId });
  }

  return { pc, streamId: reply.streamId };
}

/**
 * Pull a remote stream from ZLM via the signaling server.
 *
 * @param {object} opts
 * @param {Signaling} opts.signaling
 * @param {string} [opts.targetUserId]  user whose stream we want (room mode)
 * @param {'cam'|'screen'} [opts.kind]  room mode
 * @param {string} [opts.streamId]      solo mode: explicit stream name
 * @param {boolean} [opts.solo]         set true to use play-solo mode
 * @param {(stream: MediaStream)=>void} opts.onTrack  fired when remote stream is ready
 * @param {(state: string)=>void} [opts.onState]
 * @returns {Promise<{pc: RTCPeerConnection, streamId: string}>}
 */
export async function playStream({ signaling, targetUserId, kind, streamId, solo, onTrack, onState }) {
  const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);

  // Recvonly transceivers for audio + video so ZLM sends both tracks back.
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });

  const remoteStream = new MediaStream();
  let delivered = false;
  pc.addEventListener('track', (ev) => {
    // Use the streams provided by the browser when possible, else assemble manually.
    if (ev.streams && ev.streams[0]) {
      if (!delivered) { delivered = true; onTrack(ev.streams[0]); }
    } else {
      remoteStream.addTrack(ev.track);
      if (!delivered) { delivered = true; onTrack(remoteStream); }
    }
  });

  if (onState) {
    pc.addEventListener('connectionstatechange', () => onState(pc.connectionState));
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGathering(pc);

  const reqPayload = solo
    ? { mode: 'play-solo', streamId, sdp: pc.localDescription.sdp }
    : { mode: 'play', kind, targetUserId, sdp: pc.localDescription.sdp };
  const reply = await signaling.request('webrtc-offer', reqPayload);
  await pc.setRemoteDescription({ type: 'answer', sdp: reply.sdp });

  return { pc, streamId: reply.streamId };
}

/** Resolves when ICE gathering for `pc` reaches 'complete', or after 2s. */
function waitIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    // Hard timeout so we don't hang forever on unreachable STUN.
    const timer = setTimeout(done, 2000);
  });
}

/** Stops all senders/receivers and closes the PC. */
export function closePC(pc) {
  if (!pc) return;
  try {
    for (const sender of pc.getSenders()) {
      try { sender.track && sender.track.stop(); } catch (_) {}
    }
  } catch (_) {}
  try { pc.close(); } catch (_) {}
}
