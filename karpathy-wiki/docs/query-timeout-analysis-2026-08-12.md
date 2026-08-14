# Karpathy-Wiki 问答超时与联网查询未生效根因分析报告

## 1. 执行摘要

| 维度 | 结论 |
|------|------|
| **问题现象** | 提问「票据是什么」后，界面显示「已思考 14 步 · 搜索 9 次 · 阅读 0 页 · 29:05」，最终提示「知识库未覆盖此问题，或当前问答服务暂不可用」。 |
| **联网查询是否发起** | **未真正发起**。工具链中全部为本地 `search_pages` / `read_page`，无 `web_search` 调用。 |
| **耗时瓶颈** | 单次 `search_pages` 耗时 100.9s，多轮 `read_page` 各 20~30s；总耗时被无结果的本地知识库循环放大。 |
| **根因结论** | **前端中间件「全开时省略」策略 + v3.2 移除 web 模式按钮，导致 `web_search` 开关在默认状态下丢失；同时 `query.md` prompt 未 instruct LLM 使用 `web_search`，即使工具注入也可能不被调用。** |
| **修复优先级** | P0：修复中间件传递逻辑；P1：补充 prompt 工具说明；P1：补全流式 tool_call 的 `tool` 字段；P2：增强 query 链路日志。 |

---

## 2. 请求定位与日志现状

### 2.1 后端访问日志

文件：`karpathy-wiki/logs/api-dev.log`

最近一条成功返回的 `/api/query` 请求：

```json
{"level":30,"time":1786523413973,"pid":4404,"reqId":"req-25","method":"POST","url":"/api/query","msg":"incoming request"}
{"level":30,"time":1786523696282,"pid":4404,"reqId":"req-25","method":"POST","url":"/api/query","statusCode":200,"elapsedMs":"282309.64","msg":"request completed"}
```

- **耗时**：282,309 ms（约 4 分 42 秒）。
- **状态码**：200，表示 SSE 流已正常关闭。
- **问题**：仅有请求开始/结束两条记录，无请求体、无工具调用明细、无异常堆栈。

### 2.2 Harness 执行日志

目录：`karpathy-wiki/data/.harness/logs/`

该目录下最新日志停留在 **2025-07-29**，本次 8 月 12 日的请求未生成 harness 级日志。

### 2.3 线程持久化

目录：`karpathy-wiki/data/threads/`

为空。`config.json` 中 `sessionPersistence.threadsPersist=false`，服务端不落盘会话，无法从服务端回放本次问答内容。

### 2.4 日志结论

**现有日志不足以直接还原工具调用时序**，但结合前端截图与源码可完成代码级根因定位。

---

## 3. 工具调用链路分析

### 3.1 截图呈现的工具链

从截图展开的思考块可见：

| 步骤 | 工具 | 耗时 |
|------|------|------|
| 1 | `search_pages` | +100.9s |
| 2 | `search_pages` 返回结果 | +1.3s |
| 3 | `read_page` | +29.7s |
| 4 | `read_page` 返回结果 | +2ms |
| 5 | `read_page` | +19.6s |
| 6 | `read_page` 返回结果 | +9ms |
| 7 | `read_page` | +24.1s |
| 8 | `read_page` 返回结果 | +8ms |
| 9 | `read_page` | +21.0s |

**关键观察**：
- 14 步中，`search_pages` 调用 9 次，`read_page` 调用 0 次（顶部摘要统计）。
- 展开列表里出现的 `read_page` 行实际为「工具返回结果」事件，不是「调用」事件，因此 `ThinkingBlock` 将其计为 0 页阅读。
- **没有任何 `web_search` 工具调用记录**。

### 3.2 后端工具注册链路

```
POST /api/query
  → query.ts: 构造 input（含 webSearch/middlewares）
  → harness-adapter.query()
  → queryWorkflow()
    → buildMiddlewareContext() 决定 useWebSearch
    → initWebSearchState() 检查 webSearchConfig
    → createQueryTools() 注入 / 不注入 web_search
    → Harness.runStream() 执行 ReAct 循环
```

### 3.3 中间件解析关键代码

`api/src/workflows/query-workflow.ts`：

```ts
function buildMiddlewareContext(input: QueryInput) {
  const middlewareSet: Set<string> | null = input.middlewares && input.middlewares.length > 0
    ? new Set(input.middlewares)
    : null;
  const useWebSearch = middlewareSet != null
    ? middlewareSet.has('web_search')
    : !!input.webSearch;
  // ...
}
```

**逻辑**：
- 只要 `input.middlewares` 非空，`web_search` 是否启用完全由数组里有没有 `'web_search'` 决定。
- 如果 `input.middlewares` 为空/undefined，才回退到 `input.webSearch`。

---

## 4. 联网查询未启用的根因

### 4.1 前端传递逻辑

`frontend/src/views/Query.vue`：

```ts
// 中间件多选透传：仅在非全开时发送，全开时省略以减少请求体大小
if (store.middlewares.length > 0 && store.middlewares.length < ALL_MIDDLEWARES.length) {
  body.middlewares = [...store.middlewares];
}

// webSearch 标志仅由已移除的 web 模式按钮驱动
if (activeMode.value) {
  body.mode = activeMode.value;
  if (activeMode.value === 'web') {
    body.webSearch = true;
  }
}
```

`frontend/src/stores/query.ts`：

```ts
function loadMiddlewares(): Middleware[] {
  const raw = localStorage.getItem(STORAGE_KEYS.MIDDLEWARES);
  if (!raw) return [...ALL_MIDDLEWARES]; // 默认全开
  // ...
}
```

### 4.2 矛盾点

| 用户视角 | 系统行为 |
|----------|----------|
| 中间件面板显示「5/5」全选（含联网搜索） | 前端认为「全开=无需发送」，`body.middlewares` 被省略 |
| 用户认为已勾选联网搜索 | 后端收到 `middlewares=undefined`，回退到 `input.webSearch` |
| 界面已无独立的「联网搜索」模式按钮 | `activeMode` 默认为空，`body.webSearch` 为 false |
| 后端 `webSearchConfig` 已配置（Tavily apiKey 存在） | `initWebSearchState` 因 `input.webSearch=false` 返回 false，`web_search` 工具不注入 |

### 4.3 结论

**在默认状态下（所有中间件全开），联网搜索开关实际上被丢弃，LLM 只能看到本地 `search_pages` / `read_page` 两个工具。**

---

## 5. 最终未返回有效答案的根因

### 5.1 Prompt 未 instruct 使用联网搜索

`api/src/prompts/query.md`：

```markdown
## 步骤
1. 使用 search_pages 工具按关键词搜索相关页面
2. 使用 read_page 工具读取所有相关页面的完整内容
3. 综合页面内容生成答案

## 约束
- 如果搜索结果为空或页面内容不足以回答问题，明确回复"知识库未覆盖此问题"
```

**问题**：prompt 中从未提及 `web_search` 工具。即使 `web_search` 被正确注入，LLM 也可能不主动调用它。

### 5.2 本地知识库无命中

问题「票据是什么」超出当前 vault 覆盖范围，导致：
- `search_pages` 多次返回空或弱相关结果；
- LLM 按 prompt 约束输出「知识库未覆盖此问题」；
- 当 harness 执行异常或返回 `status='failed'` 时，`queryWorkflow` 落入第 3 级兜底，输出：

```ts
yield { text: '知识库未覆盖此问题，或当前问答服务暂不可用。' };
```

截图中的最终文案与此兜底文案一致。

### 5.3 耗时被无意义循环放大

由于无法调用 `web_search`，LLM 在 ReAct 循环中反复尝试本地搜索：
- 9 次 `search_pages` 调用；
- 其中单次耗时 100.9s，显著高于正常本地搜索；
- 多轮 `read_page` 即使返回空，也需等待 LLM 决策与代理延迟。

---

## 6. 耗时瓶颈定位

| 环节 | 耗时 | 说明 |
|------|------|------|
| `search_pages` 单步 | 100.9s | 异常高，可能叠加了代理延迟或 LLM 决策时间；本地搜索通常不应超过秒级。 |
| `read_page` 单步 | 20~30s | 主要为 LLM 决策/等待时间，实际磁盘读取在毫秒级（返回事件仅 2~9ms）。 |
| 总 ReAct 循环 | ~282s | 后端日志显示 req-25 总耗时 282s，14 步循环耗尽预算或触发兜底。 |
| 用户感知 | 29:05 | 包含前端超时、重试、404 错误请求等额外等待（日志中 req-1h/1i/1j 曾返回 404）。 |

**瓶颈根因**：不是某个单点慢，而是「无有效工具可用」导致 LLM 在空结果上反复尝试，时间被无意义循环放大。

---

## 7. 修复建议

### P0：修复中间件传递逻辑

**方案 A（推荐）**：前端始终发送 `body.middlewares`，不再因「全开」而省略。

```ts
// Query.vue
body.middlewares = [...store.middlewares];
```

后端 `buildMiddlewareContext` 已能正确处理空数组：当 `middlewares` 为空时，`shouldRunMiddleware` 返回 true（默认开启），所以发送空数组也能保持兼容行为。

**方案 B**：后端在 `middlewares` 缺失时，默认启用所有中间件（包括 `web_search`），与前端 `loadMiddlewares` 的默认值对齐。

### P1：补充 prompt 工具说明

在 `query.md` 中增加 `web_search` 使用说明：

```markdown
## 可用工具
- search_pages：搜索本地知识库页面
- read_page：读取本地知识库指定页面
- web_search：当本地知识库无法回答问题时，搜索互联网实时信息

## 步骤
1. 优先使用 search_pages 搜索本地知识库
2. 若本地搜索结果为空或不充分，使用 web_search 获取互联网信息
3. 使用 read_page 读取本地相关页面（如适用）
4. 综合信息生成答案
```

### P1：修复流式 tool_call 统计

`api/src/workflows/query-workflow.ts` 的 `processStreamEvent` 中，流式 `tool_call` 事件未设置 `tool` 字段，导致前端统计阅读数为 0：

```ts
case 'tool_call':
  const thinking: ThinkingChunk = {
    phase: 'tool_call',
    message: `调用工具：${evt.toolCall.function.name}`,
    tool: evt.toolCall.function.name, // 补上 tool 字段
    ts: new Date().toISOString(),
  };
```

### P2：增强 query 链路日志

在 `query-workflow.ts` 的关键节点增加结构化日志：
- `initWebSearchState` 返回结果与原因（webSearch=false / 缺配置 / 缺 apiKey）；
- `createQueryTools` 实际注入的工具列表；
- 每步 `afterStep` 的工具名、结果长度、耗时；
- harness 失败时的 `status` 与 `finalContent`；
- fallback 触发原因。

建议使用 `request.log` 或独立 logger，避免污染 stdout。

---

## 8. 验证 checklist

- [ ] 修复后，默认全开中间件时，后端 `input.middlewares` 应包含 `'web_search'`。
- [ ] 修复后，提问超出知识库范围的问题，工具链中应出现 `web_search`。
- [ ] `web_search` 被调用且返回结果后，最终答案应引用互联网来源（`webRefs` 非空）。
- [ ] 本地无命中但联网搜索成功时，不应再落入兜底文案。
- [ ] 前端「阅读 N 页」统计应与实际 `read_page` 调用次数一致。

---

## 9. 附录：关键文件路径

| 文件 | 作用 |
|------|------|
| `karpathy-wiki/logs/api-dev.log` | 后端访问日志 |
| `karpathy-wiki/api/src/workflows/query-workflow.ts` | query 工作流核心逻辑 |
| `karpathy-wiki/api/src/tools/web-search.ts` | 联网搜索工具实现 |
| `karpathy-wiki/api/src/prompts/query.md` | query 任务 prompt |
| `karpathy-wiki/api/src/routes/query.ts` | `/api/query` 路由 |
| `karpathy-wiki/frontend/src/views/Query.vue` | 前端请求体构造 |
| `karpathy-wiki/frontend/src/stores/query.ts` | 中间件状态管理 |
| `karpathy-wiki/frontend/src/components/ThinkingBlock.vue` | 思考过程统计展示 |
