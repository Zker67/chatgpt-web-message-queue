// 脚本运行时状态。拼接后与其他模块同处一个 IIFE 作用域，
// 因此这里用可变导出绑定 + setter，避免各模块各持一份副本。
export let currentConversationKey = null;
export let promptQueue = [];
export let mergeMessagesEnabled = false;

export let isQueuePumpRunning = false;
export let proseMirrorTransactionCounter = 0;

export let attachedComposerNode = null;
export let attachedSubmitButtonNode = null;
export let submitButtonMutationObserver = null;
export let queueHostNode = null;

export let activeEditIndex = null;
export let activeEditOriginalText = '';

export let isDragging = false;
export let dragSourceIndex = null;
export let dropInsertIndex = null;

export let hostListenersAttached = false;
export let dropLineNode = null;

// 用户干预（清空队列、切合并开关等）时自增，令进行中的异步发送作废。
export let sendCancellationToken = 0;
export let pendingDraftRestore = null;

export let lastRenderedQueueSnapshot = [];
export let pendingEnterCountFromBottom = 0;

// 连续发送失败次数，达到阈值后由 UI 层提示。
export let consecutiveSendFailures = 0;
// 上次发送尝试的时间戳，用于冷却。
export let lastSendAttemptAt = 0;

export const setCurrentConversationKey = (value) => { currentConversationKey = value; };
export const setPromptQueue = (value) => { promptQueue = value; };
export const setMergeMessagesEnabled = (value) => { mergeMessagesEnabled = value; };
export const setIsQueuePumpRunning = (value) => { isQueuePumpRunning = value; };
export const incrementTransactionCounter = () => { proseMirrorTransactionCounter++; };
export const setAttachedComposerNode = (value) => { attachedComposerNode = value; };
export const setAttachedSubmitButtonNode = (value) => { attachedSubmitButtonNode = value; };
export const setSubmitButtonMutationObserver = (value) => { submitButtonMutationObserver = value; };
export const setQueueHostNode = (value) => { queueHostNode = value; };
export const setActiveEditIndex = (value) => { activeEditIndex = value; };
export const setActiveEditOriginalText = (value) => { activeEditOriginalText = value; };
export const setIsDragging = (value) => { isDragging = value; };
export const setDragSourceIndex = (value) => { dragSourceIndex = value; };
export const setDropInsertIndex = (value) => { dropInsertIndex = value; };
export const setHostListenersAttached = (value) => { hostListenersAttached = value; };
export const setDropLineNode = (value) => { dropLineNode = value; };
export const bumpSendCancellationToken = () => { sendCancellationToken++; };
export const setPendingDraftRestore = (value) => { pendingDraftRestore = value; };
export const setLastRenderedQueueSnapshot = (value) => { lastRenderedQueueSnapshot = value; };
export const setPendingEnterCountFromBottom = (value) => { pendingEnterCountFromBottom = value; };
export const setConsecutiveSendFailures = (value) => { consecutiveSendFailures = value; };
export const setLastSendAttemptAt = (value) => { lastSendAttemptAt = value; };

// 拖拽中或行内编辑中一律不发送、不重渲染，避免用户操作被打断。
export const isInteracting = () => isDragging || activeEditIndex !== null;
