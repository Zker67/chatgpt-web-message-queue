// 纯逻辑层验证（storage + queue），不依赖 DOM。
// 用 node scripts/logic-test.mjs 运行。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');

const makeStorage = () => ({
    store: {},
    getItem(key) { return this.store[key] ?? null; },
    setItem(key, value) { this.store[key] = String(value); },
    removeItem(key) { delete this.store[key]; },
});

globalThis.localStorage = makeStorage();
globalThis.sessionStorage = makeStorage();
globalThis.location = { pathname: '/' };

const loadModule = (relativePath) =>
    readFileSync(join(rootDirectory, relativePath), 'utf8')
        .replace(/^\s*import[^;]*;\s*$/gm, '')
        .replace(/^\s*export\s+(?=(const|let|function|async|class))/gm, '');

const constantsSource = loadModule('src/constants.js');
const stateSource = loadModule('src/core/state.js');
const storageSource = loadModule('src/core/storage.js');
const queueSource = loadModule('src/core/queue.js');
// composer.js 依赖 DOM，这里只替换出它对 queue 的唯一依赖 normalizeText。
const composerStub = String.raw`function normalizeText(t){ return String(t || "").replace(/\r\n/g, "\n").trim(); }`;

const instantiate = (exposed) => new Function(`
${constantsSource}
${composerStub}
${stateSource}
${storageSource}
${queueSource}
return { ${exposed} };
`)();

let passCount = 0;
let failCount = 0;
const check = (name, condition, detail = '') => {
    if (condition) { passCount++; console.log('  PASS', name); }
    else { failCount++; console.log('  FAIL', name, detail); }
};

const commonExports = `switchConversationIfNeeded, enqueuePrompt, deleteQueueItemAt, clearQueue,
    moveQueueItem, loadPendingQueue, loadQueueForConversation,
    setMerge: (v) => setMergeMessagesEnabled(v), getQueue: () => promptQueue`;

console.log('\n[1] 新会话入队 → 建立会话后队列迁移（上游 bug 修复点）');
globalThis.location.pathname = '/';
const first = instantiate(commonExports);
first.switchConversationIfNeeded();
first.enqueuePrompt('第一条');
first.enqueuePrompt('第二条');
check('无 id 时落入 sessionStorage 暂存槽', first.loadPendingQueue().queue.length === 2,
    JSON.stringify(first.loadPendingQueue()));

// 模拟 ChatGPT 建会话后重建 UI：脚本实例状态被丢弃，但 sessionStorage 仍在。
globalThis.location.pathname = '/c/abcdef12-3456-7890';
const rebuilt = instantiate(commonExports);
rebuilt.switchConversationIfNeeded();
check('重建实例后队列被找回（上游此处丢失）', rebuilt.getQueue().length === 2,
    JSON.stringify(rebuilt.getQueue()));
check('迁移后暂存槽已清空', rebuilt.loadPendingQueue().queue.length === 0);
check('已持久化到会话键',
    rebuilt.loadQueueForConversation('conversation:abcdef12-3456-7890').length === 2);

console.log('\n[2] 拖拽重排序');
globalThis.location.pathname = '/c/11111111-2222-3333';
const reorder = instantiate(commonExports);
reorder.switchConversationIfNeeded();
['A', 'B', 'C'].forEach((item) => reorder.enqueuePrompt(item));
reorder.moveQueueItem(0, 2);
check('首条移到末尾 → B,C,A',
    JSON.stringify(reorder.getQueue()) === JSON.stringify(['B', 'C', 'A']),
    JSON.stringify(reorder.getQueue()));
reorder.moveQueueItem(2, 0);
check('末条移回开头 → A,B,C',
    JSON.stringify(reorder.getQueue()) === JSON.stringify(['A', 'B', 'C']),
    JSON.stringify(reorder.getQueue()));

console.log('\n[3] 合并模式');
globalThis.location.pathname = '/c/44444444-5555-6666';
const merge = instantiate(commonExports);
merge.switchConversationIfNeeded();
merge.setMerge(true);
merge.enqueuePrompt('问题一');
merge.enqueuePrompt('问题二');
check('合并为单条', merge.getQueue().length === 1, JSON.stringify(merge.getQueue()));
check('用空行分隔', merge.getQueue()[0] === '问题一\n\n问题二', JSON.stringify(merge.getQueue()[0]));

console.log('\n[4] 会话隔离');
globalThis.location.pathname = '/c/aaaaaaaa-bbbb-cccc';
const isolation = instantiate(commonExports);
isolation.switchConversationIfNeeded();
isolation.enqueuePrompt('会话甲的消息');
globalThis.location.pathname = '/c/dddddddd-eeee-ffff';
isolation.switchConversationIfNeeded();
check('切换到另一会话后队列为空', isolation.getQueue().length === 0, JSON.stringify(isolation.getQueue()));
globalThis.location.pathname = '/c/aaaaaaaa-bbbb-cccc';
isolation.switchConversationIfNeeded();
check('切回原会话后队列恢复', isolation.getQueue().length === 1, JSON.stringify(isolation.getQueue()));

console.log('\n[5] 边界');
globalThis.location.pathname = '/c/77777777-8888-9999';
const edges = instantiate(commonExports);
edges.switchConversationIfNeeded();
check('空白内容不入队', edges.enqueuePrompt('   ') === false && edges.getQueue().length === 0);
edges.enqueuePrompt('X');
check('越界删除返回 false', edges.deleteQueueItemAt(99) === false);
edges.clearQueue();
check('清空后该会话键被移除',
    edges.loadQueueForConversation('conversation:77777777-8888-9999').length === 0);

console.log(`\n结果：${passCount} 通过, ${failCount} 失败`);
process.exit(failCount ? 1 : 0);
