import { normalizeText } from '../platform/composer.js';
import {
    computeConversationKey,
    loadQueueForConversation,
    saveQueueForConversation,
    loadMergeSettingForConversation,
    saveMergeSettingForConversation,
    loadPendingQueue,
    savePendingQueue,
    clearPendingQueue,
} from './storage.js';
import {
    currentConversationKey, setCurrentConversationKey,
    promptQueue, setPromptQueue,
    mergeMessagesEnabled, setMergeMessagesEnabled,
    setActiveEditIndex,
    setLastRenderedQueueSnapshot,
    setPendingEnterCountFromBottom,
} from './state.js';

export function persistCurrentStateIfPossible() {
    if (currentConversationKey) {
        saveQueueForConversation(currentConversationKey, promptQueue);
        saveMergeSettingForConversation(currentConversationKey, mergeMessagesEnabled);
    } else {
        // 尚无 conversation id：落到 sessionStorage 暂存槽，等会话建立后迁移。
        savePendingQueue(promptQueue, mergeMessagesEnabled);
    }
}

// URL 变化时切换会话上下文；返回 true 表示确实发生了切换。
export function switchConversationIfNeeded() {
    const nextConversationKey = computeConversationKey();
    if (nextConversationKey === currentConversationKey) return false;

    if (currentConversationKey) persistCurrentStateIfPossible();

    // 新会话刚拿到 id：把暂存槽里的队列迁移过来，这是上游丢队列的关键修复点。
    if (!currentConversationKey && nextConversationKey) {
        const pending = loadPendingQueue();
        const carriedQueue = promptQueue.length ? promptQueue.slice() : pending.queue;
        const carriedMerge = promptQueue.length ? mergeMessagesEnabled : pending.mergeMessagesEnabled;

        if (carriedQueue.length) {
            setCurrentConversationKey(nextConversationKey);
            setPromptQueue(carriedQueue);
            setMergeMessagesEnabled(carriedMerge);

            clearPendingQueue();
            persistCurrentStateIfPossible();

            setActiveEditIndex(null);
            setLastRenderedQueueSnapshot([]);
            setPendingEnterCountFromBottom(0);
            return true;
        }
    }

    setCurrentConversationKey(nextConversationKey);

    if (nextConversationKey) {
        setPromptQueue(loadQueueForConversation(nextConversationKey));
        setMergeMessagesEnabled(loadMergeSettingForConversation(nextConversationKey));
    } else {
        // 回到无 id 状态（如新开对话）：读回暂存槽，刷新后也不丢。
        const pending = loadPendingQueue();
        setPromptQueue(pending.queue);
        setMergeMessagesEnabled(pending.mergeMessagesEnabled);
    }

    setActiveEditIndex(null);
    setLastRenderedQueueSnapshot([]);
    setPendingEnterCountFromBottom(0);
    return true;
}

export function enqueuePrompt(promptText) {
    const normalized = normalizeText(promptText);
    if (!normalized) return false;

    const beforeLength = promptQueue.length;

    if (mergeMessagesEnabled) {
        // 合并模式：追加到最后一条，而不是新增条目。
        if (promptQueue.length === 0) promptQueue.push(normalized);
        else promptQueue[promptQueue.length - 1] = `${promptQueue[promptQueue.length - 1]}\n\n${normalized}`;
    } else {
        promptQueue.push(normalized);
    }

    // 记录新增条数，供渲染层只对新行播放入场动画。
    setPendingEnterCountFromBottom(promptQueue.length > beforeLength ? promptQueue.length - beforeLength : 0);

    persistCurrentStateIfPossible();
    return true;
}

export function deleteQueueItemAt(index) {
    if (index < 0 || index >= promptQueue.length) return false;
    promptQueue.splice(index, 1);
    persistCurrentStateIfPossible();
    return true;
}

export function clearQueue() {
    promptQueue.length = 0;
    persistCurrentStateIfPossible();
}

export function moveQueueItem(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= promptQueue.length) return false;
    const [moved] = promptQueue.splice(fromIndex, 1);
    const clampedTarget = Math.max(0, Math.min(toIndex, promptQueue.length));
    promptQueue.splice(clampedTarget, 0, moved);
    persistCurrentStateIfPossible();
    return true;
}

export function mergeAllQueueItems() {
    if (promptQueue.length <= 1) return;
    setPromptQueue([promptQueue.join('\n\n')]);
    persistCurrentStateIfPossible();
}
