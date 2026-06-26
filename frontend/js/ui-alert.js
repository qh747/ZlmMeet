/** Styled alert dialog matching the app dark-glass UI. */

export const TOKEN_ERROR_MESSAGE = '令牌输入错误';
export const RECORD_HOOK_ERROR_MESSAGE = '请联系管理员配置录像事件处理流程';

let dialog;
let titleEl;
let messageEl;
let okBtn;

function ensureDialog() {
  if (dialog) return;

  dialog = document.createElement('dialog');
  dialog.className = 'app-alert-dialog';
  dialog.innerHTML = `
    <div class="app-alert-head">
      <span class="app-alert-icon" aria-hidden="true">!</span>
      <h2 class="app-alert-title">提示</h2>
    </div>
    <p class="app-alert-message"></p>
    <div class="app-alert-actions">
      <button type="button" class="primary app-alert-ok">确定</button>
    </div>
  `;
  document.body.appendChild(dialog);

  titleEl = dialog.querySelector('.app-alert-title');
  messageEl = dialog.querySelector('.app-alert-message');
  okBtn = dialog.querySelector('.app-alert-ok');

  okBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}

/**
 * @param {string} message
 * @param {{ title?: string }} [opts]
 */
export function showAppAlert(message, { title = '提示' } = {}) {
  ensureDialog();
  titleEl.textContent = title;
  messageEl.textContent = message;

  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }

  return new Promise((resolve) => {
    const done = () => {
      dialog.removeEventListener('close', done);
      resolve();
    };
    dialog.addEventListener('close', done);
  });
}

export function isTokenError(message) {
  return message === TOKEN_ERROR_MESSAGE;
}

export function showTokenErrorAlert() {
  return showAppAlert(TOKEN_ERROR_MESSAGE, { title: '令牌错误' });
}

export function showRecordHookErrorAlert() {
  return showAppAlert(RECORD_HOOK_ERROR_MESSAGE, { title: '无法获取录像' });
}
