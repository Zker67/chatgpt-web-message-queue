import { composerNode, submitButtonNode } from './selectors.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 先做几次微任务/帧级别的快速轮询，再落到限时轮询；
// timeoutMilliseconds <= 0 时只做快速探测，避免无谓等待。
export const waitFor = async (predicate, timeoutMilliseconds) => {
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

export function normalizeText(text) {
    return String(text || '').replace(/​/g, '').replace(/\r\n/g, '\n').trim();
}

export function currentComposerText() {
    return normalizeText(composerNode()?.innerText || '');
}

function fireInputEvents(composer) {
    try { composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: '' })); } catch { }
    try { composer.dispatchEvent(new InputEvent('input', { bubbles: true })); } catch { }
}

// 忽略所有空白后比较，ProseMirror 会把段落 / 空行规范化，逐字比对会误判。
export function textMatches(actual, expected) {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    return compact(actual) === compact(expected);
}

function isComposerEmpty(composer) {
    return !normalizeText(composer.innerText || '');
}

// 用 Range API 选中编辑器全部内容。比 execCommand('selectAll') 可靠：
// 后者在焦点没落进编辑器时会选中整页，删除自然无效，残留内容就会被后续注入插到中间。
function selectAllInComposer(composer) {
    try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
    } catch {
        return false;
    }
}

// 三级清空，每级都校验是否真的空了；返回是否成功。
export function clearComposer() {
    const composer = composerNode();
    if (!composer) return false;
    composer.focus();
    if (isComposerEmpty(composer)) return true;

    selectAllInComposer(composer);
    try { document.execCommand('delete', false, null); } catch { }
    if (isComposerEmpty(composer)) { fireInputEvents(composer); return true; }

    selectAllInComposer(composer);
    try {
        composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }));
    } catch { }
    if (isComposerEmpty(composer)) { fireInputEvents(composer); return true; }

    composer.textContent = '';
    fireInputEvents(composer);
    return isComposerEmpty(composer);
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
// 每一级之后都校验内容是否与目标一致；清空失败则直接放弃，绝不往残留内容里插字。
export function setComposerText(text) {
    const composer = composerNode();
    if (!composer) return false;

    composer.focus();
    if (!clearComposer()) return false;

    if (pasteIntoComposer(text) && textMatches(composer.innerText, text)) return true;

    // paste 没生效或内容不对：重新清空再试 insertText。
    if (!clearComposer()) return false;
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, text); } catch { inserted = false; }
    if (inserted && textMatches(composer.innerText, text)) { fireInputEvents(composer); return true; }

    if (!clearComposer()) return false;
    composer.textContent = text;
    fireInputEvents(composer);
    return textMatches(composer.innerText, text);
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

export function appendComposerText(textToAppend) {
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
export function clickSubmitButtonHuman() {
    const button = submitButtonNode();
    if (!button) return false;

    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
}
