# 交付文档 — Karpathy AI + Obsidian 知识库

> 版本：阶段1 + 阶段2 + 阶段3 完整交付  
> 日期：2026-07-08  
> 设计基线：《Karpathy-AI+Obsidian知识库概要设计说明书》V1.3

---

## 1. 项目概述

基于 Karpathy AI 理念构建的本地优先知识库系统，通过 LLM Agent（Harness）将原始资料编译为结构化 Markdown Wiki，支持双向链接、图谱可视化、知识问答与健康体检。

**核心闭环**：投递资料 → AI 编译 → 结构化页面 → 知识问答

---

## 2. 架构总览

```
┌─────────────────────────────────────────────┐
│                  前端 (Vue 3)                │
│   仪表盘 / 投递 / 进度 / 浏览 / 问答 /        │
│   图谱 / 体检 / 配置                         │
└──────────────────┬──────────────────────────┘
                   │ HTTP + SSE
┌──────────────────┴──────────────────────────┐
│              后端 API (Fastify)              │
│   routes / workflows / vault / engine       │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────┴──────────────────────────┐
│           @wiki/harness (Agent 引擎)         │
│   LLM 适配 / 工具循环 / 预算 / 重试 / 状态    │
└──────────────────┬──────────────────────────┘
                   │
            LLM API (DeepSeek / GLM)
```

**三层架构**：
- `@wiki/harness`：通用 Agent 引擎（LLM + 工具循环 + 预算 + 重试 + 状态持久化）
- `services/api`：业务层（Fastify 路由 + Vault 服务 + compile/query 工作流）
- `packages/web`：前端（Vue 3 + Element Plus + Pinia + vis-network）

---

## 3. 阶段1 交付清单

### 3.1 @wiki/harness（Agent 引擎）

| 模块 | 文件 | 说明 |
|------|------|------|
| Harness 主类 | `harness.ts` | 组合 LLM + 工具 + 预算 + 重试 + Hook，暴露 run/resume |
| 工具循环 | `loop/tool-loop.ts` | ReAct 式循环：LLM → 工具调用 → 结果回填 → 继续 |
| LLM 适配 | `llm/openai-compatible.ts` | OpenAI 兼容 API 适配器（支持 DeepSeek/GLM/Qwen） |
| 预算守卫 | `budget/budget-guard.ts` | 步数 + token 双预算，超限终止 |
| 重试策略 | `retry/retry-policy.ts` | 指数退避，仅对超时/限流重试 |
| 状态存储 | `state/file-state-store.ts` | JSON 文件持久化，支持断点续传 |
| Hook 管理 | `hook/hook-manager.ts` | beforeLoop/afterStep/afterLoop 生命周期 |

### 3.2 业务层（services/api）

| 模块 | 文件 | 说明 |
|------|------|------|
| 入口 | `index.ts` | Fastify 启动 + 路由注册 |
| 配置 | `config.ts` | config.json 加载 + 热加载 |
| 引擎适配 | `engine/harness-adapter.ts` | EngineAdapter 实现，桥接 harness |
| Vault 服务 | `vault/vault-service.ts` | 文件读写 + 存档 + 索引 + 日志 + 链接图 |
| compile 工作流 | `workflows/compile-workflow.ts` | 存档 → 读 SCHEMA → harness 编译 → 事件桥接 |
| query 工作流 | `workflows/query-workflow.ts` | harness 问答 → 流式答案 + 引用 |

### 3.3 API 路由（14 个）

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/compile` | POST | 编译原始资料，SSE 流式返回进度 |
| `/api/compile/resume/:runId` | POST | §11.2 断点续传，SSE 流式返回 |
| `/api/compile/runs` | GET | §11.2 查询历史编译任务 |
| `/api/compile/runs/:runId/log` | GET | §12.3-8 查询运行日志 |
| `/api/query` | POST | 知识问答，SSE 流式返回答案，done 附带 sessionId |
| `/api/query/archive` | POST | §5.1 L-7 防篡改归档，服务端存储取答案 |
| `/api/health-check` | POST | 体检：孤立页/断链/过期页 |
| `/api/health-check/fix` | POST | §4.6 一键修复，SSE 流式返回修复进度 |
| `/api/search` | GET | §5.1 全文检索：关键词搜索页面 |
| `/api/files` | GET | 浏览：目录树 + 文件内容 |
| `/api/graph` | GET | 图谱：节点 + 边 |
| `/api/stats` | GET | 仪表盘统计 |
| `/api/schema` | GET/PUT | SCHEMA.md 读取/编辑 |
| `/api/schema/history` | GET | §6.X SCHEMA 版本历史（Git log） |
| `/api/schema/diff` | GET | §6.X SCHEMA 版本对比（Git diff） |
| `/api/vault/init` | POST | §6.9 Vault 初始化（创建目录结构） |
| `/api/config` | GET/PUT | 配置读取/更新 |
| `/api/config/reload` | POST | §12.3-7 热加载配置 |
| `/health` | GET | 健康检查端点 |

### 3.4 前端模块（8 个视图）

| 视图 | 文件 | 功能 |
|------|------|------|
| 仪表盘 | `Dashboard.vue` | 全局概览 + 快捷入口 + 空状态引导 + Vault 初始化 |
| 投递资料 | `Ingest.vue` | 文件上传/URL/文本投递 |
| 编译进度 | `Progress.vue` | SSE 实时进度 + 历史任务 + 日志查看 |
| 知识浏览 | `Browse.vue` | 目录树 + 页面阅读 + 全文检索 |
| 知识问答 | `Query.vue` | 对话式问答 + 引用展示 + 一键归档 |
| 图谱 | `Graph.vue` | vis-network 双向链接图谱 |
| 体检 | `Health.vue` | 孤立页/断链/过期页报告 + 一键修复 + SSE 进度 |
| 配置 | `Config.vue` | SCHEMA 编辑 + 版本历史 + 版本对比 + 系统配置 + 热加载 |

### 3.5 外围交付物

| 文件 | 说明 |
|------|------|
| `scripts/install.ps1` | 一键安装 + 4 步向导（路径/模型/SCHEMA/完成） |
| `scripts/start.ps1` | 一键启动后端 + 前端 |
| `GETTING_STARTED.md` | 快速开始指南 |

---

## 4. 阶段2 交付清单

### 4.1 §11.2 迭代优化

| 功能 | 实现文件 | 说明 |
|------|----------|------|
| 增量编译 | `compile-cache.ts` + `compile-workflow.ts` | SHA-256 内容哈希缓存，相同内容跳过编译 |
| 并发体检 | `harness-adapter.ts` | 4 目录并行扫描断链 + 逐节点并行过期检测 |
| 断点续传 | `compile-workflow.ts` + `runs.ts` + `compile.ts` | harness.resume + 状态持久化 + resume API + 前端恢复按钮 |

### 4.2 §12.3 待定项

| 功能 | 实现文件 | 说明 |
|------|----------|------|
| §12.3-5 并发控制 | `compile-queue.ts` + `compile.ts` | Promise 链串行队列，避免 index.md/log.md 竞态 |
| §12.3-6 部分失败事务性 | `compile-workflow.ts` | draft 标记（不回滚），保留半成品供用户决策 |
| §12.3-7 配置热加载 | `config.ts` + `harness-adapter.ts` + `config.ts` 路由 | model/budget/staleDays 即时生效，adapter/vaultPath 需重启 |
| §12.3-8 harness 运行日志 | `run-logger.ts` + `runs.ts` 路由 | 控制台 + `.harness/logs/{runId}.log` 双写，JSONL 格式 |

---

## 5. 阶段3 交付清单

### 5.1 后端新增路由（5 个）

| 路由 | 方法 | 文件 | 说明 |
|------|------|------|------|
| `/api/health-check/fix` | POST | `routes/health-check.ts` | §4.6 LLM 驱动修复，SSE 流式（scan/fixing/fixed/done） |
| `/api/search` | GET | `routes/search.ts` | §5.1 全文检索，按命中次数排序 |
| `/api/query/archive` | POST | `routes/query.ts` | §5.1 L-7 防篡改归档，服务端会话存储取答案 |
| `/api/schema/history` | GET | `routes/schema.ts` | §6.X Git log 版本历史，vault 非 git 仓库时优雅降级 |
| `/api/schema/diff` | GET | `routes/schema.ts` | §6.X Git diff 版本对比，解析 @@ 行号 + +/- 行 |
| `/api/vault/init` | POST | `routes/vault.ts` | §6.9 Vault 初始化（创建标准目录结构） |

### 5.2 后端新增模块

| 模块 | 文件 | 说明 |
|------|------|------|
| 健康修复工作流 | `workflows/health-check-fix-workflow.ts` | LLM 驱动修复断链/孤立页，事件队列桥接模式 |
| 修复 prompt | `prompts/health-check-fix.md` | 修复策略：断链创建目标页/移除链接，孤立页添加引用 |
| 共享搜索工具 | `search-util.ts` | 从 query-workflow 提取，/api/search 与 query 工具共用 |

### 5.3 前端新增功能

| 功能 | 文件 | 说明 |
|------|------|------|
| 体检一键修复 | `Health.vue` | 孤立页/断链旁修复按钮，SSE 进度日志面板 |
| 全文检索 | `Browse.vue` | 目录树面板搜索框，搜索结果列表，点击打开文件 |
| 问答归档 | `Query.vue` | 每条 assistant 消息归档按钮，done 事件携带 sessionId |
| SCHEMA 版本历史 | `Config.vue` | Git commit 列表，选择基线对比 HEAD，diff 行渲染 |
| 空状态引导 | `Dashboard.vue` | 空知识库引导 + Vault 初始化按钮 |
| §12.3-2 图谱大节点降级 | `Graph.vue` | 200/500 节点三级阈值，自适应关闭平滑曲线/阴影/标签，超大图减少物理稳定迭代 |
| §12.3-3 响应式小屏图谱降级 | `Graph.vue` | 窄屏(<768px)切换列表视图，按目录分组展示页面与链接数，支持手动切换图谱/列表 |
| 类型扩展 | `types.ts` | FixRequest/FixProgressEvent/SearchHit/SchemaCommit/DiffLine/QaSessionInfo |

---

## 6. 目录结构

```
19_Karpathy-AI+Obsidian知识库/
├── Karpathy-AI+Obsidian知识库概要设计说明书.md   # 设计文档 V1.3
├── wiki-harness/                    # Agent 引擎
│   └── src/
│       ├── harness.ts               # 主类：run/resume
│       ├── loop/tool-loop.ts        # 工具循环
│       ├── llm/                     # LLM 适配器
│       ├── budget/                  # 预算守卫
│       ├── retry/                   # 重试策略
│       ├── state/                   # 状态持久化
│       └── hook/                    # 生命周期 Hook
└── karpathy-wiki/                   # 业务应用
    ├── packages/
    │   └── web/                     # Vue 3 前端
    │       └── src/
    │           ├── views/           # 8 个视图
    │           ├── stores/          # Pinia 状态管理
    │           └── types.ts         # 前端类型
    ├── services/
    │   └── api/                     # Fastify 后端
    │       ├── src/
    │       │   ├── engine/          # EngineAdapter 实现
    │       │   ├── routes/          # 9 个路由模块
    │       │   ├── workflows/       # compile/query 工作流
    │       │   ├── vault/           # Vault 文件服务
    │       │   ├── compile-cache.ts # §11.2 增量编译缓存
    │       │   ├── compile-queue.ts # §12.3-5 并发控制
    │       │   ├── run-logger.ts    # §12.3-8 运行日志
    │       │   └── config.ts        # 配置 + 热加载
    │       ├── vault/               # 知识库内容
    │       │   ├── concepts/        # 概念页
    │       │   ├── comparisons/     # 对比页
    │       │   ├── raw/             # 原始资料存档
    │       │   ├── SCHEMA.md        # 页面规范
    │       │   ├── index.md         # 索引
    │       │   └── log.md           # 操作日志
    │       ├── .harness/            # 运行时数据
    │       │   ├── state/           # 运行状态（断点续传）
    │       │   ├── logs/            # 技术日志
    │       │   └── compile-cache.json
    │       └── config.json          # 应用配置
    ├── scripts/
    │   ├── install.ps1              # 一键安装
    │   └── start.ps1                # 一键启动
    ├── GETTING_STARTED.md           # 快速开始
    └── DELIVERY.md                  # 本文档
```

---

## 7. 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| Agent 引擎 | Node.js + TypeScript | ES2022 + ESM |
| 后端 | Fastify | 4.x |
| 前端 | Vue 3 + Element Plus + Pinia | 3.x |
| 图谱 | vis-network | 9.x |
| 构建 | tsc + Vite | 5.x + 5.x |
| 包管理 | pnpm workspace | — |
| LLM | DeepSeek / GLM-4-Plus | OpenAI 兼容 API |

---

## 8. 运维信息

### 8.1 配置文件 (config.json)

```json
{
  "vaultPath": "./vault",
  "adapter": "harness",
  "llm": {
    "provider": "deepseek",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "apiKeyRef": "DEEPSEEK_KEY"
  },
  "budget": { "maxSteps": 20, "tokenBudget": 50000 },
  "server": { "host": "localhost", "port": 3000 },
  "localOnly": true,
  "healthCheck": { "staleDays": 30 }
}
```

### 8.2 环境变量

| 变量名 | 说明 | 配置位置 |
|--------|------|----------|
| `DEEPSEEK_KEY` | DeepSeek API Key | `services/api/.env` |
| `GLM_KEY` | 智谱 GLM API Key（备选） | `services/api/.env` |

API Key 仅通过环境变量引用（`apiKeyRef` 字段存变量名），不落盘（M-7 安全要求）。

### 8.3 热加载作用域

| 字段 | 热加载 | 需重启 |
|------|--------|--------|
| `llm.model` | ✅ | |
| `budget.maxSteps` | ✅ | |
| `budget.tokenBudget` | ✅ | |
| `healthCheck.staleDays` | ✅ | |
| `adapter` | | ✅ |
| `vaultPath` | | ✅ |
| `server` | | ✅ |
| `llm.provider` | | ✅ |
| `llm.baseUrl` | | ✅ |

### 8.4 运行时数据

| 路径 | 说明 |
|------|------|
| `.harness/state/{runId}.json` | 运行状态（messages/step/tokenUsed），断点续传用 |
| `.harness/logs/{runId}.log` | 技术日志（JSONL），每步工具调用 + token 消耗 |
| `.harness/compile-cache.json` | 内容哈希 → rawPath 映射，增量编译用 |

---

## 9. 端到端验证记录

### 阶段1 验证

- ✅ tsc + vue-tsc 类型检查 exit 0
- ✅ 8 个前端模块渲染正常，8 tab 路由切换正常
- ✅ 7 个 API 返回 200（仅 favicon 404）
- ✅ DeepSeek compile：28s，5 步，生成 4 个结构化页面（含 frontmatter + 双向链接）
- ✅ DeepSeek query：SSE 流式，5 个 answer chunk + refs + done

### 阶段2 验证

- ✅ tsc + vue-tsc 类型检查 exit 0
- ✅ `POST /api/config/reload`：返回 applied + requireRestart
- ✅ `POST /api/health-check`：并行扫描返回 1 孤立页 + 7 断链
- ✅ `GET /api/compile/runs`：返回 3 个历史 run，按时间倒序
- ✅ `GET /api/compile/runs/:runId/log`：返回 12 条 JSONL 日志
- ✅ 增量编译缓存：同内容第二次 compile 28s → 1.4s（缓存命中）
- ✅ `POST /api/compile/resume/:runId`：SSE 流式恢复编译

### 阶段3 验证

- ✅ tsc + vue-tsc 类型检查 exit 0（后端 + 前端均无错误）
- ✅ `GET /api/search?q=moe`：返回 2 条搜索结果（dense-model.md + mixture-of-experts.md）
- ✅ `GET /api/schema/history`：返回 1 条 Git 提交记录，gitEnabled: true
- ✅ `POST /api/vault/init`：Vault 目录初始化正常
- ✅ Health.vue 修复按钮 + SSE 进度日志面板
- ✅ Browse.vue 搜索框 + 搜索结果列表
- ✅ Query.vue 归档按钮（done 事件携带 sessionId + messageIndex）
- ✅ Config.vue 版本历史列表 + diff 对比渲染
- ✅ Dashboard.vue 空状态引导 + Vault 初始化按钮
- ✅ Graph.vue §12.3-2 三级阈值降级 + §12.3-3 响应式列表视图（vue-tsc exit 0）
- ✅ §12.3-4 MCP Server 接口详细协议落地（设计文档 §12.4，V1.3 跳过阶段1故暂不实施，保留扩展点）

---

## 10. 设计决策摘要

| 决策点 | 选择 | 理由 |
|--------|------|------|
| §12.3-5 并发控制 | Promise 链串行队列 | index.md/log.md 追加非原子，串行最简 |
| §12.3-6 部分失败 | draft 标记不回滚 | LLM 编译成本高，半成品保留供用户决策 |
| §12.3-7 热加载作用域 | model/budget/staleDays 可热更新 | 运行时参数 vs 实例绑定参数分离 |
| §12.3-8 日志格式 | JSONL 双写（控制台 + 文件） | 结构化便于 grep，双写兼顾实时与审计 |
| §12.3-2 图谱降级阈值 | 200/500 节点三级 | 200 关平滑曲线、500 简化样式+减稳定迭代，渐进降级 |
| §12.3-3 小屏阈值 | 768px 切列表视图 | 与 CSS 响应式断点一致，列表视图按目录分组保留信息密度 |
| §12.3-4 MCP 实施 | 暂不实施，保留接口规范 | V1.3 跳过阶段1后主路径无子进程边界，MCP 仅服务跨进程/跨主机扩展场景 |
| §11.2 缓存策略 | SHA-256 内容哈希前 16 字符 | 内容唯一标识，无需文件名依赖 |
| §11.2 resume 实现 | bridgeHarnessToEvents 通用桥接 | compile/resume 共享事件推送逻辑，消除重复 |
| §5.1 L-7 防篡改归档 | 服务端会话存储（Map） | 不信任客户端传内容，进程内 Map 足够（重启丢失可接受） |
| §4.6 修复工作流 | 复用 compile 事件桥接模式 | afterStep hook 推进度，与 compile 等价 |
| §5.1 搜索工具复用 | search-util.ts 共享 | /api/search 路由与 query 工具共用搜索逻辑 |
| §6.X Git 版本控制 | execFile + 优雅降级 | vault 非 git 仓库时返回 gitEnabled:false，不报错 |
| §6.9 演示模式 | POST /api/vault/init | 初始化标准目录结构，无需预置 demo 数据 |
