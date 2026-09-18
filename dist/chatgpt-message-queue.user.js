// ==UserScript==
// @name         ChatGPT Message Queue (Continued)
// @name:zh-CN   ChatGPT 消息队列（续维护版）
// @namespace    https://github.com/Zker67/chatgpt-web-message-queue
// @version      1.1.0
// @description  Press Enter while ChatGPT is generating to queue your prompt, auto-sent as soon as it is ready. Drag to reorder, edit/delete, merge and per-conversation persistence. Bilingual UI.
// @description:zh-CN  ChatGPT 生成中按 Enter 把消息送入队列，答完自动发出。支持拖拽排序、编辑删除、合并发送与按会话持久化，中英双语界面。
// @author       zker67
// @license      MIT
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/Zker67/chatgpt-web-message-queue
// @supportURL   https://github.com/Zker67/chatgpt-web-message-queue/issues
// ==/UserScript==

// Based on "ChatGPT Message Queue" by maribox (MIT, https://github.com/maribox/my_userscripts),
// which is no longer maintained upstream. See NOTICE.md for full attribution.

(() => {
    'use strict';

    // ===== src/constants.js =====
    // ---------- 存储键 ----------
    // v1 键与上游保持一致，接手后用户的既有队列不丢失。
    const storageKeyQueues = 'cgpt_message_queue_by_conversation_v1';
    const storageKeySettings = 'cgpt_message_queue_settings_by_conversation_v1';
    // 新会话尚无 conversation id 期间的暂存槽位（修复上游"新会话入队丢失"）。
    const storageKeyPendingQueue = 'cgpt_message_queue_pending_v1';
    const storageKeyLocale = 'cgpt_message_queue_locale_v1';

    // ---------- 时序 ----------
    const pollIntervalMilliseconds = 1200;
    const transactionWaitMilliseconds = 0;
    const sendEnableWaitMilliseconds = 0;
    const streamingStartWaitMilliseconds = 0;

    // 草稿恢复重试阶梯：对抗 ChatGPT 发送后对 composer 的异步清空。
    const draftRestoreRetryDelays = [0, 40, 120, 260, 420, 700, 1100, 1600, 2300, 3200];

    // 连续发送失败到达该次数后，向用户显示可见告警。
    const sendFailureNoticeThreshold = 3;

    // 连续多少轮找不到输入框才判定为页面改版。
    // ChatGPT 前端渲染较慢，启动初期找不到属正常现象，不能立刻报错。
    const composerMissNoticeThreshold = 8;

    // ---------- 布局 ----------
    const queueHostPaddingTopPixels = 10;
    const dragHandleWidthPixels = 44;
    const queueItemPaddingPixels = 12;
    const queueTextFontSizePixels = 15;
    const queueLineHeight = 1.4;

    // ---------- 动画 ----------
    const enterAnimationMilliseconds = 160;
    const exitSendAnimationMilliseconds = 170;
    const exitDeleteAnimationMilliseconds = 150;

    // ---------- DOM 标识 ----------
    const styleElementId = 'tm-cgpt-message-queue-styles';
    const queueHostId = 'tm-cgpt-message-queue-host';

    // ===== src/i18n/messages.js =====
    // 双语文案表。两种语言均为一等公民，新增文案必须同时补齐两侧。
    const messages = {
        'zh-CN': {
            mergeMessages: '合并消息',
            on: '开',
            off: '关',
            clearQueue: '清空队列',
            queuedItemLabel: '队列第 {index} 条',
            edit: '编辑',
            delete: '删除',
            save: '保存',
            cancel: '取消',
            localeToggleTitle: 'Switch to English',
            localeToggleLabel: 'EN',
            sendFailureTitle: '队列暂时无法发送',
            sendFailureBody: '连续多次尝试发送失败。可能是 ChatGPT 页面结构有变动，或发送被限流。队列已保留，可稍后重试或刷新页面。',
            selectorFailureTitle: '未找到输入框',
            selectorFailureBody: '脚本无法定位 ChatGPT 的输入框，可能是页面改版。请到 GitHub 提交 issue 以便修复。',
            dismiss: '知道了',
        },
        en: {
            mergeMessages: 'Merge messages',
            on: 'On',
            off: 'Off',
            clearQueue: 'Clear queue',
            queuedItemLabel: 'Queued item {index}',
            edit: 'Edit',
            delete: 'Delete',
            save: 'Save',
            cancel: 'Cancel',
            localeToggleTitle: '切换到中文',
            localeToggleLabel: '中',
            sendFailureTitle: 'Queue is stuck',
            sendFailureBody: 'Several send attempts failed in a row. ChatGPT\'s page structure may have changed, or sending is rate-limited. Your queue is kept — retry later or reload the page.',
            selectorFailureTitle: 'Composer not found',
            selectorFailureBody: 'The script could not locate ChatGPT\'s composer, likely due to a site update. Please open an issue on GitHub so it can be fixed.',
            dismiss: 'Got it',
        },
    };

    // ===== src/i18n/index.js =====
    const supportedLocales = ['zh-CN', 'en'];

    const detectLocale = () => {
        try {
            const stored = localStorage.getItem(storageKeyLocale);
            if (supportedLocales.includes(stored)) return stored;
        } catch { }

        const browserLanguage = String(navigator.language || '').toLowerCase();
        return browserLanguage.startsWith('zh') ? 'zh-CN' : 'en';
    };
    let currentLocale = detectLocale();

    // 文案缺失时回退到 en，再回退到键名本身，保证界面不出现空白。
    function t(key, replacements) {
        const table = messages[currentLocale] || messages.en;
        let text = table[key] ?? messages.en[key] ?? key;

        if (replacements) {
            for (const [name, value] of Object.entries(replacements)) {
                text = text.replace(`{${name}}`, String(value));
            }
        }
        return text;
    }
    function setLocale(locale) {
        if (!supportedLocales.includes(locale)) return;
        currentLocale = locale;
        try { localStorage.setItem(storageKeyLocale, locale); } catch { }
    }
    function toggleLocale() {
        setLocale(currentLocale === 'zh-CN' ? 'en' : 'zh-CN');
    }

    // ===== src/platform/selectors.js =====
    // 选择器适配层：ChatGPT 的 DOM 会随版本变动，尤其是 CSS-Modules 哈希类名
    // （上游硬编码的 .wcDTda_prosemirror-parent 就属于随时会失效的一类）。
    // 这里对每个关键节点提供一条 fallback 链，逐级降级；全链失效时上报一次。

    let selectorFailureReported = false;

    // 依次尝试选择器，返回第一个命中的元素。
    function querySelectorChain(selectorList, root = document) {
        for (const selector of selectorList) {
            try {
                const node = root.querySelector(selector);
                if (node) return node;
            } catch { }
        }
        return null;
    }

    // 由精确到宽松排列，逐级降级。前几条对应已知的 ChatGPT 结构，
    // 后几条是页面改版后的兜底，尽量只靠通用特征而非哈希类名。
    const composerSelectors = [
        'div#prompt-textarea.ProseMirror[contenteditable="true"]',
        'div#prompt-textarea[contenteditable="true"]',
        '#prompt-textarea',
        '[data-testid="prompt-textarea"]',
        '[data-virtualkeyboard="true"][contenteditable="true"]',
        'form [contenteditable="true"].ProseMirror',
        'main [contenteditable="true"].ProseMirror',
        '[contenteditable="true"].ProseMirror',
        'form [contenteditable="true"]',
        'div[contenteditable="true"][translate="no"]',
        // 只匹配 contenteditable：文本读写依赖 innerText 与 ProseMirror 注入，
        // 匹配到 textarea 会得到一个读不出也写不进的节点，比直接报错更糟。
    ];

    const submitButtonSelectors = [
        'button#composer-submit-button',
        'button[data-testid="send-button"]',
        'button[data-testid="stop-button"]',
        'form button[type="submit"]',
    ];

    // 队列面板的锚点：整个输入区外框。面板会作为它的前置兄弟节点插入，
    // 绝不能落进可编辑子树里，否则 ChatGPT 会把面板文字当成输入内容一起发出。
    const composerFormSelectors = [
        'form[data-type="unified-composer"]',
        'main form',
        'form',
    ];
    function composerNode() {
        return querySelectorChain(composerSelectors);
    }
    function submitButtonNode() {
        return querySelectorChain(submitButtonSelectors);
    }

    // 返回队列面板的锚点元素；面板将插入到它前面，成为其兄弟节点。
    function composerAnchorNode() {
        const composer = composerNode();
        if (!composer) return null;

        for (const selector of composerFormSelectors) {
            try {
                const found = composer.closest(selector);
                // 锚点必须有父节点，才能在其之前插入兄弟节点。
                if (found?.parentElement) return found;
            } catch { }
        }

        // 兜底：面板会插到锚点之前，即落在「锚点的父节点」里，
        // 因此要一直上溯到父节点不再属于任何可编辑区域为止。
        let node = composer;
        while (node.parentElement && isInsideEditable(node.parentElement)) {
            node = node.parentElement;
        }
        return node.parentElement ? node : null;
    }

    // 元素自身或其祖先是否处于 contenteditable 区域内。
    function isInsideEditable(element) {
        try {
            return Boolean(element.closest?.('[contenteditable="true"]'));
        } catch {
            return false;
        }
    }
    function submitButtonMode() {
        const button = submitButtonNode();
        if (!button) return null;

        const testId = button.getAttribute('data-testid');
        if (testId) return testId;

        // 没有 data-testid 时按 aria-label 粗判，作为改版后的兜底。
        const label = (button.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('stop')) return 'stop-button';
        if (label.includes('send')) return 'send-button';
        return null;
    }
    function isStreaming() {
        return submitButtonMode() === 'stop-button';
    }
    function isSendEnabled() {
        const button = submitButtonNode();
        if (!button) return false;
        if (submitButtonMode() !== 'send-button') return false;
        if (button.disabled) return false;
        if ((button.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return false;
        try {
            if (getComputedStyle(button).pointerEvents === 'none') return false;
        } catch { }
        return true;
    }

    // 整条 fallback 链都失效时，交由 UI 层提示一次，避免脚本静默死亡。
    function reportSelectorFailureOnce(onFailure) {
        if (selectorFailureReported) return;
        selectorFailureReported = true;
        onFailure?.();
    }

    // 输入框恢复后重置，使后续真正的改版失效仍能被提示。
    function resetSelectorFailureReport() {
        selectorFailureReported = false;
    }
    function hasComposer() {
        return Boolean(composerNode());
    }

    // ===== src/platform/composer.js =====
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // 先做几次微任务/帧级别的快速轮询，再落到限时轮询；
    // timeoutMilliseconds <= 0 时只做快速探测，避免无谓等待。
    const waitFor = async (predicate, timeoutMilliseconds) => {
        if (predicate()) return true;
        await Promise.resolve();
        if (predicate()) return true;
        await new Promise(requestAnimationFrame);
        if (predicate()) return true;
        await new Promise(requestAnimationFrame);
        if (predicate()) return true;

        if (timeoutMilliseconds <= 0) return false;

        const start = Date.now();
        while (Date.now() - start < timeoutMilliseconds) {
            if (predicate()) return true;
            await new Promise(requestAnimationFrame);
        }
        return false;
    };
    function normalizeText(text) {
        return String(text || '').replace(/​/g, '').replace(/\r\n/g, '\n').trim();
    }
    function currentComposerText() {
        return normalizeText(composerNode()?.innerText || '');
    }

    function fireInputEvents(composer) {
        try { composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: '' })); } catch { }
        try { composer.dispatchEvent(new InputEvent('input', { bubbles: true })); } catch { }
    }
    function clearComposer() {
        const composer = composerNode();
        if (!composer) return;
        composer.focus();

        try {
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
        } catch {
            composer.textContent = '';
        }

        fireInputEvents(composer);
    }

    // ProseMirror 不接受直接改 DOM，构造 paste 事件是最贴近真实输入的注入方式。
    function pasteIntoComposer(text) {
        const composer = composerNode();
        if (!composer) return false;

        composer.focus();

        try {
            const dataTransfer = new DataTransfer();
            dataTransfer.setData('text/plain', text);

            composer.dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: dataTransfer,
            }));
            fireInputEvents(composer);
            return true;
        } catch {
            return false;
        }
    }

    // 三级回退：paste 事件 → execCommand('insertText') → 直接写 textContent。
    function setComposerText(text) {
        const composer = composerNode();
        if (!composer) return false;

        composer.focus();
        clearComposer();

        if (pasteIntoComposer(text)) {
            // 宽松校验：ProseMirror 可能对空白做规范化，不要求完全相等。
            if (normalizeText(composer.innerText || '').length >= normalizeText(text).length * 0.7) return true;
        }

        let inserted = false;
        try { inserted = document.execCommand('insertText', false, text); } catch { inserted = false; }
        if (!inserted) composer.textContent = text;

        fireInputEvents(composer);
        return true;
    }

    function moveCaretToEndOfComposer(composer) {
        try {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(composer);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        } catch { }
    }
    function appendComposerText(textToAppend) {
        const composer = composerNode();
        if (!composer) return false;

        composer.focus();
        moveCaretToEndOfComposer(composer);

        if (pasteIntoComposer(textToAppend)) return true;

        let inserted = false;
        try { inserted = document.execCommand('insertText', false, textToAppend); } catch { inserted = false; }
        if (!inserted) composer.textContent = (composer.innerText || '') + textToAppend;

        fireInputEvents(composer);
        return true;
    }

    // 派发完整的 pointer/mouse/click 序列，模拟真实点击以通过站点的交互校验。
    function clickSubmitButtonHuman() {
        const button = submitButtonNode();
        if (!button) return false;

        button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));
        button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
    }

    // ===== src/core/storage.js =====

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
    function extractConversationIdFromUrl() {
        const path = location.pathname || '';
        const match = path.match(/\/c\/([a-z0-9-]{8,})/i) || path.match(/\/chat\/([a-z0-9-]{8,})/i);
        return match ? match[1] : null;
    }
    function computeConversationKey() {
        const conversationId = extractConversationIdFromUrl();
        return conversationId ? `conversation:${conversationId}` : null;
    }
    function loadQueueForConversation(conversationKey) {
        if (!conversationKey) return [];
        const loaded = loadJsonObject(storageKeyQueues)[conversationKey];
        return Array.isArray(loaded) ? loaded.map(String).filter((item) => item.trim()) : [];
    }
    function saveQueueForConversation(conversationKey, queueArray) {
        if (!conversationKey) return;
        const all = loadJsonObject(storageKeyQueues);
        if (Array.isArray(queueArray) && queueArray.length) all[conversationKey] = queueArray;
        else delete all[conversationKey];
        saveJsonObject(storageKeyQueues, all);
    }
    function loadMergeSettingForConversation(conversationKey) {
        if (!conversationKey) return false;
        return loadJsonObject(storageKeySettings)[conversationKey]?.mergeMessagesEnabled === true;
    }
    function saveMergeSettingForConversation(conversationKey, value) {
        if (!conversationKey) return;
        const all = loadJsonObject(storageKeySettings);
        all[conversationKey] = { ...(all[conversationKey] || {}), mergeMessagesEnabled: value === true };
        saveJsonObject(storageKeySettings, all);
    }

    // ---------- 新会话暂存槽（修复上游"新会话入队丢失"）----------
    // 首页 `/` 尚无 conversation id，上游只把队列放在内存变量里；ChatGPT 建会话后会重建
    // UI 并丢弃脚本实例状态，队列随之消失。这里改为落到 sessionStorage：
    // 即使脚本重新初始化也能读回，拿到 id 后再迁移到正式的 localStorage 键。
    function loadPendingQueue() {
        const pending = loadJsonObject(storageKeyPendingQueue, sessionStorage);
        return {
            queue: Array.isArray(pending.queue) ? pending.queue.map(String).filter((item) => item.trim()) : [],
            mergeMessagesEnabled: pending.mergeMessagesEnabled === true,
        };
    }
    function savePendingQueue(queueArray, mergeMessagesEnabled) {
        if (Array.isArray(queueArray) && queueArray.length) {
            saveJsonObject(storageKeyPendingQueue, {
                queue: queueArray,
                mergeMessagesEnabled: mergeMessagesEnabled === true,
            }, sessionStorage);
        } else {
            clearPendingQueue();
        }
    }
    function clearPendingQueue() {
        try { sessionStorage.removeItem(storageKeyPendingQueue); } catch { }
    }

    // ===== src/core/state.js =====
    // 脚本运行时状态。拼接后与其他模块同处一个 IIFE 作用域，
    // 因此这里用可变导出绑定 + setter，避免各模块各持一份副本。
    let currentConversationKey = null;
    let promptQueue = [];
    let mergeMessagesEnabled = false;
    let isQueuePumpRunning = false;
    let proseMirrorTransactionCounter = 0;
    let attachedComposerNode = null;
    let attachedSubmitButtonNode = null;
    let submitButtonMutationObserver = null;
    let queueHostNode = null;
    let activeEditIndex = null;
    let activeEditOriginalText = '';
    let isDragging = false;
    let dragSourceIndex = null;
    let dropInsertIndex = null;
    let hostListenersAttached = false;
    let dropLineNode = null;

    // 用户干预（清空队列、切合并开关等）时自增，令进行中的异步发送作废。
    let sendCancellationToken = 0;
    let pendingDraftRestore = null;
    let lastRenderedQueueSnapshot = [];
    let pendingEnterCountFromBottom = 0;

    // 连续发送失败次数，达到阈值后由 UI 层提示。
    let consecutiveSendFailures = 0;
    const setCurrentConversationKey = (value) => { currentConversationKey = value; };
    const setPromptQueue = (value) => { promptQueue = value; };
    const setMergeMessagesEnabled = (value) => { mergeMessagesEnabled = value; };
    const setIsQueuePumpRunning = (value) => { isQueuePumpRunning = value; };
    const incrementTransactionCounter = () => { proseMirrorTransactionCounter++; };
    const setAttachedComposerNode = (value) => { attachedComposerNode = value; };
    const setAttachedSubmitButtonNode = (value) => { attachedSubmitButtonNode = value; };
    const setSubmitButtonMutationObserver = (value) => { submitButtonMutationObserver = value; };
    const setQueueHostNode = (value) => { queueHostNode = value; };
    const setActiveEditIndex = (value) => { activeEditIndex = value; };
    const setActiveEditOriginalText = (value) => { activeEditOriginalText = value; };
    const setIsDragging = (value) => { isDragging = value; };
    const setDragSourceIndex = (value) => { dragSourceIndex = value; };
    const setDropInsertIndex = (value) => { dropInsertIndex = value; };
    const setHostListenersAttached = (value) => { hostListenersAttached = value; };
    const setDropLineNode = (value) => { dropLineNode = value; };
    const bumpSendCancellationToken = () => { sendCancellationToken++; };
    const setPendingDraftRestore = (value) => { pendingDraftRestore = value; };
    const setLastRenderedQueueSnapshot = (value) => { lastRenderedQueueSnapshot = value; };
    const setPendingEnterCountFromBottom = (value) => { pendingEnterCountFromBottom = value; };
    const setConsecutiveSendFailures = (value) => { consecutiveSendFailures = value; };

    // 拖拽中或行内编辑中一律不发送、不重渲染，避免用户操作被打断。
    const isInteracting = () => isDragging || activeEditIndex !== null;

    // ===== src/core/queue.js =====
    function persistCurrentStateIfPossible() {
        if (currentConversationKey) {
            saveQueueForConversation(currentConversationKey, promptQueue);
            saveMergeSettingForConversation(currentConversationKey, mergeMessagesEnabled);
        } else {
            // 尚无 conversation id：落到 sessionStorage 暂存槽，等会话建立后迁移。
            savePendingQueue(promptQueue, mergeMessagesEnabled);
        }
    }

    // URL 变化时切换会话上下文；返回 true 表示确实发生了切换。
    function switchConversationIfNeeded() {
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
    function enqueuePrompt(promptText) {
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
    function deleteQueueItemAt(index) {
        if (index < 0 || index >= promptQueue.length) return false;
        promptQueue.splice(index, 1);
        persistCurrentStateIfPossible();
        return true;
    }
    function clearQueue() {
        promptQueue.length = 0;
        persistCurrentStateIfPossible();
    }
    function moveQueueItem(fromIndex, toIndex) {
        if (fromIndex < 0 || fromIndex >= promptQueue.length) return false;
        const [moved] = promptQueue.splice(fromIndex, 1);
        const clampedTarget = Math.max(0, Math.min(toIndex, promptQueue.length));
        promptQueue.splice(clampedTarget, 0, moved);
        persistCurrentStateIfPossible();
        return true;
    }
    function mergeAllQueueItems() {
        if (promptQueue.length <= 1) return;
        setPromptQueue([promptQueue.join('\n\n')]);
        persistCurrentStateIfPossible();
    }

    // ===== src/core/sender.js =====





    // ---------- 草稿保护 ----------
    // 发送队列消息会占用 composer，用户当时正在输入的内容必须先存后还。
    function scheduleDraftRestore(draftText, attemptToken) {
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
    function tryRestorePendingDraft() {
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
    async function sendNextQueuedPrompt(hooks = {}) {
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
    async function pumpQueue(hooks = {}) {
        if (isQueuePumpRunning) return;
        if (isInteracting()) return;

        setIsQueuePumpRunning(true);
        try {
            await sendNextQueuedPrompt(hooks);
        } finally {
            setIsQueuePumpRunning(false);
        }
    }

    // ===== src/ui/styles.js =====
    function ensureAnimationStyles() {
        if (document.getElementById(styleElementId)) return;

        const style = document.createElement('style');
        style.id = styleElementId;
        style.textContent = `
          @keyframes tmqEnterFromBottom {
            from { opacity: 0; transform: translateY(10px); }
            to   { opacity: 1; transform: translateY(0); }
          }
          @keyframes tmqExitToRight {
            from { opacity: 1; transform: translateX(0); }
            to   { opacity: 0; transform: translateX(14px); }
          }
          @keyframes tmqExitToBottom {
            from { opacity: 1; transform: translateY(0); }
            to   { opacity: 0; transform: translateY(10px); }
          }
          .tmq-enter {
            animation: tmqEnterFromBottom ${enterAnimationMilliseconds}ms ease-out both;
            will-change: transform, opacity;
          }
          .tmq-exit-send {
            animation: tmqExitToRight ${exitSendAnimationMilliseconds}ms ease-in both;
            will-change: transform, opacity;
          }
          .tmq-exit-delete {
            animation: tmqExitToBottom ${exitDeleteAnimationMilliseconds}ms ease-in both;
            will-change: transform, opacity;
          }
          @media (prefers-reduced-motion: reduce) {
            .tmq-enter, .tmq-exit-send, .tmq-exit-delete { animation-duration: 1ms; }
          }
        `;
        document.head.appendChild(style);
    }
    function queueHostStyle() {
        return [
            'display:flex',
            'flex-direction:column',
            'gap:8px',
            `padding-top:${queueHostPaddingTopPixels}px`,
            'width:100%',
        ].join(';');
    }
    function queueRowWrapperStyle() {
        return [
            'display:flex',
            'align-items:stretch',
            'gap:0',
            'width:100%',
            'position:relative',
        ].join(';');
    }
    function dragHandleStyle() {
        return [
            'display:flex',
            'align-items:center',
            'justify-content:center',
            `width:${dragHandleWidthPixels}px`,
            'flex:0 0 auto',
            'cursor:grab',
            'opacity:.5',
            'user-select:none',
        ].join(';');
    }
    function queueItemBoxStyle() {
        return [
            'flex:1 1 auto',
            'min-width:0',
            `padding:${queueItemPaddingPixels}px`,
            'border-radius:16px',
            'border:1px solid rgba(255,255,255,.10)',
            'background:rgba(255,255,255,.04)',
            'display:flex',
            'align-items:flex-start',
            'gap:8px',
        ].join(';');
    }
    function queueTextStyle() {
        return [
            'flex:1 1 auto',
            'min-width:0',
            `font-size:${queueTextFontSizePixels}px`,
            `line-height:${queueLineHeight}`,
            'white-space:pre-wrap',
            'overflow-wrap:anywhere',
            'outline:none',
        ].join(';');
    }
    const pillButtonStyle =
        'padding:8px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.12);' +
        'background:rgba(255,255,255,.06);color:inherit;font-size:13px;cursor:pointer;user-select:none;';

    // ===== src/ui/notice.js =====

    // 可见告警条：上游发送失败只是静默 return，用户无从得知队列已卡住。
    let activeNoticeKey = null;
    function buildNotice(titleKey, bodyKey, onDismiss) {
        const notice = document.createElement('div');
        notice.contentEditable = 'false';
        notice.dataset.queueNotice = 'true';
        notice.style.cssText = [
            'display:flex',
            'align-items:flex-start',
            'gap:10px',
            'padding:10px 12px',
            'border-radius:12px',
            'border:1px solid rgba(255,180,80,.35)',
            'background:rgba(255,180,80,.10)',
            'font-size:13px',
            'line-height:1.45',
        ].join(';');

        const textColumn = document.createElement('div');
        textColumn.style.cssText = 'flex:1 1 auto;min-width:0;';

        const title = document.createElement('div');
        title.textContent = t(titleKey);
        title.style.cssText = 'font-weight:600;margin-bottom:2px;';

        const body = document.createElement('div');
        body.textContent = t(bodyKey);
        body.style.cssText = 'opacity:.85;';

        textColumn.appendChild(title);
        textColumn.appendChild(body);

        const dismissButton = document.createElement('button');
        dismissButton.type = 'button';
        dismissButton.contentEditable = 'false';
        dismissButton.textContent = t('dismiss');
        dismissButton.style.cssText =
            'flex:0 0 auto;padding:4px 10px;border-radius:999px;cursor:pointer;' +
            'border:1px solid rgba(255,255,255,.16);background:transparent;color:inherit;font-size:12px;';

        dismissButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            activeNoticeKey = null;
            notice.remove();
            onDismiss?.();
        }, true);

        notice.appendChild(textColumn);
        notice.appendChild(dismissButton);
        return notice;
    }

    // 同一类告警只挂一条，避免反复失败刷屏。
    function showNoticeOnce(host, key, titleKey, bodyKey) {
        if (!host) return;
        if (activeNoticeKey === key && host.querySelector('[data-queue-notice="true"]')) return;

        host.querySelector('[data-queue-notice="true"]')?.remove();
        activeNoticeKey = key;
        host.prepend(buildNotice(titleKey, bodyKey));
    }
    function clearNotice(host) {
        activeNoticeKey = null;
        host?.querySelector('[data-queue-notice="true"]')?.remove();
    }

    // ===== src/ui/controls.js =====




    // 复用 ChatGPT 自带的图标 sprite；取不到就退回纯文本符号。
    function spriteFileBaseHref() {
        const anyUse = document.querySelector('use[href*="sprites-core"]');
        const href = anyUse?.getAttribute('href') || '';
        return href.includes('#') ? href.split('#')[0] : null;
    }
    function makeIconOrFallback(spriteId, fallbackText) {
        const spriteBase = spriteFileBaseHref();
        if (!spriteBase) return document.createTextNode(fallbackText);

        const span = document.createElement('span');
        span.className = 'flex items-center justify-center';
        span.contentEditable = 'false';
        span.innerHTML =
            `<svg width="16" height="16" aria-hidden="true"><use href="${spriteBase}#${spriteId}"></use></svg>`;

        // sprite id 不存在时 svg 会是空白，做一次兜底检查。
        return span.querySelector('use') ? span : document.createTextNode(fallbackText);
    }
    function makeIconButton({ title, spriteId, fallbackText }) {
        const button = document.createElement('button');
        button.type = 'button';
        button.contentEditable = 'false';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.style.cssText =
            'flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;' +
            'width:28px;height:28px;border-radius:8px;border:1px solid transparent;' +
            'background:transparent;color:inherit;cursor:pointer;opacity:.7;';

        button.addEventListener('mouseenter', () => { button.style.opacity = '1'; });
        button.addEventListener('mouseleave', () => { button.style.opacity = '.7'; });

        button.appendChild(makeIconOrFallback(spriteId, fallbackText));
        return button;
    }

    function attachPillHover(button) {
        button.addEventListener('mouseenter', () => { button.style.background = 'rgba(255,255,255,.10)'; });
        button.addEventListener('mouseleave', () => { button.style.background = 'rgba(255,255,255,.06)'; });
    }

    function buildMergeToggleButton(onChanged) {
        const button = document.createElement('button');
        button.type = 'button';
        button.contentEditable = 'false';
        button.setAttribute('aria-pressed', mergeMessagesEnabled ? 'true' : 'false');
        button.style.cssText = `display:inline-flex;align-items:center;gap:8px;${pillButtonStyle}`;

        const label = document.createElement('span');
        label.textContent = t('mergeMessages');

        const state = document.createElement('span');
        state.textContent = mergeMessagesEnabled ? t('on') : t('off');
        state.style.cssText =
            'padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.14);' +
            'background:rgba(0,0,0,.12);font-size:12px;';

        attachPillHover(button);

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            // 切换开关会改变待发内容，作废进行中的发送尝试。
            bumpSendCancellationToken();
            setMergeMessagesEnabled(!mergeMessagesEnabled);

            // 开启合并时把已有队列压成一条，与开关语义保持一致。
            if (mergeMessagesEnabled && promptQueue.length > 1) mergeAllQueueItems();

            persistCurrentStateIfPossible();
            onChanged?.();
        }, true);

        button.appendChild(label);
        button.appendChild(state);
        return button;
    }

    function buildClearQueueButton(onChanged) {
        const button = document.createElement('button');
        button.type = 'button';
        button.contentEditable = 'false';
        button.textContent = t('clearQueue');
        button.style.cssText = pillButtonStyle;
        attachPillHover(button);

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            bumpSendCancellationToken();
            clearQueue();
            onChanged?.();
        }, true);

        return button;
    }

    function buildLocaleToggleButton(onChanged) {
        const button = document.createElement('button');
        button.type = 'button';
        button.contentEditable = 'false';
        button.title = t('localeToggleTitle');
        button.setAttribute('aria-label', t('localeToggleTitle'));
        button.textContent = t('localeToggleLabel');
        button.style.cssText = `${pillButtonStyle}min-width:40px;text-align:center;`;
        attachPillHover(button);

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleLocale();
            onChanged?.();
        }, true);

        return button;
    }
    function buildControlsRow(onChanged) {
        const row = document.createElement('div');
        row.contentEditable = 'false';
        row.dataset.queueControls = 'true';
        row.dataset.locale = currentLocale;
        row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;padding:2px 0 0 0;';

        row.appendChild(buildLocaleToggleButton(onChanged));
        row.appendChild(buildMergeToggleButton(onChanged));
        row.appendChild(buildClearQueueButton(onChanged));
        return row;
    }

    // ===== src/ui/dragdrop.js =====
    function clearDropLine() {
        if (dropLineNode) dropLineNode.remove();
        setDropLineNode(null);
        setDropInsertIndex(null);
    }

    function showDropLineAt(host, topWithinHostPixels) {
        if (!host) return;

        if (!dropLineNode) {
            const line = document.createElement('div');
            line.contentEditable = 'false';
            line.style.cssText =
                'position:absolute;pointer-events:none;height:0;left:0;right:0;' +
                'border-top:2px solid rgba(255,255,255,.25);';
            host.appendChild(line);
            setDropLineNode(line);
        }
        dropLineNode.style.top = `${Math.max(0, topWithinHostPixels)}px`;
    }

    function listRowWrappers(host) {
        return Array.from(host.querySelectorAll('[data-queue-row="true"]'));
    }
    function onHostDragLeave(event) {
        if (!isDragging) return;
        // 移到面板内部的子元素上不算离开。
        const related = event.relatedTarget;
        if (related && queueHostNode && queueHostNode.contains(related)) return;
        clearDropLine();
    }

    // 按指针位置与各行中线比较，算出插入点并画出指示线。
    function onHostDragOver(event, host) {
        if (!isDragging || activeEditIndex !== null) return;
        if (!host) return;

        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';

        const wrappers = listRowWrappers(host);
        if (!wrappers.length) return;

        const hostRect = host.getBoundingClientRect();
        const mouseY = event.clientY;

        let insertIndex = wrappers.length;
        let lineY = null;

        for (let i = 0; i < wrappers.length; i++) {
            const rect = wrappers[i].getBoundingClientRect();
            const middle = rect.top + rect.height / 2;

            if (mouseY < middle) {
                insertIndex = i;
                lineY = rect.top - hostRect.top;
                break;
            }
            lineY = rect.bottom - hostRect.top;
        }

        setDropInsertIndex(insertIndex);
        showDropLineAt(host, lineY ?? 0);
    }
    function onHostDrop(event, hooks = {}) {
        if (!isDragging || activeEditIndex !== null) return;

        event.preventDefault();
        event.stopPropagation();

        // 优先用内存里的源索引，丢失时回退到 dataTransfer。
        let sourceIndex = dragSourceIndex;
        if (sourceIndex === null) {
            const transferred = (() => {
                try { return event.dataTransfer.getData('text/plain'); } catch { return ''; }
            })();
            sourceIndex = transferred ? Number(transferred) : null;
        }

        if (sourceIndex === null || Number.isNaN(sourceIndex)) {
            setIsDragging(false);
            setDragSourceIndex(null);
            clearDropLine();
            return;
        }

        const rawInsertIndex = dropInsertIndex === null ? promptQueue.length : dropInsertIndex;
        const boundedInsertIndex = Math.max(0, Math.min(rawInsertIndex, promptQueue.length));

        // 先移除会让其后的目标位左移一位，需相应回退。
        let targetIndex = boundedInsertIndex;
        if (sourceIndex < targetIndex) targetIndex -= 1;

        setIsDragging(false);
        setDragSourceIndex(null);
        clearDropLine();

        moveQueueItem(sourceIndex, targetIndex);
        hooks.onQueueChanged?.();
    }
    function makeDragHandle(index, hooks = {}) {
        const handle = document.createElement('div');
        handle.contentEditable = 'false';
        handle.setAttribute('role', 'button');
        handle.setAttribute('aria-label', t('queuedItemLabel', { index: index + 1 }));
        handle.setAttribute('draggable', activeEditIndex === null ? 'true' : 'false');
        handle.style.cssText = dragHandleStyle();
        handle.textContent = '⠿';

        handle.addEventListener('mouseenter', () => { handle.style.background = 'rgba(255,255,255,.10)'; });
        handle.addEventListener('mouseleave', () => { handle.style.background = 'transparent'; });

        handle.addEventListener('dragstart', (event) => {
            if (activeEditIndex !== null) { event.preventDefault(); return; }

            // 拖拽期间队列顺序会变，作废进行中的发送尝试。
            bumpSendCancellationToken();
            setIsDragging(true);
            setDragSourceIndex(index);
            clearDropLine();

            event.dataTransfer.effectAllowed = 'move';
            try { event.dataTransfer.setData('text/plain', String(index)); } catch { }

            handle.style.cursor = 'grabbing';
        }, true);

        handle.addEventListener('dragend', () => {
            handle.style.cursor = 'grab';
            setIsDragging(false);
            setDragSourceIndex(null);
            clearDropLine();
            hooks.onDragEnd?.();
        }, true);

        return handle;
    }

    // ===== src/ui/render.js =====








    // 渲染钩子由 main 注入，避免 UI 层直接依赖发送逻辑造成循环引用。
    let renderHooks = {};
    function setRenderHooks(hooks) { renderHooks = hooks || {}; }
    function ensureQueueHost() {
        const anchor = composerAnchorNode();
        if (!anchor?.parentElement) return null;

        // 面板须紧贴在输入区外框之前；位置不对（如 ChatGPT 重建了 DOM）就重新挂载。
        const isMountedCorrectly =
            queueHostNode
            && queueHostNode.parentElement === anchor.parentElement
            && queueHostNode.nextElementSibling === anchor;

        if (queueHostNode && !isMountedCorrectly) {
            queueHostNode.remove();
            setQueueHostNode(null);
            setHostListenersAttached(false);
        }

        if (!queueHostNode) {
            const host = document.createElement('div');
            host.id = queueHostId;
            host.contentEditable = 'false';
            host.style.cssText = queueHostStyle();
            // 作为兄弟节点插在输入区之前，绝不进入其内部。
            anchor.parentElement.insertBefore(host, anchor);
            setQueueHostNode(host);
        } else {
            queueHostNode.style.cssText = queueHostStyle();
        }

        if (!hostListenersAttached) {
            setHostListenersAttached(true);
            queueHostNode.addEventListener('dragover', (event) => onHostDragOver(event, queueHostNode), true);
            queueHostNode.addEventListener('drop', (event) => onHostDrop(event, renderHooks), true);
            queueHostNode.addEventListener('dragleave', onHostDragLeave, true);
        }

        return queueHostNode;
    }

    // 构建单行。editing 为 true 时该行进入可编辑态。
    function buildQueueRow(index, { editing, anyEditing }) {
        const rowWrapper = document.createElement('div');
        rowWrapper.contentEditable = 'false';
        rowWrapper.dataset.queueRow = 'true';
        rowWrapper.dataset.queueIndex = String(index);
        rowWrapper.style.cssText = queueRowWrapperStyle();

        const handle = makeDragHandle(index, renderHooks);
        if (anyEditing) {
            // 编辑期间禁止拖拽，避免索引错乱。
            handle.setAttribute('draggable', 'false');
            handle.style.cursor = 'not-allowed';
            handle.style.opacity = '.55';
        }

        const itemBox = document.createElement('div');
        itemBox.contentEditable = 'false';
        itemBox.dataset.queueBox = 'true';
        itemBox.style.cssText = queueItemBoxStyle();

        const text = document.createElement('div');
        text.contentEditable = editing ? 'true' : 'false';
        text.spellcheck = false;
        text.setAttribute('aria-label', t('queuedItemLabel', { index: index + 1 }));
        text.style.cssText = editing
            ? `${queueTextStyle()};border-radius:10px;border:1px solid rgba(255,255,255,.18);` +
              'background:rgba(0,0,0,.12);padding:8px 10px;max-height:220px;overflow:auto;'
            : queueTextStyle();
        text.textContent = promptQueue[index];

        const buttons = document.createElement('div');
        buttons.contentEditable = 'false';
        buttons.style.cssText = 'display:flex;gap:8px;flex:0 0 auto;margin-left:auto;align-items:center;';

        const primaryButton = makeIconButton({
            title: editing ? t('save') : t('edit'),
            spriteId: editing ? 'check' : 'pencil',
            fallbackText: editing ? '✓' : '✎',
        });
        const secondaryButton = makeIconButton({
            title: editing ? t('cancel') : t('delete'),
            spriteId: editing ? 'close' : 'trash',
            fallbackText: editing ? '✕' : '🗑',
        });

        primaryButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!editing) return beginInlineEdit(index);
            commitInlineEdit(text.innerText);
        }, true);

        secondaryButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!editing) return animateAndDeleteQueueItem(index);
            cancelInlineEdit();
        }, true);

        if (editing) {
            text.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelInlineEdit();
                }
                // Enter 保存，Shift+Enter 换行。
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.stopPropagation();
                    commitInlineEdit(text.innerText);
                }
            }, true);

            text.addEventListener('blur', () => {
                if (activeEditIndex !== null) commitInlineEdit(text.innerText);
            }, { capture: true, once: true });
        }

        buttons.appendChild(primaryButton);
        buttons.appendChild(secondaryButton);

        itemBox.appendChild(text);
        itemBox.appendChild(buttons);

        rowWrapper.appendChild(handle);
        rowWrapper.appendChild(itemBox);

        return { rowWrapper, text };
    }

    // 清空重建：用于队列结构变化后的整体刷新。
    function renderQueueHard() {
        const host = ensureQueueHost();
        if (!host) return;

        clearDropLine();
        setActiveEditIndex(null);
        host.innerHTML = '';
        renderQueue();
    }
    function renderQueue() {
        const host = ensureQueueHost();
        if (!host) return;
        // 编辑或拖拽进行中不重绘，否则会打断用户操作。
        if (activeEditIndex !== null) return;
        if (isDragging) return;

        ensureAnimationStyles();

        // 只对本次新增的尾部若干行播放入场动画。
        setPendingEnterCountFromBottom(
            promptQueue.length > lastRenderedQueueSnapshot.length
                ? Math.min(promptQueue.length - lastRenderedQueueSnapshot.length, promptQueue.length)
                : 0
        );
        setLastRenderedQueueSnapshot(promptQueue.slice());

        host.innerHTML = '';
        if (promptQueue.length === 0) return;

        for (let index = 0; index < promptQueue.length; index++) {
            const { rowWrapper } = buildQueueRow(index, { editing: false, anyEditing: false });

            const isInEnterRange =
                pendingEnterCountFromBottom > 0 && index >= promptQueue.length - pendingEnterCountFromBottom;
            if (isInEnterRange) rowWrapper.classList.add('tmq-enter');

            host.appendChild(rowWrapper);
        }

        host.appendChild(buildControlsRow(renderQueueHard));
    }

    // ---------- 行内编辑 ----------
    function beginInlineEdit(index) {
        const host = ensureQueueHost();
        if (!host) return;
        if (index < 0 || index >= promptQueue.length) return;

        // 编辑中的条目不应被发送出去。
        bumpSendCancellationToken();
        clearDropLine();

        setActiveEditIndex(index);
        // 记下原文，取消编辑时回滚。
        setActiveEditOriginalText(promptQueue[index]);

        host.innerHTML = '';

        let editingTextNode = null;
        for (let i = 0; i < promptQueue.length; i++) {
            const editing = i === index;
            const { rowWrapper, text } = buildQueueRow(i, { editing, anyEditing: true });
            if (editing) editingTextNode = text;
            host.appendChild(rowWrapper);
        }

        host.appendChild(buildControlsRow(renderQueueHard));

        // 等 DOM 落定后聚焦并全选，方便直接覆写。
        if (editingTextNode) {
            queueMicrotask(() => {
                editingTextNode.focus();
                try {
                    const selection = window.getSelection();
                    const range = document.createRange();
                    range.selectNodeContents(editingTextNode);
                    selection.removeAllRanges();
                    selection.addRange(range);
                } catch { }
            });
        }
    }
    function commitInlineEdit(editedText) {
        if (activeEditIndex === null) return;

        const cleaned = renderHooks.normalizeText ? renderHooks.normalizeText(editedText) : String(editedText || '').trim();
        // 清空内容等同删除该条。
        if (!cleaned) return animateAndDeleteQueueItem(activeEditIndex);

        promptQueue[activeEditIndex] = cleaned;
        setActiveEditIndex(null);

        renderHooks.onQueueChanged?.();
        renderQueueHard();
    }
    function cancelInlineEdit() {
        if (activeEditIndex === null) return;

        promptQueue[activeEditIndex] = activeEditOriginalText;
        setActiveEditIndex(null);

        renderHooks.onQueueChanged?.();
        renderQueueHard();
    }
    function animateAndDeleteQueueItem(index) {
        if (index < 0 || index >= promptQueue.length) return;
        bumpSendCancellationToken();

        const host = ensureQueueHost();
        const row = host?.querySelector(`[data-queue-row="true"][data-queue-index="${index}"]`);

        const finish = () => {
            deleteQueueItemAt(index);
            renderQueueHard();
            renderHooks.onQueueChanged?.();
        };

        if (!row) return finish();

        row.classList.remove('tmq-enter');
        row.classList.add('tmq-exit-delete');
        setTimeout(finish, exitDeleteAnimationMilliseconds);
    }

    // ===== src/main.js =====










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

})();
