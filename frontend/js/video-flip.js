// video-flip.js — camera mirror correction by client / source platform.

export function getClientPlatform() {
  const root = document.documentElement;
  if (root.classList.contains('device-ios')) return 'ios';
  if (root.classList.contains('device-android')) return 'android';
  return 'desktop';
}

/** iOS / Android viewers (used for device bootstrap helpers). */
export function isMobileViewer() {
  const root = document.documentElement;
  return root.classList.contains('device-ios') || root.classList.contains('device-android');
}

/**
 * Whether to horizontally flip a camera tile for correct left/right.
 * WebRTC camera streams from PC / iOS / Android are commonly mirrored in the
 * encoded frames or in the browser compositor — flip all cam tiles on every
 * viewer. Screen share is never flipped.
 */
export function shouldMirrorVideo({ isScreen = false } = {}) {
  return !isScreen;
}

export function wrapVideoElement(video) {
  if (!video || video.closest('.video-flip-x, .admin-watch-video-flip')) return video;
  const parent = video.parentElement;
  if (!parent) return video;
  const wrap = document.createElement('div');
  wrap.className = 'video-flip-x';
  parent.insertBefore(wrap, video);
  wrap.appendChild(video);
  return video;
}
