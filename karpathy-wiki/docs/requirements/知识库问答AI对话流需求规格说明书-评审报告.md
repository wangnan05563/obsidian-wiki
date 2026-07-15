# 知识库问答 AI 对话流 需求规格说明书 — 评审报告

| 字段 | 值 |
| --- | --- |
| 评审对象 | 《知识库问答AI对话流需求规格说明书》v1.0.0 |
| 评审依据 | 《Karpathy-AI+Obsidian知识库搭建需求规格说明书》V2.2 + 《概要设计说明书》V1.3 + 现有实现（v1） |
| 评审日期 | 2026-07-11 |
| 评审人 | AI 评审助手 |
| 评审范围 | 功能完整性 / 技术可行性 / 接口契约一致性 / 非功能指标 / 风险覆盖 / 与现有实现匹配度 |

---

## 1. 评审结论概览

| 维度 | 评分 | 说明 |
| --- | --- | --- |
| 文档结构完整性 | ✅ 优 | 10 章节齐全，结构清晰，符合 SRS 标准范式 |
| 用户需求覆盖度 | ✅ 优 | 13 项功能完整覆盖用户提出的 13 项原始诉求 |
| 与原始需规一致性 | ⚠️ 良 | 覆盖 FR-03/FR-04，但未引用 §12.5 降级链等核心设计 |
| 与现有实现匹配度 | ⚠️ 良 | v1 已完成项正确反映，但存在数据模型 breaking change 未声明 |
| 技术可行性 | ✅ 优 | 13 项功能均有可行技术路径，依赖清晰 |
| 接口契约一致性 | ❌ 差 | 存在 3 处前后端契约矛盾，需立即修正 |
| 非功能指标合理性 | ✅ 优 | 性能指标可达，与 v1 实测对齐 |
| 风险覆盖完整性 | ⚠️ 良 | 识别 6 项风险，遗漏 5 项关键风险 |

**总体结论**：SRS v1.0.0 作为 v2 迭代基线**基本可用**，但存在 **3 项 P0 阻塞问题**必须在 v2 启动前修正，否则将导致实施阶段返工。

---

## 2. 问题清单（按优先级）

### 2.1 P0 阻塞问题（必须修正后才能启动 v2）

#### P0-1：历史对话存储架构矛盾

**位置**：F-3.3 vs §7.1

**问题描述**：
- F-3.3 明确声明"将所有问答会话持久化到**本地存储**（localStorage + IndexedDB）"
- §7.1 却新增后端 API `/api/conversations` GET/DELETE/PATCH（CRUD 接口）

**矛盾点**：如果历史对话纯本地存储，为什么需要后端 CRUD API？反之若有后端 API，则与 P2 本地优先原则冲突。

**修复建议**：二选一，明确单一存储路径：
- 方案 A（推荐）：纯前端本地存储（IndexedDB），删除 §7.1 的 `/api/conversations` 系列 API，与 P2 本地优先原则一致
- 方案 B：后端持久化到 `vault/queries/conversations.json`，但需补充文件并发写、性能、归档冲突的处理方案

---

#### P0-2：ChatMessage 数据模型 breaking change 未声明迁移策略

**位置**：§7.3 vs 现有 `frontend/src/types.ts`

**问题描述**：

现有 v1 的 ChatMessage 结构：
```typescript
// 现有：types.ts L86-98
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  refs?: string[];
  followups?: string[];
  sessionId?: string;
  messageIndex?: number;
  archived?: boolean;
}
```

SRS §7.3 的新结构：
```typescript
interface ChatMessage {
  id: string;              // 新增
  role: 'user' | 'assistant';
  content: string;
  refs?: Reference[];      // 类型变更：string[] → Reference[]
  followups?: string[];
  thinking?: ThinkingStep[];  // 新增
  attachments?: string[];     // 新增
  feedback?: 'up' | 'down' | null;  // 新增
  createdAt: string;           // 新增
}
```

**影响**：
1. `refs` 从 `string[]` 升级为 `Reference[]`，是 breaking change，所有消费 refs 的代码（store/Query.vue/MarkdownRenderer）都需改造
2. 新增 5 个字段，未提及 v1 数据迁移策略
3. 现有 `sessionId/messageIndex/archived` 字段被删除，但 v1 归档功能依赖这两个字段

**修复建议**：
- 明确数据迁移策略：v1 的 ChatMessage 如何升级到 v2 结构
- 保留 `sessionId/messageIndex/archived` 字段（归档功能必需）
- `refs` 升级为 `Reference[]` 时，提供 v1 `string[]` 的兼容映射函数

---

#### P0-3：与现有核心架构脱节（降级链 + per-session Lock + EngineAdapter 未提及）

**位置**：§6 技术架构 vs V1.3 概要设计 §12.5

**问题描述**：

V1.3 概要设计 §12.5 明确定义了 query 工作流的核心架构：
1. **降级链机制**：`queryWithHarness` → `queryWithSearchFallback` → 兜底提示
2. **per-session Lock**：SessionLock 按 question 前 32 字符做 key 串行化
3. **EngineAdapter 接口**：阶段切换抽象点（compile/resumeCompile/query/healthCheck/healthCheckFix）
4. **两阶段提交 + 快照恢复**：compile 工作流

SRS §6 技术架构完全未提及这 4 项核心机制，仅在 §6.1 提到"@wiki/harness"作为后端技术。

**风险**：
- v2 实施时可能不知道降级链存在，新增的 `thinking`/`image`/`progress` 事件需要在降级链的哪个阶段推送？
- per-session Lock 与新增的多模态、联网搜索并发关系未定义
- EngineAdapter 是 `query` 方法的接口契约，新增 `model/mode/webSearch` 参数如何透传？

**修复建议**：
- §6 新增 §6.0「现有架构继承」章节，明确列出降级链、per-session Lock、EngineAdapter 三项机制
- 在 F-3.1 思考动画中说明 thinking 事件在降级链各阶段的推送时机
- 在 F-3.9 模型切换中说明 updateConfig 已支持 model 即时生效（现有实现），无需"路由到对应适配器"

---

### 2.2 P1 重要问题（建议修正）

#### P1-1：风险清单遗漏 5 项关键风险

**位置**：§9.1

**遗漏风险**：

| 遗漏风险 | 等级 | 原因 |
| --- | --- | --- |
| SSE 连接中断后重连 | 高 | 现有实现无重连机制，v2 流式场景更复杂 |
| 模型切换时状态一致性 | 中 | 切换瞬间若有 in-flight 问答，如何处理？ |
| v1 → v2 数据迁移 | 高 | ChatMessage 结构变更，IndexedDB 已有数据如何升级？ |
| 多模态图片 MIME 伪造 | 中 | §4.3 提到"校验 MIME + 文件头魔数"，但风险清单未列 |
| 降级链与 thinking 事件冲突 | 中 | 降级到 queryWithSearchFallback 时是否还推送 thinking？ |

**修复建议**：补充到 §9.1 风险表。

---

#### P1-2：量化指标在两处重复定义

**位置**：§1.5.3 vs §4.1

**问题描述**：
- §1.5.3「目标量化指标」：TTFB ≤ 500ms、流式延迟 ≤ 200ms、Markdown 渲染 ≤ 30ms、TTS 启动 ≤ 800ms 等 7 项
- §4.1「性能」：首屏 ≤ 1.5s、流式延迟 ≤ 200ms、Markdown 渲染 ≤ 30ms 等 6 项

两处指标部分重叠、部分不同，易造成验收歧义。

**修复建议**：删除 §1.5.3 的量化指标表，统一引用 §4.1。

---

#### P1-3：状态管理拆分策略不明确

**位置**：§6.4

**问题描述**：
SRS §6.4 提出新增 4 个 store：
- `useConversationsStore`：历史对话
- `useModelStore`：模型切换
- `useTtsStore`：TTS 状态
- `useAttachmentsStore`：附件管理

并扩展 `useQueryStore` 新增 `currentThinking`、`attachments` 字段。

但现有实现 `useQueryStore` 已包含 `messages/streamingAnswer/currentRefs/currentFollowups/isLoading` 状态，未说明：
1. `messages` 是否迁移到 `useConversationsStore`？
2. `currentRefs/currentFollowups` 是否保留在 `useQueryStore`？
3. 4 个 store 之间的依赖关系？

**修复建议**：补充 store 拆分边界图，明确各 store 的职责与数据流向。

---

#### P1-4：F-3.9 模型切换实现描述与现有机制不符

**位置**：F-3.9 处理

**问题描述**：
SRS F-3.9 说"后端 queryWorkflow 读取 model 字段，路由到对应适配器"。

但现有 `harness-adapter.ts` 的 `updateConfig` 已支持 `model/budget/staleDays/provider/baseUrl/apiKey` 即时生效，**不需要"路由到对应适配器"**，只需调用 `updateConfig({ model })` 即可。

**修复建议**：修正 F-3.9 处理逻辑为"调用 `engineAdapter.updateConfig({ model })` 即时生效"，与现有实现对齐。

---

### 2.3 P2 轻微问题（可选修正）

#### P2-1：F-3.12 位置变更为明确

**位置**：F-3.12

**问题描述**：
F-3.12 说"位置：从消息底部移到引用列表上方"，但 v1 实际实现是消息底部，这是个 UI 变更，需在验收标准中明确"旧位置不保留"。

**修复建议**：在 F-3.12 验收标准补充"v1 的底部 chips 不再显示"。

---

#### P2-2：未引用 v1 编码门禁机制

**位置**：§4.5

**问题描述**：
§4.5 提到"UTF-8 无 BOM"，但未引用 v1 已落地的编码门禁三层防御机制：
1. pre-commit hook
2. .gitattributes
3. CI 门禁 + `scripts/check-encoding.js`

**修复建议**：§4.5 补充"沿用 v1 编码门禁三层防御机制"，引用 `scripts/check-encoding.js`。

---

#### P2-3：未引用 DELIVERY.md 交付基线

**位置**：§1.2

**问题描述**：
§1.2 提到"v1 刚完成"，但未引用 `DELIVERY.md §14` 作为交付基线。

**修复建议**：§1.2 补充"v1 交付清单见 DELIVERY.md §14"。

---

#### P2-4：F-3.4 工具栏"PPT 生成/视频生成"标记策略描述模糊

**位置**：F-3.4

**问题描述**：
F-3.4 说"PPT 生成"和"视频生成"v2 仅做标记，生成留 v3，但未说明"标记"的具体语义：是 prompt 前缀？是请求参数？是 UI 状态？

**修复建议**：明确"标记"= 在 SSE 请求 body 中追加 `mode: 'ppt' | 'video'` 字段，后端暂不处理。

---

## 3. 各维度详细评审

### 3.1 与原始需求文档一致性

| 原始需规条目 | SRS 对应 | 一致性 | 备注 |
| --- | --- | --- | --- |
| FR-03 检索与问答 | F-3.2 + F-3.8 + F-3.10 | ✅ | 覆盖知识库检索 + 互联网搜索 |
| FR-04 Web 前端 AI 对话模块 | F-3.1 ~ F-3.13 全部 | ✅ | 13 项功能完整覆盖 |
| FR-08 @wiki/harness 独立组件 | §6.1 技术表 | ⚠️ | 提及但未详述 |
| V1.3 §12.5 降级链 | 未提及 | ❌ | 见 P0-3 |
| V1.3 §12.5 per-session Lock | 未提及 | ❌ | 见 P0-3 |
| V1.3 EngineAdapter 接口 | 未提及 | ❌ | 见 P0-3 |
| V2.2 §11 风险项 | §9.1 部分覆盖 | ⚠️ | 见 P1-1 |

### 3.2 与现有实现匹配度

| 现有实现 | SRS 反映 | 匹配度 | 备注 |
| --- | --- | --- | --- |
| v1 Markdown 渲染 | F-3.2 保留并扩展 | ✅ | 一致 |
| v1 followups chips | F-3.12 微调 | ✅ | 一致（位置变更见 P2-1） |
| v1 SSE answer/refs/followups/done/error | §6.3 事件表 | ✅ | 一致 |
| v1 AnswerChunk.followups 字段 | §7.3 ChatMessage.followups | ✅ | 一致 |
| v1 ChatMessage 结构 | §7.3 新结构 | ❌ | breaking change 见 P0-2 |
| v1 归档功能（sessionId/messageIndex） | F-3.13 重新生成 | ⚠️ | 未明确归档与重新生成的 sessionId 关系 |
| v1 编码门禁三层防御 | §4.5 仅提 UTF-8 | ⚠️ | 见 P2-2 |

### 3.3 功能完整性

用户原始诉求 vs SRS 功能覆盖：

| 用户诉求 | SRS 功能 | 覆盖 |
| --- | --- | --- |
| 流式输出 | F-3.2 | ✅ |
| 图文并茂 | F-3.2 + F-3.5 | ✅ |
| 思考动画 | F-3.1 | ✅ |
| 历史对话记录 | F-3.3 | ✅ |
| 工具栏 | F-3.4 | ✅ |
| 多模态 | F-3.5 | ✅ |
| 复制文本图标 | F-3.7 | ✅ |
| 语音朗读 | F-3.6 | ✅ |
| 参考文章列表 | F-3.8 | ✅ |
| 模型切换 | F-3.9 | ✅ |
| 上传图片 | F-3.5 | ✅ |
| 互联网搜索工具 | F-3.10 | ✅ |
| 历史对话栏可折叠 | F-3.11 | ✅ |

**结论**：13/13 项用户诉求全覆盖，功能完整性优秀。

### 3.4 技术可行性

| 功能 | 技术路径 | 依赖 | 可行性 |
| --- | --- | --- | --- |
| F-3.1 思考动画 | SSE thinking 事件 + CSS keyframes | 后端推送 | ✅ |
| F-3.2 流式渲染 | markdown-it computed（v1 已实现） | 无新增 | ✅ |
| F-3.3 历史对话 | IndexedDB + localStorage | idb 库 | ✅ |
| F-3.4 工具栏 | Vue chip 组件 | 无 | ✅ |
| F-3.5 多模态 | el-upload + canvas 压缩 + base64 | LLM vision 能力 | ⚠️ 依赖模型 |
| F-3.6 TTS | Web Speech API | 浏览器原生 | ✅ |
| F-3.7 复制 | navigator.clipboard | 无 | ✅ |
| F-3.8 参考列表 | refs 数据结构升级 | 无 | ✅ |
| F-3.9 模型切换 | updateConfig（已实现） | 无 | ✅ |
| F-3.10 互联网搜索 | Tavily/Bing API + 新工具 | API Key | ✅ |
| F-3.11 侧栏折叠 | CSS Grid + localStorage | 无 | ✅ |
| F-3.12 联想提问 | v1 已实现 + 微调 | 无 | ✅ |
| F-3.13 消息操作 | hover 浮窗 + 重新生成 | 无 | ✅ |

**结论**：13 项功能技术路径清晰，仅 F-3.5 多模态依赖 LLM vision 能力（SRS §9.1 已识别此风险）。

### 3.5 接口契约一致性

| 接口 | SRS 定义 | 现有实现 | 一致性 |
| --- | --- | --- | --- |
| SSE answer 事件 | §6.3 `{ text }` | types.ts AnswerChunk.text | ✅ |
| SSE refs 事件 | §6.3 `{ refs: Reference[] }` | types.ts AnswerChunk.refs: string[] | ❌ 类型变更 |
| SSE followups 事件 | §6.3 `{ followups: string[] }` | types.ts AnswerChunk.followups | ✅ |
| SSE done 事件 | §6.3 `{ sessionId, messageIndex, followups? }` | routes/query.ts 一致 | ✅ |
| SSE error 事件 | §6.3 `{ message, code? }` | types.ts 无 code 字段 | ⚠️ 新增 code |
| SSE thinking 事件 | §6.3 新增 | 无 | ✅ 新增合理 |
| SSE image 事件 | §6.3 新增 | 无 | ✅ 新增合理 |
| SSE progress 事件 | §6.3 新增 | 无 | ✅ 新增合理 |
| POST /api/query | §6.2 multipart 或 json | 现有 application/json | ⚠️ 需扩展 |
| /api/conversations | §7.1 新增 | 无 | ❌ 见 P0-1 |
| /api/ai/presets | §7.1 已有 | routes/ai.ts 已有 | ✅ |
| /api/search/web | §7.1 新增 | 无 | ✅ 新增合理 |

**结论**：SSE 事件扩展合理，但 `refs` 类型变更与 `/api/conversations` 矛盾需修正。

### 3.6 非功能指标合理性

| 指标 | SRS 目标 | v1 实测 | 合理性 |
| --- | --- | --- | --- |
| Markdown 渲染 50KB | ≤ 30ms | ≤ 5ms | ✅ 保守可达 |
| 流式延迟 | ≤ 200ms | 未测 | ✅ 合理 |
| TTFB | ≤ 500ms | 未测 | ✅ 合理 |
| 历史对话首屏 | ≤ 200ms（50 条） | 未测 | ✅ 合理 |
| TTS 启动 | ≤ 800ms | 未测 | ✅ 合理 |
| 侧栏折叠动画 | ≤ 250ms | 未测 | ✅ 合理 |

**结论**：性能指标保守合理，与 v1 实测对齐。

### 3.7 风险覆盖完整性

SRS §9.1 识别 6 项风险：

| SRS 已识别风险 | 等级 | 评估 |
| --- | --- | --- |
| Web Speech API 跨浏览器一致性 | 中 | ✅ 合理 |
| IndexedDB 大数据量查询慢 | 中 | ✅ 合理 |
| LLM 视觉能力差异 | 高 | ✅ 合理 |
| 联网搜索 API 限流 | 中 | ✅ 合理 |
| 图片 base64 增大 payload | 中 | ✅ 合理 |
| 历史对话 IndexedDB 兼容 | 低 | ✅ 合理 |

遗漏 5 项（见 P1-1）。

---

## 4. 优秀设计点

SRS v1.0.0 也有诸多值得肯定的设计点：

1. **P3 可降级原则**：TTS 不可用→静默降级为文字；多模态不支持→提示用户；搜索失败→仅返回知识库。这与 v1 的降级链哲学一致
2. **F-3.4 工具栏渐进策略**：PPT/视频生成 v2 仅做标记，v3 再实现生成，避免过度承诺
3. **§4.3 安全性**：API Key 仅存后端 + Markdown html:false + 图片 MIME 校验 + rel="noopener noreferrer"，安全基线完整
4. **§5.4 响应式断点**：≥1280px 完整 / 1024-1280px 折叠 / 768-1024px 隐藏 / <768px 仅阅读，渐进式降级合理
5. **§6.2 数据流图**：从用户输入到持久化的完整数据流清晰
6. **F-3.13 消息操作整合**：复制/朗读/重新生成/反馈 4 类操作统一在一处，避免分散

---

## 5. 修复优先级与建议排期

| 优先级 | 问题 | 修复工作量 | 建议时机 |
| --- | --- | --- | --- |
| P0-1 | 历史对话存储架构矛盾 | 0.5 天 | v2 启动前 |
| P0-2 | ChatMessage breaking change 迁移 | 0.5 天 | v2 启动前 |
| P0-3 | 现有架构继承章节 | 1 天 | v2 启动前 |
| P1-1 | 风险清单补全 | 0.5 天 | v2 启动前 |
| P1-2 | 量化指标去重 | 0.25 天 | v2 启动前 |
| P1-3 | store 拆分边界 | 0.5 天 | v2 启动前 |
| P1-4 | 模型切换描述修正 | 0.25 天 | v2 启动前 |
| P2-1~P2-4 | 轻微问题 | 0.5 天 | v2 实施中 |

**总修复工作量**：约 4 天，建议在 v2 启动前完成 P0+P1 修正（约 3.5 天）。

---

## 6. 评审结论

SRS v1.0.0 作为 v2 迭代基线**基本可用**，文档结构完整、功能覆盖全面、技术路径可行。但存在 3 项 P0 阻塞问题（历史对话存储矛盾、ChatMessage breaking change、现有架构未继承）必须在 v2 启动前修正。

**建议**：
1. 先修正 P0-1/P0-2/P0-3 三项阻塞问题，发布 SRS v1.1.0
2. v2 实施前补充 P1-1 风险清单
3. P1-2/P1-3/P1-4 在实施中逐步修正
4. P2 问题作为实施过程中的优化项

修正后 SRS 可作为 v2 迭代的可靠基线。

---

## 阶段交接声明

- 当前阶段：SRS 评审 ✅ 已完成
- 下一阶段：SRS v1.1.0 修正（P0+P1）→ v2 迭代实施
- 下一阶段智能体：wiki-code-dev（修正 SRS）或 wiki-frontend-code-review（评审修正稿）
- 下一阶段技能：wiki-code-dev / wiki-frontend-code-review
- 交接上下文：本评审报告识别 3 项 P0 + 4 项 P1 + 4 项 P2 共 11 项问题，建议优先修正 P0-1（历史对话存储矛盾）/ P0-2（ChatMessage 迁移）/ P0-3（现有架构继承）后发布 SRS v1.1.0。现有实现 v1 已 clean，技术债务为零，可作为 v2 启动基线。
