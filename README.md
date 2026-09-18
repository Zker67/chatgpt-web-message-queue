<div align="center">

# ChatGPT 消息队列

**ChatGPT 还在回答，你就可以继续提问**

生成中输入的消息先进队列，等它答完自动逐条发出 —— 思路不用为等待让路。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Userscript](https://img.shields.io/badge/userscript-Tampermonkey-00485B.svg)](https://www.tampermonkey.net/)
[![Version](https://img.shields.io/badge/version-1.1.0-brightgreen.svg)](./dist/chatgpt-message-queue.user.js)
[![i18n](https://img.shields.io/badge/i18n-中文%20%7C%20English-orange.svg)](#语言切换)
[![Upstream](https://img.shields.io/badge/fork-maribox%2Fmy__userscripts-lightgrey.svg)](https://github.com/maribox/my_userscripts)
[![Site](https://img.shields.io/badge/site-chatgpt.com-10A37F.svg)](https://chatgpt.com)

</div>

---

## 这是什么

ChatGPT 生成回答时输入框是「发不出去」的：想追问只能干等。本脚本接管这一刻 —— 你照常按
Enter，消息进入输入框上方的队列；ChatGPT 一答完，队列里的消息自动发出。

适合让 ChatGPT 分步讲解时随时插问、连续抛出多个追问、或跑多步骤工作流。

### 快捷键

| 按键 | 行为 |
|---|---|
| `Enter`（生成中） | 消息进入队列，等 ChatGPT 答完自动发出 |
| `Enter`（空闲时） | ChatGPT 原生发送，脚本不介入 |
| `Ctrl+Enter` / `Cmd+Enter` | 脚本不拦截，原样交给 ChatGPT 处理 |
| `Shift+Enter` | 换行 |

> 本项目接手自 [maribox](https://github.com/maribox/my_userscripts) 的
> [ChatGPT Message Queue](https://greasyfork.org/en/scripts/561517-chatgpt-message-queue)（MIT，已停止维护），
> 在其基础上重构并继续维护。署名与出处见 [`NOTICE.md`](./NOTICE.md)。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开 [`dist/chatgpt-message-queue.user.js`](./dist/chatgpt-message-queue.user.js)，点击 **Raw** 即可安装。
3. 访问 `chatgpt.com`，在生成过程中按 Enter 试试。

## 功能

| 功能 | 说明 |
|---|---|
| 生成中入队 | 流式输出时按 Enter，消息进入队列而非被丢弃 |
| 不干扰原生按键 | `Ctrl+Enter` / `Cmd+Enter` 与 `Shift+Enter` 均不拦截 |
| 自动发送 | 检测到生成结束，自动发出队首消息 |
| 拖拽排序 | 拖左侧手柄调整顺序，带插入位置指示线 |
| 编辑 / 删除 | 行内编辑（Enter 保存、Shift+Enter 换行、Esc 取消） |
| 合并发送 | 开启后新消息并入上一条，合成一次提问发出 |
| 按会话持久化 | 各对话的队列互相独立，刷新页面不丢失 |
| 草稿保护 | 发送队列消息时，你正在输入的内容会被自动还原 |
| 悬浮面板 | 队列面板悬浮在输入框上方，不进入 ChatGPT 的 DOM，不会被当成输入内容 |
| 中文界面兼容 | 发送 / 停止按钮的判定同时覆盖中英文 aria-label |
| 双语界面 | 中文 / English，跟随浏览器语言并可手动切换 |

### 语言切换

队列面板右下角的 **中 / EN** 按钮可随时切换，选择会被记住。默认跟随浏览器语言。

## 相比上游的改进

| 改进 | 说明 |
|---|---|
| **修复新会话丢队列** | 上游在新对话中入队的消息会随 ChatGPT 重建界面而丢失；现改为先存入 `sessionStorage`，会话建立后迁移到正式存储 |
| **选择器适配层** | 上游硬编码 `.wcDTda_prosemirror-parent` 等哈希类名，页面改版即全线失效；现为每个关键节点提供多级 fallback |
| **失败可见** | 上游发送失败只是静默返回；现连续失败会在面板显示提示，不再默默卡住 |
| **双语界面** | 上游仅英文 |
| **模块化 + 构建** | 上游为 1221 行单文件；现按 `core` / `ui` / `platform` / `i18n` 分层，构建为单文件产物 |
| **发送确认模型** | 上游只认「进入生成态」才出队，检测一旦失灵就会反复重发同一条；现改为「进入生成态 **或** 输入框被清空」即确认，失败则撤回注入文本、还原草稿，并有冷却期防连发 |
| **逻辑测试** | 新增队列与发送流程测试（`npm test`），覆盖迁移、排序、合并、会话隔离、发送确认、冷却与中文按钮判定 |

## 已知限制

- **图片 / 附件不入队**：附件会随下一条消息直接发出。这是上游遗留的限制，计划在 M3 处理。
- 仅支持 `chatgpt.com` 与 `chat.openai.com`。

## 开发

```bash
npm run build   # 由 src/ 构建出 dist/ 单文件用户脚本
npm test        # 队列逻辑 + 发送流程测试（无需浏览器）
npm run check   # 构建 + 语法校验 + 测试
```

`dist/` 下的产物**需要提交**：用户脚本要能被直接安装。

### 目录结构

```
src/
├── constants.js        存储键、时序、布局等常量
├── i18n/               中英文案与语言切换
├── platform/           与 ChatGPT DOM 打交道的一层
│   ├── selectors.js    多级 fallback 选择器（改版时改这里）
│   └── composer.js     ProseMirror 文本注入与发送点击
├── core/               与界面无关的队列逻辑
│   ├── storage.js      持久化与新会话暂存槽
│   ├── state.js        运行时状态
│   ├── queue.js        入队 / 排序 / 会话切换
│   └── sender.js       发送时序与草稿恢复
├── ui/                 队列面板渲染与交互
└── main.js             启动、事件绑定、主循环
```

页面改版导致脚本失效时，通常只需要修 `src/platform/selectors.js`。

### 排查

脚本在页面上暴露了诊断入口。打开 ChatGPT 页面按 F12，在控制台运行：

```js
copy(JSON.stringify(__cmqDiag(), null, 2))
```

它会把输入框、发送 / 停止按钮的定位结果与当前判定（是否生成中、是否可发送）复制到剪贴板，提 issue 时直接贴上即可。

## 路线图

- **M1**（当前）模块化重构、选择器适配层、修复新会话丢队列、双语界面
- **M2** 事件驱动取代轮询、队列导入导出、全局设置
- **M3** 图片 / 附件入队

详见 [`plans/`](./plans/README.md)。

## 许可

[MIT](./LICENSE)。衍生自 maribox 的同名脚本，再分发时请保留 [`NOTICE.md`](./NOTICE.md) 中的上游署名。
