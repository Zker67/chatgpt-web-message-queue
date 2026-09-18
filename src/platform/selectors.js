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

// 界面可能是中文，aria-label 也随之本地化，判定必须中英同时覆盖。
const sendLabelPattern = /send|submit|发送|提交|傳送/i;
const stopLabelPattern = /stop|cancel|停止|中止|终止|取消/i;

const stopButtonSelectors = [
    'button[data-testid="stop-button"]',
    'button[data-testid*="stop"]',
    'button#composer-submit-button[aria-label*="停止"]',
    'button#composer-submit-button[aria-label*="Stop"]',
];

const sendButtonSelectors = [
    'button[data-testid="send-button"]',
    'button#composer-submit-button',
    'button[data-testid*="send"]',
    'form button[type="submit"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
];

// 输入区外框：用于计算悬浮面板的位置，面板本身不再挂进这棵子树。
const composerFormSelectors = [
    'form[data-type="unified-composer"]',
    'main form',
    'form',
];

export function composerNode() {
    return querySelectorChain(composerSelectors);
}

// 输入框所在的表单（或最外层可编辑容器之外的那一层），只用于取坐标。
export function composerFormNode() {
    const composer = composerNode();
    if (!composer) return null;

    for (const selector of composerFormSelectors) {
        try {
            const found = composer.closest(selector);
            if (found) return found;
        } catch { }
    }

    // 兜底：向上走到脱离所有可编辑区域为止，取那一层作为外框。
    let node = composer;
    while (node.parentElement && isInsideEditable(node.parentElement)) {
        node = node.parentElement;
    }
    return node;
}

function isInsideEditable(element) {
    try {
        return Boolean(element.closest?.('[contenteditable="true"]'));
    } catch {
        return false;
    }
}

function labelOf(button) {
    return [
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.getAttribute('data-testid'),
    ].filter(Boolean).join(' ');
}

function isVisible(element) {
    try {
        if (!element.isConnected) return false;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    } catch {
        return true;
    }
}

// 停止按钮：新版 ChatGPT 中它与发送按钮可能是两个不同元素，而非同一按钮换状态，
// 所以不能只盯一个节点的属性，而要在整个输入区里找。
export function stopButtonNode() {
    const direct = querySelectorChain(stopButtonSelectors);
    if (direct && isVisible(direct)) return direct;

    const form = composerFormNode();
    if (!form) return null;
    for (const button of form.querySelectorAll('button')) {
        if (!isVisible(button)) continue;
        const label = labelOf(button);
        if (stopLabelPattern.test(label) && !sendLabelPattern.test(label)) return button;
    }
    return null;
}

export function submitButtonNode() {
    const direct = querySelectorChain(sendButtonSelectors);
    if (direct) return direct;

    const form = composerFormNode();
    if (!form) return null;
    for (const button of form.querySelectorAll('button')) {
        if (sendLabelPattern.test(labelOf(button))) return button;
    }
    return null;
}

export function submitButtonMode() {
    const button = submitButtonNode();
    if (!button) return null;

    const testId = button.getAttribute('data-testid') || '';
    if (/stop/i.test(testId)) return 'stop-button';
    if (/send/i.test(testId)) return 'send-button';

    const label = labelOf(button);
    if (stopLabelPattern.test(label)) return 'stop-button';
    if (sendLabelPattern.test(label)) return 'send-button';
    return null;
}

// ---------- 生成态判定 ----------
// 新版 ChatGPT 允许生成中直接发送，生成期间右下角仍是发送箭头、没有停止按钮，
// 所以不能再靠按钮判定，而要看对话本身的状态：
//   · 最后一条是用户消息 → 已提问、尚未开始回答
//   · 最后一条是助手消息但还没出现「复制 / 点赞」操作栏 → 回答尚未完成
//   · 存在「正在思考」类指示 → 推理阶段（此时 DOM 可能长时间静止）
//   · 对话区最近仍在持续变动 → 正在流式输出
// 任一信号为真即视为生成中；宁可多等，不可误发。

const thinkingTextPattern = /^(正在思考|思考中|正在推理|推理中|正在搜索|搜索中|正在生成|Thinking|Reasoning|Searching|Working)/i;

const turnActionSelectors = [
    '[data-testid="copy-turn-action-button"]',
    '[data-testid*="turn-action"]',
    '[data-testid*="good-response"]',
    'button[aria-label*="复制"]',
    'button[aria-label*="Copy"]',
    'button[aria-label*="回复"]',
    'button[aria-label*="response"]',
];

const streamingHintSelectors = [
    '.result-streaming',
    '.result-thinking',
    '[data-is-streaming="true"]',
    '[data-message-streaming="true"]',
    'main [class*="shimmer"]',
    'main [class*="thinking"]',
    'main [class*="streaming"]',
];

// 对话区最近一次内容变动的时间，由 main.js 的 MutationObserver 写入。
let lastConversationMutationAt = 0;
export function noteConversationMutation() {
    lastConversationMutationAt = Date.now();
}
// 流式输出会持续改动 DOM；这段时间内没有改动才认为它停了。
const conversationQuietMilliseconds = 2500;
// 助手消息既无操作栏、又无思考指示、且静止超过此时长，视为已完成（防止操作栏选择器失效导致永远"生成中"）。
const assistantSettleMilliseconds = 10000;

function recentConversationMutationWithin(milliseconds) {
    return lastConversationMutationAt > 0 && Date.now() - lastConversationMutationAt < milliseconds;
}

// 对话轮次：优先用 data-message-author-role，退而用 article[data-turn]。
export function conversationTurns() {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll('[data-message-author-role]')); } catch { }
    if (nodes.length) {
        return nodes.map((node) => ({
            role: node.getAttribute('data-message-author-role'),
            element: node.closest('article') || node.closest('[data-turn]') || node,
        }));
    }
    try { nodes = Array.from(document.querySelectorAll('article[data-turn], [data-turn]')); } catch { }
    return nodes.map((node) => ({ role: node.getAttribute('data-turn'), element: node }));
}

function hasTurnActions(element) {
    for (const selector of turnActionSelectors) {
        try { if (element.querySelector(selector)) return true; } catch { }
    }
    return false;
}

export function hasThinkingIndicator() {
    for (const selector of streamingHintSelectors) {
        try { if (document.querySelector(selector)) return true; } catch { }
    }
    const turns = conversationTurns();
    const last = turns[turns.length - 1];
    if (!last) return false;
    // 思考指示通常是最后一轮里的一小段短文本。
    const text = String(last.element.innerText || '').trim();
    return text.length > 0 && text.length < 40 && thinkingTextPattern.test(text);
}

// 供诊断输出与测试使用：给出判定依据。
export function streamingAssessment() {
    const turns = conversationTurns();
    const last = turns[turns.length - 1] || null;
    const lastRole = last ? last.role : null;
    const lastHasActions = last ? hasTurnActions(last.element) : null;
    const thinking = hasThinkingIndicator();
    const stopButton = Boolean(stopButtonNode()) || submitButtonMode() === 'stop-button';
    const quietFor = lastConversationMutationAt ? Date.now() - lastConversationMutationAt : null;

    let streaming = false;
    let reason = 'idle';
    if (stopButton) { streaming = true; reason = 'stop-button'; }
    else if (thinking) { streaming = true; reason = 'thinking-indicator'; }
    else if (lastRole === 'user') { streaming = true; reason = 'awaiting-assistant'; }
    else if (lastRole === 'assistant' && !lastHasActions) {
        // 没有操作栏：仍在输出中；但若长时间静止，按已完成处理，避免选择器失效时卡死。
        if (recentConversationMutationWithin(assistantSettleMilliseconds)) { streaming = true; reason = 'assistant-unfinished'; }
        else { reason = 'assistant-settled-without-actions'; }
    }
    else if (recentConversationMutationWithin(conversationQuietMilliseconds)) { streaming = true; reason = 'conversation-mutating'; }

    return { streaming, reason, lastRole, lastHasActions, thinking, stopButton, quietFor, turnCount: turns.length };
}

export function isStreaming() {
    return streamingAssessment().streaming;
}

export function isSendEnabled() {
    if (isStreaming()) return false;
    const button = submitButtonNode();
    if (!button) return false;
    if (submitButtonMode() === 'stop-button') return false;
    if (button.disabled) return false;
    if ((button.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return false;
    try {
        if (getComputedStyle(button).pointerEvents === 'none') return false;
    } catch { }
    return true;
}

// 整条 fallback 链都失效时，交由 UI 层提示一次，避免脚本静默死亡。
export function reportSelectorFailureOnce(onFailure) {
    if (selectorFailureReported) return;
    selectorFailureReported = true;
    onFailure?.();
}

// 输入框恢复后重置，使后续真正的改版失效仍能被提示。
export function resetSelectorFailureReport() {
    selectorFailureReported = false;
}

// 诊断信息：页面改版排查用，在控制台调用 __cmqDiag() 即可。
export function collectDiagnostics() {
    const describe = (element) => element ? {
        tag: element.tagName,
        id: element.id || null,
        testid: element.getAttribute('data-testid'),
        label: element.getAttribute('aria-label'),
        disabled: element.disabled ?? null,
        className: String(element.className || '').slice(0, 120),
    } : null;

    const form = composerFormNode();
    return {
        url: location.href,
        composer: describe(composerNode()),
        form: describe(form),
        submitButton: describe(submitButtonNode()),
        stopButton: describe(stopButtonNode()),
        submitButtonMode: submitButtonMode(),
        streaming: streamingAssessment(),
        isSendEnabled: isSendEnabled(),
        lastTurnText: (() => {
            const turns = conversationTurns();
            const last = turns[turns.length - 1];
            return last ? String(last.element.innerText || '').slice(0, 80) : null;
        })(),
        formButtons: form ? Array.from(form.querySelectorAll('button')).map(describe) : [],
    };
}
