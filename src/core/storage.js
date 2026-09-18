import {
    storageKeyQueues,
    storageKeySettings,
    storageKeyPendingQueue,
} from '../constants.js';

function loadJsonObject(key, storage = localStorage) {
    try {
        const parsed = JSON.parse(storage.getItem(key) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function saveJsonObject(key, value, storage = localStorage) {
    try {
        storage.setItem(key, JSON.stringify(value));
    } catch { }
}

export function extractConversationIdFromUrl() {
    const path = location.pathname || '';
    const match = path.match(/\/c\/([a-z0-9-]{8,})/i) || path.match(/\/chat\/([a-z0-9-]{8,})/i);
    return match ? match[1] : null;
}

export function computeConversationKey() {
    const conversationId = extractConversationIdFromUrl();
    return conversationId ? `conversation:${conversationId}` : null;
}

export function loadQueueForConversation(conversationKey) {
    if (!conversationKey) return [];
    const loaded = loadJsonObject(storageKeyQueues)[conversationKey];
    return Array.isArray(loaded) ? loaded.map(String).filter((item) => item.trim()) : [];
}

export function saveQueueForConversation(conversationKey, queueArray) {
    if (!conversationKey) return;
    const all = loadJsonObject(storageKeyQueues);
    if (Array.isArray(queueArray) && queueArray.length) all[conversationKey] = queueArray;
    else delete all[conversationKey];
    saveJsonObject(storageKeyQueues, all);
}

export function loadMergeSettingForConversation(conversationKey) {
    if (!conversationKey) return false;
    return loadJsonObject(storageKeySettings)[conversationKey]?.mergeMessagesEnabled === true;
}

export function saveMergeSettingForConversation(conversationKey, value) {
    if (!conversationKey) return;
    const all = loadJsonObject(storageKeySettings);
    all[conversationKey] = { ...(all[conversationKey] || {}), mergeMessagesEnabled: value === true };
    saveJsonObject(storageKeySettings, all);
}

// ---------- 新会话暂存槽（修复上游"新会话入队丢失"）----------
// 首页 `/` 尚无 conversation id，上游只把队列放在内存变量里；ChatGPT 建会话后会重建
// UI 并丢弃脚本实例状态，队列随之消失。这里改为落到 sessionStorage：
// 即使脚本重新初始化也能读回，拿到 id 后再迁移到正式的 localStorage 键。
export function loadPendingQueue() {
    const pending = loadJsonObject(storageKeyPendingQueue, sessionStorage);
    return {
        queue: Array.isArray(pending.queue) ? pending.queue.map(String).filter((item) => item.trim()) : [],
        mergeMessagesEnabled: pending.mergeMessagesEnabled === true,
    };
}

export function savePendingQueue(queueArray, mergeMessagesEnabled) {
    if (Array.isArray(queueArray) && queueArray.length) {
        saveJsonObject(storageKeyPendingQueue, {
            queue: queueArray,
            mergeMessagesEnabled: mergeMessagesEnabled === true,
        }, sessionStorage);
    } else {
        clearPendingQueue();
    }
}

export function clearPendingQueue() {
    try { sessionStorage.removeItem(storageKeyPendingQueue); } catch { }
}
