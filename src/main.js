import { pollIntervalMilliseconds, exitSendAnimationMilliseconds, composerMissNoticeThreshold, queueHostId } from './constants.js';
import { composerNode, composerFormNode, isStreaming, reportSelectorFailureOnce, resetSelectorFailureReport, collectDiagnostics, noteConversationMutation } from './platform/selectors.js';
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
import { ensureQueueHost, positionQueueHost, renderQueue, renderQueueHard, setRenderHooks } from './ui/render.js';
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
// Ctrl/Cmd+Enter：完全不拦截，原样交给 ChatGPT 处理；
// Shift+Enter：换行。
function onComposerKeydownCapture(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing) return;
    // 带 Ctrl/Cmd 时一律放行，交给 ChatGPT 自己处理。
    if (event.ctrlKey || event.metaKey) return;

    const composer = composerNode();
    if (!composer || document.activeElement !== composer) return;

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

// 新版 ChatGPT 的发送 / 停止按钮可能是两个元素互相替换，而非同一按钮改属性，
// 因此改为观察整个输入区子树，任何变化都重新评估是否可以发下一条。
let observerEvaluationScheduled = false;
function attachSubmitButtonObserver() {
    const form = composerFormNode();
    if (!form || form === attachedSubmitButtonNode) return;

    setAttachedSubmitButtonNode(form);

    submitButtonMutationObserver?.disconnect();
    const observer = new MutationObserver(() => {
        // 合并同一帧内的多次变动，避免高频触发。
        if (observerEvaluationScheduled) return;
        observerEvaluationScheduled = true;
        requestAnimationFrame(() => {
            observerEvaluationScheduled = false;
            if (!isStreaming() && promptQueue.length && !isInteracting()) pump();
            if (pendingDraftRestore) tryRestorePendingDraft();
            positionQueueHost();
        });
    });

    observer.observe(form, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-testid', 'disabled', 'aria-disabled', 'aria-label', 'class'],
    });
    setSubmitButtonMutationObserver(observer);
}

// 观察对话区的内容变动，作为「仍在流式输出」的信号。
// 只记录内容级变动（增删节点 / 文本改动），忽略属性变化，避免 hover 之类的样式切换干扰；
// 输入区与队列面板内的变动不计入。
let conversationObserver = null;
let observedConversationRoot = null;
function attachConversationObserver() {
    const root = document.querySelector('main') || document.body;
    if (!root || root === observedConversationRoot) return;
    observedConversationRoot = root;

    conversationObserver?.disconnect();
    conversationObserver = new MutationObserver((records) => {
        for (const record of records) {
            const target = record.target;
            const element = target.nodeType === 1 ? target : target.parentElement;
            if (!element) continue;
            if (element.closest('form')) continue;
            if (element.closest('#' + queueHostId)) continue;
            noteConversationMutation();
            return;
        }
    });
    conversationObserver.observe(root, { childList: true, subtree: true, characterData: true });
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
    attachConversationObserver();

    if (!isDragging) renderQueue();
    positionQueueHost();

    if (pendingDraftRestore) tryRestorePendingDraft();
    if (promptQueue.length && !isStreaming() && !isInteracting()) pump();
}

// 视口或布局变化时重新贴合输入框。
window.addEventListener('resize', positionQueueHost, true);
window.addEventListener('scroll', positionQueueHost, true);

// 控制台诊断入口：页面改版时让用户一键导出关键节点信息。
try { window.__cmqDiag = () => collectDiagnostics(); } catch { }

// ---------- 启动 ----------
ensureAnimationStyles();
installHistoryHooks();
switchConversationIfNeeded();
setInterval(tick, pollIntervalMilliseconds);
tick();
