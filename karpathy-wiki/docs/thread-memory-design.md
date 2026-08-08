# 知识库问答 · 线程隔离本地存储与本地记忆 · 设计规格

> 对应需求：问答会话本地持久化（按线程隔离）+ 本地记忆（读/写/清，仅存于本地）。
> 实现位置：`api/src/engine/thread-memory-store.ts`、`api/src/routes/threads.ts`、`api/src/routes/query.ts`、`frontend/src/services/threadMemory.ts` 及前端问答/会话联动。

> ⚠️ **设计状态变更（2026-08-05）**：本规格描述的「服务端落盘 `data/threads/` + `data/conversations/`」模型，已被《用户注册与数据隔离需求规格说明书》§2.3 的**本地优先数据驻留模型**取代。
> - 新决策（D-1）：`sessionPersistence.threadsPersist` 与 `conversationsPersist` 默认均为 **false**——**会话内容不存储于服务器端，仅由客户端本地（IndexedDB）维护**，并按 `ownerId`（=用户 id）做本地多账户隔离（FR-RM-05 / FR-RM-06）。
> - `ThreadMemoryStore` 在 `persist=false` 时**不再写盘**：`appendSessionMessage` / `appendMemory` 仅返回结构占位值，`getHistoryContext` 恒返回 `[]`；跨重启的会话连贯性改由前端每轮透传完整 `history` 保证。
> - 前端 `conversations` store 停止向 `/api/conversations` 双写/上传，历史会话唯一权威源为 IndexedDB（含 `ownerId` 索引）。
> - 后端 `/api/conversations` 路由族（GET/PUT/DELETE/pin/rename）已**默认停用**：仅当 `sessionPersistence.conversationsPersist === true`（默认 `false`）时才在 `index.ts` 注册。默认情况下服务端不暴露任何会话 CRUD 端点，彻底落实「服务端禁写会话」（FR-RM-04）。
> - 既有服务端会话数据已通过 `scripts/migrate-sessions-local.mjs` **备份**至 `data/_migrated_local_<ts>/` 并从活动路径移除（仅备份、不硬删，可回滚）。
> - 本文件保留作为引擎内部实现参考；涉及「会话是否落盘服务端」以 SRS §2.3 与 `sessionPersistence` 配置为准。

---

## 1. 目标与约束

| 目标 | 说明 |
| --- | --- |
| 本地持久化 | 问答会话数据落盘到本地 `data/threads/`，进程重启不丢失 |
| 线程（thread）隔离 | 每个线程拥有独立的问答会话上下文与记忆，互不干扰 |
| 本地记忆 | 系统在本地记录并维护历史对话内容，后续问答注入上下文，连贯交互 |
| 数据仅本地 | 全部写入本地文件，**不向外传输、无云端写入** |
| 读写清闭环 | 记忆支持 读取（read）/ 写入（write / append）/ 清理（clear） |

---

## 2. 概念与隔离边界（会话 / 线程 / 记忆）

```
┌─────────────────────────────────────────────────────────────┐
│  data/threads/                                                │
│   ├─ {threadId-A}/                ← 线程 A 隔离边界（目录）      │
│   │   ├─ thread.json   (元信息 meta)                            │
│   │   ├─ session.json  (会话：完整 Q&A 轮次)  ← 会话上下文      │
│   │   └─ memory.json   (记忆：滚动上下文)    ← 工作记忆         │
│   ├─ {threadId-B}/                ← 线程 B（与 A 完全隔离）     │
│   │   └─ ...                                                     │
│   └─ ...                                                        │
└─────────────────────────────────────────────────────────────┘
```

| 概念 | 角色 | 与主键关系 |
| --- | --- | --- |
| **Thread（线程）** | 唯一隔离容器 / 命名空间。所有读写都必须携带合法 `threadId`，且只能访问自己的目录。 | 1 个 threadId 对应 1 个目录 |
| **Session（会话）** | 线程内的**问答会话上下文**：完整 Q&A 轮次记录，用于归档与重建。当前实现 **1 线程 1 会话**，`sessionId === threadId`。 | 1 线程 : 1 会话 |
| **Memory（记忆）** | 线程内的**滚动工作记忆**：历史对话片段，专门在下一轮问答时注入 LLM 提示词（`## 历史对话`），实现连贯交互。 | 1 线程 : 1 记忆 |

**隔离边界要点**
- `threadId` 是唯一的安全边界；非法 `threadId`（非 UUID）在所有读写路径被拒绝，杜绝目录穿越与越界访问。
- Session 与 Memory 平行存在，各自有独立生命周期：**清空记忆 ≠ 清空会话**（"遗忘上下文"与"抹掉记录"解耦）。
- 写入按线程串行化（`withThreadLock`），避免并发写同一线程文件导致内容竞争丢失。

---

## 3. 本地存储数据结构（JSON Schema）

### 3.1 `thread.json`（元信息，列表/摘要用，不含 messages/memory 全文）
```jsonc
{
  "id": "uuid-v4",
  "title": "新会话",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "isPinned": false,
  "messageCount": 3,
  "preview": "最近一条回答的前 60 字"
}
```

### 3.2 `session.json`（会话 · 持久化 Q&A 上下文）
```jsonc
{
  "threadId": "uuid-v4",
  "sessionId": "uuid-v4",          // 当前实现等于 threadId
  "messages": [
    { "question": "…", "answer": "…", "refs": ["页面名"], "ts": "ISO8601" }
  ],
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

### 3.3 `memory.json`（记忆 · 注入 LLM 的滚动上下文）
```jsonc
{
  "threadId": "uuid-v4",
  "entries": [
    { "role": "user",      "content": "…", "ts": "ISO8601" },
    { "role": "assistant", "content": "…", "ts": "ISO8601" }
  ],
  "updatedAt": "ISO8601"
}
```

> 类型定义见 `api/src/engine/thread-memory-store.ts`：`ThreadMeta / SessionData / MemoryData / QaTurn / HistoryMessage`。

---

## 4. 生命周期

| 对象 | 创建 | 更新 | 清理 | 随线程删除 |
| --- | --- | --- | --- | --- |
| **Thread** | `POST /api/threads` 或首次问答惰性创建 | 每次问答刷新 `updatedAt`/`preview` | `DELETE /api/threads/:id` | — |
| **Session** | 首次问答 `appendSessionMessage` | 每轮问答追加一条 `QaTurn` | `DELETE /api/threads/:id/session` | 是 |
| **Memory** | 首次问答 `appendMemory` | 每轮问答追加 user/assistant 两条；写入时执行**滚动裁剪**与**过期淘汰** | `DELETE /api/threads/:id/memory` | 是 |

**记忆裁剪 / 过期策略**
- 滚动窗口：`MAX_MEMORY_MESSAGES = 40`（约 20 轮对话），超出时丢弃最旧条目。
- 过期：`MEMORY_MAX_AGE_MS = 30 天`，append 时丢弃超期条目。
- 目的：控制提示词体积与 token 成本，同时保留近期连贯所需的上下文。

---

## 5. 记忆 API（读 / 写 / 清）

| 方法 & 路径 | 作用 |
| --- | --- |
| `POST   /api/threads` | 创建线程 → `{ thread }` |
| `GET    /api/threads` | 列出线程摘要（置顶优先，updatedAt 倒序） |
| `GET    /api/threads/:id` | 读取完整线程（meta + session + memory） |
| `DELETE /api/threads/:id` | 删除线程（连同 session/memory） |
| `POST   /api/threads/:id/rename` · `/pin` | 重命名 / 切换置顶 |
| `GET    /api/threads/:id/session` | **读**会话 |
| `DELETE /api/threads/:id/session` | **清**会话 |
| `GET    /api/threads/:id/memory` | **读**记忆 |
| `POST   /api/threads/:id/memory` | **写/追加**记忆（`{entries[]}` 或 `{role,content}`） |
| `DELETE /api/threads/:id/memory` | **清**记忆 |

> 所有路径均对 `:id` 做 UUID 校验，非法 id 返回 `400`；数据全部读写于本地 `data/threads/`，无远程调用。

---

## 6. 与问答流程的集成（`/api/query`）

每轮问答的处理（见 `api/src/routes/query.ts`）：

1. **解析 threadId**：携带合法 `threadId` → 使用本地记忆作为历史上下文；未携带 → 回退前端透传 `history`（向后兼容），并由后端自动创建新线程。非法 `threadId` → 直接 `400`。
2. **注入上下文**：从 `store.getHistoryContext(threadId)` 取得记忆条目，构造 `QueryInput.history`（即提示词中的 `## 历史对话`），保证跨重启连贯。
3. **持久化**：答案生成后
   - `store.appendSessionMessage(threadId, {question, answer, refs, ts})` 落盘会话；
   - `store.appendMemory(threadId, [{user},{assistant}])` 落盘记忆。
4. **回传**：`done` 事件携带 `threadId` + `sessionId` + `messageIndex`，前端据此续接记忆并支持防篡改归档。

归档（`POST /api/query/archive`）改为从本地 `session.json` 读取问答内容（跨重启可用，不再受原内存 `Map` 过期限制）。

---

## 7. 数据仅本地（安全与隐私）

- 所有会话/记忆仅写入 `data/threads/{threadId}/` 下的本地文件，无任何云端上传、外发接口或第三方同步。
- `threadId` 强制 UUID 校验 + 目录拼接校验，杜绝路径穿越（`../` 等）。
- 与既有 `localOnly` 配置理念一致：知识库问答的上下文数据完全受控于本地磁盘。
- 清理能力齐备：记忆可单独清空（保留会话归档），会话可单独清空（保留记忆），线程可整体删除（`DELETE /api/threads/:id` 移除整个目录）。

---

## 8. 验证

- 单元测试 `api/test/thread-memory.test.ts`：线程隔离、跨重启持久化、记忆读写清、滚动裁剪、非法 id 拒绝、生命周期。
- 集成测试 `api/test/thread-query-integration.test.ts`：真实挂载 `threads`/`query` 路由 + 假 adapter，验证记忆注入连贯性、自动建线程、HTTP 记忆读写清闭环、删除线程级联清理。
- 全量 API 测试 `npm test`：334 项全部通过（含本特性的 14 项）。
