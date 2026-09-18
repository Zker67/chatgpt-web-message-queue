// 发送流程 + 流式检测验证：用桩模拟 ChatGPT 行为，跑真实的 constants/state/sender 源码。
// 用 node scripts/sender-test.mjs 运行。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const loadModule = (relativePath) =>
    readFileSync(join(rootDirectory, relativePath), 'utf8')
        .replace(/^\s*import[^;]*;\s*$/gm, '')
        .replace(/^\s*export\s+(?=(const|let|function|async|class))/gm, '');

const constantsSource = loadModule('src/constants.js');
const stateSource = loadModule('src/core/state.js');
const senderSource = loadModule('src/core/sender.js');

globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 4);
globalThis.performance = globalThis.performance || { now: () => Date.now() };

let passCount = 0;
let failCount = 0;
const check = (name, condition, detail = '') => {
    if (condition) { passCount++; console.log('  PASS', name); }
    else { failCount++; console.log('  FAIL', name, detail); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 构造一个可编程的 ChatGPT 桩：composerText / streaming / sendEnabled 可随时改。
function makeHarness(queue, behaviour) {
    const world = {
        composerText: behaviour.initialDraft || '',
        streaming: false,
        sendEnabled: true,
        clicks: 0,
        log: [],
    };

    const stubs = `
        const isStreaming = () => __w.streaming;
        const isSendEnabled = () => !__w.streaming && __w.sendEnabled;
        const composerNode = () => ({ get innerText() { return __w.composerText; } });
        const waitFor = async (predicate, timeoutMilliseconds) => {
            if (predicate()) return true;
            const start = Date.now();
            while (Date.now() - start < Math.max(timeoutMilliseconds, 40)) {
                await new Promise(requestAnimationFrame);
                if (predicate()) return true;
            }
            return false;
        };
        const normalizeText = (t) => String(t || '').trim();
        const currentComposerText = () => normalizeText(__w.composerText);
        const setComposerText = (t) => { __w.composerText = t; __w.log.push('注入:' + t); return true; };
        const textMatches = (a, b) => String(a || '').replace(/\s+/g, '') === String(b || '').replace(/\s+/g, '');
        const appendComposerText = (t) => { __w.composerText += t; __w.log.push('追加:' + t); };
        const clearComposer = () => { __w.composerText = ''; __w.log.push('清空'); };
        const clickSubmitButtonHuman = () => { __w.clicks++; __w.log.push('点击发送'); __w.onClick?.(); return true; };
        const persistCurrentStateIfPossible = () => {};
        const isInteracting = () => false;
    `;

    const api = new Function('__w', `
        ${constantsSource}
        ${stateSource.replace(/^\s*const isInteracting[^\n]*$/m, '')}
        ${stubs}
        ${senderSource}
        promptQueue.push(...__w.initialQueue);
        return { sendNextQueuedPrompt, pumpQueue, getQueue: () => promptQueue, tryRestorePendingDraft,
                 getFailures: () => consecutiveSendFailures };
    `)(Object.assign(world, { initialQueue: queue, onClick: behaviour.onClick?.(world) }));

    return { world, api };
}

console.log('\n[1] 正常发送：点击后 ChatGPT 清空输入框并进入生成态 → 出队');
{
    const { world, api } = makeHarness(['第一条', '第二条'], {
        onClick: (w) => () => { setTimeout(() => { w.composerText = ''; w.streaming = true; }, 20); },
    });
    const sent = await api.sendNextQueuedPrompt();
    check('返回成功', sent === true);
    check('队首已出队', api.getQueue().length === 1 && api.getQueue()[0] === '第二条', JSON.stringify(api.getQueue()));
    check('只点击了一次', world.clicks === 1, String(world.clicks));
}

console.log('\n[2] 流式检测失灵（isStreaming 永远 false）但输入框被清空 → 仍应判定为已发出');
{
    const { world, api } = makeHarness(['唯一一条'], {
        onClick: (w) => () => { setTimeout(() => { w.composerText = ''; }, 20); },  // 不置 streaming
    });
    const sent = await api.sendNextQueuedPrompt();
    check('判定为已发出', sent === true);
    check('已出队，不会重复发送', api.getQueue().length === 0, JSON.stringify(api.getQueue()));

    // 检测失灵下发出的下一条必须被拉长的冷却拦住，否则就是「对方没答完就猛发」。
    api.getQueue().push('紧随其后的一条');
    world.composerText = '';
    await api.pumpQueue();
    check('未观察到生成态时，下一条被额外冷却拦下', world.clicks === 1, '点击数=' + world.clicks);
}

console.log('\n[3] 点击无效（既没进生成态、输入框也没清空）→ 不出队、撤回注入文本、还原草稿');
{
    const { world, api } = makeHarness(['队列消息'], { initialDraft: '我正在打的草稿' });
    const sent = await api.sendNextQueuedPrompt();
    check('判定失败', sent === false);
    check('消息仍在队列', api.getQueue().length === 1);
    check('输入框还原为用户草稿，而非残留队列文本', world.composerText === '我正在打的草稿', JSON.stringify(world.composerText));
    check('失败计数 +1', api.getFailures() === 1, String(api.getFailures()));
}

console.log('\n[4] 冷却：失败后立刻再次 pump，不应再次点击（防连发）');
{
    const { world, api } = makeHarness(['同一条'], {});
    await api.sendNextQueuedPrompt();           // 第一次：失败
    const clicksAfterFirst = world.clicks;
    await api.pumpQueue();                       // 紧接着第二次
    await api.pumpQueue();                       // 第三次
    check('后续尝试被冷却拦下，点击数不增加', world.clicks === clicksAfterFirst, `${clicksAfterFirst} → ${world.clicks}`);
}

console.log('\n[5] 生成中不发送');
{
    const { world, api } = makeHarness(['消息'], {});
    world.streaming = true;
    const sent = await api.sendNextQueuedPrompt();
    check('生成中直接返回', sent === false && world.clicks === 0);
}

// ---------- 流式检测：中文界面 ----------
console.log('\n[6] isStreaming 在中文 aria-label 下的判定');
{
    const selectorsSource = loadModule('src/platform/selectors.js');
    function makeButton(attrs) {
        return {
            tagName: 'BUTTON', isConnected: true, disabled: false, className: '',
            getAttribute: (k) => attrs[k] ?? null,
            getBoundingClientRect: () => ({ width: 30, height: 30 }),
        };
    }
    function runWith(buttons) {
        const form = {
            querySelectorAll: () => buttons,
            querySelector: () => null,
        };
        const composer = { closest: () => form, parentElement: null };
        const documentStub = {
            querySelector: (selector) => {
                if (selector.includes('#prompt-textarea')) return composer;
                for (const button of buttons) {
                    const testid = button.getAttribute('data-testid') || '';
                    const label = button.getAttribute('aria-label') || '';
                    if (selector.includes('data-testid="stop-button"') && testid === 'stop-button') return button;
                    if (selector.includes('data-testid*="stop"') && /stop/.test(testid)) return button;
                    if (selector.includes('data-testid="send-button"') && testid === 'send-button') return button;
                    if (selector.includes('aria-label*="停止"') && label.includes('停止')) return button;
                    if (selector.includes('aria-label*="发送"') && label.includes('发送')) return button;
                }
                return null;
            },
        };
        return new Function('document', 'getComputedStyle', `
            ${selectorsSource}
            return { isStreaming: isStreaming(), mode: submitButtonMode() };
        `)(documentStub, () => ({ display: 'block', visibility: 'visible', pointerEvents: 'auto' }));
    }

    const idle = runWith([makeButton({ 'aria-label': '发送提示' })]);
    check('中文「发送提示」→ 非生成中', idle.isStreaming === false && idle.mode === 'send-button', JSON.stringify(idle));

    const busy = runWith([makeButton({ 'aria-label': '停止流式传输' })]);
    check('中文「停止流式传输」→ 生成中', busy.isStreaming === true, JSON.stringify(busy));

    const busyEn = runWith([makeButton({ 'data-testid': 'stop-button', 'aria-label': 'Stop streaming' })]);
    check('英文 stop-button → 生成中', busyEn.isStreaming === true, JSON.stringify(busyEn));

    const twoButtons = runWith([
        makeButton({ 'aria-label': '发送提示', 'data-testid': 'send-button' }),
        makeButton({ 'aria-label': '停止', 'data-testid': 'stop-button' }),
    ]);
    check('发送与停止并存（两元素互换）时以停止为准 → 生成中', twoButtons.isStreaming === true, JSON.stringify(twoButtons));

    const voiceOnly = runWith([makeButton({ 'aria-label': '开始语音模式' })]);
    check('只有语音按钮 → 不误判为生成中', voiceOnly.isStreaming === false, JSON.stringify(voiceOnly));
}

console.log('\n[7] 生成态判定：新版无停止按钮，改看对话状态');
{
    const selectorsSource = loadModule('src/platform/selectors.js');
    const el = (attrs = {}, { text = '', children = [] } = {}) => ({
        tagName: 'DIV', isConnected: true, disabled: false, className: '',
        getAttribute: (k) => attrs[k] ?? null,
        get innerText() { return text; },
        querySelector: (selector) => children.find((child) => child.__matches?.(selector)) || null,
        querySelectorAll: () => [],
        closest: () => null,
        getBoundingClientRect: () => ({ width: 30, height: 30 }),
    });
    const actionButton = () => Object.assign(el({ 'data-testid': 'copy-turn-action-button' }), {
        __matches: (selector) => selector.includes('copy-turn-action-button'),
    });

    function assess(turns, { mutatedAgoMs = null } = {}) {
        const sendButton = el({ 'aria-label': '发送提示' });
        const form = { querySelectorAll: () => [sendButton], querySelector: () => null };
        const composer = { closest: () => form, parentElement: null };
        const doc = {
            querySelector: (selector) => selector.includes('#prompt-textarea') ? composer : null,
            querySelectorAll: (selector) => selector.includes('data-message-author-role') ? turns.map((turn) => turn.node) : [],
        };
        const body = selectorsSource + '\n' +
            (mutatedAgoMs === null ? '' : 'lastConversationMutationAt = Date.now() - ' + mutatedAgoMs + ';\n') +
            'return streamingAssessment();';
        return new Function('document', 'getComputedStyle', body)(doc, () => ({ display: 'block', visibility: 'visible', pointerEvents: 'auto' }));
    }
    const turn = (role, text, withActions) => ({
        node: el({ 'data-message-author-role': role }, { text, children: withActions ? [actionButton()] : [] }),
    });

    let a = assess([]);
    check('空对话 → 空闲', a.streaming === false, a.reason);

    a = assess([turn('user', '问题', false)]);
    check('最后一条是用户消息（已提问未答）→ 生成中', a.streaming === true && a.reason === 'awaiting-assistant', a.reason);

    a = assess([turn('user', '问题', false), turn('assistant', '正在思考', false)]);
    check('助手轮显示「正在思考」→ 生成中', a.streaming === true && a.reason === 'thinking-indicator', a.reason);

    a = assess([turn('user', '问题', false), turn('assistant', '回答内容很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长', false)], { mutatedAgoMs: 500 });
    check('助手输出中（无操作栏 + 刚有变动）→ 生成中', a.streaming === true && a.reason === 'assistant-unfinished', a.reason);

    a = assess([turn('user', '问题', false), turn('assistant', '完整回答', true)], { mutatedAgoMs: 8000 });
    check('助手已完成（有操作栏 + 已静止）→ 空闲', a.streaming === false, a.reason);

    a = assess([turn('user', '问题', false), turn('assistant', '完整回答', false)], { mutatedAgoMs: 20000 });
    check('无操作栏但静止 20 秒 → 视为完成，防卡死', a.streaming === false && a.reason === 'assistant-settled-without-actions', a.reason);

    a = assess([turn('user', '问题', false), turn('assistant', '完整回答', true)], { mutatedAgoMs: 800 });
    check('有操作栏但对话区仍在变动 → 生成中（收尾阶段）', a.streaming === true && a.reason === 'conversation-mutating', a.reason);
}

console.log(`\n结果：${passCount} 通过, ${failCount} 失败`);
process.exit(failCount ? 1 : 0);
