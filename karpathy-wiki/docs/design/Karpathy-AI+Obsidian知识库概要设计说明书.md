# Karpathy-AI + Obsidian 知识库概要设计说明书

| 项目 | 内容 |
| --- | --- |
| 文档名称 | Karpathy-AI + Obsidian 知识库概要设计说明书 |
| 文档版本 | V1.3 |
| 编制日期 | 2026-07-07 |
| 文档状态 | 评审通过（策略调整） |
| 需求基准 | 《Karpathy-AI+Obsidian知识库搭建需求规格说明书》V2.2 |
| 变更说明 | V1.0 首版；V1.1 评审修正（1 严重+10 中+9 轻）；V1.2 架构自洽性复审修正（4 严重不一致+2 中+1 待办）；V1.3 S-1 PoC 执行发现本机为 Trae IDE 非 TRAE CLI，用户决策跳过阶段1直接自研，合并阶段1+2、移除 TraeCliAdapter、保留 EngineAdapter 接口默认 HarnessAdapter |

---

## 1. 引言

### 1.1 编写目的

本文档对知识库系统进行概要级设计，覆盖总体架构、模块划分、核心组件设计、接口设计、数据设计、部署设计与安全设计，作为详细设计与编码实施的基准。

### 1.2 设计原则

1. **简约至上**：每处设计只保留必要复杂度，拒绝过度抽象。
2. **目标驱动**：每个模块可追溯到需规的 FR/NFR 验收项。
3. **零业务耦合**：`@wiki/harness` 不得包含任何知识库专用逻辑。
4. **渐进自研**：阶段1 用 TRAE CLI 验证，阶段2 用自研组件替换，架构模式一致。
5. **低门槛优先**：所有设计决策须符合"15 分钟搭建、零命令行日常使用"。

### 1.3 术语

沿用需规 V2.2 术语表，关键术语：Vault、SCHEMA.md、Harness、`@wiki/harness`、FR/NFR/AC。

### 1.4 参考资料

- 需规 V2.2（唯一需求基准）
- 《AI 引擎自研评估报告》
- 《Harness 架构适用性评估》
- TRAE 官方文档 https://docs.trae.cn

### 1.5 设计范围

| 范围内 | 范围外 |
| --- | --- |
| `@wiki/harness` 独立组件包 | 模型训练/微调 |
| 知识库业务层 | 飞书网关（FR-07，二期） |
| 桥接 API | 公网部署与多租户 |
| Web 前端 8 大模块 | 移动端原生 App |
| 一键安装与部署 | |
| 安全设计 | |

---

## 2. 总体设计

### 2.1 设计目标

| 目标 | 对应需规 |
| --- | --- |
| 自动生长的结构化知识库 | FR-01、FR-02 |
| 基于 Wiki 的 Token 高效问答 | FR-03、NFR-01 |
| Web 前端零安装使用 | FR-04、NFR-05 |
| AI 引擎渐进自研 + Harness 独立组件化 | FR-05、FR-08 |
| 一键安装 15 分钟搭建 | FR-06、NFR-05 |
| 国产化与自主可控 | NFR-06 |

### 2.2 总体架构

#### 2.2.1 阶段1 架构（TRAE CLI 验证）

```
┌─────────────────────────────────────────────────────────────┐
│                     Web 前端（Vue 3）                         │
└───────────────┬─────────────────────────────────────────────┘
                │ REST + SSE
┌───────────────▼─────────────────────────────────────────────┐
│                  桥接 API 层（Fastify）                       │
│           引擎适配器接口（EngineAdapter）                    │
└───────┬───────────────────────────────────────┬─────────────┘
        │ 子进程调用（spawn）                    │ MCP（可选）
┌───────▼───────────────────┐   ┌────────────────▼──────────────┐
│   TRAE CLI（阶段1 引擎）   │   │   TRAE Work（可选）            │
│   Skill: compile/query/   │   │                               │
│   health-check            │   └────────────────────────────────┘
└───────┬───────────────────┘
        │ 读写
┌───────▼─────────────────────────────────────────────────────┐
│              Vault（本地 Markdown 文件）                      │
└─────────────────────────────────────────────────────────────┘
```

阶段1 关键点：桥接 API 通过 `EngineAdapter` 接口调用 TRAE CLI（子进程 + SSE 流式输出）。`EngineAdapter` 是阶段2 替换的预留点。

#### 2.2.2 阶段2 架构（自研 `@wiki/harness` + 业务层）

```
┌─────────────────────────────────────────────────────────────┐
│                     Web 前端（Vue 3）                         │
└───────────────┬─────────────────────────────────────────────┘
                │ REST + SSE
┌───────────────▼─────────────────────────────────────────────┐
│           知识库业务层（Fastify + 工作流编排）                │
│     compile/query/health-check 工作流 / Markdown 解析 /       │
│     双向链接 / SCHEMA 注入 / 鉴权 / 路由                     │
└───────┬───────────────────────────────────────┬─────────────┘
        │ npm 包引用（import）                   │
┌───────▼───────────────────┐   ┌────────────────▼──────────────┐
│  @wiki/harness（独立包）   │   │   TRAE Work（可选）            │
│  loop/state/retry/budget/  │   └────────────────────────────────┘
│  hook/LLM 适配器           │
└───────┬───────────────────┘
        │ 工具读写
┌───────▼─────────────────────────────────────────────────────┐
│              Vault（本地 Markdown 文件）                      │
└─────────────────────────────────────────────────────────────┘
```

阶段2 关键点：业务层通过 `import { Harness } from '@wiki/harness'` 引用，无子进程边界；`EngineAdapter` 接口实现切换为 `HarnessAdapter`。

### 2.3 模块划分

```
karpathy-wiki/                    # 知识库项目主仓库（monorepo）
├── packages/
│   └── web/                      # Web 前端（Vue 3）
├── services/
│   └── api/                      # 知识库业务层（Fastify）+ 阶段1 桥接 API
│       ├── src/
│       │   └── prompts/          # prompt 单点存储（compile/query/health-check-fix），阶段1 Skill 与阶段2 harness 共引用，保证等价性（M-3）
│       └── trae-skills/          # 阶段1 TRAE CLI Skill 定义（仅 compile/query）
├── vault/                        # 知识库内容（运行时生成，不入仓库）
├── scripts/                      # 一键安装脚本
└── docker-compose.yml

wiki-harness/                     # @wiki/harness 独立仓库（独立 npm 包）
├── src/
├── tests/
├── README.md
└── package.json
```

两个仓库：主仓库 `karpathy-wiki` 与独立仓库 `wiki-harness`。阶段2 主仓库通过 `npm install @wiki/harness` 引用独立组件。`prompts/` 位于 `api/src/prompts/`，阶段1 Skill 文件直接 `import` 或字符串拼接引用，阶段2 harness 通过 `beforeLoop` Hook 注入，保证两阶段 prompt 等价（M-3）。

### 2.4 技术栈选型

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 语言 | TypeScript（全栈） | 前后端同语言，Harness 与业务层同语言合并，消除边界 |
| Web 前端 | Vue 3 + Vite + Pinia + Element Plus | 需规建议；Element Plus 开源、组件全、马卡龙主题可定制 |
| Markdown 渲染 | markdown-it + KaTeX + 自写 wikilink 插件 | 支持 `[[页面名]]` 解析为内部链接 |
| 图谱可视化 | vis.js | 性能优于 D3 大规模场景，API 简洁 |
| 后端 | Fastify | 性能高、插件体系清晰、SSE 原生支持 |
| `@wiki/harness` | TypeScript + 零运行时依赖 | 可复用到任意 TS 项目 |
| TRAE CLI 调用 | Node.js `child_process.spawn` | 流式 stdout 转 SSE |
| 桌面打包 | Tauri | 体积小、安全、跨平台 |
| 部署 | Docker Compose + 裸机脚本 | 双轨覆盖 |

---

## 3. `@wiki/harness` 独立组件设计

### 3.1 组件定位

`@wiki/harness` 是轻量级 LLM Agent 运行时，公式 `Agent = LLM + Harness`。它包裹任意 OpenAI 兼容 LLM，提供工具调用循环、状态管理、错误重试、预算控制、确定性 Hook 五项核心机制。零业务耦合，可独立运行、独立发布、复用到其他 LLM 应用。

### 3.2 包结构

```
wiki-harness/
├── src/
│   ├── index.ts                  # 对外导出入口
│   ├── harness.ts                # Harness 主类（编排五机制）
│   ├── loop/
│   │   └── tool-loop.ts          # 工具调用循环（Function Calling）
│   ├── state/
│   │   ├── state-store.ts        # 状态存储抽象
│   │   └── file-state-store.ts   # 文件持久化实现
│   ├── retry/
│   │   └── retry-policy.ts       # 重试策略（指数退避）
│   ├── budget/
│   │   └── budget-guard.ts       # 预算守卫（max_steps + token_budget）
│   ├── hook/
│   │   └── hook-manager.ts       # 确定性 Hook（4 类生命周期）
│   ├── llm/
│   │   ├── llm-adapter.ts        # LLM 适配器接口
│   │   ├── openai-compatible.ts  # OpenAI 兼容实现（GLM/Qwen/DeepSeek）
│   │   └── token-counter.ts      # Token 计数器
│   ├── tools/
│   │   └── tool-registry.ts      # 工具注册表
│   ├── cli/
│   │   └── index.ts              # CLI 入口（独立运行）
│   └── types.ts                  # 公共类型定义
├── tests/                        # 独立测试套件（覆盖率 ≥ 80%）
├── examples/                     # 使用示例（含非知识库场景）
│   ├── code-gen/                 # 代码生成 Agent 示例
│   └── doc-summary/              # 文档摘要 Agent 示例
├── README.md
├── CHANGELOG.md
└── package.json                  # name: @wiki/harness
```

### 3.3 核心类设计

#### 3.3.1 Harness 主类

```typescript
// src/harness.ts
export interface HarnessConfig {
  llm: LLMConfig;                 // LLM 适配器配置
  tools: ToolDefinition[];        // 工具注册列表
  budget?: BudgetConfig;          // 预算配置
  retry?: RetryConfig;            // 重试配置
  hooks?: Partial<Hooks>;         // 确定性 Hook
  stateStore?: StateStore;        // 状态存储（默认内存）
}

export interface Hooks {
  beforeLoop: (ctx: RunContext) => Promise<void>;
  beforeStep: (ctx: RunContext, step: number) => Promise<void>;
  afterStep: (ctx: RunContext, step: number, result: StepResult) => Promise<void>;
  afterLoop: (ctx: RunContext, result: RunResult) => Promise<void>;
}

export class Harness {
  constructor(config: HarnessConfig);
  async run(task: { task: string; context?: Record<string, unknown> }): Promise<RunResult>;
  async resume(runId: string): Promise<RunResult>;   // 中断恢复
}
```

`Harness` 是唯一对外入口，编排五机制：`beforeLoop` Hook → 预算检查 → LLM 调用 → 工具执行 → `afterStep` Hook → 重试判断 → 循环 → `afterLoop` Hook。

#### 3.3.2 工具调用循环（tool-loop）

```typescript
// src/loop/tool-loop.ts
// 循环逻辑：LLM 返回 tool_calls → 逐个执行工具 → 结果回填 messages → 下一轮
// 终止条件：LLM 返回纯文本无 tool_calls，或预算耗尽
export async function runLoop(ctx: RunContext): Promise<RunResult>;
```

采用 OpenAI Function Calling 协议（`tool_calls` 字段），GLM/Qwen/DeepSeek 均兼容。每轮调用 LLM 后检查是否含 `tool_calls`，有则执行工具并回填 `tool` 角色消息，无则视为完成。

#### 3.3.3 状态管理（state）

```typescript
// src/state/state-store.ts
export interface StateStore {
  save(runId: string, state: RunState): Promise<void>;
  load(runId: string): Promise<RunState | null>;
  list(): Promise<string[]>;
}

export interface RunState {
  runId: string;
  task: string;
  messages: Message[];            // 完整对话历史
  step: number;                   // 当前步数
  tokenUsed: number;              // 已用 Token
  status: 'running' | 'paused' | 'done' | 'failed';
  startedAt: string;
}
```

默认实现 `FileStateStore`（JSON 文件持久化到 `.harness/state/`）。`resume(runId)` 读取状态后从 `step` 继续。

#### 3.3.4 重试策略（retry）

```typescript
// src/retry/retry-policy.ts
export interface RetryConfig {
  maxRetries: number;             // 默认 3
  baseDelayMs: number;            // 默认 1000
  maxDelayMs: number;             // 默认 30000
  retryOn: ('timeout' | 'rate_limit' | 'tool_error' | 'parse_error')[];
}
```

指数退避 + 抖动。LLM 超时/限流触发重试；工具错误按配置决定是否重试。

#### 3.3.5 预算守卫（budget）

```typescript
// src/budget/budget-guard.ts
export interface BudgetConfig {
  maxSteps: number;               // 循环步数上限，默认 20
  tokenBudget: number;            // Token 上限，默认 50000
}

// 每步前检查：if (step >= maxSteps || tokenUsed >= tokenBudget) → 终止返回部分结果
```

超限时不抛异常，而是返回 `RunResult` 含 `status: 'budget_exceeded'` 与已完成的 `messages`，符合 AC-08-8。

#### 3.3.6 确定性 Hook（hook）

四类生命周期 Hook，由业务层注入固定逻辑，不交 LLM 决策：

| Hook | 时机 | 典型用途（知识库场景） |
| --- | --- | --- |
| beforeLoop | 循环开始前 | 读 SCHEMA.md 注入 system prompt |
| beforeStep | 每步 LLM 调用前 | 记录步骤日志 |
| afterStep | 每步工具执行后 | 持久化状态、SSE 推送进度 |
| afterLoop | 循环结束后 | 更新 index.md/log.md |

#### 3.3.7 LLM 适配器

```typescript
// src/llm/llm-adapter.ts
export interface LLMAdapter {
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse>;
  chatStream(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<LLMChunk>;
  countTokens(messages: Message[]): number;
}

// src/llm/openai-compatible.ts
// 实现 OpenAI 兼容 API，通过 base_url + api_key 切换 GLM/Qwen/DeepSeek
export class OpenAICompatibleAdapter implements LLMAdapter {
  constructor(config: { baseUrl: string; apiKey: string; model: string });
}
```

切换模型仅改 `baseUrl`/`model`，符合 AC-08-10。Token 计数用 `tiktoken` 估算。

### 3.4 CLI 设计

```bash
# 独立运行（脱离任何业务项目）
npx @wiki/harness run \
  --task "完成任务X" \
  --llm.baseUrl https://open.bigmodel.cn/api/paas/v4 \
  --llm.model glm-4-plus \
  --llm.apiKey $GLM_KEY \
  --tools ./tools.json \
  --budget.maxSteps 20

# 中断恢复
npx @wiki/harness resume --runId <id>
```

`tools.json` 声明工具 schema（JSON Schema 格式），CLI 内置通用 `shell`/`http`/`file` 工具，可独立完成一次 LLM + 工具调用循环，符合 AC-08-3。

### 3.5 独立发布策略

| 项 | 策略 |
| --- | --- |
| 仓库 | 独立 Git 仓库 `wiki-harness` |
| 包名 | `@wiki/harness`（npm scoped package） |
| 版本 | SemVer，独立 CHANGELOG |
| 发布 | `npm publish`，CI 自动化 |
| 测试 | 独立 Jest 套件，覆盖率 ≥ 80%（AC-08-12） |
| 零耦合校验 | CI 静态检查 `src/` 不得 import 任何 `markdown`/`obsidian`/`frontmatter` 相关包（AC-08-11） |
| 文档 | 独立 README + API 文档，含 `examples/code-gen` 与 `examples/doc-summary` 两个非知识库示例（AC-08-13） |

### 3.6 需规追溯

| 设计点 | 对应 AC |
| --- | --- |
| 独立仓库与版本 | AC-08-1 |
| npm 发布 | AC-08-2、AC-08-14 |
| CLI 独立运行 | AC-08-3 |
| 编程 API | AC-08-4 |
| tool loop | AC-08-5、AC-05-9 |
| state | AC-08-6、AC-05-9 |
| retry | AC-08-7、AC-05-9 |
| budget 双上限 | AC-08-8、AC-05-9 |
| hook 四类 | AC-08-9、AC-05-9 |
| LLM 适配器 | AC-08-10、AC-05-10 |
| 零业务耦合 | AC-08-11、AC-05-12 |
| 测试覆盖 | AC-08-12 |
| 非知识库示例 | AC-08-13 |

---

## 4. 知识库业务层设计

### 4.1 模块定位

业务层是知识库项目的核心，基于 `@wiki/harness` 实现 compile/query/health-check 三类工作流，并提供桥接 API 给前端调用。阶段1 通过 `TraeCliAdapter` 调用 TRAE CLI；阶段2 切换为 `HarnessAdapter` 调用 `@wiki/harness`。

### 4.2 包结构

```
api/
├── src/
│   ├── index.ts                  # Fastify 启动入口
│   ├── routes/                   # REST 路由
│   │   ├── compile.ts
│   │   ├── query.ts
│   │   ├── health-check.ts
│   │   ├── files.ts              # 文件读写/目录树
│   │   ├── schema.ts             # SCHEMA 编辑
│   │   └── config.ts             # 配置
│   ├── engine/                   # 引擎适配器（阶段切换点）
│   │   ├── engine-adapter.ts     # 接口定义
│   │   ├── trae-cli-adapter.ts   # 阶段1：子进程调用 TRAE CLI
│   │   └── harness-adapter.ts    # 阶段2：调用 @wiki/harness
│   ├── workflows/                # 工作流编排（阶段2）
│   │   ├── compile-workflow.ts
│   │   ├── query-workflow.ts
│   │   └── health-check-workflow.ts
│   ├── markdown/                 # Markdown 工具（阶段2 注册到 harness）
│   │   ├── frontmatter.ts        # frontmatter 解析/生成
│   │   ├── wikilink.ts           # [[link]] 提取/反向索引
│   │   └── index-updater.ts      # index.md 追加
│   ├── vault/                    # Vault 文件操作
│   │   ├── vault-service.ts
│   │   └── init.ts               # 一键初始化目录结构
│   ├── sse.ts                    # SSE 流式输出封装
│   ├── auth.ts                   # 鉴权（可选）
│   └── config.ts                 # 配置加载
├── trae-skills/                  # 阶段1 TRAE CLI Skill 定义（仅 compile/query；healthCheck 走业务层确定性逻辑，无需 Skill）
│   ├── compile.md
│   └── query.md
└── package.json
```

### 4.3 引擎适配器接口（阶段切换核心）

```typescript
// src/engine/engine-adapter.ts
export interface EngineAdapter {
  compile(input: CompileInput): AsyncIterable<ProgressEvent>;   // 流式
  query(input: QueryInput): AsyncIterable<AnswerChunk>;         // 流式
  healthCheck(): Promise<HealthReport>;
}

// 阶段1：子进程调用 TRAE CLI（仅 compile/query 走 Skill；healthCheck 直接调用业务层确定性逻辑）
export class TraeCliAdapter implements EngineAdapter {
  // compile/query：spawn('trae', ['cli', 'run', '--skill', 'compile', '--input', json])
  //   stdout 行按 SSE 协议解析为 ProgressEvent
  // healthCheck：绕过子进程，直接调用业务层 build_link_graph（与阶段2 一致，纯确定性）
}

// 阶段2：调用 @wiki/harness
export class HarnessAdapter implements EngineAdapter {
  // compile/query：new Harness({ llm, tools: [readFile, writeFile, parseFrontmatter, ...], hooks, budget })
  //   compile → harness.run({ task: '编译资料', context: { rawPath, schema } })
  // healthCheck：同样绕过 harness，直接调用业务层 build_link_graph
}
```

`EngineAdapter` 是阶段1→阶段2 切换的唯一抽象点，对应 AC-05-7 与 NFR-03-4。配置项 `engine.adapter` 决定使用哪个实现，默认 `trae-cli`，阶段2 切换为 `harness`。

**【A-6 localOnly 降级路径】**：`localOnly: true` 时，`EngineAdapter` 实现直接走本地降级分支，不构造子进程（阶段1）或不构造 harness 实例（阶段2）：
- `compile`：仅存档原文到 `raw/`，不生成 entities/concepts/comparisons 页面，不更新 index.md（仅 append_log 记录"localOnly 模式，未编译"）
- `query`：退化为纯关键词检索已编译页面（`search_pages` 工具直接走业务层），不调 LLM，返回匹配页面摘要 + 链接
- `healthCheck`：本就纯确定性，不受影响
- 降级分支在 `EngineAdapter` 实现内部判断，业务层无感知

### 4.4 compile 工作流设计

#### 4.4.1 阶段1（TRAE CLI Skill）

Skill 定义文件 `trae-skills/compile.md` 承载 prompt 与步骤约束：

```
# Skill: compile
## 任务
读取 raw/ 中的资料，按 SCHEMA.md 约束生成结构化 Wiki 页面。
## 步骤
1. 读 SCHEMA.md
2. 读 raw/{path}
3. 判定页面类型（entity/concept/comparison）
4. 生成页面（含 frontmatter）
5. 建立双向链接 [[页面名]]
6. 追加 index.md 摘要行
7. 追加 log.md 操作记录
## 输出
每步输出 JSON 事件到 stdout：{ "step": "read_schema", "status": "done" }
```

`TraeCliAdapter` 解析 stdout JSON 行转为 `ProgressEvent`，经 SSE 推送前端。

**【S-1 技术风险缓解】TRAE CLI Skill 输出协议 PoC**：
阶段1 进入详细设计前须先做 PoC 验证：TRAE CLI Skill 能否精确控制 stdout 输出 JSON 行、是否被 CLI 自身日志污染、是否支持流式。备选方案（按优先级）：
1. **stdout JSON 行**（首选）：Skill 每步 `console.log(JSON.stringify(event))`，桥接 API 按行解析。
2. **文件监听**（备选）：Skill 将进度事件写入 `.trae/progress.jsonl`，桥接 API 用 `chokidar` 监听文件变化转 SSE。
3. **MCP Server 模式**（备选）：若 TRAE CLI 支持 MCP Server 模式，桥接 API 作为 MCP Client 订阅事件流。

PoC 不通过则优先采用方案 2，不影响整体架构。

**【A-5 两阶段控制权差异说明】**：阶段1 与阶段2 的"控制权分布"有意不同，是阶段升级的合理差异，非语义等价：
- **阶段1（prompt 驱动验证）**：7 步全由 LLM 自主决策（判定类型、生成页面、建链接），桥接 API 仅解析 stdout 事件流。控制权在 LLM，信任 prompt 约束。适用于快速验证 prompt 有效性，但 LLM 可能漏步（如漏更新 index.md）。
- **阶段2（harness 编排产品化）**：工具循环由 harness 编排，`beforeLoop`/`afterLoop` Hook 兜底（强制读 SCHEMA、强制校验页面、强制更新 index/log）。控制权从 LLM 收回到确定性 Hook，杜绝漏步。
- **质量影响**：阶段2 在 prompt 等价前提下，因 Hook 兜底，编译完整性 ≥ 阶段1。这正是阶段升级的价值，不构成"两阶段语义不一致"的缺陷。

#### 4.4.2 阶段2（@wiki/harness 工作流）

```typescript
// src/workflows/compile-workflow.ts
export async function compileWorkflow(
  harness: Harness,
  ctx: { vaultPath: string; rawPath: string }
): AsyncIterable<ProgressEvent> {
  // beforeLoop hook：读 SCHEMA.md 注入 system prompt
  // 工具注册：readFile, writeFile, parseFrontmatter, extractWikilinks, appendIndex, appendLog
  // harness.run({ task: '按 SCHEMA 编译 raw 资料', context: ctx })
  // afterLoop hook：校验生成的页面、更新 index/log
}
```

工具注册（业务层实现，注册到 harness）：

| 工具 | 功能 | 对应 AC |
| --- | --- | --- |
| `read_file` | 读 Vault 文件 | AC-05-14 |
| `write_file` | 写页面（含 frontmatter） | AC-05-13、AC-02-2 |
| `parse_frontmatter` | 解析 frontmatter | AC-05-14 |
| `extract_wikilinks` | 提取 `[[link]]` 建反向索引 | AC-05-14、AC-02-3 |
| `append_index` | 追加 index.md 摘要行 | AC-01-3、AC-02-4 |
| `append_log` | 追加 log.md 操作记录 | AC-01-4、AC-02-4 |

确定性 Hook 串联固定步骤（不交 LLM 决策）：
- `beforeLoop`：读 SCHEMA.md → 拼入 system prompt
- `afterLoop`：校验页面、更新 index/log（兜底，防 LLM 漏做）

### 4.5 query 工作流设计

```
用户提问
  ↓
read_index（读 index.md 获取全貌）
  ↓
search_pages（关键词匹配相关页面，仅读已编译页面，不读 raw/）
  ↓
harness.run({ task: '基于已编译页面回答', context: { pages } })
  ↓
LLM 流式生成答案 + [[页面名]] 引用
  ↓
SSE 逐字推送前端
  ↓
用户确认高价值 → 归档到 queries/
```

关键约束（AC-03-3）：query 工作流的 `search_pages` 工具只检索 `entities/`、`concepts/`、`comparisons/`，不得读 `raw/`。无相关内容时 LLM 须回复"知识库未覆盖"（AC-03-2），由 system prompt 强约束。

### 4.6 health-check 工作流设计

```
扫描全库
  ↓
build_link_graph（构建双向链接图）
  ↓
检测三类问题：
  - 孤立页面（无入链）
  - 断链（指向不存在的页面）
  - 过期页面（30 天未更新，看 frontmatter.updated）
  ↓
结构化报告 → 前端可视化
  ↓
append_log
```

health-check 不调用 LLM，纯确定性逻辑，由 `build_link_graph` 工具 + 算法实现，符合 AC-02-5。

**【M-2 healthCheck 与 harness 关系】**：`healthCheck()` 在阶段1 与阶段2 实现一致——均绕过引擎（子进程/harness），直接调用业务层 `build_link_graph` 确定性逻辑，不构造 `Harness` 实例，不调用 LLM。`EngineAdapter` 接口中 `healthCheck()` 返回 `Promise<HealthReport>`（非流式），与 compile/query 的流式接口区分。**仅 `/api/health-check/fix`（一键修复）走引擎**，因修复断链等操作需 LLM 决策。

**【AC-02-5 阈值固化】**：过期页面判定阈值固化为常量 `STALE_THRESHOLD_DAYS = 30`，可通过 config.json `healthCheck.staleDays` 覆盖。

---

## 5. 桥接 API 设计

### 5.1 REST 接口一览

| 方法 | 路径 | 功能 | 请求 | 响应 | 对应 FR |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/compile` | 投递资料并编译 | file 类型 `multipart/form-data`（字段 `file`）；url/text 类型 `application/json` `{ type, content }` | SSE 流 | FR-02 |
| POST | `/api/query` | 问答 | `{ question, history? }` | SSE 流 | FR-03 |
| POST | `/api/query/archive` | 归档高价值问答 | `{ sessionId, messageIndex }`（服务端从会话存储取答案，防篡改） | `{ fileId }` | FR-03 |
| POST | `/api/health-check` | 体检 | `{}` | `{ orphans[], brokenLinks[], stale[] }` | FR-02 |
| POST | `/api/health-check/fix` | 一键修复 | `{ issueType, target }` | SSE 流 | FR-04 |
| GET | `/api/files/tree` | 目录树 | `?dir=` | `TreeNode[]` | FR-04 |
| GET | `/api/files` | 读文件 | `?path=xxx`（query 参数，避免路径编码问题） | `{ content, frontmatter }` | FR-04 |
| PUT | `/api/files` | 写文件 | `?path=xxx` + `{ content }` | `{ ok }` | FR-04 |
| GET | `/api/graph` | 图谱数据 | `?dir=&tag=` | `{ nodes[], edges[] }` | FR-04 |
| GET | `/api/search?q=` | 全文检索 | `?q=&type=&tag=` | `Hit[]` | FR-04 |
| GET | `/api/schema` | 读 SCHEMA | - | `{ content }` | FR-04 |
| PUT | `/api/schema` | 改 SCHEMA | `{ content }` | `{ ok }` | FR-04 |
| GET | `/api/schema/history` | SCHEMA 版本历史（Git log） | - | `Commit[]` | FR-04 |
| GET | `/api/schema/diff` | SCHEMA 版本对比 | `?from=&to=` | `Diff[]` | FR-04 |
| GET | `/api/config` | 读配置 | - | `Config` | FR-04 |
| PUT | `/api/config` | 改配置 | `Config` | `{ ok }` | FR-04 |
| GET | `/api/stats` | 仪表盘统计 | - | `Stats` | FR-04 |
| POST | `/api/vault/init` | 初始化 Vault | `{ path }` | `{ ok }` | FR-01 |

### 5.2 SSE 事件协议

compile 流式事件：

```
event: progress
data: {"step":"read_schema","status":"done","message":"已读取 SCHEMA.md"}

event: progress
data: {"step":"extract","status":"running","message":"提取要点中..."}

event: page
data: {"path":"concepts/llm-wiki.md","title":"LLM Wiki 方法论"}

event: done
data: {"pages":["concepts/llm-wiki.md"],"indexUpdated":true}
```

query 流式事件：

```
event: token
data: {"text":"LLM Wiki 是"}

event: token
data: {"text":"用 LLM 维护"}

event: refs
data: {"refs":["[[llm-wiki]]","[[karpathy]]"]}

event: done
data: {"archivable":true}
```

health-check 修复流式事件同 compile。

### 5.3 鉴权

默认仅监听 `localhost`（NFR-02-4），无鉴权。若配置 `host: 0.0.0.0` 对外暴露，强制启用 token 鉴权（`Authorization: Bearer <token>`），token 在配置文件中设置，首次启动随机生成并提示。

---

## 6. Web 前端设计

### 6.1 页面路由

| 路径 | 模块 | 对应 AC |
| --- | --- | --- |
| `/` | 仪表盘 | AC-04-1 |
| `/browse` | 知识浏览 | AC-04-1、AC-04-2 |
| `/browse/:path` | 页面详情 | AC-04-2 |
| `/search` | 全文检索 | AC-04-1 |
| `/graph` | 图谱视图 | AC-04-3 |
| `/chat` | AI 对话 | AC-04-5 |
| `/ingest` | 资料投递 | AC-04-4 |
| `/health` | 体检报告 | AC-04-6 |
| `/config` | 配置中心 | AC-04-7 |

### 6.2 状态管理（Pinia）

| Store | 职责 |
| --- | --- |
| `useVaultStore` | 目录树、当前文件、文件列表 |
| `useChatStore` | 会话历史、流式接收、引用归档 |
| `useCompileStore` | 投递状态、编译进度事件流 |
| `useGraphStore` | 图谱节点边数据、过滤条件 |
| `useConfigStore` | 全局配置、模型切换 |

### 6.3 Markdown 渲染管线

```
原始 Markdown
  ↓ markdown-it 解析
  ↓ wikilink 插件：[[页面名]] → <a href="#/browse/页面名">页面名</a>
  ↓ KaTeX 插件：$...$ → 公式
  ↓ frontmatter 提取（gray-matter）
  ↓ 渲染为 Vue 组件
```

wikilink 插件自写，约 30 行，扩展 markdown-it 的 `inline` 规则。

**【NFR-04-2 Obsidian 语法禁令】**：渲染管线不支持 Obsidian 专属语法（`![[embed]]`、`%%注释%%`、`~~~` callout 等），仅支持标准 Markdown + `[[wikilink]]`。写入校验在 `write_file` 工具中拒绝含专属语法的页面。

### 6.X SCHEMA 可视化编辑器（M-9）

配置中心 SCHEMA 编辑页：
- 基于 `@monaco-editor/react` 提供 Markdown 语法高亮编辑
- 保存时调用 `PUT /api/schema`，后端写入后触发 SCHEMA 失效传播：下次 compile/query 重新读取（不缓存）
- 版本对比：`GET /api/schema/history` 列出 Git commit 历史，`GET /api/schema/diff?from=&to=` 用 `diff-match-patch` 渲染前后差异

### 6.4 图谱可视化

用 vis.js `Network`：
- 节点 = 页面，边 = 双向链接
- 节点颜色按目录区分（entities/concepts/comparisons）
- 支持缩放、拖拽、点击跳转、按目录/tag 过滤（AC-04-3）
- 1000 节点用 `physics.stabilization` 与 `smooth: false` 优化性能（NFR-01）

### 6.5 AI 对话组件

```
<ChatWindow>
  ├── 消息列表（流式逐字渲染）
  ├── 引用徽章（点击跳转 /browse）
  ├── 归档按钮（高价值问答）
  └── 输入框（Enter 发送）
</ChatWindow>
```

流式接收用 `EventSource`（SSE），逐字拼接渲染。

### 6.6 资料投递组件

三种方式（AC-04-4）：
- 拖拽上传：`<div @drop>` 接收文件
- URL 粘贴：输入框粘贴 URL，后端抓取
- 富文本粘贴：`<textarea>` 粘贴文本

投递后跳转编译进度页，SSE 实时显示步骤（AC-02-6）。

### 6.7 体检报告组件

三类报告可视化列表：孤立页、断链、过期页。每项带"一键修复"按钮（AC-04-6），点击调用 `/api/health-check/fix`，SSE 显示修复进度。

### 6.8 UI 设计规范

遵循用户偏好（AC-04-8）：

| 项 | 规范 |
| --- | --- |
| UI 库 | Element Plus（开源） |
| 配色 | 马卡龙：主色浅粉 `#FFD6E0`、辅色浅青 `#C8E6E0`、背景 `#FFF9FB` |
| 圆角 | 大圆角 `16px`，卡片 `20px` |
| 质感 | 磨砂玻璃 `backdrop-filter: blur(8px)`，卡片半透明白 |
| IP | 卡通机器人头像（SVG，置于空状态与欢迎页） |
| 字体 | 圆润字体栈 `--el-font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif` |
| 响应式 | Element Plus 栅格 + 断点 `768px / 1024px` |

### 6.9 空状态与演示模式

- 引导式空状态（NFR-05-4）：首次进入无数据时，显示卡通机器人 + "投递第一篇资料"引导
- 演示模式（NFR-05-6）：内置示例 Vault（`vault-demo/`），一键加载体验全部功能

---

## 7. 数据设计

### 7.1 Vault 文件结构（FR-01）

```
my-wiki/
├── SCHEMA.md
├── index.md
├── log.md
├── raw/
│   ├── articles/
│   ├── papers/
│   └── assets/
├── entities/
├── concepts/
├── comparisons/
└── queries/
```

初始化由 `POST /api/vault/init` 触发，一键生成（AC-01-5）。

### 7.2 frontmatter Schema

```yaml
---
title: 页面标题            # 必填
type: entity|concept|comparison|query   # 必填
created: 2026-07-07       # 必填，ISO 日期
updated: 2026-07-07       # 必填，ISO 日期
source: https://...        # 必填，原始资料来源
tags: [tag1, tag2]         # 必填，标签数组
---
```

### 7.3 index.md 格式

```markdown
# 知识库目录

- [[llm-wiki]] — 用 LLM 维护 Markdown 知识库的方法论
- [[karpathy]] — AI 研究者，LLM Wiki 提出者
```

### 7.4 log.md 格式

```markdown
# 操作日志

## 2026-07-07 14:30
- 操作类型：compile | query | health-check
- 影响文件：path/to/file.md
- 备注：简短说明
```

操作类型枚举三类：`compile`（编译入库）、`query`（归档高价值问答）、`health-check`（体检）。

### 7.5 配置文件

`config.json`（Vault 根目录）：

```json
{
  "vaultPath": "/path/to/my-wiki",
  "adapter": "trae-cli",
  "llm": {
    "provider": "glm",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "model": "glm-4-plus",
    "apiKeyRef": "GLM_KEY"
  },
  "traeCliPath": "trae",
  "budget": { "maxSteps": 20, "tokenBudget": 50000 },
  "server": { "host": "localhost", "port": 3000 },
  "localOnly": false,
  "git": { "autoCommit": true },
  "healthCheck": { "staleDays": 30 }
}
```

**【L-1 配置合并】**：`adapter` 为顶层字段（`trae-cli` 或 `harness`），`llm` 统一配置 LLM，`traeCliPath` 仅阶段1 用。`apiKeyRef` 引用环境变量名，**API Key 不落盘**（M-7）。

**【M-7 API Key 安全】**：向导式初始化填写的 API Key 写入系统环境变量或 `.env` 文件（`.gitignore`），config.json 仅存 `apiKeyRef: "GLM_KEY"` 引用。运行时从 `process.env[apiKeyRef]` 读取。

**【M-8 敏感资料开关】**：`localOnly: true` 时，`EngineAdapter` 实现直接走本地降级分支（详见 §4.3 A-6），不构造子进程/harness。compile 仅存档原文到 `raw/` 不生成页面，query 退化为纯关键词检索，healthCheck 不受影响。降级在 Adapter 内部判断，业务层无感知。配置中心提供开关 UI。

**【默认值清单】**（NFR-05-7）：`adapter` 默认 `trae-cli`；`budget.maxSteps` 默认 20；`budget.tokenBudget` 默认 50000；`server.host` 默认 `localhost`；`server.port` 默认 3000；`localOnly` 默认 false；`git.autoCommit` 默认 true；`healthCheck.staleDays` 默认 30。必填项：`vaultPath`、`llm.apiKeyRef`、`llm.model`。

`adapter` 是阶段切换开关：`trae-cli`（阶段1）或 `harness`（阶段2）。

---

## 8. 接口设计补充

### 8.1 引擎适配器接口（EngineAdapter）

见 4.3 节，是阶段切换与引擎可替换的核心抽象，对应 AC-05-7、NFR-03-4、NFR-04-3。

### 8.2 `@wiki/harness` 编程 API

见 3.3 节，对应 AC-08-4。

### 8.3 工具定义协议（注册到 harness）

```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;          // OpenAI Function 参数 schema
  handler: (args: unknown, ctx: RunContext) => Promise<unknown>;
}
```

业务层工具（`read_file` 等）按此协议实现并注册。

---

## 9. 部署设计

### 9.1 一键安装脚本

#### Windows（`install.ps1`，AC-06-1）

```powershell
# 检查 Node.js → 检查 TRAE CLI → 安装依赖 → 初始化 Vault → 启动服务
```

#### macOS/Linux（`install.sh`，AC-06-2）

```bash
#!/bin/bash
# 同上流程
```

### 9.2 Docker Compose（AC-06-3）

```yaml
version: '3.8'
services:
  wiki-api:
    build: ./services/api
    ports: ["3000:3000"]
    volumes: ["./vault:/app/vault"]
    environment:
      - GLM_KEY=${GLM_KEY}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
  wiki-web:
    build: ./packages/web
    ports: ["3001:80"]
    depends_on: [wiki-api]
    restart: unless-stopped
```

`docker compose up` 一键启动，Vault 挂载到宿主机持久化。

### 9.3 桌面端（AC-06-4）

Tauri 打包：用 `bun build --compile` 将 Fastify 后端编译为单 binary，作为 Tauri sidecar 捆绑；前端 dist 由 Tauri webview 加载。双击图标启动 sidecar 后端并打开窗口。目标：binary ≤ 80MB，冷启动 ≤ 2 秒。端口冲突时后端自动选择可用端口（从 3000 起递增探测）。

### 9.4 向导式初始化（AC-06-5）

首次启动 Web 向导：

```
步骤1：选择 Vault 路径（或用默认 ./vault）
  ↓
步骤2：选择模型（GLM/Qwen/DeepSeek 下拉，填 API Key）
  ↓
步骤3：生成默认 SCHEMA.md（可后续改）
  ↓
步骤4：完成 → 进入仪表盘（演示模式可一键加载示例）
```

### 9.5 安装进度可视化（AC-06-6）

安装脚本输出结构化日志，桌面端/Web 端解析显示进度条与错误提示。失败时给出可操作修复建议（NFR-05-5）。

---

## 10. 安全设计

### 10.1 本地优先

- 默认仅监听 `localhost`（NFR-02-4）
- 对外暴露须显式配置 `host: 0.0.0.0` + token 鉴权

### 10.2 数据主权

- 全部内容 Markdown 本地存储（NFR-02-1）
- AI 调用外部 API 时明确告知上传范围（NFR-02-2）
- 敏感资料"仅本地处理"开关：开启后不调用 LLM，仅本地检索

### 10.3 版本管理

- Vault 支持 Git（NFR-02-3），初始化时 `git init`
- 每次编译后自动 `git commit`（可配置关闭）

### 10.4 写入约束

- AI 仅可写 `raw/`、`entities/`、`concepts/`、`comparisons/`、`queries/`、`index.md`、`log.md`
- 不得修改 `SCHEMA.md`（由 SCHEMA 自身声明，prompt 强约束 + 业务层 `write_file` 工具校验路径白名单）

---

## 11. 阶段化交付计划

### 11.0 PoC 结论与策略调整（V1.2 → V1.3）

**S-1 PoC 执行结论**：本机安装的是 Trae CN IDE（VS Code fork，`trae.cmd`），非独立 TRAE CLI（`traecli` 命令不可用）。TRAE CLI 支持的 `--print`/`--json` 非交互模式是 `TraeCliAdapter` 子进程调用的前提，当前环境不满足。

**用户决策**：跳过阶段1 TRAE CLI 验证，直接进入自研 `@wiki/harness` + 业务层。prompt 验证在 Trae IDE 中手动进行，不集成到系统中。

**策略调整**：
- 原阶段1（TRAE CLI 验证）+ 阶段2（自研）合并为新阶段1（自研 `@wiki/harness` + 业务层 + 桥接 API + Web 前端）
- `TraeCliAdapter` 暂不实现，`EngineAdapter` 接口保留但默认实现为 `HarnessAdapter`
- `trae-skills/` 目录移除，prompt 资产仍存于 `api/src/prompts/`，供 harness `beforeLoop` Hook 注入与 Trae IDE 手动验证共用
- 阶段3 迭代优化不变

### 11.1 阶段1：自研 `@wiki/harness` + 业务层 + Web 前端

| 交付物 | 对应 AC |
| --- | --- |
| `@wiki/harness` 独立包（独立仓库） | AC-08-1 ~ AC-08-14 |
| `HarnessAdapter` + compile/query 工作流 + 工具注册 | AC-05-13 ~ AC-05-18 |
| 桥接 API（Fastify + REST + SSE） | AC-05-2、AC-05-7 |
| Web 前端 8 大模块 | AC-04-1 ~ AC-04-9 |
| 一键安装脚本 | AC-06-1 ~ AC-06-7 |
| 向导式初始化 | AC-06-5 |
| SCHEMA 可视化编辑器 + 版本对比 | AC-04-7、需规 §8.1 第6条 |
| 《快速上手指南》（含截图，NFR-05-3） | NFR-05-3 |
| healthCheck 走业务层确定性逻辑（build_link_graph） | AC-02-5 |

垂直切片首批交付：投递一篇资料 → `HarnessAdapter.compile` → SSE 流 → 前端显示进度 → 生成页面。

### 11.2 阶段2：迭代优化（持续）

- 增量编译（仅编译新增/变更资料）
- 并发体检
- 断点续传（`harness.resume`）
- 可选：补回 `TraeCliAdapter` 作为备选引擎（若 TRAE CLI 后续安装）

---

## 12. 设计评审记录

### 12.1 自评审检查清单

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| 覆盖全部 FR | ✅ | FR-01~FR-08 均有设计对应 |
| 覆盖全部 NFR | ✅ | NFR-01~NFR-06 均有设计对应（V1.1 补全 NFR-03-3/04-2/05-3） |
| 简约至上 | ✅ | 无过度抽象；`EngineAdapter` 是唯一阶段切换点 |
| 零业务耦合 | ✅ | `@wiki/harness` 无 Markdown/知识库依赖，CI 静态校验；V1.1 Hook 示例去业务化 |
| 阶段切换平滑 | ✅ | `EngineAdapter` 接口 + `adapter` 配置开关；V1.1 补全事件转换、healthCheck 绕过、prompt 等价性 |
| 需规追溯 | ✅ | 每个设计点标注对应 AC |
| 低门槛 | ✅ | 一键安装 + 向导 + 演示模式 + Web 零命令行 + 快速上手指南 |
| 国产化 | ✅ | TRAE CLI / 自研 / 国产模型 |

### 12.2 V1.0 → V1.1 评审修正记录

| 编号 | 严重度 | 问题 | 修正措施 |
| --- | --- | --- | --- |
| S-1 | 严重 | TRAE CLI Skill stdout 协议未验证 | §4.4.1 补充 PoC 验证 + 3 个备选方案（stdout/文件监听/MCP） |
| M-1 | 中 | 阶段2 事件转换机制缺失 | §4.4.2 补充 afterStep Hook + AsyncGenerator 桥接机制 |
| M-2 | 中 | healthCheck 与 harness 关系不明 | §4.6 明确绕过 harness，直接调用 build_link_graph |
| M-3 | 中 | prompt 等价性无保障 | §4.4.2 + §2.3 新增 `prompts/` 单点存储，双引擎共引用 |
| M-4 | 中 | tiktoken 国产模型不准 | §3.3.7 改为流式累加 + provider tokenizer 双轨 |
| M-5 | 中 | Tauri 打包方式不明 | §9.3 明确 bun build --compile + sidecar + 端口自动选择 |
| M-6 | 中 | 文件上传协议不明 | §5.1 明确 multipart/form-data vs application/json |
| M-7 | 中 | API Key 明文落盘 | §7.5 改为 apiKeyRef 引用环境变量，不落盘 |
| M-8 | 中 | 敏感资料开关缺失 | §7.5 + §4.5 补充 localOnly 开关与降级逻辑 |
| M-9 | 中 | SCHEMA 可视化编辑缺失 | §6.X 新增 Monaco 编辑器 + 版本对比 + 失效传播 |
| M-10 | 中 | trae-skills 目录不一致 | §2.3 统一至 api/trae-skills/ |
| L-1 | 轻 | 配置冗余 | §7.5 合并 engine 与 llm 为统一配置 |
| L-2 | 轻 | LLMConfig 类型未定义 | §3.3.7 补充 LLMConfig 类型 |
| L-3 | 轻 | Docker 端口易混淆 | §9.2 改为 3001:80 + 健康检查 |
| L-4 | 轻 | Hook 表含业务示例 | §3.3.6 改为通用示例，业务示例移至 §4.4.2 |
| L-5 | 轻 | 文件路径编码 | §5.1 改为 query 参数 ?path= |
| L-6 | 轻 | fix 事件 schema 缺失 | §5.2 补充 scan/fixing/fixed/done 事件 |
| L-7 | 轻 | archive 篡改风险 | §5.1 改为 sessionId + messageIndex |
| L-8 | 轻 | 迁移/语法/指南遗漏 | §10.5 迁移 + §6.3 语法禁令 + §11.1 快速上手指南 |
| L-9 | 轻 | AC 追溯不完整 | §4.6 阈值 + §10.6 TRAE Work + §6.X SCHEMA 生效 |

### 12.2.1 V1.1 → V1.2 架构自洽性与过度设计复审记录

本次复审针对"架构是否自洽、是否过度设计"两个维度，未覆盖 V1.1 已修问题。

| 编号 | 严重度 | 问题 | 修正措施 |
| --- | --- | --- | --- |
| A-1 | 严重 | healthCheck 阶段1 路径矛盾：§4.6 称不调 LLM，但 §11.1 列了 health-check Skill | §4.3/§4.6/§11.1 明确 healthCheck 不走 Skill，两阶段均绕过引擎直接调用 build_link_graph；仅 /api/health-check/fix 走引擎；trae-skills 仅 compile/query |
| A-2 | 严重 | §2.3 目录树与 §4.2 路径冲突：tools/trae-skills vs api/trae-skills | §2.3 目录树删除 tools/，trae-skills 仅保留在 api/ 下 |
| A-3 | 严重 | §2.3 遗漏 prompts/ 目录（V1.1 评审声称修复但实际遗漏） | §2.3 补 api/src/prompts/，明确阶段1 Skill 与阶段2 harness 共引用机制 |
| A-4 | 严重 | §9.2 docker-compose.yml wiki-api 键重复（YAML 非法） | 合并为单个 wiki-api 块，restart/healthcheck 并入 |
| A-5 | 中 | 两阶段控制权差异未说明，易误判语义不等价 | §4.4.1 后补 A-5 说明：阶段1 prompt 驱动 vs 阶段2 harness 编排 + Hook 兜底，控制权从 LLM 收回到确定性逻辑，是阶段升级价值 |
| A-6 | 中 | localOnly 在 TraeCliAdapter 实现空白 | §4.3 + §7.5 补降级路径：Adapter 内部判断，不构造子进程/harness，compile 仅存档、query 退化为关键词检索 |
| A-7 | 中 | 并发/事务/热加载/harness 日志空白 | §12.3 补 4 项详细设计待办（队列/文件锁、.partial 标记、热加载作用域、harness 日志去向） |

**过度设计评估结论**：核心架构（EngineAdapter / Harness 五机制 / 三工作流）合理，无过度。`@wiki/harness` 独立仓库化基础设施经用户决策维持原方案（V1.1），不回调。`resume(runId)` 接口保留但 §11.3 已列为阶段3 可选。SCHEMA Git 版本对比依赖 Git 初始化，已在 §6.X 说明。

### 12.3 剩余待详细设计阶段处理项

1. TRAE CLI Skill stdout 协议 PoC 验证结果落地
2. 图谱 1000 节点 vis.js benchmark 与降级方案
3. 响应式小屏图谱视图降级方案
4. MCP Server 接口详细协议（✅ 已落地，详见 §12.4）
5. **【A-7 并发控制】**：多个 compile 请求并发时 `index.md`/`log.md` 追加竞态的处理方案（队列串行化 vs 文件锁 vs 内存缓冲批量写）
6. **【A-7 部分失败事务性】**：compile 中途失败时已生成页面的回滚策略（标记 `.partial` 待清理 vs Git 回滚 vs 不回滚标记为 draft）
7. **【A-7 配置热加载边界】**：`config.json` 修改 `budget`/`llm.model`/`adapter` 后是否需重启服务，热加载作用域与时机
8. **【A-7 harness 运行日志与 log.md 关系】**：`log.md` 是业务日志，harness 自身运行日志（step/token/error）的去向（`.harness/logs/` vs 控制台 vs 合并到 log.md）

### 12.4 §12.3-4 MCP Server 接口详细协议

#### 12.4.1 定位与当前状态

**定位**：MCP（Model Context Protocol）Server 模式原为 §4.4.1 S-1 风险缓解的第 3 备选方案——当 TRAE CLI Skill 的 stdout JSON 行协议不可控时，作为事件流订阅的替代通道。本节给出该模式的完整接口规范。

**当前状态（V1.3 决策后）**：
- V1.3 用户决策跳过阶段1（TRAE CLI 验证），直接进入阶段2 自研 `@wiki/harness`，`TraeCliAdapter` 移除，主路径改为 `HarnessAdapter` 通过 `import` 直接调用 harness，**无子进程边界、无 stdout 解析需求**。
- 因此 MCP Server 模式在当前阶段**不实施**，本节仅作为接口规范保留，服务于两类未来场景：
  1. **场景 A（harness 跨进程复用）**：当 `@wiki/harness` 需被非 Node.js 项目（如 Python/Rust 客户端）或外部 IDE 调用时，将 harness 包装为 MCP Server 暴露。
  2. **场景 B（TRAE CLI 回归）**：若未来 TRAE CLI 原生支持 MCP Server 模式，桥接 API 切换为 MCP Client 订阅事件，替代 stdout 解析。

**触发条件**：满足以下任一条件时启动本节实施：
- 出现非 Node.js 客户端需要调用 harness 的需求；
- TRAE CLI 官方发布 MCP Server 模式且经评估优于 stdout 方案；
- harness 需要跨主机部署（MCP over SSE 支持远程，stdout 仅本地）。

#### 12.4.2 协议基础

MCP 基于 **JSON-RPC 2.0**，传输层支持两种：

| 传输 | 方向 | 适用场景 | 本项目选用 |
| --- | --- | --- | --- |
| stdio | 双向（请求-响应 + 通知） | 本地子进程，桥接 API spawn harness-mcp 进程 | 场景 A/B 默认 |
| SSE + HTTP POST | Server → Client 推进度，Client → Server 推请求 | 远程跨主机、Web 客户端 | 场景 A 远程扩展 |

**消息类型**：
- `request`：含 `id`，需响应 `result`/`error`
- `notification`：无 `id`，单向推送（如进度事件）
- `response`：对应某 `request` 的结果

#### 12.4.3 三类原语映射

MCP 定义三类原语，harness 业务能力映射如下：

| MCP 原语 | 方向 | harness 映射 | 用途 |
| --- | --- | --- | --- |
| `tools` | Client → Server | compile / query / health-check-fix / search | LLM 主动调用的工具 |
| `resources` | 双向 | Vault 文件 / SCHEMA.md / index.md / log.md / `.harness/state/*` | 客户端按 URI 读取或订阅变更 |
| `prompts` | Client → Server | compile/query/health-check-fix prompt 模板 | 客户端获取标准 prompt（保证等价性 M-3） |

> 注：`notifications/resources/*` 由 Server 推送，用于文件变更通知（如 compile 完成后 index.md 变更），桥接 API 据此刷新前端缓存。

#### 12.4.4 接口定义

##### 12.4.4.1 工具接口（tools）

**tools/list** — 列出可用工具

```jsonc
// → Request
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }

// ← Response
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "tools": [
      {
        "name": "compile",
        "description": "编译原始资料为结构化 Markdown 页面",
        "inputSchema": {
          "type": "object",
          "properties": {
            "rawPath": { "type": "string", "description": "raw/ 下相对路径" }
          },
          "required": ["rawPath"]
        }
      },
      {
        "name": "query",
        "description": "基于知识库的问答",
        "inputSchema": {
          "type": "object",
          "properties": {
            "question": { "type": "string" },
            "sessionId": { "type": "string", "description": "复用会话上下文" }
          },
          "required": ["question"]
        }
      },
      {
        "name": "health_check_fix",
        "description": "修复孤立页/断链",
        "inputSchema": {
          "type": "object",
          "properties": {
            "issueType": { "enum": ["broken_link", "orphan_page"] },
            "target": { "type": ["string", "object"] }
          },
          "required": ["issueType", "target"]
        }
      },
      {
        "name": "search",
        "description": "全文检索",
        "inputSchema": {
          "type": "object",
          "properties": { "query": { "type": "string" } },
          "required": ["query"]
        }
      }
    ]
  }
}
```

**tools/call** — 调用工具（流式进度通过 notification 推送）

```jsonc
// → Request
{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": {
    "name": "compile",
    "arguments": { "rawPath": "raw/moe-notes.md" }
  }
}

// ← Notification（Server 主动推送，多次）
{
  "jsonrpc": "2.0",
  "method": "notifications/progress",
  "params": {
    "progressToken": "compile-run-abc123",   // 与 tools/call 的 _meta.progressToken 对应
    "step": "read_schema",
    "status": "done",
    "ts": 1720412345678
  }
}

// ← Response（最终结果）
{
  "jsonrpc": "2.0", "id": 2,
  "result": {
    "content": [
      { "type": "text", "text": "编译完成，生成 4 个页面" }
    ],
    "isError": false
  }
}
```

> 进度关联机制：Client 在 `tools/call` 的 `_meta.progressToken` 中传入唯一 token，Server 在 `notifications/progress` 中回传相同 token，Client 据此将进度事件路由到对应 SSE 流。

##### 12.4.4.2 资源接口（resources）

**resources/list** — 列出 Vault 资源

```jsonc
// ← Response
{
  "result": {
    "resources": [
      { "uri": "vault://schema.md", "name": "SCHEMA", "mimeType": "text/markdown" },
      { "uri": "vault://index.md", "name": "索引", "mimeType": "text/markdown" },
      { "uri": "vault://concepts/moe.md", "name": "MoE 概念页", "mimeType": "text/markdown" },
      { "uri": "harness://state/abc123", "name": "运行状态 abc123", "mimeType": "application/json" }
    ]
  }
}
```

**resources/read** — 读取资源内容

```jsonc
// → Request
{ "method": "resources/read", "params": { "uri": "vault://schema.md" } }

// ← Response
{
  "result": {
    "contents": [
      { "uri": "vault://schema.md", "mimeType": "text/markdown", "text": "# SCHEMA\n..." }
    ]
  }
}
```

**resources/subscribe** — 订阅资源变更（compile 完成后 index.md 变更自动推送）

```jsonc
// → Request
{ "method": "resources/subscribe", "params": { "uri": "vault://index.md" } }

// ← Notification（资源变更时）
{
  "method": "notifications/resources/updated",
  "params": { "uri": "vault://index.md" }
}
```

##### 12.4.4.3 Prompt 模板接口（prompts）

**prompts/list** 与 **prompts/get** 保证客户端获取与 harness 内部 `beforeLoop` 注入完全一致的 prompt（M-3 等价性）。

```jsonc
// → Request
{ "method": "prompts/get", "params": { "name": "compile" } }

// ← Response
{
  "result": {
    "description": "compile 工作流 system prompt",
    "messages": [
      { "role": "user", "content": { "type": "text", "text": "<prompts/compile.md 内容>" } }
    ]
  }
}
```

#### 12.4.5 桥接 API 作为 MCP Client 的实现

启用 MCP 模式时，`EngineAdapter` 接口不变，仅替换实现：

```typescript
// src/engine/mcp-adapter.ts（未来扩展点，当前不实现）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class McpAdapter implements EngineAdapter {
  private client: Client;

  constructor(private config: { command: string; args?: string[] }) {
    const transport = new StdioClientTransport({ command, args });
    this.client = new Client({ name: 'karpathy-wiki-bridge', version: '1.0.0' }, { capabilities: {} });
    // 连接时完成 initialize 握手 + capabilities 协商
  }

  async compile(input: CompileInput): AsyncIterable<ProgressEvent> {
    const token = `compile-${Date.now()}`;
    // 注册 progressToken → 事件队列
    // 调用 tools/call，期间消费 notifications/progress 转为 ProgressEvent yield
    // 收到最终 response 后清理队列
  }

  async query(input: QueryInput): AsyncIterable<QueryEvent> { /* 同模式 */ }
  async healthCheckFix(input: FixInput): AsyncIterable<FixEvent> { /* 同模式 */ }
}
```

**事件路由**：`notifications/progress.progressToken` 是路由键，McpAdapter 内部维护 `Map<progressToken, AsyncQueue<ProgressEvent>>`，每个 `tools/call` 创建独立队列，桥接 API 从队列消费转 SSE。

#### 12.4.6 与 stdout JSON 行方案对比

| 维度 | stdout JSON 行（§4.4.1 方案1） | MCP Server（本节） |
| --- | --- | --- |
| 协议复杂度 | 低（按行 JSON） | 中（JSON-RPC 2.0 + 握手） |
| 双向通信 | 否（仅 Server→Client） | 是（Client 可调 tools/resources） |
| 资源订阅 | 否（需轮询） | 是（resources/subscribe） |
| 跨语言 | 受限（依赖 stdout 编码） | 原生支持（SDK 多语言） |
| 跨主机 | 否 | 是（SSE 传输） |
| 依赖 | 零 | `@modelcontextprotocol/sdk` |
| 当前实施 | 否（V1.3 跳过阶段1） | 否（保留扩展点） |

#### 12.4.7 错误处理与降级

| 错误类型 | MCP 错误码 | 处理策略 |
| --- | --- | --- |
| 工具参数校验失败 | -32602 (Invalid params) | 返回 `isError: true` + 错误描述，不重试 |
| LLM 调用超时 | -32001 (Server error) | harness 内部重试（§3.3.4），仍失败则返回 |
| 预算耗尽 | -32002 (Server error) | 返回部分结果 + `status: budget_exceeded`（AC-08-8） |
| 进程崩溃 | 连接断开 | Client 检测 EOF → 转为 SSE error 事件 → 前端提示重试 |
| 握手失败 | -32603 (Internal error) | Client 不重试，记录日志并降级到 stdout 模式（若可用） |

#### 12.4.8 实施清单（触发时执行）

当 §12.4.1 触发条件满足时，按以下顺序实施：

1. 新增 `api/src/engine/mcp-adapter.ts`（实现 `EngineAdapter`）
2. 新增 `wiki-harness/src/mcp/server.ts`（harness 包装为 MCP Server，复用 `examples/` 中的工具 schema）
3. `config.json` 新增 `adapter: "mcp"` 选项与 `mcp: { command, args }` 配置
4. 在 `index.ts` 启动时根据 `adapter` 字段实例化 `McpAdapter`
5. 端到端验证：compile/query/health-check-fix 三工作流通过 MCP 通道完成
6. 更新 DELIVERY.md 记录 MCP 适配实施

---

## 13. 阶段交接声明

- 当前阶段：概要设计（V1.2，评审通过）✅ 已完成
- 下一阶段：详细设计与编码实施（阶段1 优先）
- 下一阶段智能体：全栈开发智能体
- 下一阶段技能：web-dev-trae / fullstack-developer / 前端设计技能
- 交接上下文：本概要设计 V1.2（评审通过）作为设计基准。下一阶段须依据本设计与需规 V2.2 进行详细设计与编码。**前置任务**：阶段1 进入详细设计前须先完成 TRAE CLI Skill 输出协议 PoC（S-1）。优先交付阶段1：TRAE CLI Skill（仅 compile/query）+ 桥接 API + Web 前端 + 一键安装 + SCHEMA 编辑器 + 快速上手指南。`@wiki/harness` 独立组件包可在阶段1 并行启动（不阻塞主线）。`EngineAdapter` 接口须在阶段1 即落地，确保阶段2 平滑切换。prompt 资产单点存储于 `api/src/prompts/`，双引擎共引用。**V1.2 新增待办**（§12.3 第 5-8 项）：并发控制、部分失败事务性、配置热加载边界、harness 运行日志去向，须在详细设计阶段明确。
