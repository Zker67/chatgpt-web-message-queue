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

// 多信号综合判定是否正在生成：任何一个信号为真即视为生成中。
export function isStreaming() {
    if (stopButtonNode()) return true;
    if (submitButtonMode() === 'stop-button') return true;
    try {
        if (document.querySelector('.result-streaming, [data-is-streaming="true"], [data-message-streaming="true"]')) return true;
    } catch { }
    return false;
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
        isStreaming: isStreaming(),
        isSendEnabled: isSendEnabled(),
        formButtons: form ? Array.from(form.querySelectorAll('button')).map(describe) : [],
    };
}
