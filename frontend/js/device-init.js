/** Sync bootstrap: add device / viewport classes on <html> before paint. */
(function () {
  var ua = navigator.userAgent;
  var root = document.documentElement;

  function isIPhone() {
    return /iPhone|iPod/i.test(ua);
  }

  /** macOS Safari also reports maxTouchPoints > 1; must not treat desktop Mac as iPad. */
  function isMacDesktop() {
    if (!/Macintosh|Mac OS X/i.test(ua)) return false;
    if (isIPhone() || /iPad/i.test(ua)) return false;
    return window.matchMedia('(pointer: fine)').matches
      && window.matchMedia('(hover: hover)').matches;
  }

  function isIPad() {
    if (/iPad/i.test(ua)) return true;
    if (isIPhone() || isMacDesktop()) return false;
    // iPadOS 13+ may report MacIntel without "iPad" in UA
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  }

  function isAndroidTablet() {
    return /Android/i.test(ua) && !/Mobile/i.test(ua);
  }

  var isIOS = isIPhone() || isIPad();
  var isAndroid = /Android/i.test(ua);
  if (isIOS) {
    root.classList.add('device-ios');
  }
  if (isIPhone()) {
    root.classList.add('device-iphone');
  }
  if (isIPad()) {
    root.classList.add('device-ipad');
  }
  if (isAndroid) {
    root.classList.add('device-android');
  }
  if (isAndroid && /Mobile/i.test(ua)) {
    root.classList.add('device-android-phone');
  }
  if (isAndroidTablet()) {
    root.classList.add('device-android-tablet');
  }
  if (window.matchMedia('(pointer: coarse)').matches) {
    root.classList.add('device-touch');
  }

  function shouldWrapStaticVideo(video) {
    return video && (video.id === 'localVideo' || video.id === 'remoteVideo');
  }

  function wrapCameraVideo(video) {
    if (!video || video.dataset.flipWrapped === '1') return;
    if (!shouldWrapStaticVideo(video)) return;
    var parent = video.parentElement;
    if (!parent || parent.classList.contains('video-flip-x')) return;
    var wrap = document.createElement('div');
    wrap.className = 'video-flip-x';
    parent.insertBefore(wrap, video);
    wrap.appendChild(video);
    video.dataset.flipWrapped = '1';
  }

  function applyViewportClasses() {
    var w = window.innerWidth;
    root.classList.toggle('device-mobile', w <= 720);
    root.classList.toggle('device-narrow', w <= 480);
    root.classList.toggle('device-tablet', isIPad() || isAndroidTablet());
  }

  function initCameraVideoFlipWrap() {
    document.querySelectorAll('#localVideo, #remoteVideo').forEach(wrapCameraVideo);
  }

  applyViewportClasses();
  window.addEventListener('resize', applyViewportClasses, { passive: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCameraVideoFlipWrap);
  } else {
    initCameraVideoFlipWrap();
  }

  root.classList.toggle('device-desktop', !isIOS && !isAndroid);
})();
