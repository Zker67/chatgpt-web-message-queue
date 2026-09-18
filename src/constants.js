// ---------- 存储键 ----------
// v1 键与上游保持一致，接手后用户的既有队列不丢失。
export const storageKeyQueues = 'cgpt_message_queue_by_conversation_v1';
export const storageKeySettings = 'cgpt_message_queue_settings_by_conversation_v1';
// 新会话尚无 conversation id 期间的暂存槽位（修复上游"新会话入队丢失"）。
export const storageKeyPendingQueue = 'cgpt_message_queue_pending_v1';
export const storageKeyLocale = 'cgpt_message_queue_locale_v1';

// ---------- 时序 ----------
export const pollIntervalMilliseconds = 1200;
export const transactionWaitMilliseconds = 0;
export const sendEnableWaitMilliseconds = 0;
export const streamingStartWaitMilliseconds = 0;

// 草稿恢复重试阶梯：对抗 ChatGPT 发送后对 composer 的异步清空。
export const draftRestoreRetryDelays = [0, 40, 120, 260, 420, 700, 1100, 1600, 2300, 3200];

// 连续发送失败到达该次数后，向用户显示可见告警。
export const sendFailureNoticeThreshold = 3;

// 连续多少轮找不到输入框才判定为页面改版。
// ChatGPT 前端渲染较慢，启动初期找不到属正常现象，不能立刻报错。
export const composerMissNoticeThreshold = 8;

// ---------- 布局 ----------
export const queueHostPaddingTopPixels = 10;
export const dragHandleWidthPixels = 44;
export const queueItemPaddingPixels = 12;
export const queueTextFontSizePixels = 15;
export const queueLineHeight = 1.4;

// ---------- 动画 ----------
export const enterAnimationMilliseconds = 160;
export const exitSendAnimationMilliseconds = 170;
export const exitDeleteAnimationMilliseconds = 150;

// ---------- DOM 标识 ----------
export const styleElementId = 'tm-cgpt-message-queue-styles';
export const queueHostId = 'tm-cgpt-message-queue-host';
