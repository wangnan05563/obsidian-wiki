# DeepSeek Harness 调研与架构对比分析

> 调研方式：通过 **GitHub MCP**（`deepseek-ai/deepseek-harness` 仓库的 README、根目录结构、`docs/architecture.md`、`packages/` 清单）实拉源码结构 + 公开报道交叉验证。
> 调研时间：2026-08-14 ｜ 对比对象：本仓库 `wiki-harness`（生产中以 `HarnessAdapter` / `queryWorkflow` 接入）。

---

## 1. DeepSeek Harness（DSH）是什么

| 维度 | 事实（来自 GitHub MCP 实拉） |
|---|---|
| 仓库 | `github.com/deepseek-ai/deepseek-harness`（`deepseek-ai` 官方组织） |
| 发布 | 2026-08-13 创建，**开发者预览版（Developer Preview）** |
| 一句话定位 | "Everything is a Plugin" —— DeepSeek 自己做的 Agent 运行框架（不是新模型、不是 API 客户端，而是把模型接入文件/终端/网页/工具并编排上下文、工具调用、任务执行的执行层） |
| License | **MIT**（可商用、可改） |
| 形态 | pnpm monorepo，含 `packages/ apps/ examples/ python/ native/ vendor/ website/ docs/`；启动方式 `npx @deepseek-ai/dsh web`（Web UI 默认 `127.0.0.1:3080`） |
| 内置模式 | **标准 / 极简 / 创造 / PTC**（程序化工具调用）四种，各默认加载不同插件集 |
| 生态 | `dsh-plugin` 话题、Discord 社区、`awesome-deepseek-harness` 精选列表、第三方插件（如 `dsh-agent-teams` 子智能体编排）已出现 |
| 稳定性声明 | 官方明确：**"THERE WILL BE COMPATIBILITY-BREAKING CHANGES."**（迭代快速、破坏性变更） |

**底层基石**：[Cordis](https://github.com/cordiverse/cordis) 插件元框架，理念来自北大与 DeepSeek 联合署名的论文《A Programming Paradigm for Spatiotemporal Composability》。Cordis 只负责插件的加载/卸载/依赖关系，具体 Agent 能力全部由插件提供。

---

## 2. DSH 架构核心（与本地框架最值得对比的部分）

### 2.1 一切皆插件，没有特权核心
> "There is no privileged core to patch: you extend dsh by mounting a plugin beside the others." —— 连 **模型适配器、工具注册表、会话日志、Agent Loop 本身**都是插件，全部可被配置替换，无需改 dsh 源码。

本地 `wiki-harness` 的 Agent Loop、StateStore、HookManager 是**写死在主类里**的（虽有接口抽象，但只有单一实现、不可组合替换）。

### 2.2 运行时由 Profiles + Bundles 组合而成
- **Profile**：命名组合（存于 Harness home），列出堆叠的 bundle、out-of-tree 插件、用户的 `cordis.patch.yml`。`web` / `headless` 为内置模板。
- **Bundle**：Cordis 配置行 + 挂载代码的发布单元。`dsh-base`（模型/工具/持久化/沙箱/审批/设置/凭据/遥测）是每份 profile 的第一层；`dsh-web-app` 加浏览器应用；`dsh-headless` 加无服务器的一次性运行器。
- 分层覆盖顺序：profile 列出的各 bundle → profile 的 `cordis.patch.yml` → home 级 patch → `--patch` 覆盖。任意一行都可用自己的 patch 替换（`dsh --profile web --dump-config` 可见实际启动树）。

### 2.3 上下文键值（ctx.xxx）+ 能力接缝（Seam）
核心包把能力注册到共享 `ctx`：
`ctx.llm` `ctx.tools` `ctx.agents` `ctx.agentLoop` `ctx.sessions` `ctx.systemPrompt` `ctx.fs` `ctx.shell` `ctx.subprocess` `ctx.terminals` `ctx.commands` `ctx.jobs` `ctx.sandbox` `ctx.sessionTitle` `ctx.goals` …

**Seam = Service Definition + Service Provider + Consumer** 三者齐备才算能力。关键收益：文件系统与子进程共享同一执行世界，**把 provider 指向远程沙箱，Bash/PTY/LSP 一并迁移，无需各自 fork**。

### 2.4 追加式（append-only）会话事件日志 = 单一事实源
> "Model-visible means logged." —— 任何进模型请求的内容都必须能从日志重建，并有运行时不变式断言。

- `SessionEvent` 是持久事实，追加写入并广播（`session/event`）。
- `deriveMessages()` 从日志投影出模型可见历史；原始 `assistant/chunk` 保留以便回放与 UI 还原。
- **Fork / resume / 转录 / 遥测 / 持久化全部派生自此流**。

本地 `wiki-harness` 的会话是 `RunContext.messages: Message[]`（普通数组）+ `FileStateStore` 整存整取，`resume()` 直接 reload 原始消息——**没有事件溯源，无 fork、无重放不变式**。

### 2.5 事件驱动扩展点（瀑布流）
事件分三类：
- **Session events**：持久事实（turn/start、step/start、user/message、assistant/*、tool/* …）。
- **Agent events**（`agent/*`）：携带活体 `Agent`（inbox/step/status/request/validation/continuation），用于观察或拦截在途工作。
- **Capability events**（`fs/*`、`tools/*`、`telemetry/*`）：把策略/适配器挂到接缝，不 import loop。

其中 `agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute/execute/post-execute` 是**瀑布流**，监听器必须调 `next()` 委托；`agent/pre-step` 可**改写或拒绝**模型所见；`agent/turn-stopping` 可终止一轮。

本地 HookManager 仅 4 个钩子：`beforeLoop / beforeStep / afterStep / afterLoop`——**无请求级拦截、无改写/拒绝、无瀑布委托**。

### 2.6 50+ 内置能力包（packages/ 实拉清单节选）
`core`（session/system-prompt/tools/agent/agent-loop/scope）、`llm`、`fs`、`shell`、`subprocess`、`terminal`、`lsp`、`sandbox`、`e2b`（远程沙箱）、`mcp`、`skill`、`subagent`、`workflow`、`plan`（计划模式）、`compaction`（上下文压缩）、`goal`（同会话目标）、`guard`（审批/护栏）、`jobs`、`schedule`、`credentials`、`settings`、`storage`、`identity`、`feedback`、`runtime-diagnostics`、`web`、`client`、`sdk` … 覆盖了文件系统、终端/PTY、语言服务器、网页访问、技能、子智能体、工作流、计划模式、MCP、沙箱、压缩、遥测等。

**本地 `wiki-harness` 完全没有上述任何一项**——它是为"RAG 式问答 + 少量工具"聚焦设计的极简运行时。

---

## 3. 现有框架（wiki-harness）现状

| 层 | 位置 | 职责 |
|---|---|---|
| 运行时 | `wiki-harness/src/harness.ts` | `Harness` 类：`run` / `resume` / `runStream` |
| 循环 | `loop/tool-loop.ts` | `runLoop` / `runLoopStream`：单 `while` 循环（LLM→tool_calls→执行→回填→下一轮） |
| LLM | `llm/llm-adapter.ts` + `openai-compatible.ts` | `LLMAdapter` 抽象 + `OpenAICompatibleAdapter`（原生 fetch、SSE 流式、tool_calls 分片累积） |
| 护栏 | `budget/budget-guard.ts` `retry/retry-policy.ts` | 步数/token 预算、指数退避（仅 timeout/rate_limit 重试） |
| 钩子 | `hook/hook-manager.ts` | 4 方法钩子 |
| 持久化 | `state/file-state-store.ts` | `save/load/list` 整存整取 |
| 生产接入 | `api/src/engine/harness-adapter.ts` | `HarnessAdapter implements EngineAdapter`（BYOK、vault、webSearch、tools 配置） |
| 业务流 | `api/src/workflows/query-workflow.ts` | 导入 `Harness` + `runStream`，编排对 Obsidian vault 的问答 |
| 替换缝 | `api/src/types.ts` | `EngineAdapter` 注释明确为"阶段切换抽象点，V1.3 仅 HarnessAdapter，但接口预留为后续替换" |

**测试**：`file-state-store.test.ts` `retry-policy.test.ts` `tool-loop.test.ts`（vitest），质量基线良好。
**优点**：极简、零重依赖、流式链路清爽、预算/重试/钩子边界清晰、已落地生产且 `EngineAdapter` 已解耦。

---

## 4. 能力对比矩阵

| 能力 | wiki-harness（现状） | DeepSeek Harness |
|---|---|---|
| Agent Loop 可替换 | ❌ 单一实现写死 | ✅ 本身即插件（`ctx.agentLoop`） |
| 模型适配器可换 | ⚠️ 有接口但仅 1 实现 | ✅ 多 provider 插件 |
| 工具注册/执行 | ⚠️ 内存数组 + 顺序执行 | ✅ 作用域注册表 + 护栏执行流水线（`tools/*` 事件） |
| 会话持久化 | ⚠️ 整存整取数组 | ✅ 追加式事件日志（可回放/fork） |
| 断点恢复 | ✅ `resume()` 重 load 消息 | ✅ 从日志派生 + fork |
| 请求级拦截/改写/拒绝 | ❌ 仅 before/after 钩子 | ✅ `agent/pre-step` 瀑布可改写/拒 |
| 能力接缝（换 provider 联动迁移） | ❌ | ✅ FS/Shell/Subprocess/PTY/LSP 共享执行世界 |
| 子智能体 / 计划模式 | ❌ | ✅ `subagent` / `plan` |
| 上下文压缩 | ❌ | ✅ `compaction` |
| MCP / 技能 / 工作流 | ❌ | ✅ `mcp` / `skill` / `workflow` |
| 沙箱（本地/远程） | ❌ | ✅ `sandbox` / `e2b` |
| UI / 无头 / SDK | ❌（仅库） | ✅ `web` / `headless` / `sdk` / `client` |
| 遥测 / 凭据 / 设置 | ❌ | ✅ `telemetry` / `credentials` / `settings` |
| 多语言 / 原生加速 | ❌ 纯 TS | ✅ `python/` + `native/`（Rust 绑定） |
| 学习曲线 | 低（~270 文件的小运行时） | 高（Cordis 新范式 + 50+ 包） |
| 稳定性 | ✅ 自用稳定 | ⚠️ DevPreview，破坏性变更 |
| 供应链面 | 小 | 大（230 workspace 成员 + native 代码） |

---

## 5. DSH 对本项目的核心优势

1. **可演进性天花板高**：连 Loop、会话、模型都能换，产品不会因"核心写死"而触顶。本地若要加能力只能改主类或加钩子。
2. **一次性替换的联动效应**：远程沙箱/换模型是"改一个 provider"，而非到处 fork——对多环境部署（本机/云/评测）极友好。
3. **可审计、可回放、可 fork 的会话**：追加式日志让"出了什么、模型看见了什么"100% 可重建，利于调试 vault 问答的幻觉/越界。
4. **开箱即用的 Agent 能力**：MCP、子智能体、计划模式、压缩、技能——若 wiki 从"问答"演进为"能代办/多步研究的 Agent"，这些是现成的。
5. **MIT + 活跃生态**：可合法集成，且 `dsh-plugin` 生态在快速生长。

## 6. DSH 的风险与不适用点（对当前项目）

1. **DevPreview 不稳定**：官方明示破坏性变更——直接嵌入生产问答服务风险高。
2. **过度工程**：当前 wiki 是聚焦的 RAG Q&A，50+ 包 + Cordis 新范式是显著 overkill，维护成本远高于收益。
3. **学习/迁移成本**：Cordis"时空可组合"范式较学术，团队需重新建立心智模型；`native/` 原生绑定需信任供应链。
4. **与 DeepSeek 生态耦合**：虽支持 OpenAI 协议（BYOK 可用别家），但默认调优与社区重心在 DeepSeek 模型。
5. **本地已具备解耦缝**：`EngineAdapter` 已是预留替换点，说明团队早有"未来可换引擎"的打算——但这也意味着**现在不必为了"能换"而引入 DSH**。

---

## 7. 升级 / 替换价值判断（结论）

**是否值得"整体替换"为 DSH：当前不建议。**
理由：DevPreview 不稳定 + 对聚焦场景 overkill + 供应链/学习成本。直接把生产问答迁到 DSH 属高风险低紧迫。

**是否值得"升级架构（借鉴设计思想）"：值得，且应选择性增量采纳。**
本地 `wiki-harness` 已在测试与流式上打好底子，但 Loop/会话/钩子是写死的。建议把 DSH 的**设计哲学**搬进 v0.2，而不是搬它的代码：

| 借鉴项 | 落地到 wiki-harness 的做法 | 优先级 |
|---|---|---|
| 追加式会话事件日志 | `RunContext.messages` → append-only `SessionEvent[]`；`deriveMessages()` 投影；强化 `resume`、增加 `fork`、可审计 | **P0** |
| 能力接缝（Definition/Provider/Consumer） | 把 LLM / FS / Shell 抽象为可换 provider，`sandbox` 成配置而非改码 | **P1** |
| 富事件总线（agent/*、tools/* 瀑布 + next 拦截/改写/拒绝） | 把 4 方法 `HookManager` 升级为可拦截请求/工具/轮次的总线（护栏/审批、上下文注入自然落地） | **P1** |
| 上下文压缩（compaction） | 针对大 Obsidian vault 长会话做历史压缩，控 token 预算 | **P2** |
| 子智能体 / 计划模式 | 仅当 wiki 演进为多步研究/代办 Agent 时引入 | **P3（看产品方向）** |

**替换触发条件（未来再评估）**：当 DSH 达到 1.0 稳定、且 wiki 产品需求已超出极简运行时承载力（需要 MCP/子智能体/计划/沙箱）时，利用已有的 `EngineAdapter` 缝做整体迁移，成本可控。

---

## 8. 建议下一步

1. **短期（本周可做）**：在 `wiki-harness` 内把会话改为事件溯源（P0），顺手让 `resume` 更稳、加 `dump-session` 调试命令。
2. **中期**：将 `HookManager` 升级为带 `next()` 的事件总线（P1），把"审批/越界护栏/上下文注入"从 hack 变成一等能力。
3. **跟踪**：watch `deepseek-ai/deepseek-harness` 与 `cordiverse/cordis`，等 1.0 与生态成熟；先用 `npx @deepseek-ai/dsh web` 在本机体验四种模式，验证哪些能力真对自己有用。
4. **不做什么**：现在不把生产问答迁到 DSH，不动 `EngineAdapter` 之外的接入层。

---

### 附：调研证据索引（GitHub MCP 实拉）
- `deepseek-ai/deepseek-harness` → `README.md`、`docs/architecture.md`、`packages/`（55 个包目录）、根目录结构
- 公开报道交叉印证：InfoQ《DeepSeek 把 Harness 开源了：模型、工具、Agent Loop 全是插件》、DeepTech《DeepSeek 正式开源 Harness》、36kr《刚刚，DeepSeek Harness 震撼开源：一切皆插件》
- 本地证据：`wiki-harness/src/*`、`karpathy-wiki/api/src/engine/harness-adapter.ts`、`query-workflow.ts`、`types.ts`（`EngineAdapter` 注释）
