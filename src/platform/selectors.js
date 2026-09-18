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

export function composerNode() {
    return querySelectorChain(composerSelectors);
}

export function submitButtonNode() {
    return querySelectorChain(submitButtonSelectors);
}

// 返回队列面板的锚点元素；面板将插入到它前面，成为其兄弟节点。
export function composerAnchorNode() {
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

export function submitButtonMode() {
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

export function isStreaming() {
    return submitButtonMode() === 'stop-button';
}

export function isSendEnabled() {
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
export function reportSelectorFailureOnce(onFailure) {
    if (selectorFailureReported) return;
    selectorFailureReported = true;
    onFailure?.();
}

// 输入框恢复后重置，使后续真正的改版失效仍能被提示。
export function resetSelectorFailureReport() {
    selectorFailureReported = false;
}

export function hasComposer() {
    return Boolean(composerNode());
}
