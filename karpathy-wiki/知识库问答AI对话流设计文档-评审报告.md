# 概要设计 / 详细设计 / 实施计划 — 评审报告

| 字段 | 值 |
| --- | --- |
| 评审对象 | 概要设计说明书 V1.0.0 + 详细设计说明书 V1.0.0 + 实施计划 V1.0.0 |
| 评审依据 | SRS v1.1.0 + V1.3 概要设计 + 现有实现（v1） |
| 评审日期 | 2026-07-11 |
| 评审人 | AI 评审助手 |
| 评审范围 | 文档一致性 / 设计完整性 / 可实施性 / 接口契约 / 风险覆盖 |

---

## 1. 评审结论概览

| 文档 | 评分 | 说明 |
| --- | --- | --- |
| 概要设计说明书 | ✅ 优 | 总体架构清晰，模块划分完整，继承 v1 三项核心机制 |
| 详细设计说明书 | ⚠️ 良 | 组件实现详细，但存在 3 处接口不一致 |
| 实施计划 | ⚠️ 良 | 阶段划分合理，但任务依赖与验证有 2 处遗漏 |

**总体结论**：三份文档作为 v2 实施基线**基本可用**，存在 **2 项 P0 阻塞问题** + **4 项 P1 重要问题**，需修正后交付。

---

## 2. 问题清单

### 2.1 P0 阻塞问题

#### P0-1：详细设计 §3.3 useModelStore.switchModel 未调用后端 updateConfig

**位置**：详细设计 §3.3 useModelStore

**问题描述**：
详细设计 §3.3 的 `switchModel` 实现：
```typescript
async function switchModel(key: string) {
  currentModel.value = key;
  localStorage.setItem('selectedModel', key);
  // 模型切换在下一次 /api/query 请求时生效（请求体携带 model 字段）
}
```

但概要设计 §2.3.3 与 SRS §6.0.3 明确说"调用 `engineAdapter.updateConfig({ model })` 即时生效"。

**矛盾**：详细设计改为"下一次请求时生效"，与概要设计的"即时生效"不一致。

**修复建议**：
- 方案 A（推荐）：在 `switchModel` 中增加 `await fetch('/api/ai/config', { method: 'PUT', body: { model: key } })` 调用后端即时生效
- 方案 B：保持详细设计方案，但修正概要设计 §2.3.3 和 SRS §6.0.3 的描述为"下一次请求时生效"

#### P0-2：详细设计 §5.1 routes/query.ts 调用 `engineAdapter` 未导入

**位置**：详细设计 §5.1

**问题描述**：
```typescript
// 详细设计 §5.1
if (model && model !== config.llm.model) {
  engineAdapter.updateConfig({ model });  // ← engineAdapter 未导入
}
```

`engineAdapter` 变量在代码片段中未声明，实际实现中需要从模块导入或通过依赖注入获取。

**修复建议**：补充 `engineAdapter` 的导入或获取方式：
```typescript
import { engineAdapter } from '../engine/harness-adapter';
// 或
import { getEngineAdapter } from '../engine';
const adapter = getEngineAdapter();
```

---

### 2.2 P1 重要问题

#### P1-1：概要设计 §4.2 `/api/query` 请求体与详细设计不一致

**位置**：概要设计 §4.2 vs 详细设计 §5.1

**问题描述**：
- 概要设计 §4.2 定义请求体含 `attachments?: string[]`
- 详细设计 §5.1 的 `QueryRequest` 接口也含 `attachments?: string[]`
- 但详细设计 §2.1.3 的 `sendQuestion` 函数中 `body` 却使用 `attachments: pendingAttachments.value` 而非 `attachmentsStore.flush()`

**修复建议**：统一为 `attachmentsStore.flush()` 返回值：
```typescript
attachments: pendingAttachments.value.length > 0 ? attachmentsStore.flush() : undefined,
```

#### P1-2：实施计划 S4 阶段依赖 S2，但 S4-T5 useModelStore 依赖后端 API

**位置**：实施计划 §6.1 S4-T5

**问题描述**：
S4-T5 `useModelStore` 调用 `GET /api/ai/presets`（v1 已有），但 `switchModel` 需要调用后端 `updateConfig`（P0-1 修复后），这依赖 S2 阶段的后端改造。

实施计划 §6 标注 S4 依赖 "S2 + S3"，但 S4-T5 的具体任务描述未说明依赖 S2 的哪个任务。

**修复建议**：在 S4-T5 任务描述中补充"依赖 S2-T4（query 路由扩展，支持 model 字段）"。

#### P1-3：详细设计未覆盖 SSE 中断重连机制

**位置**：详细设计 §9.1

**问题描述**：
详细设计 §9.1 错误处理表提到"SSE 连接中断 → 保留已接收答案 + 重试按钮"，但未给出实现细节。

SRS §9.1 风险 R7 要求"前端监听 `EventSource.onerror`，提供重试按钮"。

**修复建议**：补充 SSE 中断处理实现：
```typescript
// 在 useSSEStream.ts 中
function handleStreamError(error: Error) {
  // 保留已接收的流式答案到 store
  if (queryStore.streamingAnswer) {
    queryStore.finalizeAnswer();  // 保留部分答案
  }
  queryStore.errorMessage = '连接中断，请重试';
  // 提供重试按钮（在 Query.vue 中根据 errorMessage 显示）
}
```

#### P1-4：实施计划缺少 DELIVERY.md 更新的具体内容指引

**位置**：实施计划 §8.1 S6-T7

**问题描述**：
S6-T7 仅说"更新 DELIVERY.md，追加 §15 交付清单"，但未说明交付清单应包含哪些内容。

**修复建议**：补充 S6-T7 的交付清单内容指引：
- 新增文件清单（11 个组件 + 5 个 store + 3 个 composable + 2 个后端模块）
- 改造文件清单
- 验证结果（tsc/vue-tsc/编码/E2E/构建）
- 已知问题与后续优化项

---

### 2.3 P2 轻微问题

#### P2-1：概要设计 §3.1 组件清单缺少 MessageItem

**位置**：概要设计 §3.1

**问题描述**：
详细设计 §2.1.2 模板中使用了 `<MessageItem>` 组件，但概要设计 §3.1 模块清单未列出。

**修复建议**：在概要设计 §3.1 补充 `MessageItem.vue`（单条消息渲染容器，内部组合 MarkdownRenderer/ThinkingBlock/RefsList 等）。

#### P2-2：详细设计 §3.2 useConversationsStore 缺少 loadMessages 方法

**位置**：详细设计 §3.2

**问题描述**：
详细设计 §3.1 useQueryStore 有 `loadMessages(msgs)` 方法，但 useConversationsStore 的 `selectConversation` 只设置 `currentConversationId`，未调用 `loadMessages` 加载会话消息到 query store。

**修复建议**：在 `selectConversation` 中补充加载逻辑：
```typescript
async function selectConversation(id: string) {
  currentConversationId.value = id;
  const record = await db.get(STORE_NAME, id);
  if (record) {
    useQueryStore().loadMessages(record.messages);
  }
}
```

#### P2-3：实施计划未提及 usePersistentState 的改造

**位置**：实施计划 §5.1

**问题描述**：
详细设计 §2.1.3 使用了 `usePersistentState('sidebar-collapsed', false)`，v1 已有此 composable，但实施计划 S3-T8 列出的是 `useSSEStream` 改造，未提到 `usePersistentState` 是否需要改造以支持新的 key。

**修复建议**：确认 usePersistentState 无需改造（通用 composable），在实施计划中说明"沿用 v1 实现"。

#### P2-4：详细设计 §2.10 MarkdownRenderer 图片点击放大未实现

**位置**：详细设计 §2.10

**问题描述**：
详细设计 §2.10 自定义图片渲染中 `onclick` 触发自定义事件，但未说明事件监听与 el-image 预览的集成方式。

**修复建议**：补充图片点击放大实现：
```typescript
// MarkdownRenderer.vue
onMounted(() => {
  el.value?.addEventListener('image-click', (e: CustomEvent) => {
    // 使用 Element Plus ElImage 的 preview 功能
    previewSrc.value = e.detail.src;
    previewVisible.value = true;
  });
});
```

---

## 3. 各文档详细评审

### 3.1 概要设计评审

| 维度 | 评分 | 说明 |
| --- | --- | --- |
| 总体架构 | ✅ 优 | 架构图清晰，前后端分层明确 |
| v1 架构继承 | ✅ 优 | 降级链/per-session Lock/EngineAdapter 完整继承 |
| 模块划分 | ⚠️ 良 | 缺少 MessageItem 组件（P2-1） |
| 接口设计 | ✅ 优 | SSE 事件协议完整 |
| 数据设计 | ✅ 优 | IndexedDB schema + 迁移策略清晰 |
| 前端设计 | ✅ 优 | 组件树 + store 边界图清晰 |
| 后端设计 | ✅ 优 | 模块职责明确 |
| 安全设计 | ✅ 优 | XSS/API Key/图片/URL 全覆盖 |
| 部署设计 | ✅ 优 | 依赖 + 构建 + 门禁完整 |
| SRS 追溯 | ✅ 优 | 13 项功能全覆盖 |

### 3.2 详细设计评审

| 维度 | 评分 | 说明 |
| --- | --- | --- |
| 组件实现 | ✅ 优 | 11 个组件 + 模板 + 逻辑 + 样式 |
| Store 实现 | ⚠️ 良 | useModelStore 与概要设计不一致（P0-1） |
| Composable 实现 | ✅ 优 | useTTS/useClipboard/useImageCompress 详细 |
| 后端实现 | ⚠️ 良 | engineAdapter 未导入（P0-2） |
| 数据持久化 | ✅ 优 | 迁移函数详细 |
| SSE 事件流 | ✅ 优 | 完整事件序列图 |
| 错误处理 | ⚠️ 良 | SSE 中断重连未详细（P1-3） |
| 样式设计 | ✅ 优 | CSS 变量 + 响应式断点 |

### 3.3 实施计划评审

| 维度 | 评分 | 说明 |
| --- | --- | --- |
| 阶段划分 | ✅ 优 | 6 阶段自底向上，依赖明确 |
| 任务拆解 | ✅ 优 | 30+ 任务，每任务含文件与说明 |
| 验证策略 | ✅ 优 | 每阶段验证清单 + 命令 |
| 风险控制 | ✅ 优 | 5 项风险 + 回滚策略 + 门禁 |
| 依赖关系 | ⚠️ 良 | S4-T5 依赖未详细（P1-2） |
| 交付指引 | ⚠️ 良 | DELIVERY.md 内容未指引（P1-4） |
| 命令适配 | ✅ 优 | PowerShell 分号分隔，无 && |

### 3.4 三份文档一致性

| 检查项 | 概要 ↔ 详细 | 概要 ↔ 实施 | 详细 ↔ 实施 |
| --- | --- | --- | --- |
| 模块清单 | ⚠️ 缺 MessageItem | ✅ 一致 | ✅ 一致 |
| 接口契约 | ✅ 一致 | ✅ 一致 | ✅ 一致 |
| 模型切换 | ❌ 即时 vs 请求时 | ✅ 一致 | ⚠️ 依赖未详 |
| 错误处理 | ⚠️ SSE 重连未详 | ✅ 一致 | ✅ 一致 |

---

## 4. 优秀设计点

1. **概要设计 §2.3 架构继承**：完整继承 v1 三项核心机制，v2 扩展点清晰
2. **详细设计 §3.2 IndexedDB 实现**：完整 idb 封装 + 迁移函数 + v1→v2 数据升级
3. **详细设计 §4.1 useTTS**：stripMarkdown 函数覆盖全面，中英文 voice 选择逻辑清晰
4. **详细设计 §7 SSE 事件序列图**：正常/降级/错误三场景完整
5. **实施计划 §2.2 里程碑**：M1~M5 交付物与验证标准对应
6. **实施计划 §9 验证策略**：PowerShell 命令适配 + 编码门禁三层防御

---

## 5. 修复优先级与建议

| 优先级 | 问题 | 修复工作量 | 建议时机 |
| --- | --- | --- | --- |
| P0-1 | useModelStore 与概要设计不一致 | 0.5 天 | 交付前 |
| P0-2 | engineAdapter 未导入 | 0.25 天 | 交付前 |
| P1-1 | 请求体 attachments 不一致 | 0.25 天 | 交付前 |
| P1-2 | S4-T5 依赖未详细 | 0.25 天 | 交付前 |
| P1-3 | SSE 中断重连未详细 | 0.5 天 | 交付前 |
| P1-4 | DELIVERY.md 内容指引 | 0.25 天 | 交付前 |
| P2-1~P2-4 | 轻微问题 | 0.5 天 | 交付前 |

**总修复工作量**：约 2.5 天。

---

## 6. 评审结论

三份文档作为 v2 实施基线**基本可用**，设计完整、结构清晰、可实施性强。存在 2 项 P0 阻塞问题（useModelStore 不一致 + engineAdapter 未导入）和 4 项 P1 重要问题需修正。

**建议**：修正 P0 + P1 后交付，P2 问题在实施过程中修正。
