// Optional real-DOM regression tests. Start Chrome with a CDP endpoint first.
// Isolated about:blank pages only; no ChatGPT requests, account or extension.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const endpoint = process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222';
const source = await readFile(process.argv[2] || new URL('../dist/chatgpt-message-queue.user.js', import.meta.url), 'utf8');
// Expose existing functions only in this isolated fixture, not in the shipped script.
const testSource = source.replace('window.__cmqDiag = () => collectDiagnostics();',
    'window.__cmqDiag = () => collectDiagnostics(); window.__cmqBrowserTest = { setComposerText };');
assert.ok(testSource !== source, 'diagnostic entry point changed');
async function connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data), request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result);
    });
    return { close: () => socket.close(), send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, 10000);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params }));
        });
    } };
}
const version = await (await fetch(`${endpoint}/json/version`)).json();
const browser = await connect(version.webSocketDebuggerUrl);
const context = await browser.send('Target.createBrowserContext');
const cases = [
    ['connected composer text is ignored', `document.querySelector('#paste').firstChild.data='new draft'`, false],
    ['queued text mutation survives detachment', `const n=document.querySelector('#paste');n.firstChild.data='new draft';n.remove()`, false],
    ['replacing editor contents leaves orphan text records', `const e=document.querySelector('[contenteditable]');e.querySelector('span').firstChild.data='new draft';e.replaceChildren(document.createElement('p'))`, false],
    ['connected conversation text is observed', `document.querySelector('#reply').firstChild.data='new response text'`, true],
    ['new conversation content is observed', `document.querySelector('#history').appendChild(document.createElement('p'))`, true],
    ['role heading with a pending user message remains busy', '', true,
        `<div><h4 data-conversation-role="user">You said:</h4><p>queued question</p></div>`],
    ['role heading with thinking text remains busy without Stop', '', true,
        `<div><h4 data-conversation-role="assistant"></h4>Thinking</div>`],
    ['completed role-heading turn with action bar is idle', '', false,
        `<div data-talvt-turn-state="complete"><div><h4 data-conversation-role="assistant">ChatGPT said:</h4><p>done</p></div><button aria-label="Copy">Copy</button></div>`],
];
let failures = 0;
try {
    for (const [name, mutation, expected, history] of cases) {
        const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId: context.browserContextId, background: true });
        const page = await connect(`${version.webSocketDebuggerUrl.replace(/\/devtools\/browser\/.*/, '')}/devtools/page/${targetId}`);
        try {
            const result = await page.send('Runtime.evaluate', {
                expression: `(async()=>{document.body.innerHTML=${JSON.stringify(`<main><section id="history">${history || '<span id="reply">ready</span>'}</section><form><div class="ProseMirror" contenteditable="true"><span id="paste">draft</span></div><button type="button" aria-label="Send">Send</button></form></main>`)};\n${testSource}\n;await new Promise(r=>setTimeout(r,50));${mutation};await new Promise(r=>setTimeout(r,30));return window.__cmqDiag().streaming;})()`,
                awaitPromise: true, returnByValue: true,
            });
            if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
            assert.equal(result.result.value.streaming, expected, JSON.stringify(result.result.value));
            console.log(`PASS ${name}`);
        } catch (error) {
            failures++;
            console.error(`FAIL ${name}: ${error.message}`);
        } finally {
            page.close();
            await browser.send('Target.closeTarget', { targetId });
        }
    }
    // Check replacement against an asynchronous editor model as well as DOM.
    // This lightweight fixture supplements the live ProseMirror check; it is
    // not a complete simulation of the application's editor transactions.
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId: context.browserContextId, background: true });
    const page = await connect(`${version.webSocketDebuggerUrl.replace(/\/devtools\/browser\/.*/, '')}/devtools/page/${targetId}`);
    try {
        const result = await page.send('Runtime.evaluate', {
            expression: `(async()=>{
                document.body.innerHTML='<main><form><div class="ProseMirror" contenteditable="true"><p>UNSENT-DRAFT</p></div><button type="button" aria-label="Send">Send</button></form></main>';
                const editor=document.querySelector('[contenteditable]');
                let model=editor.innerText;
                const observer=new MutationObserver(()=>{model=editor.innerText;});
                observer.observe(editor,{subtree:true,childList:true,characterData:true});
                editor.addEventListener('paste',event=>{
                    event.preventDefault();
                    model += event.clipboardData.getData('text/plain');
                    editor.textContent=model;
                });
                ${testSource}
                const edited=window.__cmqBrowserTest.setComposerText('QUEUED-PROMPT');
                await new Promise(requestAnimationFrame);
                return {edited,dom:editor.innerText,model};
            })()`, awaitPromise: true, returnByValue: true,
        });
        if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
        assert.deepEqual(result.result.value,{edited:true,dom:'QUEUED-PROMPT',model:'QUEUED-PROMPT'});
        console.log('PASS queued prompt replaces draft in asynchronous editor state');
    } catch(error) {
        failures++;
        console.error(`FAIL queued prompt replaces draft in asynchronous editor state: ${error.message}`);
    } finally {
        page.close();
        await browser.send('Target.closeTarget',{targetId});
    }
} finally {
    await browser.send('Target.disposeBrowserContext', { browserContextId: context.browserContextId });
    browser.close();
}
console.log(`${cases.length + 1 - failures} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
