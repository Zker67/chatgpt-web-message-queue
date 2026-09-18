import { pollIntervalMilliseconds, exitSendAnimationMilliseconds } from './constants.js';
import { composerNode, submitButtonNode, isStreaming, reportSelectorFailureOnce } from './platform/selectors.js';
import { currentComposerText, clearComposer, sleep } from './platform/composer.js';
import {
    promptQueue,
    attachedComposerNode, setAttachedComposerNode,
    attachedSubmitButtonNode, setAttachedSubmitButtonNode,
    submitButtonMutationObserver, setSubmitButtonMutationObserver,
    pendingDraftRestore,
    isDragging,
    isInteracting,
    incrementTransactionCounter,
} from './core/state.js';
import { switchConversationIfNeeded, enqueuePrompt, persistCurrentStateIfPossible } from './core/queue.js';
import { pumpQueue, tryRestorePendingDraft } from './core/sender.js';
import { ensureAnimationStyles } from './ui/styles.js';
import { ensureQueueHost, renderQueue, renderQueueHard, setRenderHooks } from './ui/render.js';
import { showNoticeOnce } from './ui/notice.js';
import { normalizeText } from './platform/composer.js';

// 出队前播放送出动画，让用户看清是哪条被发走了。
async function animateDequeueSendIfVisible() {
    const host = ensureQueueHost();
    const firstRow = host?.querySelector('[data-queue-row="true"]');
    if (!firstRow) return;

    ensureAnimationStyles();
    firstRow.classList.remove('tmq-enter');
    firstRow.classList.add('tmq-exit-send');
    await sleep(exitSendAnimationMilliseconds);
}

const sendHooks = {
    onBeforeDequeue: animateDequeueSendIfVisible,
    onQueueChanged: () => renderQueueHard(),
    onRepeatedFailure: () => {
        showNoticeOnce(ensureQueueHost(), 'send-failure', 'sendFailureTitle', 'sendFailureBody');
    },
};

// UI 层通过钩子回调核心逻辑，避免相互直接依赖。
setRenderHooks({
    normalizeText,
    onQueueChanged: () => {
        persistCurrentStateIfPossible();
        pump();
    },
    onDragEnd: () => {
        if (promptQueue.length && !isStreaming()) pump();
    },
});

function pump() {
    pumpQueue(sendHooks);
}

// ---------- 流式输出中劫持 Enter ----------
// 正在生成时按 Enter 不再被站点忽略，而是把内容收进队列。
function onComposerKeydownCapture(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;

    const composer = composerNode();
    if (!composer || document.activeElement !== composer || !isStreaming()) return;

    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();

    const text = currentComposerText();
    if (text) {
        enqueuePrompt(text);
        renderQueueHard();
    }
    clearComposer();
}

function attachComposerListeners() {
    const composer = composerNode();
    if (!composer || composer === attachedComposerNode) return;

    setAttachedComposerNode(composer);

    // ProseMirror 的事务事件既用于确认文本已写入，也用作草稿恢复的时机。
    composer.addEventListener('prosemirrorDispatchTransaction', () => {
        incrementTransactionCounter();
        if (pendingDraftRestore) tryRestorePendingDraft();
    }, false);

    composer.addEventListener('keydown', onComposerKeydownCapture, true);
}

// 盯住发送按钮状态：从 stop-button 变回 send-button 即代表生成结束，可以发下一条。
function attachSubmitButtonObserver() {
    const button = submitButtonNode();
    if (!button || button === attachedSubmitButtonNode) return;

    setAttachedSubmitButtonNode(button);

    submitButtonMutationObserver?.disconnect();
    const observer = new MutationObserver(() => {
        if (!isStreaming() && promptQueue.length && !isInteracting()) pump();
        if (pendingDraftRestore) tryRestorePendingDraft();
    });

    observer.observe(button, {
        attributes: true,
        attributeFilter: ['data-testid', 'disabled', 'aria-disabled', 'aria-label'],
    });
    setSubmitButtonMutationObserver(observer);
}

// ---------- SPA 路由 ----------
function notifyUrlChange() {
    if (switchConversationIfNeeded()) {
        renderQueueHard();
        pump();
    }
}

function installHistoryHooks() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
        const result = originalPushState.apply(this, args);
        queueMicrotask(notifyUrlChange);
        return result;
    };

    history.replaceState = function (...args) {
        const result = originalReplaceState.apply(this, args);
        queueMicrotask(notifyUrlChange);
        return result;
    };

    window.addEventListener('popstate', () => queueMicrotask(notifyUrlChange), true);
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    notifyUrlChange();
    renderQueueHard();
    if (pendingDraftRestore) tryRestorePendingDraft();
    if (promptQueue.length && !isStreaming() && !isInteracting()) pump();
}, true);

// ---------- 主循环 ----------
function tick() {
    notifyUrlChange();

    // composer 找不到通常意味着页面改版，提示一次而非静默失效。
    if (!composerNode()) {
        reportSelectorFailureOnce(() => {
            showNoticeOnce(document.body, 'selector-failure', 'selectorFailureTitle', 'selectorFailureBody');
        });
        return;
    }

    ensureQueueHost();
    attachComposerListeners();
    attachSubmitButtonObserver();

    if (!isDragging) renderQueue();

    if (pendingDraftRestore) tryRestorePendingDraft();
    if (promptQueue.length && !isStreaming() && !isInteracting()) pump();
}

// ---------- 启动 ----------
ensureAnimationStyles();
installHistoryHooks();
switchConversationIfNeeded();
setInterval(tick, pollIntervalMilliseconds);
tick();
