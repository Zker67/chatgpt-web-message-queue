import { pollIntervalMilliseconds, exitSendAnimationMilliseconds, composerMissNoticeThreshold } from './constants.js';
import { composerNode, submitButtonNode, isStreaming, isSendEnabled, reportSelectorFailureOnce, resetSelectorFailureReport } from './platform/selectors.js';
import { currentComposerText, clearComposer, clickSubmitButtonHuman, sleep } from './platform/composer.js';
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
import { showNoticeOnce, clearNotice } from './ui/notice.js';
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

// ---------- 劫持 Enter ----------
// Enter：生成中入队，空闲时不拦截、走官方发送；
// Ctrl/Cmd+Enter：等同官方 Enter，任何时候都直发，生成中亦然（绕过队列）；
// Shift+Enter：换行。
function onComposerKeydownCapture(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing) return;

    const composer = composerNode();
    if (!composer || document.activeElement !== composer) return;

    // Ctrl/Cmd+Enter：绕过队列直接发送。生成中官方会忽略按键，
    // 因此由脚本显式点发送按钮，而不是放行给页面。
    if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        event.stopPropagation();

        if (currentComposerText() && isSendEnabled()) clickSubmitButtonHuman();
        return;
    }

    // 空闲时不拦截，保持 ChatGPT 原生的发送行为。
    if (!isStreaming()) return;

    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();

    const text = currentComposerText();
    if (text) {
        enqueuePrompt(text);
        renderQueueHard();
    }
    // 即使没有可入队的文本也清一次，抹掉 ProseMirror 可能残留的空白节点。
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
let consecutiveComposerMisses = 0;

function tick() {
    notifyUrlChange();

    // ChatGPT 是前端渲染的，脚本启动时输入框往往尚未出现；
    // 只有连续多轮都找不到才判定为页面改版，避免刚进页面就误报。
    if (!composerNode()) {
        consecutiveComposerMisses++;
        if (consecutiveComposerMisses >= composerMissNoticeThreshold) {
            reportSelectorFailureOnce(() => {
                showNoticeOnce(document.body, 'selector-failure', 'selectorFailureTitle', 'selectorFailureBody');
            });
        }
        return;
    }

    // 输入框回来了：撤掉告警并重置上报标记，以便后续真正失效时仍能提示。
    if (consecutiveComposerMisses) {
        consecutiveComposerMisses = 0;
        resetSelectorFailureReport();
        clearNotice(document.body);
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
