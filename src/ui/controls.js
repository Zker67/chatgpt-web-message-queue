import { t, currentLocale, toggleLocale } from '../i18n/index.js';
import { pillButtonStyle } from './styles.js';
import { mergeMessagesEnabled, setMergeMessagesEnabled, promptQueue, bumpSendCancellationToken } from '../core/state.js';
import { persistCurrentStateIfPossible, clearQueue, mergeAllQueueItems } from '../core/queue.js';

// 复用 ChatGPT 自带的图标 sprite；取不到就退回纯文本符号。
function spriteFileBaseHref() {
    const anyUse = document.querySelector('use[href*="sprites-core"]');
    const href = anyUse?.getAttribute('href') || '';
    return href.includes('#') ? href.split('#')[0] : null;
}

export function makeIconOrFallback(spriteId, fallbackText) {
    const spriteBase = spriteFileBaseHref();
    if (!spriteBase) return document.createTextNode(fallbackText);

    const span = document.createElement('span');
    span.className = 'flex items-center justify-center';
    span.contentEditable = 'false';
    span.innerHTML =
        `<svg width="16" height="16" aria-hidden="true"><use href="${spriteBase}#${spriteId}"></use></svg>`;

    // sprite id 不存在时 svg 会是空白，做一次兜底检查。
    return span.querySelector('use') ? span : document.createTextNode(fallbackText);
}

export function makeIconButton({ title, spriteId, fallbackText }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.contentEditable = 'false';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.style.cssText =
        'flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;' +
        'width:28px;height:28px;border-radius:8px;border:1px solid transparent;' +
        'background:transparent;color:inherit;cursor:pointer;opacity:.7;';

    button.addEventListener('mouseenter', () => { button.style.opacity = '1'; });
    button.addEventListener('mouseleave', () => { button.style.opacity = '.7'; });

    button.appendChild(makeIconOrFallback(spriteId, fallbackText));
    return button;
}

function attachPillHover(button) {
    button.addEventListener('mouseenter', () => { button.style.background = 'rgba(255,255,255,.10)'; });
    button.addEventListener('mouseleave', () => { button.style.background = 'rgba(255,255,255,.06)'; });
}

function buildMergeToggleButton(onChanged) {
    const button = document.createElement('button');
    button.type = 'button';
    button.contentEditable = 'false';
    button.setAttribute('aria-pressed', mergeMessagesEnabled ? 'true' : 'false');
    button.style.cssText = `display:inline-flex;align-items:center;gap:8px;${pillButtonStyle}`;

    const label = document.createElement('span');
    label.textContent = t('mergeMessages');

    const state = document.createElement('span');
    state.textContent = mergeMessagesEnabled ? t('on') : t('off');
    state.style.cssText =
        'padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.14);' +
        'background:rgba(0,0,0,.12);font-size:12px;';

    attachPillHover(button);

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        // 切换开关会改变待发内容，作废进行中的发送尝试。
        bumpSendCancellationToken();
        setMergeMessagesEnabled(!mergeMessagesEnabled);

        // 开启合并时把已有队列压成一条，与开关语义保持一致。
        if (mergeMessagesEnabled && promptQueue.length > 1) mergeAllQueueItems();

        persistCurrentStateIfPossible();
        onChanged?.();
    }, true);

    button.appendChild(label);
    button.appendChild(state);
    return button;
}

function buildClearQueueButton(onChanged) {
    const button = document.createElement('button');
    button.type = 'button';
    button.contentEditable = 'false';
    button.textContent = t('clearQueue');
    button.style.cssText = pillButtonStyle;
    attachPillHover(button);

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        bumpSendCancellationToken();
        clearQueue();
        onChanged?.();
    }, true);

    return button;
}

function buildLocaleToggleButton(onChanged) {
    const button = document.createElement('button');
    button.type = 'button';
    button.contentEditable = 'false';
    button.title = t('localeToggleTitle');
    button.setAttribute('aria-label', t('localeToggleTitle'));
    button.textContent = t('localeToggleLabel');
    button.style.cssText = `${pillButtonStyle}min-width:40px;text-align:center;`;
    attachPillHover(button);

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleLocale();
        onChanged?.();
    }, true);

    return button;
}

export function buildControlsRow(onChanged) {
    const row = document.createElement('div');
    row.contentEditable = 'false';
    row.dataset.queueControls = 'true';
    row.dataset.locale = currentLocale;
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;padding:2px 0 0 0;';

    row.appendChild(buildLocaleToggleButton(onChanged));
    row.appendChild(buildMergeToggleButton(onChanged));
    row.appendChild(buildClearQueueButton(onChanged));
    return row;
}
