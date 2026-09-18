// ---------- 存储键 ----------
// v1 键与上游保持一致，接手后用户的既有队列不丢失。
export const storageKeyQueues = 'cgpt_message_queue_by_conversation_v1';
export const storageKeySettings = 'cgpt_message_queue_settings_by_conversation_v1';
// 新会话尚无 conversation id 期间的暂存槽位（修复上游"新会话入队丢失"）。
export const storageKeyPendingQueue = 'cgpt_message_queue_pending_v1';
export const storageKeyLocale = 'cgpt_message_queue_locale_v1';

// ---------- 时序 ----------
export const pollIntervalMilliseconds = 1200;
// 注入文本后等 ProseMirror 确认收到的上限。
export const transactionWaitMilliseconds = 800;
// 注入后等发送按钮变为可用的上限（按钮随输入内容异步启用）。
export const sendEnableWaitMilliseconds = 1500;
// 点击后等「确实发出去了」的上限：进入生成态，或输入框被 ChatGPT 清空。
export const sendConfirmWaitMilliseconds = 3000;
// 两次发送尝试之间的最短间隔，无论成败。杜绝检测失灵时连发同一条。
export const sendCooldownMilliseconds = 2500;
// 发出后若始终没观察到生成态（检测可能失灵），额外延长冷却，避免对方还没答完就连发下一条。
export const unconfirmedStreamingExtraCooldownMilliseconds = 6000;

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
