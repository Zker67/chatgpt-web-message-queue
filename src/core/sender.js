import {
    transactionWaitMilliseconds,
    sendEnableWaitMilliseconds,
    streamingStartWaitMilliseconds,
    draftRestoreRetryDelays,
    sendFailureNoticeThreshold,
} from '../constants.js';
import { isStreaming, isSendEnabled, composerNode } from '../platform/selectors.js';
import {
    waitFor,
    normalizeText,
    currentComposerText,
    setComposerText,
    appendComposerText,
    clickSubmitButtonHuman,
} from '../platform/composer.js';
import {
    promptQueue,
    proseMirrorTransactionCounter,
    sendCancellationToken,
    isQueuePumpRunning, setIsQueuePumpRunning,
    pendingDraftRestore, setPendingDraftRestore,
    consecutiveSendFailures, setConsecutiveSendFailures,
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
// 每一步都校验 sendCancellationToken，用户一旦干预即刻放弃本次尝试；
// 只有确认真的进入流式输出才出队，确保失败时消息不丢。
export async function sendNextQueuedPrompt(hooks = {}) {
    if (!promptQueue.length || isStreaming() || isInteracting()) return false;

    const myAttemptToken = sendCancellationToken;

    const savedDraftText = currentComposerText();
    const nextQueuedPromptText = promptQueue[0];
    const baselineTransactionCount = proseMirrorTransactionCounter;

    setComposerText(nextQueuedPromptText);

    // 等 ProseMirror 确认收到文本：优先看 transaction 计数，其次比对文本。
    const editorAcknowledgedText = await waitFor(
        () => proseMirrorTransactionCounter > baselineTransactionCount
            || currentComposerText() === normalizeText(nextQueuedPromptText),
        transactionWaitMilliseconds
    );
    if (sendCancellationToken !== myAttemptToken) return false;
    if (!editorAcknowledgedText) return noteSendFailure(hooks);

    const sendButtonEnabled = await waitFor(() => !isStreaming() && isSendEnabled(), sendEnableWaitMilliseconds);
    if (sendCancellationToken !== myAttemptToken) return false;
    if (!sendButtonEnabled) return noteSendFailure(hooks);

    clickSubmitButtonHuman();
    if (sendCancellationToken !== myAttemptToken) return false;

    // 必须确认进入流式输出，否则视为没发出去，不出队。
    const streamingStarted = await waitFor(() => isStreaming(), streamingStartWaitMilliseconds);
    if (sendCancellationToken !== myAttemptToken) return false;
    if (!streamingStarted) return noteSendFailure(hooks);

    if (savedDraftText) scheduleDraftRestore(savedDraftText, myAttemptToken);

    await hooks.onBeforeDequeue?.();
    if (sendCancellationToken !== myAttemptToken) return false;

    promptQueue.shift();
    persistCurrentStateIfPossible();

    setConsecutiveSendFailures(0);
    hooks.onQueueChanged?.();
    return true;
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
