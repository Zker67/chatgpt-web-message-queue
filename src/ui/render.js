import { queueHostId, exitDeleteAnimationMilliseconds } from '../constants.js';
import { composerFormNode } from '../platform/selectors.js';
import {
    queueHostNode, setQueueHostNode,
    hostListenersAttached, setHostListenersAttached,
    promptQueue,
    activeEditIndex, setActiveEditIndex,
    activeEditOriginalText, setActiveEditOriginalText,
    isDragging,
    lastRenderedQueueSnapshot, setLastRenderedQueueSnapshot,
    pendingEnterCountFromBottom, setPendingEnterCountFromBottom,
    bumpSendCancellationToken,
} from '../core/state.js';
import { deleteQueueItemAt } from '../core/queue.js';
import { ensureAnimationStyles, queueHostStyle, queueRowWrapperStyle, queueItemBoxStyle, queueTextStyle } from './styles.js';
import { buildControlsRow, makeIconButton } from './controls.js';
import { makeDragHandle, clearDropLine, onHostDragOver, onHostDrop, onHostDragLeave } from './dragdrop.js';
import { t } from '../i18n/index.js';

// 渲染钩子由 main 注入，避免 UI 层直接依赖发送逻辑造成循环引用。
let renderHooks = {};
export function setRenderHooks(hooks) { renderHooks = hooks || {}; }

export function ensureQueueHost() {
    if (!composerFormNode()) return null;

    // 面板永远挂在 body 上；被 ChatGPT 的整页重渲染移除时重新创建。
    if (queueHostNode && !queueHostNode.isConnected) {
        setQueueHostNode(null);
        setHostListenersAttached(false);
    }

    if (!queueHostNode) {
        const host = document.createElement('div');
        host.id = queueHostId;
        host.contentEditable = 'false';
        host.setAttribute('role', 'region');
        host.style.cssText = queueHostStyle();
        host.style.display = 'none';
        document.body.appendChild(host);
        setQueueHostNode(host);
    }

    if (!hostListenersAttached) {
        setHostListenersAttached(true);
        queueHostNode.addEventListener('dragover', (event) => onHostDragOver(event, queueHostNode), true);
        queueHostNode.addEventListener('drop', (event) => onHostDrop(event, renderHooks), true);
        queueHostNode.addEventListener('dragleave', onHostDragLeave, true);
    }

    return queueHostNode;
}

// 按输入框外框的坐标把面板贴在其上方。用 bottom 定位，队列变长时向上生长。
export function positionQueueHost() {
    const host = queueHostNode;
    if (!host || host.style.display === 'none') return;

    const form = composerFormNode();
    if (!form) { host.style.display = 'none'; return; }

    const rect = form.getBoundingClientRect();
    if (!rect.width) { host.style.display = 'none'; return; }

    const gapPixels = 8;
    host.style.left = `${Math.round(rect.left)}px`;
    host.style.width = `${Math.round(rect.width)}px`;
    host.style.bottom = `${Math.round(window.innerHeight - rect.top + gapPixels)}px`;
}

function showQueueHost(host) {
    host.style.cssText = queueHostStyle();
    host.style.display = 'flex';
    positionQueueHost();
}

function hideQueueHost(host) {
    host.style.display = 'none';
}

// 构建单行。editing 为 true 时该行进入可编辑态。
function buildQueueRow(index, { editing, anyEditing }) {
    const rowWrapper = document.createElement('div');
    rowWrapper.contentEditable = 'false';
    rowWrapper.dataset.queueRow = 'true';
    rowWrapper.dataset.queueIndex = String(index);
    rowWrapper.style.cssText = queueRowWrapperStyle();

    const handle = makeDragHandle(index, renderHooks);
    if (anyEditing) {
        // 编辑期间禁止拖拽，避免索引错乱。
        handle.setAttribute('draggable', 'false');
        handle.style.cursor = 'not-allowed';
        handle.style.opacity = '.55';
    }

    const itemBox = document.createElement('div');
    itemBox.contentEditable = 'false';
    itemBox.dataset.queueBox = 'true';
    itemBox.style.cssText = queueItemBoxStyle();

    const indexBadge = document.createElement('span');
    indexBadge.contentEditable = 'false';
    indexBadge.textContent = `#${index + 1}`;
    indexBadge.style.cssText = 'flex:0 0 auto;opacity:.55;font-size:12px;line-height:1.4;padding-top:2px;user-select:none;';
    itemBox.appendChild(indexBadge);

    const text = document.createElement('div');
    text.contentEditable = editing ? 'true' : 'false';
    text.spellcheck = false;
    text.setAttribute('aria-label', t('queuedItemLabel', { index: index + 1 }));
    text.style.cssText = editing
        ? `${queueTextStyle()};border-radius:10px;border:1px solid rgba(255,255,255,.18);` +
          'background:rgba(0,0,0,.12);padding:8px 10px;max-height:220px;overflow:auto;'
        : queueTextStyle();
    text.textContent = promptQueue[index];

    const buttons = document.createElement('div');
    buttons.contentEditable = 'false';
    buttons.style.cssText = 'display:flex;gap:8px;flex:0 0 auto;margin-left:auto;align-items:center;';

    const primaryButton = makeIconButton({
        title: editing ? t('save') : t('edit'),
        spriteId: editing ? 'check' : 'pencil',
        fallbackText: editing ? '✓' : '✎',
    });
    const secondaryButton = makeIconButton({
        title: editing ? t('cancel') : t('delete'),
        spriteId: editing ? 'close' : 'trash',
        fallbackText: editing ? '✕' : '🗑',
    });

    primaryButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!editing) return beginInlineEdit(index);
        commitInlineEdit(text.innerText);
    }, true);

    secondaryButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!editing) return animateAndDeleteQueueItem(index);
        cancelInlineEdit();
    }, true);

    if (editing) {
        text.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelInlineEdit();
            }
            // Enter 保存，Shift+Enter 换行。
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                commitInlineEdit(text.innerText);
            }
        }, true);

        text.addEventListener('blur', () => {
            if (activeEditIndex !== null) commitInlineEdit(text.innerText);
        }, { capture: true, once: true });
    }

    buttons.appendChild(primaryButton);
    buttons.appendChild(secondaryButton);

    itemBox.appendChild(text);
    itemBox.appendChild(buttons);

    rowWrapper.appendChild(handle);
    rowWrapper.appendChild(itemBox);

    return { rowWrapper, text };
}

// 清空重建：用于队列结构变化后的整体刷新。
export function renderQueueHard() {
    const host = ensureQueueHost();
    if (!host) return;

    clearDropLine();
    setActiveEditIndex(null);
    host.innerHTML = '';
    renderQueue();
}

export function renderQueue() {
    const host = ensureQueueHost();
    if (!host) return;
    // 编辑或拖拽进行中不重绘，否则会打断用户操作。
    if (activeEditIndex !== null) return;
    if (isDragging) return;

    ensureAnimationStyles();

    // 只对本次新增的尾部若干行播放入场动画。
    setPendingEnterCountFromBottom(
        promptQueue.length > lastRenderedQueueSnapshot.length
            ? Math.min(promptQueue.length - lastRenderedQueueSnapshot.length, promptQueue.length)
            : 0
    );
    setLastRenderedQueueSnapshot(promptQueue.slice());

    host.innerHTML = '';
    if (promptQueue.length === 0) { hideQueueHost(host); return; }
    showQueueHost(host);

    for (let index = 0; index < promptQueue.length; index++) {
        const { rowWrapper } = buildQueueRow(index, { editing: false, anyEditing: false });

        const isInEnterRange =
            pendingEnterCountFromBottom > 0 && index >= promptQueue.length - pendingEnterCountFromBottom;
        if (isInEnterRange) rowWrapper.classList.add('tmq-enter');

        host.appendChild(rowWrapper);
    }

    host.appendChild(buildControlsRow(renderQueueHard));
}

// ---------- 行内编辑 ----------
export function beginInlineEdit(index) {
    const host = ensureQueueHost();
    if (!host) return;
    if (index < 0 || index >= promptQueue.length) return;

    // 编辑中的条目不应被发送出去。
    bumpSendCancellationToken();
    clearDropLine();

    setActiveEditIndex(index);
    // 记下原文，取消编辑时回滚。
    setActiveEditOriginalText(promptQueue[index]);

    host.innerHTML = '';
    showQueueHost(host);

    let editingTextNode = null;
    for (let i = 0; i < promptQueue.length; i++) {
        const editing = i === index;
        const { rowWrapper, text } = buildQueueRow(i, { editing, anyEditing: true });
        if (editing) editingTextNode = text;
        host.appendChild(rowWrapper);
    }

    host.appendChild(buildControlsRow(renderQueueHard));

    // 等 DOM 落定后聚焦并全选，方便直接覆写。
    if (editingTextNode) {
        queueMicrotask(() => {
            editingTextNode.focus();
            try {
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(editingTextNode);
                selection.removeAllRanges();
                selection.addRange(range);
            } catch { }
        });
    }
}

export function commitInlineEdit(editedText) {
    if (activeEditIndex === null) return;

    const cleaned = renderHooks.normalizeText ? renderHooks.normalizeText(editedText) : String(editedText || '').trim();
    // 清空内容等同删除该条。
    if (!cleaned) return animateAndDeleteQueueItem(activeEditIndex);

    promptQueue[activeEditIndex] = cleaned;
    setActiveEditIndex(null);

    renderHooks.onQueueChanged?.();
    renderQueueHard();
}

export function cancelInlineEdit() {
    if (activeEditIndex === null) return;

    promptQueue[activeEditIndex] = activeEditOriginalText;
    setActiveEditIndex(null);

    renderHooks.onQueueChanged?.();
    renderQueueHard();
}

export function animateAndDeleteQueueItem(index) {
    if (index < 0 || index >= promptQueue.length) return;
    bumpSendCancellationToken();

    const host = ensureQueueHost();
    const row = host?.querySelector(`[data-queue-row="true"][data-queue-index="${index}"]`);

    const finish = () => {
        deleteQueueItemAt(index);
        renderQueueHard();
        renderHooks.onQueueChanged?.();
    };

    if (!row) return finish();

    row.classList.remove('tmq-enter');
    row.classList.add('tmq-exit-delete');
    setTimeout(finish, exitDeleteAnimationMilliseconds);
}
