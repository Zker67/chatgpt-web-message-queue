import { t } from '../i18n/index.js';

// 可见告警条：上游发送失败只是静默 return，用户无从得知队列已卡住。
let activeNoticeKey = null;

export function buildNotice(titleKey, bodyKey, onDismiss) {
    const notice = document.createElement('div');
    notice.contentEditable = 'false';
    notice.dataset.queueNotice = 'true';
    notice.style.cssText = [
        'display:flex',
        'align-items:flex-start',
        'gap:10px',
        'padding:10px 12px',
        'border-radius:12px',
        'border:1px solid rgba(255,180,80,.35)',
        'background:rgba(255,180,80,.10)',
        'font-size:13px',
        'line-height:1.45',
    ].join(';');

    const textColumn = document.createElement('div');
    textColumn.style.cssText = 'flex:1 1 auto;min-width:0;';

    const title = document.createElement('div');
    title.textContent = t(titleKey);
    title.style.cssText = 'font-weight:600;margin-bottom:2px;';

    const body = document.createElement('div');
    body.textContent = t(bodyKey);
    body.style.cssText = 'opacity:.85;';

    textColumn.appendChild(title);
    textColumn.appendChild(body);

    const dismissButton = document.createElement('button');
    dismissButton.type = 'button';
    dismissButton.contentEditable = 'false';
    dismissButton.textContent = t('dismiss');
    dismissButton.style.cssText =
        'flex:0 0 auto;padding:4px 10px;border-radius:999px;cursor:pointer;' +
        'border:1px solid rgba(255,255,255,.16);background:transparent;color:inherit;font-size:12px;';

    dismissButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        activeNoticeKey = null;
        notice.remove();
        onDismiss?.();
    }, true);

    notice.appendChild(textColumn);
    notice.appendChild(dismissButton);
    return notice;
}

// 同一类告警只挂一条，避免反复失败刷屏。
export function showNoticeOnce(host, key, titleKey, bodyKey) {
    if (!host) return;
    if (activeNoticeKey === key && host.querySelector('[data-queue-notice="true"]')) return;

    host.querySelector('[data-queue-notice="true"]')?.remove();
    activeNoticeKey = key;
    host.prepend(buildNotice(titleKey, bodyKey));
}

export function clearNotice(host) {
    activeNoticeKey = null;
    host?.querySelector('[data-queue-notice="true"]')?.remove();
}
