import {
    transactionWaitMilliseconds,
    sendEnableWaitMilliseconds,
    sendConfirmWaitMilliseconds,
    sendCooldownMilliseconds,
    unconfirmedStreamingExtraCooldownMilliseconds,
    draftRestoreRetryDelays,
    sendFailureNoticeThreshold,
} from '../constants.js';
import { isStreaming, isSendEnabled, composerNode } from '../platform/selectors.js';
import {
    waitFor,
    normalizeText,
    textMatches,
    currentComposerText,
    setComposerText,
    appendComposerText,
    clearComposer,
    clickSubmitButtonHuman,
} from '../platform/composer.js';
import {
    promptQueue,
    sendCancellationToken,
    isQueuePumpRunning, setIsQueuePumpRunning,
    pendingDraftRestore, setPendingDraftRestore,
    consecutiveSendFailures, setConsecutiveSendFailures,
    lastSendAttemptAt, setLastSendAttemptAt,
    isInteracting,
} from './state.js';
import { persistCurrentStateIfPossible } from './queue.js';

// ---------- 草稿保护 ----------
// 发送队列消息会占用 composer，用户当时正在输入的内容必须先存后还。
export function scheduleDraftRestore(draftText, attemptToken) {
    const draft = normalizeText(draftText);
    if (!draft) return;

    setPendingDraftRestore({
        attemptToken,
        draftText: draft,
        attemptIndex: 0,
        startedAt: performance.now(),
    });

    queueMicrotask(tryRestorePendingDraft);
}

// ChatGPT 会在发送后异步清空 composer，时机不确定，
// 因此按 draftRestoreRetryDelays 阶梯重试，直到草稿确实回到输入框。
export function tryRestorePendingDraft() {
    if (!pendingDraftRestore) return;

    if (sendCancellationToken !== pendingDraftRestore.attemptToken) {
        setPendingDraftRestore(null);
        return;
    }

    if (isInteracting()) return;

    const composer = composerNode();
    if (!composer) return;

    const currentText = normalizeText(composer.innerText || '');
    const draft = pendingDraftRestore.draftText;

    if (draft && currentText.includes(draft)) {
        setPendingDraftRestore(null);
        return;
    }

    if (currentText === '') setComposerText(draft);
    else appendComposerText(`\n\n${draft}`);

    if (normalizeText(composer.innerText || '').includes(draft)) {
        setPendingDraftRestore(null);
        return;
    }

    pendingDraftRestore.attemptIndex += 1;
    if (pendingDraftRestore.attemptIndex >= draftRestoreRetryDelays.length) {
        setPendingDraftRestore(null);
        return;
    }

    setTimeout(() => {
        if (pendingDraftRestore) tryRestorePendingDraft();
    }, draftRestoreRetryDelays[pendingDraftRestore.attemptIndex]);
}

// ---------- 发送 ----------
// 每一步都校验 sendCancellationToken，用户一旦干预即刻放弃本次尝试。
// 只有确认「确实发出去了」才出队；失败则撤回注入的文本，不留残渣。
export async function sendNextQueuedPrompt(hooks = {}) {
    if (!promptQueue.length || isStreaming() || isInteracting()) return false;

    // 冷却：无论上次成败，都要间隔足够时间。检测一旦失灵，这是防连发的最后闸门。
    if (Date.now() - lastSendAttemptAt < sendCooldownMilliseconds) return false;
    setLastSendAttemptAt(Date.now());

    const myAttemptToken = sendCancellationToken;

    const savedDraftText = currentComposerText();
    const nextQueuedPromptText = promptQueue[0];

    // 注入失败（多半是清空不了输入框）直接放弃，绝不把队列文本插进残留内容里。
    if (!setComposerText(nextQueuedPromptText)) return abortAttempt(savedDraftText, hooks);

    // 等编辑器内容与目标一致（忽略空白差异），不再以 transaction 计数作捷径——
    // 计数变了只说明有编辑发生，不代表内容正确。
    const editorAcknowledgedText = await waitFor(
        () => textMatches(currentComposerText(), nextQueuedPromptText),
        transactionWaitMilliseconds
    );
    if (sendCancellationToken !== myAttemptToken) return false;
    if (!editorAcknowledgedText) return abortAttempt(savedDraftText, hooks);

    const sendButtonEnabled = await waitFor(() => isSendEnabled(), sendEnableWaitMilliseconds);
    if (sendCancellationToken !== myAttemptToken) return false;
    if (!sendButtonEnabled) return abortAttempt(savedDraftText, hooks);

    // 记下点击前输入框里实际渲染出的文本，作为「是否已被 ChatGPT 清空」的对照。
    const renderedBeforeClick = currentComposerText();
    clickSubmitButtonHuman();
    if (sendCancellationToken !== myAttemptToken) return false;

    // 发出确认：进入生成态，或者输入框内容已不再是我们注入的那段（官方发送后会清空）。
    const sendConfirmed = await waitFor(
        () => isStreaming() || currentComposerText() !== renderedBeforeClick,
        sendConfirmWaitMilliseconds
    );
    if (sendCancellationToken !== myAttemptToken) return false;
    if (!sendConfirmed) return abortAttempt(savedDraftText, hooks);

    if (savedDraftText) scheduleDraftRestore(savedDraftText, myAttemptToken);

    await hooks.onBeforeDequeue?.();
    if (sendCancellationToken !== myAttemptToken) return false;

    promptQueue.shift();
    persistCurrentStateIfPossible();

    // 冷却从本次尝试结束时起算；若没观察到生成态，说明检测可能失灵，额外拉长。
    setLastSendAttemptAt(Date.now() + (isStreaming() ? 0 : unconfirmedStreamingExtraCooldownMilliseconds));

    setConsecutiveSendFailures(0);
    hooks.onQueueChanged?.();
    return true;
}

// 发送失败：撤掉注入的队列文本，把用户原本的草稿放回去，避免越积越多。
function abortAttempt(savedDraftText, hooks) {
    if (savedDraftText) setComposerText(savedDraftText);
    else clearComposer();
    // 一次失败尝试本身可能耗时数秒，冷却必须从结束时刻起算才有意义。
    setLastSendAttemptAt(Date.now());
    return noteSendFailure(hooks);
}

// 上游此处静默返回，用户不知道队列卡住；这里累计失败并在达阈值时提示。
function noteSendFailure(hooks) {
    setConsecutiveSendFailures(consecutiveSendFailures + 1);
    if (consecutiveSendFailures >= sendFailureNoticeThreshold) {
        hooks.onRepeatedFailure?.();
        setConsecutiveSendFailures(0);
    }
    return false;
}

export async function pumpQueue(hooks = {}) {
    if (isQueuePumpRunning) return;
    if (isInteracting()) return;

    setIsQueuePumpRunning(true);
    try {
        await sendNextQueuedPrompt(hooks);
    } finally {
        setIsQueuePumpRunning(false);
    }
}
