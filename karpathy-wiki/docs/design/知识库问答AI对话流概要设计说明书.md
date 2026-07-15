# 知识库问答 AI 对话流 — 概要设计说明书

| 字段 | 值 |
| --- | --- |
| 文档版本 | V1.0.1 |
| 编写日期 | 2026-07-11 |
| 修订日期 | 2026-07-11 |
| 编写人 | wiki-code-dev |
| 适用项目 | Karpathy AI + Obsidian 知识库（karpathy-wiki） |
| 需求基准 | 《知识库问答AI对话流需求规格说明书》v1.1.0 |
| 设计基线 | 《Karpathy-AI+Obsidian 知识库概要设计说明书》V1.3 |
| 上一版本交付 | DELIVERY.md §14：Markdown 渲染 + 联想提问（v1 已完成） |
| 范围 | 知库问答（Query）页面 v2 升级的概要级设计 |
| 修订记录 | V1.0.1：按评审报告修正 P2-1（补充 MessageItem 组件） |

---

## 目录

1. [引言](#1-引言)
2. [总体设计](#2-总体设计)
3. [模块划分](#3-模块划分)
4. [接口设计](#4-接口设计)
5. [数据设计](#5-数据设计)
6. [前端设计](#6-前端设计)
7. [后端设计](#7-后端设计)
8. [安全设计](#8-安全设计)
9. [部署设计](#9-部署设计)
10. [附录](#10-附录)

---

## 1. 引言

### 1.1 编写目的

本文档对知识库问答 AI 对话流 v2 升级进行概要级设计，覆盖总体架构、模块划分、接口设计、数据设计、前后端设计、安全与部署设计，作为详细设计与编码实施的基准。

### 1.2 设计原则

1. **继承 v1 架构**：降级链、per-session Lock、EngineAdapter 三项核心机制必须继承，不重新设计
2. **本地优先**：历史对话、附件、偏好均本地存储，不上传后端
3. **可降级**：TTS/多模态/联网搜索不可用时静默降级，不阻断主流程
4. **渐进实施**：PPT/视频生成 v2 仅做 UI 标记，生成留 v3
5. **零业务耦合**：`@wiki/harness` 不包含知识库专用逻辑

### 1.3 术语

沿用 SRS v1.1.0 术语表，关键术语：SSE、TTS、多模态、工具栏、思考动画、降级链、per-session Lock、EngineAdapter。

### 1.4 参考资料

- SRS v1.1.0（唯一需求基准）
- 《概要设计说明书》V1.3（现有系统设计基线）
- DELIVERY.md §14（v1 交付清单）

### 1.5 设计范围

| 范围内 | 范围外 |
| --- | --- |
| 前端 5 个新增 store + 重构 Query.vue | 移动端深度适配 |
| 后端 SSE 事件扩展 + web_search 工具 | 视频生成 / PPT 生成实施 |
| IndexedDB 本地存储方案 | 对话数据云同步 |
| TTS / 多模态 / 联网搜索 | 协同 / 多用户共享 |

---

## 2. 总体设计

### 2.1 设计目标

| 目标 | 对应 SRS |
| --- | --- |
| 对标豆包 / Trae Work 的 AI 对话流体验 | F-3.1 ~ F-3.13 |
| 继承 v1 降级链 + per-session Lock | §6.0 |
| 纯前端本地持久化 | F-3.3 + P2 本地优先 |
| 可降级的多模态 / TTS / 联网搜索 | P3 可降级 |

### 2.2 总体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Web 前端（Vue 3）                               │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Query.vue（主视图）                                              │   │
│  │  ┌──────────┐  ┌────────────────────────────────────────────┐    │   │
│  │  │ 侧栏     │  │ 消息区 + 工具栏 + 输入区                    │    │   │
│  │  │ 历史对话  │  │ ┌──────────────────────────────────────┐  │    │   │
│  │  │ 模型选择  │  │ │ MarkdownRenderer + ThinkingBlock    │  │    │   │
│  │  │ 折叠     │  │ │ + RefsList + FollowupsChips          │  │    │   │
│  │  └──────────┘  │ └──────────────────────────────────────┘  │    │   │
│  │                └────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Pinia Stores                                                     │   │
│  │  useQueryStore | useConversationsStore | useModelStore            │   │
│  │  useTtsStore | useAttachmentsStore                                 │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Composables                                                      │   │
│  │  useTTS | useIndexedDB | useClipboard | useImageCompress          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  IndexedDB（本地持久化）                                           │   │
│  │  conversations | attachments | preferences                        │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ REST + SSE
┌──────────────────────────────▼──────────────────────────────────────────┐
│                    桥接 API 层（Fastify）                                │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  routes/query.ts（SSE 推送）                                      │   │
│  │  routes/ai.ts（presets / test-connection）                        │   │
│  │  routes/search.ts（web search 直接调用）                          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  EngineAdapter 接口（v1 已有）                                     │   │
│  │  HarnessAdapter（默认实现）                                        │   │
│  │  updateConfig({ model }) 即时生效                                  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────────┐
│                    @wiki/harness（ReAct 循环）                           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  工具：search_pages | read_page | web_search（新）                │   │
│  │  降级链：queryWithHarness → queryWithSearchFallback → 兜底         │   │
│  │  per-session Lock（question 前 32 字符 key）                       │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ 读写
┌──────────────────────────────▼──────────────────────────────────────────┐
│                    Vault（本地 Markdown 文件）                            │
│                    vault/queries/attachments/（新，图片附件）             │
└─────────────────────────────────────────────────────────────────────────┘
                               │
                    外部 API（LLM / Tavily / Bing）
```

### 2.3 架构继承（v1 基线）

v2 完整继承 v1 的三项核心架构机制（详见 SRS §6.0）：

#### 2.3.1 降级链

```
queryWithHarness（首选，走 @wiki/harness ReAct 循环）
  ↓ 失败
queryWithSearchFallback（降级，直接调用 search_pages + LLM 单轮）
  ↓ 失败
兜底提示（返回友好错误）
```

v2 扩展点：
- `thinking` 事件在降级链各阶段均推送
- `web_search` / `image` / `progress` 事件仅在 `queryWithHarness` 阶段推送

#### 2.3.2 per-session Lock

按 question 前 32 字符做 key 串行化，v2 不改变 Lock 粒度。

#### 2.3.3 EngineAdapter 接口

`updateConfig({ model })` 即时生效，v2 模型切换直接调用此方法。

### 2.4 技术选型

| 层 | 技术 | 版本 | 说明 |
| --- | --- | --- | --- |
| 前端框架 | Vue 3 | ^3.4 | Composition API + setup 语法 |
| UI 库 | Element Plus | ^2.7 | 已有 |
| 状态管理 | Pinia | ^2.1 | 已有 |
| Markdown 渲染 | markdown-it | ^14.1 | v1 已引入 |
| 本地存储 | idb | ^8.0 | IndexedDB wrapper，新引入 |
| 工具集 | @vueuse/core | ^10.0 | useStorage 等，新引入 |
| TTS | Web Speech API | 浏览器原生 | 零依赖 |
| 后端框架 | Fastify | ^4.26 | 已有 |
| 后端语言 | TypeScript | ^5.4 | strict 模式 |
| AI 引擎 | @wiki/harness | workspace | 已有 |
| 联网搜索 | Tavily / Bing API | - | 外部 API |

---

## 3. 模块划分

### 3.1 前端模块

| 模块 | 职责 | 对应 SRS | 新增/改造 |
| --- | --- | --- | --- |
| `Query.vue` | 问答主视图，集成所有功能 | F-3.1~F-3.13 | 改造 |
| `MessageItem.vue` | 单条消息渲染容器，内部组合 MarkdownRenderer/ThinkingBlock/RefsList 等 | F-3.2 + F-3.7 + F-3.13 | 新增 |
| `MarkdownRenderer.vue` | Markdown 流式渲染 | F-3.2 | 改造（v1 已有） |
| `ThinkingBlock.vue` | 思考动画折叠块 | F-3.1 | 新增 |
| `ConversationSidebar.vue` | 历史对话侧栏 | F-3.3 + F-3.11 | 新增 |
| `InputToolbar.vue` | 输入工具栏 | F-3.4 | 新增 |
| `MessageActions.vue` | 消息操作浮窗 | F-3.7 + F-3.13 | 新增 |
| `RefsList.vue` | 参考文章列表 | F-3.8 | 新增 |
| `FollowupsChips.vue` | 联想提问 chips | F-3.12 | 改造（v1 已有） |
| `ModelSelector.vue` | 模型选择器 | F-3.9 | 新增 |
| `AttachmentUploader.vue` | 图片上传 | F-3.5 | 新增 |
| `TtsController.vue` | 语音朗读控制 | F-3.6 | 新增 |

### 3.2 前端 Store 模块

| Store | 职责 | 对应 SRS | 新增/改造 |
| --- | --- | --- | --- |
| `useQueryStore` | 会话内状态（消息/流式缓冲/思考/引用/联想） | F-3.1~F-3.2 | 改造（v1 已有） |
| `useConversationsStore` | 历史对话列表 + CRUD + IndexedDB | F-3.3 | 新增 |
| `useModelStore` | 模型预设 + 切换 | F-3.9 | 新增 |
| `useTtsStore` | 朗读状态 + 当前消息 | F-3.6 | 新增 |
| `useAttachmentsStore` | 图片附件 + 压缩 + blob 存储 | F-3.5 | 新增 |

### 3.3 前端 Composables

| Composable | 职责 | 对应 SRS | 新增/改造 |
| --- | --- | --- | --- |
| `useSSEStream` | SSE 流式读取 | F-3.2 | 改造（v1 已有） |
| `useTTS` | Web Speech API 封装 | F-3.6 | 新增 |
| `useClipboard` | 剪贴板复制 | F-3.7 | 新增 |
| `useImageCompress` | canvas 图片压缩 | F-3.5 | 新增 |
| `usePersistentState` | localStorage 持久化 | F-3.11 | 改造（v1 已有） |
| `useAutoRefresh` | 自动刷新 | - | 已有 |

### 3.4 后端模块

| 模块 | 职责 | 对应 SRS | 新增/改造 |
| --- | --- | --- | --- |
| `routes/query.ts` | SSE 推送（扩展 thinking/image/progress） | F-3.1~F-3.2 | 改造 |
| `routes/ai.ts` | 预设列表 + 连通性测试 | F-3.9 | 已有 |
| `routes/search.ts` | 联网搜索直接调用 | F-3.10 | 新增 |
| `workflows/query-workflow.ts` | 降级链 + thinking 推送 | F-3.1 | 改造 |
| `tools/web-search.ts` | Tavily/Bing 搜索工具 | F-3.10 | 新增 |
| `engine/harness-adapter.ts` | EngineAdapter 实现 | - | 已有 |

### 3.5 数据层模块

| 模块 | 职责 | 对应 SRS | 新增/改造 |
| --- | --- | --- | --- |
| IndexedDB `conversations` store | 历史对话结构化存储 | F-3.3 | 新增 |
| IndexedDB `attachments` store | 图片 blob 存储 | F-3.5 | 新增 |
| localStorage 轻量索引 | 侧栏列表 + 偏好 | F-3.3 + F-3.11 | 新增 |
| `config.json` 扩展 | presets + webSearch + attachments | F-3.9 + F-3.10 + F-3.5 | 改造 |

---

## 4. 接口设计

### 4.1 SSE 事件协议（扩展）

v2 在 v1 基础上扩展事件类型，完整协议如下：

| 事件 | 触发时机 | payload | v1 已有 |
| --- | --- | --- | --- |
| `thinking` | 工具调用 / 思考阶段 | `{ phase: 'thinking'\|'tool_call'\|'composing', message: string, tool?: string, args?: Record<string, unknown> }` | ❌ |
| `answer` | 流式答案 | `{ text: string }` | ✅ |
| `image` | 答案中嵌入图片 | `{ url: string, alt: string, width?: number, height?: number }` | ❌ |
| `refs` | 引用页面/文章 | `{ refs: Reference[] }` | ✅（类型升级） |
| `followups` | 联想提问 | `{ followups: string[] }` | ✅ |
| `progress` | 联网搜索进度 | `{ step: 'searching'\|'fetching'\|'done', count?: number }` | ❌ |
| `done` | 流式结束 | `{ sessionId: string, messageIndex: number, followups?: string[] }` | ✅ |
| `error` | 降级失败 | `{ message: string, code?: string }` | ✅ |

**事件推送顺序**：
```
thinking* (多次) → answer* (多次流式) → refs → progress? → followups → done
                                            ↓ 失败
                                          error
```

### 4.2 REST API

| API | 方法 | 请求 | 响应 | 说明 |
| --- | --- | --- | --- | --- |
| `/api/query` | POST | `{ question: string, history: ChatMessage[], model?: string, mode?: string, webSearch?: boolean, attachments?: string[] }` | SSE 流 | 扩展请求体 |
| `/api/query/archive` | POST | `{ sessionId: string, messageIndex: number }` | `{ ok: boolean, path: string }` | v1 已有 |
| `/api/ai/presets` | GET | - | `LlmPreset[]` | v1 已有 |
| `/api/ai/test-connection` | POST | `{ provider, baseUrl, model, apiKey }` | `AiTestResult` | v1 已有 |
| `/api/search/web` | POST | `{ query: string, limit?: number }` | `{ results: SearchResult[] }` | 新增 |

### 4.3 Reference 数据结构

```typescript
interface Reference {
  url?: string;            // 联网搜索时的来源 URL
  title: string;           // 页面标题或文章标题
  path?: string;           // 知识库页面路径
  snippet: string;         // 摘要
  source: 'vault' | 'web'; // 来源类型
  citeIndex: number;       // [1][2][3] 引用编号
}
```

### 4.4 web_search 工具接口

```typescript
interface WebSearchTool {
  name: 'web_search';
  description: '搜索互联网实时信息。返回摘要 + URL。';
  parameters: {
    type: 'object';
    properties: { query: { type: 'string' } };
    required: ['query'];
  };
  handler: (args: { query: string; limit?: number }) => Promise<SearchResult[]>;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
```

---

## 5. 数据设计

### 5.1 IndexedDB Schema

```
Database: karpathy-wiki-chat
Version: 2

Object Stores:
├── conversations (keyPath: id)
│   └── 索引: updatedAt, isPinned
├── attachments (keyPath: id)
│   └── 索引: conversationId
└── preferences (keyPath: key)
    └── 侧栏状态、模型偏好等
```

### 5.2 数据模型

#### 5.2.1 ConversationRecord

```typescript
interface ConversationRecord {
  id: string;              // sessionId
  title: string;           // 首个问题前 30 字
  createdAt: string;       // ISO 8601
  updatedAt: string;
  messageCount: number;
  isPinned: boolean;
  preview: string;         // 末条 assistant 回答前 60 字
  messages: ChatMessage[];
}
```

#### 5.2.2 ChatMessage（v2，向后兼容 v1）

```typescript
interface ChatMessage {
  id: string;               // v2 新增
  role: 'user' | 'assistant';
  content: string;
  refs?: Reference[];       // v2 升级（v1 为 string[]）
  followups?: string[];    // v1 已有
  thinking?: ThinkingStep[];   // v2 新增
  attachments?: string[];   // v2 新增
  feedback?: 'up' | 'down' | null;  // v2 新增
  createdAt: string;        // v2 新增
  // v1 保留字段（归档依赖）
  sessionId?: string;
  messageIndex?: number;
  archived?: boolean;
}
```

#### 5.2.3 Attachment

```typescript
interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  blob: Blob;               // 原图
  thumbnail: Blob;          // 缩略图
}
```

### 5.3 v1 → v2 数据迁移

应用启动时检测 IndexedDB schema 版本，若为 v1 则批量执行 `migrateV1Message`：
- `refs: string[]` → `Reference[]`（path = 原字符串，source = 'vault'）
- 补充 `id`、`createdAt` 字段
- 保留 `sessionId/messageIndex/archived`

### 5.4 配置文件扩展

```json
{
  "llm": {
    "presets": [
      { "key": "deepseek-v3", "provider": "deepseek", "baseUrl": "...", "model": "deepseek-chat", "apiKeyRef": "DEEPSEEK_API_KEY" },
      { "key": "glm-4.6", "provider": "glm", "baseUrl": "...", "model": "glm-4.6", "apiKeyRef": "GLM_API_KEY" }
    ],
    "selected": "deepseek-v3"
  },
  "webSearch": {
    "provider": "tavily",
    "apiKeyRef": "TAVILY_API_KEY",
    "maxResults": 5
  },
  "attachments": {
    "maxSizeMB": 10,
    "compressToMB": 2
  }
}
```

---

## 6. 前端设计

### 6.1 组件树

```
App.vue
└── Query.vue（主视图）
    ├── ConversationSidebar.vue（左侧栏，可折叠）
    │   ├── 新建对话按钮
    │   ├── 搜索框
    │   ├── 历史对话列表
    │   └── 折叠按钮
    ├── 主区域
    │   ├── 会话头（标题 + 操作按钮）
    │   ├── 消息区
    │   │   └── MessageItem（每条消息）
    │   │       ├── RobotAvatar / UserAvatar
    │   │       ├── MarkdownRenderer.vue（assistant）
    │   │       ├── ThinkingBlock.vue（assistant，可折叠）
    │   │       ├── RefsList.vue（assistant）
    │   │       ├── FollowupsChips.vue（assistant）
    │   │       └── MessageActions.vue（hover 浮窗）
    │   ├── InputToolbar.vue（工具栏）
    │   └── InputArea（输入框 + 附件 + 发送）
    └── ModelSelector.vue（顶部模型选择器）
```

### 6.2 状态管理

#### 6.2.1 useQueryStore（改造）

```typescript
// v1 已有 + v2 扩展
const messages = ref<ChatMessage[]>([]);
const streamingAnswer = ref<string>('');
const currentRefs = ref<Reference[]>([]);      // v2: string[] → Reference[]
const currentFollowups = ref<string[]>([]);
const currentThinking = ref<ThinkingStep[]>([]);  // v2 新增
const isLoading = ref(false);
const errorMessage = ref('');

// v2 新增 actions
function appendThinking(step: ThinkingStep) { /* ... */ }
function clearThinking() { /* ... */ }
```

#### 6.2.2 useConversationsStore（新增）

```typescript
const conversations = ref<ConversationRecord[]>([]);
const currentConversationId = ref<string | null>(null);
const searchKeyword = ref('');

async function loadConversations() { /* 从 IndexedDB 读取 */ }
async function persistConversation(messages: ChatMessage[]) { /* 写入 IndexedDB */ }
async function deleteConversation(id: string) { /* ... */ }
async function renameConversation(id: string, title: string) { /* ... */ }
async function togglePin(id: string) { /* ... */ }
function selectConversation(id: string) { /* 切换当前会话，load messages 到 query store */ }
```

#### 6.2.3 useModelStore（新增）

```typescript
const currentModel = ref<string>('');
const presets = ref<LlmPreset[]>([]);

async function loadPresets() { /* GET /api/ai/presets */ }
async function switchModel(key: string) {
  // 检查 useQueryStore.isLoading，若 loading 则等待
  // 调用后端 updateConfig（通过下一轮 SSE 请求体传递）
  // 写 localStorage
}
```

#### 6.2.4 useTtsStore（新增）

```typescript
const state = ref<'idle' | 'playing' | 'paused'>('idle');
const currentMsgId = ref<string | null>(null);

function speak(text: string, msgId: string) { /* ... */ }
function pause() { /* ... */ }
function resume() { /* ... */ }
function stop() { /* ... */ }
```

#### 6.2.5 useAttachmentsStore（新增）

```typescript
const attachments = ref<Map<string, Attachment>>(new Map());

async function addImage(file: File): Promise<string> {
  // 1. 校验 MIME + 大小
  // 2. canvas 压缩到 ≤ 2MB
  // 3. 生成缩略图（200x200）
  // 4. blob 存 IndexedDB
  // 5. 返回 attachment id
}
function getThumbnail(id: string): Blob | null { /* ... */ }
```

### 6.3 Composables

#### 6.3.1 useTTS

```typescript
export function useTTS() {
  const utterance = ref<SpeechSynthesisUtterance | null>(null);
  const state = ref<'idle' | 'playing' | 'paused'>('idle');

  function speak(text: string, lang = 'zh-CN') {
    // 1. 剥离 Markdown 语法
    const cleanText = stripMarkdown(text);
    // 2. 创建 utterance
    utterance.value = new SpeechSynthesisUtterance(cleanText);
    utterance.value.lang = lang;
    // 3. 监听事件
    utterance.value.onend = () => { state.value = 'idle'; };
    // 4. 启动
    speechSynthesis.speak(utterance.value);
    state.value = 'playing';
  }

  function pause() { speechSynthesis.pause(); state.value = 'paused'; }
  function resume() { speechSynthesis.resume(); state.value = 'playing'; }
  function stop() { speechSynthesis.cancel(); state.value = 'idle'; }

  return { state, speak, pause, resume, stop };
}
```

#### 6.3.2 useClipboard

```typescript
export function useClipboard() {
  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 降级：document.execCommand('copy')
      return fallbackCopy(text);
    }
  }
  function copyPlainText(md: string): string {
    return stripMarkdown(md);
  }
  return { copy, copyPlainText };
}
```

#### 6.3.3 useImageCompress

```typescript
export function useImageCompress() {
  async function compress(file: File, maxSizeMB = 2): Promise<Blob> {
    // 1. 创建 Image 对象
    // 2. canvas 缩放
    // 3. toBlob 输出 jpeg/webp
  }
  async function generateThumbnail(blob: Blob, size = 200): Promise<Blob> {
    // canvas 缩放到 200x200
  }
  return { compress, generateThumbnail };
}
```

### 6.4 SSE 事件处理扩展

```typescript
function handleSSEEvent(eventType: string, data: string) {
  const parsed = JSON.parse(data);
  switch (eventType) {
    case 'thinking':
      store.appendThinking({
        phase: parsed.phase,
        message: parsed.message,
        tool: parsed.tool,
        args: parsed.args,
        ts: new Date().toISOString(),
      });
      break;
    case 'answer':
      store.appendAnswer(parsed.text || '');
      break;
    case 'image':
      // 插入图片到流式答案
      store.appendAnswer(`\n\n![${parsed.alt}](${parsed.url})\n\n`);
      break;
    case 'refs':
      store.setRefs(parsed.refs || []);
      break;
    case 'progress':
      // 更新联网搜索进度
      store.setProgress(parsed.step, parsed.count);
      break;
    case 'followups':
      store.setFollowups(parsed.followups || []);
      break;
    case 'done':
      store.finalizeAnswer(parsed.sessionId, parsed.messageIndex, parsed.followups);
      break;
    case 'error':
      store.handleError(parsed.message || '问答出错');
      break;
  }
}
```

---

## 7. 后端设计

### 7.1 routes/query.ts 扩展

```typescript
// 扩展请求体
interface QueryRequest {
  question: string;
  history: ChatMessage[];
  model?: string;           // v2 新增
  mode?: string;            // v2 新增
  webSearch?: boolean;      // v2 新增
  attachments?: string[];   // v2 新增
}

// SSE 推送扩展
function sendThinking(reply, phase, message, tool?) {
  reply.raw.write(`event: thinking\ndata: ${JSON.stringify({ phase, message, tool })}\n\n`);
}

function sendImage(reply, url, alt, width?, height?) {
  reply.raw.write(`event: image\ndata: ${JSON.stringify({ url, alt, width, height })}\n\n`);
}

function sendProgress(reply, step, count?) {
  reply.raw.write(`event: progress\ndata: ${JSON.stringify({ step, count })}\n\n`);
}
```

### 7.2 workflows/query-workflow.ts 扩展

```typescript
async function queryWithHarness(question, history, options) {
  // 1. 推送 thinking: 'thinking'
  sendThinking('thinking', '正在思考...');
  
  // 2. 注入 web_search 工具（若 options.webSearch）
  const tools = [searchPages, readPage];
  if (options.webSearch) {
    tools.push(createWebSearchTool(config.webSearch));
  }
  
  // 3. ReAct 循环
  for (const step of harness.run(question, history, tools)) {
    if (step.type === 'tool_call') {
      sendThinking('tool_call', `正在调用：${step.tool}`, step.tool, step.args);
    }
    if (step.type === 'answer_chunk') {
      sendAnswer(step.text);
    }
  }
  
  // 4. 推送 refs + followups + done
}
```

### 7.3 tools/web-search.ts

```typescript
export function createWebSearchTool(config: { provider: 'tavily' | 'bing'; apiKey: string }) {
  return {
    name: 'web_search',
    description: '搜索互联网实时信息。返回摘要 + URL。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    handler: async (args: { query: string; limit?: number }) => {
      if (config.provider === 'tavily') {
        return await tavilySearch(config.apiKey, args.query, args.limit || 5);
      }
      return await bingSearch(config.apiKey, args.query, args.limit || 5);
    },
  };
}

async function tavilySearch(apiKey: string, query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
  });
  const data = await res.json();
  return data.results.map(r => ({ title: r.title, url: r.url, snippet: r.content }));
}
```

### 7.4 routes/search.ts（新增）

```typescript
// POST /api/search/web
// 直接调用联网搜索（不经过 LLM）
fastify.post('/api/search/web', async (request, reply) => {
  const { query, limit } = request.body;
  const results = await createWebSearchTool(config.webSearch).handler({ query, limit });
  return { results };
});
```

---

## 8. 安全设计

### 8.1 XSS 防护

| 层 | 措施 |
| --- | --- |
| markdown-it | `html: false`（禁止源 HTML 直通） |
| 用户消息 | 保持纯文本，不渲染 Markdown |
| assistant 消息 | markdown-it 渲染，html 转义 |
| 图片 URL | 校验协议（仅 https / attachment://） |

### 8.2 API Key 安全

| Key | 存储 | 前端可见 |
| --- | --- | --- |
| LLM API Key | 后端 config.json + 环境变量 | ❌ 仅脱敏引用 |
| Tavily / Bing Key | 后端 config.json + 环境变量 | ❌ 仅脱敏引用 |
| 模型预设 | 后端返回 apiKeyRef（引用名），不返回实际 Key | ❌ |

### 8.3 图片上传安全

| 措施 | 说明 |
| --- | --- |
| MIME 校验 | 白名单：jpg/png/webp/gif |
| 文件头魔数 | 校验实际文件类型，防伪造 MIME |
| 大小限制 | ≤ 10MB（配置可调） |
| 压缩 | 前端压缩到 ≤ 2MB |
| 存储 | IndexedDB blob，不写入文件系统 |

### 8.4 外部 URL 安全

- 跳转加 `rel="noopener noreferrer"`
- 仅允许 https 协议

---

## 9. 部署设计

### 9.1 依赖新增

```json
// frontend/package.json 新增
{
  "dependencies": {
    "idb": "^8.0.0",
    "@vueuse/core": "^10.0.0"
  }
}
```

### 9.2 构建流程

```powershell
# 前端构建
Remove-Item -Recurse -Force "services\api\public" -ErrorAction SilentlyContinue
pnpm run build

# 后端无新增依赖
```

### 9.3 编码门禁

沿用 v1 编码门禁三层防御：
1. pre-commit hook（UTF-8 无 BOM 检查）
2. .gitattributes（charset=utf-8）
3. CI 门禁 + `scripts/check-encoding.js`

### 9.4 测试策略

| 类型 | 工具 | 覆盖范围 |
| --- | --- | --- |
| 单元测试 | vitest | store actions / composables |
| 类型检查 | tsc + vue-tsc | 0 error |
| 编码检查 | check-encoding.js | 51 文件全 UTF-8 |
| E2E | Playwright | 13 项功能验收用例 |

---

## 10. 附录

### 10.1 模块依赖关系

```
Query.vue
├── useQueryStore ← useConversationsStore（持久化时）
├── useModelStore ← useQueryStore（检查 isLoading）
├── useTtsStore ← useQueryStore（检查 messages）
├── useAttachmentsStore ← useQueryStore（提交前 flush）
├── useSSEStream ← useQueryStore（事件处理）
├── useTTS ← useTtsStore
├── useClipboard
└── useImageCompress ← useAttachmentsStore
```

### 10.2 SRS 追溯矩阵

| SRS 功能 | 设计模块 | 接口 |
| --- | --- | --- |
| F-3.1 思考动画 | ThinkingBlock + useQueryStore.currentThinking | SSE thinking |
| F-3.2 流式渲染 | MarkdownRenderer（v1 改造） | SSE answer |
| F-3.3 历史对话 | ConversationSidebar + useConversationsStore | IndexedDB |
| F-3.4 工具栏 | InputToolbar | 请求体 mode 字段 |
| F-3.5 多模态 | AttachmentUploader + useAttachmentsStore | 请求体 attachments |
| F-3.6 TTS | TtsController + useTTS | 无（纯前端） |
| F-3.7 复制 | MessageActions + useClipboard | 无（纯前端） |
| F-3.8 参考列表 | RefsList | SSE refs |
| F-3.9 模型切换 | ModelSelector + useModelStore | GET /api/ai/presets |
| F-3.10 联网搜索 | InputToolbar + web_search 工具 | SSE progress + POST /api/search/web |
| F-3.11 侧栏折叠 | ConversationSidebar | localStorage |
| F-3.12 联想提问 | FollowupsChips（v1 改造） | SSE followups |
| F-3.13 消息操作 | MessageActions | 无（重新生成复用 /api/query） |

### 10.3 修订历史

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| V1.0.0 | 2026-07-11 | 初版 |
| V1.0.1 | 2026-07-11 | 按评审报告修正：补充 MessageItem 组件到 §3.1 模块清单 |

---

## 阶段交接声明

- 当前阶段：概要设计 V1.0.0 ✅ 已完成
- 下一阶段：详细设计
- 下一阶段智能体：wiki-code-dev
- 下一阶段技能：wiki-code-dev
- 交接上下文：本文档涵盖 11 个前端组件 + 5 个 store + 3 个 composables + 4 个后端模块，完整继承 v1 三项核心架构，可追溯 SRS 13 项功能。作为详细设计基准。
