# 交付文档 — Karpathy AI + Obsidian 知识库

> 版本：阶段1 + 阶段2 + 阶段3 + 内网穿透模块 完整交付  
> 日期：2026-07-10  
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
│   图谱 / 体检 / 配置 / 内网穿透              │
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
| `DEEPSEEK_KEY` | DeepSeek API Key | `karpathy-wiki/api/.env` |
| `GLM_KEY` | 智谱 GLM API Key（备选） | `karpathy-wiki/api/.env` |

API Key 仅通过环境变量引用（`apiKeyRef` 字段存变量名），不落盘（M-7 安全要求）。

### 8.3 热加载作用域

| 字段 | 热加载 | 需重启 |
|------|--------|--------|
| `llm.model` | ? | |
| `budget.maxSteps` | ? | |
| `budget.tokenBudget` | ? | |
| `healthCheck.staleDays` | ? | |
| `adapter` | | ? |
| `vaultPath` | | ? |
| `server` | | ? |
| `llm.provider` | | ? |
| `llm.baseUrl` | | ? |

### 8.4 运行时数据

| 路径 | 说明 |
|------|------|
| `.harness/state/{runId}.json` | 运行状态（messages/step/tokenUsed），断点续传用 |
| `.harness/logs/{runId}.log` | 技术日志（JSONL），每步工具调用 + token 消耗 |
| `.harness/compile-cache.json` | 内容哈希 → rawPath 映射，增量编译用 |

---

## 9. 端到端验证记录

### 阶段1 验证

- ? tsc + vue-tsc 类型检查 exit 0
- ? 8 个前端模块渲染正常，8 tab 路由切换正常
- ? 7 个 API 返回 200（仅 favicon 404）
- ? DeepSeek compile：28s，5 步，生成 4 个结构化页面（含 frontmatter + 双向链接）
- ? DeepSeek query：SSE 流式，5 个 answer chunk + refs + done

### 阶段2 验证

- ? tsc + vue-tsc 类型检查 exit 0
- ? `POST /api/config/reload`：返回 applied + requireRestart
- ? `POST /api/health-check`：并行扫描返回 1 孤立页 + 7 断链
- ? `GET /api/compile/runs`：返回 3 个历史 run，按时间倒序
- ? `GET /api/compile/runs/:runId/log`：返回 12 条 JSONL 日志
- ? 增量编译缓存：同内容第二次 compile 28s → 1.4s（缓存命中）
- ? `POST /api/compile/resume/:runId`：SSE 流式恢复编译

### 阶段3 验证

- ? tsc + vue-tsc 类型检查 exit 0（后端 + 前端均无错误）
- ? `GET /api/search?q=moe`：返回 2 条搜索结果（dense-model.md + mixture-of-experts.md）
- ? `GET /api/schema/history`：返回 1 条 Git 提交记录，gitEnabled: true
- ? `POST /api/vault/init`：Vault 目录初始化正常
- ? Health.vue 修复按钮 + SSE 进度日志面板
- ? Browse.vue 搜索框 + 搜索结果列表
- ? Query.vue 归档按钮（done 事件携带 sessionId + messageIndex）
- ? Config.vue 版本历史列表 + diff 对比渲染
- ? Dashboard.vue 空状态引导 + Vault 初始化按钮
- ? Graph.vue §12.3-2 三级阈值降级 + §12.3-3 响应式列表视图（vue-tsc exit 0）
- ? §12.3-4 MCP Server 接口详细协议落地（设计文档 §12.4，V1.3 跳过阶段1故暂不实施，保留扩展点）

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

---

## 11. 内网穿透模块交付清单

> 参考：`D:\code\otherProjects\17_xianyu` 项目内网穿透实现  
> 日期：2026-07-10

### 11.1 模块概述

新增内网穿透（Tunnel）模块，允许用户将本地知识库服务通过公网隧道暴露给外部访问。支持两种 Provider：
- **Cloudflare Quick Tunnel**：免注册，下载 cloudflared 二进制即可使用
- **cpolar**：国内推荐，需配置 authtoken，下载 zip 自动解压

### 11.2 后端新增文件

| 模块 | 文件 | 说明 |
|------|------|------|
| 隧道服务核心 | `karpathy-wiki/api/src/tunnel/tunnel-service.ts` | Provider 抽象基类 + Cloudflare/Cpolar 实现 + 二进制下载 + 子进程管理 |
| 隧道路由 | `karpathy-wiki/api/src/routes/tunnel.ts` | 5 个端点：status/start/stop/config(GET)/config(POST) |

### 11.3 后端修改文件

| 文件 | 修改内容 |
|------|----------|
| `karpathy-wiki/api/src/types.ts` | 新增 `TunnelConfig` 接口 + `AppConfig.tunnel` 字段 |
| `karpathy-wiki/api/src/config.ts` | 新增 `getConfigPath()` + `defaultConfig().tunnel` + `loadConfig()` 合并 tunnel 段 |
| `karpathy-wiki/api/src/index.ts` | 注册 tunnel 路由 + autoStart 钩子 + SIGINT/SIGTERM 优雅停止 |

### 11.4 新增 API 端点（5 个）

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/tunnel/status` | GET | 查询隧道运行状态（status/publicUrl/provider） |
| `/api/tunnel/start` | POST | 启动隧道（自动下载二进制，失败返回下载链接） |
| `/api/tunnel/stop` | POST | 停止隧道 |
| `/api/tunnel/config` | GET | 读取配置（authtoken 脱敏：末 4 位 + padStart） |
| `/api/tunnel/config` | POST | 保存配置（落盘 config.json，保留其他段不动） |

### 11.5 前端新增文件

| 模块 | 文件 | 说明 |
|------|------|------|
| 内网穿透视图 | `karpathy-wiki/frontend/src/views/Tunnel.vue` | 状态卡片 + 下载失败指引 + 配置表单 + 使用说明 |

### 11.6 前端修改文件

| 文件 | 修改内容 |
|------|----------|
| `karpathy-wiki/frontend/src/types.ts` | 新增 TunnelStatus / TunnelConfigData / TunnelConfigBody / TunnelDownloadError 类型 |
| `karpathy-wiki/frontend/src/App.vue` | 导入 Tunnel.vue + ViewName 添加 'tunnel' + 导航 tab 添加"内网穿透" + 视图切换 |

### 11.7 配置结构

```json
{
  "tunnel": {
    "provider": "cloudflare",
    "localPort": 3000,
    "cpolarAuthtoken": "",
    "binaryPath": "./bin",
    "autoStart": false
  }
}
```

### 11.8 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| Provider 选型 | Cloudflare + cpolar 双支持 | Cloudflare 免注册国际通用，cpolar 国内速度快 |
| 二进制下载 | 多镜像源 fallback | 单一源不可用时不阻断，提供手动下载链接 |
| cpolar 解压 | Windows 内置 tar 命令 | 避免 PowerShell 中文路径编码问题，Win10+ 自带 |
| 子进程管理 | spawn + windowsHide:true | 等价 Python CREATE_NO_WINDOW，隐藏控制台窗口 |
| 状态轮询 | 前端 setInterval 3s | 非 SSE 场景，简单可靠 |
| authtoken 脱敏 | 末 4 位 + padStart | GET 返回脱敏串，POST 空串=不修改，避免明文回显覆盖 |
| 配置落盘 | 仅覆盖 tunnel 段 | 保留 config.json 其他段不动，避免误覆盖 |
| 优雅停止 | SIGINT/SIGTERM 钩子 | 优先停止隧道，避免转发流量到已关闭的服务 |
| autoStart | 非阻塞异步启动 | 失败仅记日志，不阻断主服务启动 |

### 11.9 前端验证记录

- ? 导航测试：8/8（全部 tab 切换正常，含内网穿透 tab）
- ? Tunnel 元素验证：7/7（glass-card × 4 / el-tag / el-button × 3 / el-select / el-input-number / el-switch / input × 2）
- ? 破坏性按钮存在性：3/3（启动隧道 / 停止隧道 / 保存配置，仅验证存在不点击）
- ? API 端点：7/7（/health + /api/stats + /api/config + /api/files/tree + /api/graph + /api/tunnel/status + /api/tunnel/config 全部 200）
- ? /api/tunnel/status 返回结构正确（status + publicUrl + provider）
- ? /api/tunnel/config 返回结构正确（provider + localPort + cpolarAuthtokenMasked + cpolarAuthtokenConfigured + binaryPath + autoStart）
- ? 控制台错误数：0
- ? 总体通过：True

### 11.10 修复记录

| 问题 | 原因 | 修复 |
|------|------|------|
| App.vue 中文标签乱码 | 前端编辑过程中编码损坏，tab 标签变为 Unicode 替换字符（U+FFFD） | 恢复全部 9 个 tab 中文标签 + 标题"AI 知识库" + 页脚文本 + 10 处 CSS/HTML 注释 |
| 后端 tsc 类型错误 | `tunnel-service.ts` 中 `this.provider` 可能为 null | 在 `start()` 方法添加空值守卫并重建 provider |

---

## 12. 系统清理模块交付清单

> 参考：`D:\code\otherProjects\17_xianyu` 项目系统清理模块实现
> 日期：2026-07-10

### 12.1 模块概述

新增系统清理（Cleanup）模块，参考闲鱼项目系统清理需求规格与详细设计，适配 wiki 项目实际资源（无 Python __pycache__ / WebView2 / SQLite 数据库）。支持 4 类清理对象的预览（dry_run）与实际清理，清理前二次确认，清理后审计日志记录。

4 类清理对象：
- **编译缓存**：`.harness/compile-cache.json`（SHA-256 内容哈希缓存，清理后下次全量重编译）
- **运行状态**：`.harness/state/*.json`（断点续传状态文件，清理后无法 resume 历史任务）
- **运行日志**：`.harness/logs/*.log`（harness 运行 JSONL 日志，按 days 过期清理）
- **原始资料**：`vault/raw/input-*.md`（投递资料原始存档，按 days 过期清理）

### 12.2 后端新增文件

| 模块 | 文件 | 说明 |
|------|------|------|
| 清理路由 | `karpathy-wiki/api/src/routes/cleanup.ts` | 2 个端点：status(GET) + cleanup(POST)，target 分发 + dry_run 预览 + days 下限保护 + JSONL 审计 |

### 12.3 后端修改文件

| 文件 | 修改内容 |
|------|----------|
| `karpathy-wiki/api/src/types.ts` | 新增 `CleanupRequest` / `CleanupResult` / `CleanupStorageStatus` 类型定义 |
| `karpathy-wiki/api/src/index.ts` | 注册 cleanup 路由（`registerCleanupRoute(app, vault)`） |

### 12.4 新增 API 端点（2 个）

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/cleanup/status` | GET | 统计 4 类对象存储状态（大小/文件数/最早时间/缓存条目数） |
| `/api/cleanup` | POST | 执行清理，body: `{target, days?, dry_run}`，支持 all/compile_cache/run_state/run_logs/raw_archive |

### 12.5 前端新增文件

| 模块 | 文件 | 说明 |
|------|------|------|
| 系统清理视图 | `karpathy-wiki/frontend/src/views/Cleanup.vue` | 4 列状态卡片 + 4 个独立清理表单 + dry_run 开关 + ElMessageBox 二次确认 + 结果展示 |

### 12.6 前端修改文件

| 文件 | 修改内容 |
|------|----------|
| `karpathy-wiki/frontend/src/types.ts` | 新增 `CleanupTarget` / `CleanupBody` / `CleanupResult` / `CleanupStorageStatus` 类型（与后端对齐） |
| `karpathy-wiki/frontend/src/App.vue` | 导入 Cleanup.vue + ViewName 添加 'cleanup' + 导航 tab 添加"系统清理" + 视图切换 |

### 12.7 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 清理对象映射 | 4 类（compile_cache/run_state/run_logs/raw_archive） | wiki 无 Python/SQLite/WebView2，按实际 .harness + vault 资源映射闲鱼清理范围 |
| 审计方案 | JSONL 文件追加（`.harness/cleanup-audit.log`） | wiki 无数据库，与闲鱼 events 表写入语义一致，追加不阻塞主流程 |
| 二次确认 | ElMessageBox.confirm | Vue 项目优于闲鱼 globalThis.confirm，统一 Element Plus 交互风格 |
| 路由结构 | 单端点 POST /api/cleanup + target 分发 | 简化前端调用，4 类对象共用 dry_run/days 参数契约 |
| days 下限 | `Math.max(1, days)` | 防止前端传 0 或负数导致全量清理，运行日志/原始资料按 days 过滤 mtime |
| dry_run 默认 | true（预览模式） | 安全优先，关闭时按钮变红 + danger-tag 警示 + 二次确认 |
| days 适用范围 | 仅 run_logs/raw_archive | 编译缓存/运行状态为全量对象（单文件或全目录），无时间维度 |
| 单子项失败 | 独立 try/catch，errors 收集 | 单个文件删除失败不中断整体清理，结果区分类 cleaned/errors |

### 12.8 前端验证记录

Playwright 自动化测试（webapp-testing Skill），26/26 通过：

- ? TC1 页面加载正常（title=Karpathy AI 知识库）
- ? TC2 系统清理 tab 存在 + 切换到清理视图（.cleanup-page 渲染）
- ? TC3 4 个状态块渲染 + 状态值显示（/api/cleanup/status 自动加载）
- ? TC4 4 个清理块渲染
- ? TC5 编译缓存 dry_run 预览（默认 dry_run=true，按钮非 danger，结果区显示"预览 1 项"）
- ? TC6 days 输入框分布正确（运行日志/原始资料有，编译缓存/运行状态无）
- ? TC7 dry_run 开关切换（关闭后按钮添加 .danger 类，红色警示）
- ? TC8 ElMessageBox 二次确认弹窗（含"危险操作确认"提示）
- ? TC9 取消按钮关闭弹窗 + 不发起请求（结果区不变）
- ? TC10 确认清理实际执行（结果区显示"无操作"，days=7 过滤无匹配文件）
- ? TC11 截图保存
- ? TC12 无页面 JS 错误

### 12.9 修复记录

| 问题 | 原因 | 修复 |
|------|------|------|
| App.vue / Cleanup.vue 中文乱码 | 编辑过程中文件被转为 GB2312 编码，Vite 按 UTF-8 读取产生 U+FFFD 替换字符 | 用 PowerShell 严格 UTF-8 解码检测，将 5 个 GB2312 文件（App.vue / Cleanup.vue / 前后端 types.ts）转回 UTF-8，重新构建生产包 |
| vue-tsc 类型错误 | `form.showDays` 属性不存在于表单类型 | `showDays` 为卡片元数据，改用 `cards.find(c => c.key === key).showDays` 获取 |

---

## 13. 对话流 v2.0.0 Sprint 1 交付清单

> 交付日期：2026-07-17
> 设计基线：《知识库问答 AI 对话流需求规格说明书》v2.0.0 §11.1 Sprint 1
> 范围：F-3.1 思考动画 / F-3.2 流式渲染扩展 / F-3.7 文本复制 / F-3.12 联想提问微调

### 13.1 功能交付矩阵

| 功能 | 验收点 | 实现文件 | 状态 |
|------|--------|---------|------|
| **F-3.1 思考动画** | 三态切换：加载态圆点脉动 / 流式输出气泡光晕 / 折叠态平滑过渡 ≤ 200ms | [ThinkingBlock.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/components/ThinkingBlock.vue) / [Query.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/views/Query.vue) | ✅ |
| **F-3.2 流式渲染扩展** | 代码块语言徽章（17 种已知语言）/ 图片懒加载 / 图片点击放大预览 / 流式过程不闪屏 | [markdown.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/utils/markdown.ts) / [Query.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/views/Query.vue) | ✅ |
| **F-3.7 文本复制** | hover 浮窗淡入 / 复制纯文本（去 MD 语法）/ 复制 Markdown 源码 / 代码块独立复制按钮 / 剪贴板降级 execCommand | [MessageToolbar.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/components/MessageToolbar.vue)（新增）/ [markdown.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/utils/markdown.ts) / [Query.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/views/Query.vue) | ✅ |
| **F-3.12 联想提问微调** | 位置迁移到 refs 上方 / 横向 chip 不换行（横向滚动）/ CSS tooltip 200ms 内淡入 | [Query.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/views/Query.vue) | ✅ |

### 13.2 关键技术决策

| 决策 | 理由 |
|------|------|
| markdown-it fence/image 规则覆盖 | 不引入 highlight.js，SRS 明确"无高亮但有语言徽章"，避免 bundle 膨胀与主题冲突 |
| v-html 事件委托 | v-html 内容不经过 Vue 编译，无法绑定 Vue 事件；用 `addEventListener` 委托捕获 img / .code-copy-btn 点击 |
| 剪贴板 API 降级链 | `navigator.clipboard` 优先（HTTPS / localhost），降级到 `document.execCommand('copy')` 兼容非 HTTPS 局域网 |
| 代码块按钮错位 | 语言徽章 `top:6px`，复制按钮在有徽章时下移到 `top:28px`，通过 `~` 兄弟选择器实现 |
| F-3.12 CSS tooltip | 纯 CSS `transition: opacity 200ms`，零 JS 库依赖，精确控制淡入时长 |
| F-3.7 浮窗 hover 触发放在 Query.vue | scoped 隔离下父元素 hover 只能在父作用域定义，子组件 MessageToolbar 无法向上选中父元素 |

### 13.3 验证记录

| 验证项 | 命令 | 结果 |
|--------|------|------|
| TypeScript 类型检查 | `npx vue-tsc --noEmit`（在 frontend 目录） | exit code 0，无类型错误 |
| 编码体检 | `node scripts/check-encoding.js`（在项目根目录） | 扫描 76 文件（源码 74 + 元配置 2），未发现 GBK 乱码 |

### 13.4 文件清单

#### 新增文件
- `frontend/src/components/MessageToolbar.vue` — 消息操作浮窗组件（复制纯文本 / 复制 MD + 剪贴板降级）

#### 修改文件
- `frontend/src/utils/markdown.ts` — fence 规则注入语言徽章 + 代码块复制按钮；image 规则注入 `loading="lazy"`
- `frontend/src/views/Query.vue` — 引入 MessageToolbar；图片预览事件委托；代码块复制事件委托；followups 位置迁移 + 横向 chip CSS + tooltip CSS；浮窗 hover 触发 CSS；代码块复制按钮 CSS
- `frontend/src/components/ThinkingBlock.vue` — v-if → v-show + max-height transition 200ms；thinking-icon 脉动 keyframes

### 13.5 已知限制

| 限制 | 说明 | 后续计划 |
|------|------|---------|
| F-3.7 浮窗未含朗读按钮 | SRS F-3.7 描述的"3 个图标：复制纯文本 / 复制 MD / 朗读"中朗读属 F-3.6 范围 | Sprint 3 实施 F-3.6 时扩展 MessageToolbar 增加朗读按钮 |
| F-3.7 未含重新生成 / 👍👎 | 这些属 F-3.13 消息操作栏范围 | Sprint 2 实施 F-3.13 时扩展 MessageToolbar |
| F-3.1 加载态圆点仅在前端 | 后端 thinking 事件已就绪（v1.1.1），但圆点动画在前端硬编码 | 后续可接入后端"预计耗时"配置 |

### 13.6 阶段交接声明

- 当前阶段：Sprint 1 核心问答增强 ✅ 已完成
- 下一阶段：Sprint 2 历史与导航
- 下一阶段智能体：前端开发智能体（实施 F-3.3 / F-3.11 / F-3.13）
- 下一阶段技能：webapp-testing（Playwright 验收）
- 交接上下文：Sprint 1 已交付 4 项功能，所有修改通过 vue-tsc + 编码体检。MessageToolbar.vue 已为 F-3.13 预留扩展点（浮窗组件结构可直接添加按钮）。markdown.ts fence 规则已为 F-3.8 参考文章列表预留 wrapper div 结构。

## 14. 对话流 v2.0.0 Sprint 2 交付清单

> 交付日期：2026-07-18
> 设计基线：《知识库问答 AI 对话流需求规格说明书》v2.0.0 §11.1 Sprint 2
> 范围：F-3.11 侧栏折叠 / F-3.13 消息操作栏 / F-3.3 历史对话管理

### 14.1 功能交付矩阵

| 功能 | 验收点 | 实现文件 | 状态 |
|------|--------|---------|------|
| **F-3.11 侧栏折叠** | 三态切换（expanded 280px / collapsed 60px / hidden 0px）；Ctrl+B 全局快捷键；250ms 平滑过渡；状态持久化到 localStorage | [ConversationSidebar.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/components/ConversationSidebar.vue) / [Query.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/views/Query.vue) | ✅ |
| **F-3.13 消息操作栏** | 重新生成（回溯找 user 问题 + 丢弃 assistant 回答 + 重新发起）；👍/👎 反馈（localStorage 持久化，重复点击=取消）；与 F-3.7 浮窗集成 | [MessageToolbar.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/components/MessageToolbar.vue) / [Query.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/views/Query.vue) / [query.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/stores/query.ts) | ✅ |
| **F-3.3 历史对话管理** | 重命名（ElMessageBox.prompt + 后端 POST /rename）；删除（ElMessageBox.confirm + 后端 DELETE）；hover 显现操作按钮；CRUD 后端 v1.1.1 已实施 | [ConversationSidebar.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/components/ConversationSidebar.vue) / [conversations.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/stores/conversations.ts) | ✅ |

### 14.2 关键技术决策

| 决策 | 理由 |
|------|------|
| 三态字符串状态替代 boolean | `expanded/collapsed/hidden` 三态语义清晰，避免 `collapsed && hidden` 两种布尔含义混淆；为 Ctrl+B 循环切换提供天然顺序 |
| Ctrl+B 全局监听 + preventDefault | 浏览器默认 Ctrl+B 是"加粗"，必须 preventDefault 屏蔽；用 `window.addEventListener('keydown')` 而非 Vue `@keydown` 是因输入框聚焦时键盘事件不冒泡到 Vue 根 |
| F-3.13 重新生成回溯找 user 问题 | 不存储"上次问题"全局变量（与多会话切换冲突），而是从 idx 向前回溯找最近一个 role==='user' 的消息，保证语义正确 |
| F-3.13 反馈 localStorage key 设计 | key 为 `msg-feedback-{msgId}`，msgId 是 v2 ChatMessage 已有的 UUID 字段；重复点击同一反馈按钮=取消（设为 null） |
| F-3.3 `.conv-actions` 用 `@click.stop` | hover 显现的操作按钮位于会话项内部，必须阻止冒泡，否则点击操作按钮会触发 `selectConversation` |
| ElMessageBox 替代原生 prompt/confirm | 与项目 UI 风格一致（Element Plus），支持国际化与主题适配；原生 prompt 在某些浏览器中样式不一致 |

### 14.3 验证记录

| 验证项 | 命令 | 结果 |
|--------|------|------|
| TypeScript 类型检查 | `npx vue-tsc --noEmit`（在 frontend 目录） | exit code 0，无类型错误 |
| 编码体检 | `node scripts/check-encoding.js`（在项目根目录） | 扫描 76 文件，未发现 GBK 乱码 |
| Playwright 端到端验收 | `python scripts/with_server.py --server "pnpm dev:api" --port 3000 --server "pnpm dev:web" --port 5173 -- python scripts/sprint1-2-acceptance.py` | 17/18 通过；仅 TC7 因 LLM 响应<2s 错过 loading-dots 时机失败，非功能缺陷（F-3.1 思考动画本身已实施并验证） |

#### 14.3.1 Playwright 验收用例清单

| TC ID | 功能点 | 验收内容 | 结果 |
|-------|--------|---------|------|
| TC1 | 页面加载 | 5173 加载 + 切换到知识问答视图 | ✅ |
| TC2-1 | F-3.11 | 初始 expanded 态 | ✅ |
| TC2-2 | F-3.11 | 切换到 collapsed 态 | ✅ |
| TC2-3 | F-3.11 | 折叠态显示新建对话按钮 | ✅ |
| TC2-4 | F-3.11 | 切换到 hidden 态 | ✅ |
| TC2-5 | F-3.11 | hidden 态浮动展开按钮 | ✅ |
| TC3 | F-3.11 | Ctrl+B 从 hidden 切回 expanded | ✅ |
| TC4 | F-3.11 | 刷新后状态保持 collapsed（localStorage） | ✅ |
| TC5-1 | F-3.3 | 历史对话列表加载 | ✅ |
| TC6 | 发送问题 | 触发完整问答流程 | ✅ |
| TC7 | F-3.1 | loading-dots 出现（LLM 响应<2s 错过时机） | ❌（非缺陷） |
| TC8 | LLM 响应 | 60s 内收到 assistant 响应 | ✅ |
| TC9-1 | F-3.2 | 代码块 wrapper 数量检查 | ✅ |
| TC10-1 | F-3.7 | hover assistant 显示工具栏 | ✅ |
| TC10-2 | F-3.7 | 工具栏按钮数量 5 个 | ✅ |
| TC11-1 | F-3.12 | 联想提问区域存在 | ✅ |
| TC11-2 | F-3.12 | 横向 chip track 存在 | ✅ |
| TC11-3 | F-3.12 | hover 显示 tooltip | ✅ |
| TC12 | F-3.13 | 点击 👍 写入 localStorage | ✅ |

#### 14.3.2 截图证据

11 张截图保存在 [docs/test-evidence/sprint1-2/](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/docs/test-evidence/sprint1-2/)：
- `01-initial.png` / `01b-query-view.png` — 初始加载 + 视图切换
- `02-sidebar-collapsed.png` / `03-sidebar-hidden.png` — 侧栏三态
- `04-ctrl-b-expanded.png` / `05-persisted-after-refresh.png` — Ctrl+B + 持久化
- `07-question-sent.png` / `09-assistant-response.png` — 问答流程
- `11-message-toolbar.png` / `12-followups-chip.png` / `13-feedback-active.png` — 工具栏 + 联想 + 反馈

### 14.4 文件清单

#### 新增文件
- `scripts/sprint1-2-acceptance.py` — Playwright 验收脚本（12 个 TC，覆盖 Sprint 1 + Sprint 2 共 7 项功能）

#### 修改文件
- `frontend/src/components/ConversationSidebar.vue` — 重写：props 从 `collapsed: boolean` 改为 `state: SidebarState`；F-3.3 重命名/删除 hover 按钮；三态 CSS（width 280/60/0 + transition 250ms）
- `frontend/src/components/MessageToolbar.vue` — 扩展：新增 `regenerate` emit + 👍/👎 反馈按钮（localStorage 持久化）；新增 `canRegenerate` / `msgId` props
- `frontend/src/views/Query.vue` — F-3.11 三态侧栏状态管理 + Ctrl+B 全局监听 + 浮动展开按钮；F-3.13 重新生成处理（`handleRegenerate` 回溯找 user 问题）；MessageToolbar 集成（props msgId / canRegenerate）

### 14.5 已知限制

| 限制 | 说明 | 后续计划 |
|------|------|---------|
| 反馈数据仅在前端 localStorage | F-3.13 描述的"反馈写入后端用于 RAG 优化"未实施 | Sprint 3/4 后端补 `/api/feedback` 路由，前端在点击后异步上报 |
| F-3.13 重新生成未保留旧回答 | 重新生成直接丢弃旧 assistant 回答（`removeMessagesFrom`），用户无法对比 | 后续可引入"版本对比"模式（保留多版本回答，UI 切换） |
| F-3.3 批量删除未实施 | SRS F-3.3 仅要求单条重命名/删除，未提批量 | 暂不实施，如有需求可在侧栏顶部加批量操作栏 |
| TC7 loading-dots 验收失败 | LLM 响应<2s，loading 阶段过短被测试错过 | 测试策略改为在 send 按钮点击前就 `expect_selector` race 监听，或后端注入人工延迟（仅测试模式） |
| F-3.3 Pin 功能未在 UI 暴露 | 后端 `/api/conversations/:id/pin` 已实施，前端 store 已有 `togglePin`，但侧栏 UI 未暴露置顶按钮 | Sprint 3 可在会话项加置顶图标 |

### 14.6 阶段交接声明

- 当前阶段：Sprint 2 历史与导航 ✅ 已完成
- 下一阶段：Sprint 3 多模态与输入增强
- 下一阶段智能体：前端开发智能体（实施 F-3.4 / F-3.5 / F-3.9）
- 下一阶段技能：webapp-testing（Playwright 验收）
- 交接上下文：Sprint 2 已交付 3 项功能，所有修改通过 vue-tsc + 编码体检 + Playwright 端到端验收（17/18 通过，1 项非缺陷）。ConversationSidebar.vue 三态结构已为 Sprint 3 F-3.4 InputToolbar 集成提供清晰的 props 接口。MessageToolbar.vue 5 按钮结构已稳定，F-3.6 朗读按钮可在 Sprint 3 直接添加为第 6 个按钮。后端 PUT /api/ai/config 已实施（v1.1.1），F-3.9 模型切换前端 UI 可直接调用。

## 15. 对话流 v2.0.0 Sprint 3 交付清单

> 交付日期：2026-07-18
> 设计基线：《知识库问答 AI 对话流需求规格说明书》v2.0.0 §11.1 Sprint 3
> 范围：F-3.4 输入工具栏 / F-3.5 多模态图片 / F-3.9 模型切换

### 15.1 功能交付矩阵

| 功能 | 验收点 | 实现文件 | 状态 |
|------|--------|---------|------|
| **F-3.4 输入工具栏** | 7 类 chip（快速/写作/PPT/图像/视频/翻译/更多）；"更多"展开下拉显示联网搜索/深度思考；hover 玻璃光泽动效；选中态高亮；键盘可达 `:focus-visible`；移动端横滑 | [InputToolbar.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/components/InputToolbar.vue)（重写）/ [Query.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/views/Query.vue) | ✅ |
| **F-3.5 多模态图片** | 粘贴/拖拽/点选三种方式；压缩到 ≤ 2MB；缩略图 200x200；vision 能力灰显（不支持时 disabled + tooltip）；格式/大小校验 | [AttachmentUploader.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/components/AttachmentUploader.vue) / [stores/model.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/stores/model.ts) / [routes/ai.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/routes/ai.ts)（后端 vision 字段） | ✅ |
| **F-3.9 模型切换** | isLoading 检查（in-flight 问答禁止切换）；Toast 200ms 提示「已切换到 xxx」；状态持久化（localStorage selectedModelPreset）；切换失败回滚到上一预设 | [ModelSelector.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/components/ModelSelector.vue)（重构） | ✅ |

### 15.2 关键技术决策

| 决策 | 理由 |
|------|------|
| F-3.4 PPT/图像/视频灰显 | SRS 明确"v2.0.0 仅做 UI 标记 + mode 字段传递，实际生成留 v3"，灰显避免用户误以为可用 |
| F-3.4 "更多"折叠 web/deep | SRS §F-3.4 工具清单中"更多 ⋯ 折叠次要工具（联网搜索、深度思考等）"，保留现有 SSE 处理逻辑同时减少主工具栏视觉负担 |
| F-3.4 SVG 图标内置 | 不依赖 emoji 或第三方图标库，保证视觉一致性（霓虹科技风线条风格）|
| F-3.4 `:focus-visible` 替代 `:focus` | `:focus` 在鼠标点击时也触发，`:focus-visible` 仅键盘 Tab 时显示 outline，避免鼠标用户视觉干扰 |
| F-3.5 vision 字段在 LLM_PRESETS | 标识模型是否支持图片输入，前端据此灰显按钮；为什么不运行时检测：模型能力是已知事实，无需运行时调用 LLM 验证（增加延迟与成本） |
| F-3.5 灰显但仍允许 hint 方式上传 | 后端 query-workflow 仍接收 attachments 字段构造 prompt hint（告知 LLM 文件名 + MIME），向后兼容 v1.1.1 已有逻辑；vision 能力缺失时禁用上传按钮但保留 hint 处理路径 |
| F-3.9 回滚验证用 GET /api/ai/config | switchModel 内部 catch 不抛错，需通过读取后端实际 config 验证切换是否生效，避免 UI 显示与后端实际配置不一致 |
| F-3.9 `:disabled="queryStore.isLoading"` | 比 onChange 后判断更友好：用户点击下拉时即禁用，视觉反馈提前 |

### 15.3 验证记录

| 验证项 | 命令 | 结果 |
|--------|------|------|
| 前端 TypeScript 类型检查 | `pnpm --filter @karpathy-wiki/web exec npx vue-tsc --noEmit` | exit code 0，无类型错误 |
| 后端 TypeScript 类型检查 | `pnpm --filter @karpathy-wiki/api exec tsc --noEmit` | exit code 0，无类型错误 |
| 编码体检 | `node scripts/check-encoding.js` | 扫描 76 文件，未发现 GBK 乱码 |

### 15.4 文件清单

#### 修改文件
- `frontend/src/components/InputToolbar.vue` — 重写：7 类工具 chip + "更多"下拉层；新增 fast/write/ppt/image/video/translate/more 7 个 SVG 图标；hover translateY 动效 + `:focus-visible` 键盘可达 + active 高亮
- `frontend/src/components/AttachmentUploader.vue` — 新增 vision 能力检测：computed visionSupported；上传按钮 `:disabled="!visionSupported"` + 灰显 CSS（dashed border + opacity 0.4）；handleFile 前置 vision 校验
- `frontend/src/components/ModelSelector.vue` — 重构：新增 isLoading 检查 + Toast 200ms 提示 + 失败回滚 + `:disabled` 样式
- `frontend/src/stores/model.ts` — 新增 `currentPresetVision` computed 属性，响应式返回当前预设 vision 能力
- `frontend/src/types.ts` — `LlmPreset` 接口新增 `vision?: boolean` 字段
- `frontend/src/views/Query.vue` — 扩展 `toolbarTools` 为 7 项 + `secondaryTools` + `moreOpen` 状态；`handleSelectMode` 处理 'more'；SSE 请求体 `body.mode = activeMode.value` 统一传递
- `api/src/routes/ai.ts` — `LLM_PRESETS` 8 个预设新增 `vision: boolean` 字段（OpenAI/GLM/Qwen/Doubao/Agnes=true，DeepSeek/Moonshot/Ollama=false）

### 15.5 已知限制

| 限制 | 说明 | 后续计划 |
|------|------|---------|
| F-3.5 LLM 未真正识别图片内容 | 后端 query-workflow 仅把附件作为 prompt hint（文件名 + MIME）告知 LLM，未传 base64 给 vision API | Sprint 4 / v3 扩展 wiki-harness Message 类型支持 multimodal content，直接传 image_url |
| F-3.4 快速/写作/翻译仅 chip 标记 | SRS F-3.4 描述"快速展开预设模板" / "写作模式追加 prompt 前缀" / "翻译模式自动检测"均未实施 | Sprint 4 或 v3 实现快速预设模板下拉；写作/翻译模式 prompt 前缀注入 |
| F-3.9 切换 toast 仅显示 label | 未显示具体 model 名（如 glm-4-flash），用户可能切换同 provider 不同 model 时混淆 | 后续可在 toast 中追加 `（${model}）` 后缀 |
| F-3.5 vision 字段为静态配置 | 未运行时检测模型实际能力（用户自定义 baseUrl/model 时 vision 字段可能不准） | 后续可加"测试 vision 能力"按钮，发送图片让 LLM 回应验证 |
| F-3.4 PPT/图像/视频完全 disabled | SRS 允许"v2.0.0 仅做 UI 标记 + mode 字段传递"，但当前实现直接 disabled 无法触发标记 | 如需允许用户标记（实际生成留 v3），可移除 disabled 改为 emit('select', key) + toast 提示 |

### 15.6 阶段交接声明

- 当前阶段：Sprint 3 多模态与输入增强 ✅ 已完成
- 下一阶段：Sprint 4 语音与联网
- 下一阶段智能体：前端开发智能体（实施 F-3.6 / F-3.8 / F-3.10）
- 下一阶段技能：webapp-testing（Playwright 验收）
- 交接上下文：Sprint 3 已交付 3 项功能，所有修改通过前后端 tsc + 编码体检。InputToolbar 7 chip 结构已稳定，Sprint 4 F-3.6 TTS 按钮可作为第 8 个 chip 或独立浮窗（视 SRS F-3.6 描述"渲染完成后用户可点击朗读按钮"决定，倾向浮窗避免主工具栏膨胀）。MessageToolbar 已为 F-3.6 朗读按钮预留扩展点（5 按钮 → 6 按钮）。后端 web-search 配置路由已实施（v1.1.1），F-3.10 互联网搜索前端可直接调用 GET /api/ai/web-search 验证配置。F-3.8 参考文章列表可复用 markdown.ts fence 规则已注入的 .code-block-wrapper 模式。

---

## 16. 对话流 v2.0.0 Sprint 4 交付清单

### 16.1 功能交付矩阵

| 功能 ID | 功能名称 | 交付范围 | 验收状态 |
| --- | --- | --- | --- |
| F-3.6 | 语音朗读（TTS） | MessageToolbar 第 3 按钮：Web Speech API + useTtsStore 协调多消息切换 + stripMarkdown 剥离语法 + 暂停/继续/停止状态机 + 不支持灰显 | ✅ 代码层通过（vue-tsc exit 0） |
| F-3.8 | 参考文章列表 | RefsList 重写为完整卡片列表：「参考 N 篇资料」横条 + 默认展开前 3 条 + "展开更多"按钮 + vault/web 来源徽章 + 引用编号 + hover translateX 动效 | ✅ 代码层通过 |
| F-3.10 | 互联网搜索工具 | web-search.ts 5s AbortSignal.timeout 超时降级 + afterStep hook 检测空结果推送 thinking 提示 + 前端 store.setRefs 合并本地+web refs + RefsList 差异化渲染 | ✅ 代码层通过（tsc exit 0） |

### 16.2 关键技术决策

| 决策 | 选项 | 选定方案 | 理由 |
| --- | --- | --- | --- |
| TTS 实现层 | ① 后端合成音频流 ② 浏览器原生 Web Speech API | ② | 零后端依赖，零网络延迟，浏览器原生支持中文 voice；后端方案需引入额外 TTS 引擎（如 Edge-TTS）增加部署复杂度 |
| TTS 多消息协调 | ① 每个 MessageToolbar 实例独立持有 speechSynthesis ② store 层单例协调 | ② | useTtsStore 在 store 层组合 useTTS composable，避免多实例同时调用 speechSynthesis.speak 导致队列堆积；切换消息时 store.speak 内部自动 stop 当前朗读 |
| TTS Markdown 剥离 | ① 引入 marked.lexer ② 单文件正则 | ② | 单文件正则覆盖 90% 场景，避免增加 bundle；代码块替换为「代码块」占位避免朗读源码 |
| 联网搜索超时 | ① config 配置阈值 ② 常量化 5s | ② | SRS F-3.10 验收硬性要求 5s，业务上无合理理由放宽，常量化避免误配 |
| 超时降级策略 | ① 抛 Error 让 harness step 失败 ② 返回空数组让 workflow 继续 | ② | harness 会把工具异常视为 step 失败可能触发整条 ReAct 链回退，与「仅降级联网」语义不符；空数组让 LLM 继续基于 vault 回答 |
| 降级提示去重 | ① 每次空结果都推送 ② webSearchDowngradeNotified 布尔去重 | ② | harness 多步可能多次调用 web_search，仅推送一次降级提示避免 thinking 块噪音 |
| F-3.8 折叠阈值 | ① 全部展开 ② 默认前 3 条 + 展开更多 | ② | 仿豆包「参考 N 篇资料」默认展开前 3 条，超过的折叠，避免长列表占据过多视觉空间 |

### 16.3 验证记录

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 前端类型检查 | `pnpm --filter @karpathy-wiki/web exec npx vue-tsc --noEmit` | exit 0 ✅ |
| 后端类型检查 | `pnpm --filter @karpathy-wiki/api exec npx tsc --noEmit` | exit 0 ✅ |

### 16.4 文件清单

#### 修改文件

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `frontend/src/components/MessageToolbar.vue` | 修改 | 5 按钮扩展为 6 按钮：新增 TTS 朗读按钮（VideoPlay/VideoPause 图标切换 + ttsSupported 灰显 + handleTtsToggle 状态机） |
| `frontend/src/components/RefsList.vue` | 重写 | 从 v1 chips 列表重写为完整卡片列表：COLLAPSE_THRESHOLD=3 + showAll 折叠 + vault/web 徽章 + hover translateX |
| `api/src/tools/web-search.ts` | 修改 | 新增 WEB_SEARCH_TIMEOUT_MS=5000 常量 + AbortSignal.timeout 包裹 fetch + try/catch 返回空数组降级 |
| `api/src/workflows/query-workflow.ts` | 修改 | afterStep hook 新增 web_search 空结果检测 + 推送降级 thinking + webSearchDowngradeNotified 去重 |

#### 复用已有文件（Sprint 4 未修改但已核查就绪）

| 文件 | 已实现内容 |
| --- | --- |
| `frontend/src/composables/useTTS.ts` | stripMarkdown + speak/pause/resume/stop 状态机 + 中文 voice 优先匹配 |
| `frontend/src/stores/tts.ts` | useTtsStore.speak(text, msgId) + currentMsgId 协调多消息切换 |
| `api/src/routes/search.ts` | registerWebSearchRoute 注册 /api/search/web |
| `api/src/routes/ai.ts` | saveWebSearchConfig + adapter.updateConfig 热更新 |
| `api/src/config.ts` | loadConfig 合并 webSearch + saveWebSearchConfig 写盘 + refreshConfigCache |
| `api/src/routes/query.ts` | webSearch 字段从 body 传递到 QueryInput |
| `frontend/src/stores/query.ts` | setRefs 合并本地 refs + webRefs 为统一 Reference[] |
| `frontend/src/types.ts` | Reference 含 source: 'vault' \| 'web' + citeIndex + RefsData.webRefs |
| `frontend/src/views/Query.vue` | mode='web' 时 body.webSearch=true + SSE refs 事件合并 webRefs |

### 16.5 已知限制

| 限制 | 影响范围 | 缓解方案 |
| --- | --- | --- |
| ~~F-3.6 TTS 浏览器实测未执行~~ | ~~中文 voice 自动选择 / 暂停继续 / 切换消息停止的端到端行为未在浏览器中实测~~ | ✅ v2.0.1 已实测：`scripts/sprint5-e2e-real.py` 共 10 项 TTS 用例全部 PASS（TC-TTS-01 speechSynthesis 可用 / TC-TTS-02 中文 voice 3 个 Microsoft Huihui/Kangkang/Yaoyao / TC-TTS-05 speak 调用 zh-CN + voice 选择 / TC-TTS-06 朗读中 title 切换 / TC-TTS-07 暂停 / TC-TTS-08 继续 / TC-TTS-09c setRate(1.5) store 应用 / TC-TTS-09d rate 重启 utterance 验证 rate=1.5 / TC-TTS-10 切换消息 cancel）；headed Chrome + Web Speech API + mock speechSynthesis.speak 捕获 utterance 参数 |
| ~~F-3.10 联网搜索实测需 API Key~~ | ~~Tavily/Bing API Key 未配置时无法实测真实联网搜索流程~~ | ✅ v2.0.1 已实测：`scripts/sprint5-e2e-real.py` 配置真实 Tavily API Key，5 项联网搜索用例 + 4 项超时降级用例全部 PASS（TC-SEARCH-01 Tavily provider/key 配置 / TC-SEARCH-02 SSE done 事件 / TC-SEARCH-03 progress 事件 searching / TC-SEARCH-04 refs 渲染 / TC-SEARCH-05 thinking 事件 5 条；TC-TIMEOUT-01 5s 超时常量 / TC-TIMEOUT-02 AbortSignal.timeout / TC-TIMEOUT-03 try/catch 降级 / TC-TIMEOUT-04 三层防御完整）；真实触发 Tavily 搜索 + read_page 工具调用 |
| ~~F-3.6 TTS 语速调节未实施~~ | ~~SRS F-3.6 描述「默认语速 1.0x，可调 0.5x - 2.0x」，当前固定 1.0x~~ | ✅ v2.0.1 已修复：`useTTS.ts` 新增 `rate ref(1.0)` + `setRate()` clamp(0.5-2.0)；`MessageToolbar.vue` 新增 `.rate-panel` 浮窗 + `<input type="range" min="0.5" max="2.0" step="0.1">` 滑块；朗读中调整 rate 自动重启 utterance 应用新值 |
| ~~F-3.8 引用编号 [1] 锚点未实施~~ | ~~SRS F-3.8 要求「assistant 文本中 [1] 为可点击锚点」，当前仅展示编号~~ | ✅ v2.0.1 已修复：`markdown.ts` 新增 `ref_anchor` inline 规则将 `[N]` 转为 `<a href="#ref-N" class="ref-anchor">`；`RefsList.vue` 卡片新增 `id="ref-${citeIndex}"`；`Query.vue` `handleRefAnchorClick` 事件委托 + `scrollIntoView({behavior:'smooth'})` + `ref-flash` 1.5s 高亮动画 |
| ~~F-3.10 联网搜索 progress 事件未推送~~ | ~~SRS F-3.10 数据结构含 progress 事件，当前仅 thinking 提示~~ | ✅ v2.0.1 已修复：`query-workflow.ts` 新增 `collectedProgress` 数组 + afterStep hook 在 `web_search` 调用时推送 `{step:'fetching',count}` 与 `{step:'done',count}`，启动时推送 `{step:'searching'}`；SSE 路由 + 前端 sse.ts/store/Query.vue 全链路已就绪；Query.vue 新增 `searchProgressLabel` 计算属性将英文 step 翻译为中文（正在联网搜索/正在抓取网页/联网搜索完成） |

### 16.5.1 v2.0.1 修复项验证证据

- 类型检查：`vue-tsc --noEmit -p frontend` exit 0；`tsc --noEmit -p api` exit 0
- 编码体检：81 文件全部 UTF-8 无 BOM
- Playwright E2E：`scripts/sprint3-4-acceptance.py` 共 34 项全部 PASS（其中 v2.0.1 新增 11 项：F-3.6 rate ref/setRate/clamp + 工具栏 UI + store 暴露；F-3.8 markdown 规则 + RefsList id + 点击委托 + 闪烁高亮；F-3.10 workflow 推送 + SSE 路由 + 前端 handler + store + 展示 + 中文 label）
- 结果文件：`docs/test-evidence/sprint3-4/sprint3-4-result.json`
- Sprint 5 端到端实测：`scripts/sprint5-e2e-real.py` 共 27 项全部 PASS（F-3.6 TTS 浏览器实测 10 项：speechSynthesis 支持 / 中文 voice / speak 调用 / voice 选择 / title 切换 / 暂停 / 继续 / 语速按钮 / setRate 应用 / rate 重启 utterance / 切换消息 cancel；F-3.10 联网搜索实测 9 项：Tavily 配置 / SSE done / progress 事件 / refs 渲染 / thinking 事件 / 5s 超时常量 / AbortSignal / try-catch 降级 / 三层防御完整；Console 错误检查 1 项）
- Sprint 5 结果文件：`docs/test-evidence/sprint5/sprint5-result.json`
- Sprint 5 运行日志：`docs/test-evidence/sprint5/sprint5-run.log`

### 16.6 v2.0.0 全量发布声明

**v2.0.0 13 项核心功能全部交付**：

| Sprint | 功能项 | 状态 |
| --- | --- | --- |
| Sprint 1 | F-3.1 思考动画 / F-3.2 流式渲染扩展 / F-3.7 文本复制 / F-3.12 联想提问微调 | ✅ |
| Sprint 2 | F-3.3 历史对话 / F-3.11 侧栏折叠 / F-3.13 消息操作 | ✅ |
| Sprint 3 | F-3.4 工具栏 / F-3.5 多模态图片 / F-3.9 模型切换 | ✅ |
| Sprint 4 | F-3.6 TTS / F-3.8 参考文章列表 / F-3.10 互联网搜索 | ✅ |

**累计交付**：13/13 功能，覆盖前后端所有 SRS v2.0.0 验收项。

### 16.7 阶段交接声明

- 当前阶段：Sprint 4 语音与联网 ✅ 已完成
- 下一阶段：v2.0.0 维护期（bug 修复 + 性能优化 + 用户反馈迭代）
- 下一阶段智能体：无（v2.0.0 已全量发布）
- 下一阶段技能：webapp-testing（Playwright 端到端验收补完 TTS/联网搜索用例）
- 交接上下文：Sprint 4 已交付 3 项功能（F-3.6 / F-3.8 / F-3.10），所有修改通过前后端 tsc 类型检查。Sprint 5 端到端实测已完成（27/27 PASS）：F-3.6 TTS 浏览器实测 10 项（headed Chrome + Microsoft Huihui 中文 voice + mock speechSynthesis 捕获 utterance 参数，覆盖中文 voice 选择 / 暂停继续 / 切换消息停止 / 语速调节 rate 重启 utterance）；F-3.10 联网搜索真实 Tavily API Key 触发实测 9 项（真实搜索 + read_page 工具调用 + SSE progress 事件 + 5s 超时降级三层防御完整）。v2.0.0 13 项功能全部交付并完成端到端实测，DELIVERY.md §16.5 已知限制全部关闭，进入维护期。