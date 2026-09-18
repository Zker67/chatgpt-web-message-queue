# M1：接手上游 + 模块化重构 + 稳定性加固

- 状态：进行中
- 日期：2026-09-18
- 目标版本：`1.1.0`

## 背景

上游 [`maribox/my_userscripts`](https://github.com/maribox/my_userscripts) 自 2026-01-05
建仓后再无提交（0 star / 0 fork），Greasy Fork 条目 561517 停更。脚本以 MIT 发布，
可合法接手继续维护，署名要求见 `NOTICE.md`。

上游基线快照：`_upstream/original-v1.0.0.user.js`（1221 行单文件 IIFE，`@grant none`）。

## 上游核心机制（重构时必须保留）

这些是上游踩坑换来的实战经验，重写时不得简化：

1. **ProseMirror 文本注入**：`clearComposer()` 用 `execCommand` → `pasteIntoComposer()`
   构造 `ClipboardEvent` + `DataTransfer` → 失败回退 `insertText` → 再回退 `textContent`。
   注入后用 `innerText.length >= target.length * 0.7` 做宽松校验。
2. **发送时序**：`setComposerText` → 等 transaction 计数变化 → 等 `isSendEnabled()` →
   `clickSubmitButtonHuman()` 派发完整 pointer/mouse/click 序列 → 等 `isStreaming()` 确认
   真的发出去了 → 才 `shift()` 出队。任一步失败都不出队，避免丢消息。
3. **`sendCancellationToken`**：用户干预（清空队列、切 merge）时自增，令进行中的异步发送作废。
4. **草稿保护**：发送前存下 composer 里用户正在打的字，发出后按
   `draftRestoreRetryDelays = [0,40,120,...,3200]` 阶梯重试恢复，对抗 ChatGPT 的异步清空。
5. **`isInteracting()` 闸门**：拖拽中或行内编辑中一律不发送、不重渲染，避免操作被打断。

## 目标拆解

### 1. 工程化（单文件 → 模块化 + 构建产物）

- `src/` 按 `core` / `ui` / `platform` / `i18n` 分层，构建脚本拼接为单文件 `dist/*.user.js`。
- 构建产物**进版本控制**（用户脚本需可直接安装，`.gitignore` 不忽略 `dist/`）。
- 零运行时依赖，保持 `@grant none`。

### 2. 选择器适配层（`src/platform/selectors.js`）

上游硬编码 `.wcDTda_prosemirror-parent` 这类 CSS-Modules 哈希类名，OpenAI 一改版即全线失效。
改为多级 fallback 链，逐级降级，全部失效时上报一次可见告警而非静默死掉。

### 3. 修复：新会话入队丢失（上游已知问题 2）

根因：`/` 首页无 conversation id，`computeConversationKey()` 返回 `null`，队列只存在内存
`transientQueue`；ChatGPT 建会话后重建 UI，脚本实例状态被丢弃。

方案：无 id 期间把队列落到 `sessionStorage` 的 pending 槽位，会话 id 出现后迁移到正式
`localStorage` 键并清除 pending 槽位。

### 4. 发送失败可见反馈

上游发送失败静默 `return false`，用户不知道队列卡住。改为失败计数达阈值后在队列面板顶部
显示可关闭的提示条，说明可能原因（DOM 改版 / 被限流）。

### 5. 双语 i18n

`src/i18n/` 提供 `zh-CN` / `en`，默认跟随 `navigator.language`，可在面板内手动切换并持久化。
面向 Greasy Fork 受众，英文必须是完整一等公民。

## 验收标准

- `npm run check` 通过（构建 + `node --check` 语法校验）。
- `dist/chatgpt-message-queue.user.js` 可直接被 Tampermonkey 安装。
- 浏览器实测（由用户执行）：流式输出中 Enter 入队、恢复后自动发送、拖拽排序、行内编辑、
  合并开关、清空队列、刷新后队列仍在、新会话首次入队不丢、中英切换生效。

## 不在本阶段范围

- 附件/图片入队（上游已知问题 1）→ M3
- 事件驱动取代 1200ms 轮询 → M2
- 队列导入导出、全局设置 → M2
