// quality.js — video quality presets and UI helpers for publish-side pages.

export const QUALITIES = {
  smooth: {
    key: 'smooth',
    label: '流畅',
    desc: '426×240 · 15fps',
    width: 426,
    height: 240,
    frameRate: { ideal: 15, max: 20 },
  },
  standard: {
    key: 'standard',
    label: '标清',
    desc: '640×480 · 24fps',
    width: 640,
    height: 480,
    frameRate: { ideal: 24, max: 30 },
  },
  hd: {
    key: 'hd',
    label: '高清',
    desc: '1280×720 · 30fps',
    width: 1280,
    height: 720,
    frameRate: { ideal: 30, max: 30 },
  },
};

export const STORAGE_KEY = 'zlm.quality';
export const DEFAULT_QUALITY = 'standard';

export function getStoredQuality() {
  const q = sessionStorage.getItem(STORAGE_KEY);
  return QUALITIES[q] ? q : DEFAULT_QUALITY;
}

export function setStoredQuality(key) {
  if (QUALITIES[key]) sessionStorage.setItem(STORAGE_KEY, key);
}

export function getQualityLabel(key) {
  return (QUALITIES[key] || QUALITIES[DEFAULT_QUALITY]).label;
}

export function getVideoConstraints(qualityKey) {
  const q = QUALITIES[qualityKey] || QUALITIES[DEFAULT_QUALITY];
  return {
    width: { ideal: q.width },
    height: { ideal: q.height },
    frameRate: q.frameRate,
  };
}

/** Replace the video sender track on an active publish PeerConnection. */
export async function replaceVideoTrackInPC(pc, newTrack) {
  if (!pc || !newTrack) return;
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (sender) await sender.replaceTrack(newTrack);
}

/**
 * Swap the video track on an existing MediaStream (audio tracks untouched).
 * Stops and removes the old video track.
 */
export function swapStreamVideoTrack(stream, newVideoTrack) {
  for (const t of stream.getVideoTracks()) {
    stream.removeTrack(t);
    t.stop();
  }
  stream.addTrack(newVideoTrack);
}

/**
 * Wire the quality toolbar button + dialog on pages that include the markup.
 *
 * @param {object} opts
 * @param {() => boolean} opts.isCamOn       returns false when camera is off
 * @param {(key: string) => Promise<boolean>} opts.onApply  apply quality; return false on failure
 * @param {() => string} [opts.getCurrent]   current quality key
 */
export function wireQualityUI({ isCamOn, onApply, getCurrent = getStoredQuality }) {
  const btn = document.getElementById('btnQuality');
  const dialog = document.getElementById('qualityDialog');
  const failDialog = document.getElementById('qualityFailDialog');
  const failMsg = document.getElementById('qualityFailMsg');
  const failOk = document.getElementById('qualityFailOk');
  const closeBtn = document.getElementById('qualityClose');

  if (!btn || !dialog) return;

  function showFail(message) {
    if (failDialog && failMsg) {
      failMsg.textContent = message;
      failDialog.showModal();
    }
  }

  function highlightCurrent() {
    const current = getCurrent();
    for (const opt of dialog.querySelectorAll('.quality-option')) {
      opt.classList.toggle('selected', opt.dataset.quality === current);
    }
    const labelEl = btn.querySelector('.label');
    if (labelEl) labelEl.textContent = getQualityLabel(current);
  }

  btn.addEventListener('click', () => {
    highlightCurrent();
    dialog.showModal();
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', () => dialog.close());
  }

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  for (const opt of dialog.querySelectorAll('.quality-option')) {
    opt.addEventListener('click', async () => {
      const key = opt.dataset.quality;
      if (!key || key === getCurrent()) {
        dialog.close();
        return;
      }
      if (!isCamOn()) {
        dialog.close();
        showFail('请先打开摄像头后再切换画质');
        return;
      }
      const ok = await onApply(key);
      if (ok) {
        setStoredQuality(key);
        highlightCurrent();
        dialog.close();
      } else {
        dialog.close();
        showFail('画质切换失败，请稍后重试');
      }
    });
  }

  if (failOk && failDialog) {
    failOk.addEventListener('click', () => failDialog.close());
  }

  highlightCurrent();
}
