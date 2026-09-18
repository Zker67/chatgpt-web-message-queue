// 构建脚本：把 src/ 下的模块按固定顺序拼接为单文件用户脚本。
// 不引入打包器，保持零依赖；模块间靠拼接后的同一函数作用域共享符号。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(rootDirectory, 'dist', 'chatgpt-message-queue.user.js');

// 拼接顺序即依赖顺序，不可随意调整。
const moduleFiles = [
    'src/constants.js',
    'src/i18n/messages.js',
    'src/i18n/index.js',
    'src/platform/selectors.js',
    'src/platform/composer.js',
    'src/core/storage.js',
    'src/core/state.js',
    'src/core/queue.js',
    'src/core/sender.js',
    'src/ui/styles.js',
    'src/ui/notice.js',
    'src/ui/controls.js',
    'src/ui/dragdrop.js',
    'src/ui/render.js',
    'src/main.js',
];

const stripModuleSyntax = (source) =>
    source
        // 去掉 import / export 语句，拼接后同处一个作用域，无需模块语义。
        .replace(/^\s*import[^;]*;\s*$/gm, '')
        .replace(/^\s*export\s+(?=(const|let|function|async|class))/gm, '')
        .replace(/^\s*export\s*\{[^}]*\};\s*$/gm, '')
        .trimEnd();

const readVersion = async () => {
    const packageJson = JSON.parse(await readFile(join(rootDirectory, 'package.json'), 'utf8'));
    return packageJson.version;
};

const buildBanner = (version) => `// ==UserScript==
// @name         ChatGPT Message Queue (Continued)
// @name:zh-CN   ChatGPT 消息队列（续维护版）
// @namespace    https://github.com/Zker67/chatgpt-web-message-queue
// @version      ${version}
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
`;

const build = async () => {
    const version = await readVersion();

    const moduleSources = await Promise.all(
        moduleFiles.map(async (relativePath) => {
            const source = await readFile(join(rootDirectory, relativePath), 'utf8');
            return `    // ===== ${relativePath} =====\n` + indent(stripModuleSyntax(source));
        })
    );

    const body = moduleSources.join('\n\n');
    const output = `${buildBanner(version)}
(() => {
    'use strict';

${body}

})();
`;

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output, 'utf8');

    const lineCount = output.split('\n').length;
    console.log(`built ${outputPath} (v${version}, ${lineCount} lines, ${moduleFiles.length} modules)`);
};

function indent(source) {
    return source
        .split('\n')
        .map((line) => (line.trim() ? `    ${line}` : line))
        .join('\n');
}

await build();
