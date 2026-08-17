# wiki-harness 增量升级：开源调研与优化需求梳理

> 调研日期：2026-08-14 ｜ 调研手段：GitHub MCP（`search_repositories` / `get_file_contents` / `search_code`）+ GitHub API 元数据
> 目标：为 karpathy-wiki 后端 `wiki-harness`（LLM + 工具循环 + hooks + 文件状态）的增量升级筛选最有参考价值的技术方案，并据此梳理结构化优化需求。
> 升级总原则（来自既有纪律）：**默认关闭 / 零破坏（default-off / zero-breakage）**——新增能力不开启即完全透传，绝不改变现有 Q&A 行为。

---

## 一、调研全景：同类开源项目候选

通过 GitHub 检索 `agent framework` / `llm agent framework language:TypeScript` / `multi-agent framework`（按 stars 排序），得到候选池。按"与本项目架构相关度（TS / RAG Q&A / 工具循环 / 事件溯源 / 拦截器 / 压缩 / 规划 / 子智能体）"筛选，重点深读以下仓库：

| 候选 | 定位 | 与本项目相关点 | 备注 |
|---|---|---|---|
| **mastra** (mastra-ai/mastra) | 现代 TS AI 应用/智能体框架 | 图工作流、storage 暂停/恢复、上下文管理（RAG+观察记忆）、MCP、evals、可观测性 | ⭐27.2k，极活跃 |
| **langgraphjs** (langchain-ai/langgraphjs) | 低层"有状态智能体"编排框架 | **checkpoint 事件溯源**（401 处代码）、durable execution 崩溃恢复、**subagents**（212 处）、短/长期记忆 | ⭐3.2k，MIT，活跃 |
| **voltagent** (VoltAgent/voltagent) | 开源 TS 智能体工程平台 | **Guardrails 运行时拦截/校验**（81 处）、工具生命周期 hooks、Supervisors & Sub-Agents、LibSQL 记忆、可恢复流式 | ⭐10.4k，MIT，活跃 |
| **12-factor-agents** (humanlayer) | 构建可靠 LLM 软件的 12 条原则 | Factor 5 统一执行态/业务态、Factor 9 错误压缩进上下文、Factor 12 无状态 reducer、Factor 8 掌控控制流、Factor 10 小而专的 agent | ⭐25.3k，原则/内容库 |
| LlamaIndexTS (run-llama) | TS 数据框架（RAG） | RAG/记忆模式 | ⚠️ **已废弃（deprecated）**，仅作模式参考，不采用 |
| nanobot / open-multi-agent / swarms / crewAI 等 | 多智能体框架 | 多智能体编排思路 | 与本项目"单循环+可选子智能体"定位偏差大，仅作理念旁证 |

---

## 二、筛选结果：最有参考价值的 4 个方案

> 评估维度：**架构契合度**（是否贴合 TS + 工具循环 + RAG Q&A）、**可借鉴的具体机制**、**采用风险（是否需引入依赖/重写）**、**社区活跃度**。

### 1. 12-factor-agents —— 设计哲学总纲（GO：纯原则，零采用风险）
- 不直接提供代码库，而是给出可逐项落地的工程原则，最契合本项目"小步模块化、不推倒重写"的既有纪律。
- 关键映射：**Factor 5（统一执行态与业务态）→ 事件溯源 SessionLog**；**Factor 9（把错误压缩进上下文）→ 上下文压缩**；**Factor 12（让 agent 成为无状态 reducer）→ 日志回放/崩溃恢复**；**Factor 8（掌控你的控制流）→ 规划器/plan mode**；**Factor 10（小而专注的 agent）→ 子智能体**。

### 2. langgraphjs —— 事件溯源 + 子智能体 + 崩溃恢复的范式标杆（GO：借鉴模式，不引入依赖）
- `libs/checkpoint` 是专门的"检查点/事件日志"基础设施（base.ts / schema.ts / serde/types.ts），与本项目 **P0 事件溯源 SessionLog** 高度同构：状态 = 不可变事件的追加日志，恢复 = 从检查点重放。
- `examples/streaming/src/subagent-status`（in-process / remote）与 `libs/sdk*/docs/subagents.md` 给出**一等公民级子智能体**范式，对应本项目子智能体开关。
- durable execution + interrupts 对应"崩溃后从断点恢复"——直接缓解本项目的 `:3000` 孤儿进程/重启丢状态痛点。
- **No-Go on 依赖**：langgraph 是图编排引擎，引入等于重写 harness；只取其"checkpoint = 追加日志 + 重放"的**思想**。

### 3. voltagent —— 拦截器/Guardrail 总线 + 子智能体的实现范本（GO：借鉴模式，不引入依赖）
- `packages/core/src/agent/guardrail.ts` + `and-guardrail.ts` + 配套 spec（81 处）证明 **Guardrails 是运行时拦截/校验层**：在 agent 输入/输出处插入校验钩子（内容策略、安全规则）。这正是本项目 **P1 HookManager（拦截器总线）** 的现成范本。
- 工具注册表带 **lifecycle hooks + cancellation**，对应"工具调用前后钩子"。
- **Supervisors & Sub-Agents**（supervisor 运行时路由任务、保持同步）对应子智能体编排。
- **No-Go on 依赖**：voltagent 是含云控制台（VoltOps）的工程平台，体量大；只取其 Guardrail/Hook 设计。

### 4. mastra —— 生产级 TS 框架基线（GO：架构基线参考）
- 提供"生产就绪智能体"的完整拼图：图工作流、storage 适配器（暂停/恢复）、observability/evals、MCP、RAG。
- 最适合作为**整体架构基线对照**——尤其其"storage-backed pause/resume"与"observability"对应本项目可观测性缺口（此前 Q&A 管线 143s/282s 长耗时却无 stage 级日志的痛点）。
- **No-Go on 依赖**：batteries-included 框架，会与现有 Fastify/tsx/BYOK 技术栈冲突；仅作"生产级该有什么"的清单。

### 明确否决
- **LlamaIndexTS**：官方已标记 deprecated，不采用为代码参考（其 RAG/记忆思想已被 langgraph/mastra 覆盖）。
- **crewAI / autogen / MetaGPT 等 Python 框架**：语言栈与"小而专的子智能体 + TS 单循环"定位不符，仅作多智能体理念旁证，不纳入采纳清单。

---

## 三、Go / No-Go 评估矩阵

| 方案 | 采纳动作 | 决策 | 零破坏影响 | 风险 |
|---|---|---|---|---|
| 12-factor-agents | 作为设计原则写入升级规范，逐项映射 | **GO（原则）** | 无（仅指导） | 低 |
| langgraphjs checkpoint/重放思想 | 借鉴"追加日志+重放"模式实现 SessionLog | **GO（模式）** | 默认关闭时完全透传 | 中（需设计事件 schema） |
| voltagent Guardrail/Hook | 借鉴实现 HookManager（生命周期钩子+校验） | **GO（模式）** | 无钩子时透传 | 中（钩子顺序/异常传播需定规） |
| voltagent / langgraph 子智能体 | 借鉴声明式 SubAgentConfig + supervisor 路由 | **GO（模式，已启动）** | 默认关闭；`resolveSubAgents` 已接线 | 中（递归隔离——子智能体排除 `spawn_*`） |
| mastra observability/storage | 借鉴"步骤追踪 + storage 适配器"补齐可观测性 | **GO（基线）** | 仅新增追踪日志，不改主链路 | 低 |
| 引入任一框架作为依赖 | 直接依赖 langgraphjs / voltagent / mastra | **No-Go** | — | 高（重写风险、栈冲突） |

---

## 四、结构化优化需求（映射到 karpathy-wiki / wiki-harness）

> 每项标注：**参考来源 / 收益 / 风险与零破坏影响 / 优先级**。优先级沿用既有增量路线：P0 事件溯源 → P1 拦截器总线 → P2 上下文压缩 → P3 规划器 → 子智能体（默认关闭）。

### P0 — 事件溯源 SessionLog（可观测 + 可恢复的根基）
- **P0-1 追加式 SessionLog**：为每次 Q&A 会话建立不可变事件流，事件类型至少含 `user_msg / llm_token / tool_call / tool_result / plan / subagent_spawn / error / done`。
  - 参考：langgraphjs `libs/checkpoint`（401 处）、12-factor Factor 5/12。
  - 收益：问答过程可回放、可审计、可直接驱动前端时间线；**顺带解决"长耗时无 stage 日志"痛点**（每事件带 stage 与时间戳）。
  - 零破坏：仅新增写日志，不读则不展示；现有链路行为不变。
- **P0-2 重放/重建（rehydrate）**：会话崩溃或后端重启后，从 SessionLog 重建内存状态继续，而非丢上下文。
  - 参考：langgraphjs durable execution、12-factor Factor 12（无状态 reducer）。
  - 收益：缓解 `:3000` 重启后状态丢失、孤儿进程问题；支持"断点续答"。
  - 风险：需保证事件幂等与顺序；默认关闭时不重放。
- **P0-3 持久化与暴露**：SessionLog 落到现有 FS 持久层，并提供只读 API 供前端"会话时间线/步骤追踪"渲染。
  - 参考：mastra storage、voltagent LibSQL memory。

### P1 — 拦截器总线 HookManager（可扩展性的中枢）
- **P1-1 生命周期钩子**：定义 `beforeLLM / afterLLM / beforeTool / afterTool / onToken / onError` 钩子点，框架在对应时机调用已注册钩子。
  - 参考：voltagent `guardrail.ts`（输入/输出拦截校验）、工具 lifecycle hooks；12-factor Factor 8（掌控控制流）。
  - 收益：审计、预算守卫、内容护栏、错误压缩等都可作为"钩子"插拔，不侵入主循环。
  - 零破坏：未注册任何钩子时完全透传（与现有行为一致）。
- **P1-2 内置钩子**：`audit-log`（落 SessionLog）、`token-budget-guard`（超预算熔断）、`content-guardrail`（输入/输出校验）、`error-compactor`（接 P2）。
  - 参考：voltagent Guardrails 校验语义。
- **P1-3 钩子异常语义**：钩子抛错默认阻断并转 `onError`；钩子自身故障不得拖垮主链路（fail-soft）。
  - 风险：需明确钩子执行顺序与短路规则；默认全关。

### P2 — 上下文压缩（控成本、防溢出）
- **P2-1 滚动压缩**：上下文窗口逼近上限时，保留最近 N 轮 + 对较早轮次生成压缩摘要，摘要进入 SessionLog 以便重放。
  - 参考：12-factor Factor 9（把错误压缩进上下文）、Factor 3（掌控你的上下文窗口）。
  - 收益：长会话不爆 token、降成本；配合 P0 重放可恢复压缩态。
  - 零破坏：仅当会话超阈值触发；短会话无感。
- **P2-2 错误压缩钩子**：将重复/同类错误折叠为单条上下文摘要（接 P1-1 `onError`）。
  - 参考：12-factor Factor 9。
- **P2-3 压缩与事件溯源对齐**：压缩摘要作为一类事件写入 SessionLog，重放时优先用摘要而非原始长日志。
  - 参考：langgraphjs `checkpoint/serde`。

### P3 — 规划器 Plan Mode + LlmPlanner（多步可控）
- **P3-1 计划模式**：执行多步任务前，LLM 先产出计划（步骤图），用户/自动审批后再执行；支持暂停/恢复。
  - 参考：langgraphjs "Deep Agents"（plan + subagents + 文件系统）、12-factor Factor 8。
  - 收益：复杂问答可控、可解释；减少"跑偏"。
  - 零破坏：默认关闭；关闭时维持现有单循环。
- **P3-2 LlmPlanner 集成**：规划结果转为既有工作流步骤；与 P0 事件溯源、P1 钩子天然衔接（每计划步 = 一个事件）。
  - 参考：mastra workflows 控制流。
- **P3-3 与子智能体协同**：规划步可委派给子智能体（见 SA）。

### SA — 子智能体（默认关闭，已启动接线）
- **SA-1 声明式 SubAgentConfig → 自动注册 `spawn_<name>` 工具**：隔离的子预算/上下文；子智能体**排除 `spawn_*`** 以防隐式递归。
  - 参考：langgraphjs subagents（212 处）、voltagent Supervisors & Sub-Agents、12-factor Factor 10（小而专的 agent）。
  - 现状：`api/src/engine/harness-adapter.ts` 的 `resolveSubAgents` + `RESEARCHER_SUBAGENT` 已落地；`config.json` 的 `enableSubAgents` 字段 + 前端 `Config.vue` 实时开关已接好（本次会话前序工作）。
  - 零破坏：`enableSubAgents` 默认 `false`；关闭时不注册任何子智能体。

### 横切 — 生产可观测性（直接回应历史痛点）
- **X-1 步骤级追踪面板**：基于 P0 SessionLog 渲染每步 stage、耗时、token，定位"143s/282s 长耗时"瓶颈阶段。✅ **已落地（2026-08-16）**
  - 现状：`wiki-harness` 的 `runLoop`/`runLoopStream` 每步测量 `llmMs/toolMs/tokens/toolNames` 写入 `RunState.timings` 并 `console.log('[harness-step]',…)`；`harness.runStream` 终端态补齐 `stateStore.save`（此前流式不落盘）；api 新增只读 `GET /api/query/runs`（列表含 totalMs）与 `GET /api/query/runs/:runId`（events+timings+聚合总耗时，读 `getApiDir()/.harness/state`）；`AnswerChunk.runId` 经 SSE done → store → `ChatMessage.runId` 透传；前端 `QueryTracePanel.vue` 折叠面板懒加载拉取并渲染每步表（>2s 步骤高亮为热点）。三端 tsc 全绿，端到端冒烟（mock LLM 驱动 runStream → 落盘 → 实时路由 200 返回 timings）通过，已部署 `public_live_1786810548145` 并重启后端。
  - 参考：mastra observability、voltagent tracing。
  - ✅ 安全（2026-08-16 收口）：trace + compile 共四条 runs 路由已统一挂 `requireAuth`（`registerRunsRoute` 传 `isolationGuards` + 各路由加 `preHandler: guards.requireAuth`），无 token 返回 401；前端 `QueryTracePanel`/`compile.ts` 均经 `apiFetch` 自动带 token，登录态下无感。冒烟确认 `GET /api/query/runs` 无 token → 401、SPA 200。
- **X-2 可恢复流式（resumable streaming）**：客户端刷新后可重连进行中的 SSE 继续接收同一响应。✅ **已落地（2026-08-15）**
  - 现状：`api/src/workflows/stream-run-manager.ts` 新增进程级单例 `StreamRunManager`（`start`/`subscribe`/`unsubscribe`/`has`，默认 TTL 5min 回收完成态 run），把 harness 运行（`adapter.query`）与 HTTP 请求生命周期解耦——客户端断开只退订、`run` 继续后台跑完并缓冲全量 chunk；`subscribe` 返回 `'finished'|'live'`（先回放缓冲再阻塞至 done）。`api/src/routes/query.ts` 在 `enableResumableStream` 开启时走两条新分支：首连 `handleResumableStart` 首帧发 `open{runId}`、由管理器驱动 producer 并在 `chunk.done` 时 `onDone` 一次性持久化（会话+记忆，加 `input.question` 会话锁，仅首连加）；重连 `handleResumeRun` 凭 `runId` 订阅进行中 run 回放完整响应，未知 runId 返回 `error(code:RESUME_NOT_FOUND)`。`config.json` 增 `enableResumableStream`（默认 `false`，`saveResumableStreamConfig` 支持 PUT 热切换，本次会话已置 `true` 验证）；`types.ts` 增字段、`index.ts` 接线。`frontend`：`stores/query.ts` 缓冲增 `currentManagerRunId`/`currentDidDone` 与 writer `setManagerRunId/managerRunId/threadId/didDone/resetForResume`（`resetForResume` 清空已收部分内容但保留 runId 供重连定位）；`utils/sse.ts` 增 `open` 事件处理 + 收敛自动 finalize（持有 managerRunId 时交回重连层）+ `consumeQuerySSEResumable(initialFetch,resumeFetch,writer,signal?,onActivity?,maxResume=1)` 包装（异常断开且持有 runId 时凭 `resumeFetch` 重连续接，任何失败降级兜底 finalize 部分答案，绝不卡死 `isLoading`）；`Query.vue`/`FloatingChat.vue`/`mobile/MobileQuery.vue` 三处发送流均改为 `initialFetch`+`resumeFetch`+`consumeQuerySSEResumable`。三端 tsc 全绿（`vue-tsc --noEmit` 0 错），`api/_smoke_resume.ts` 单元冒烟 `RESUME_OK`（断开→run 继续→重连回放完整答案），`api/_smoke_resume_http.mjs` 打真实后端 6/6 通过（含用 agnes 真实 LLM 首连拿到 `open{runId}`+产出 25 字后 abort，重连 `resume=runId` 收到 `done`+完整回放 97 字）。已构建部署 `public_live_1786817854967` 并重启后端。
  - 零破坏：`enableResumableStream` 默认 `false`；关闭时 `query.ts` 完全走原内联 SSE 路径（首连分支 `if (enableResumableStream)` 短路、resume 短路同条件），X-1 行为不受影响。
  - 参考：voltagent resumable streaming（本项目已用 SSE，增强移动端体验）。
- **X-3（可选未来）MCP 工具暴露**：将 harness 工具以 MCP 暴露，便于外部系统/智能体复用。
  - 参考：mastra MCP、voltagent MCP。

---

## 五、落地节奏与门禁（建议）

1. **P0 优先**：先落 SessionLog + 步骤追踪（同时修历史"无 stage 日志"痛点），门禁 `typecheck → 单测 → 全量 → build → 端到端冒烟`。
2. **P1 紧随**：HookManager 透传骨架 + 1~2 个内置钩子（audit-log、error-compactor 雏形），保持默认全关。
3. **P2 在 P0/P1 之上**：压缩依赖事件流与钩子，顺序开展。
4. **P3 / SA**：规划器与子智能体均为"显式开启"能力，复用 P0~P2 基建；子智能体开关已可用，下一步补 supervisor 路由与预算隔离。
5. **全程零破坏纪律**：任何新能力 `default-off`；上线前确认关闭态行为与基线一致（参照前序"开关改造"回归流程）。

---

## 六、参考链接
- mastra: https://github.com/mastra-ai/mastra
- langgraphjs: https://github.com/langchain-ai/langgraphjs
- voltagent: https://github.com/VoltAgent/voltagent
- 12-factor-agents: https://github.com/humanlayer/12-factor-agents
- LlamaIndexTS（已废弃，不采纳）: https://github.com/run-llama/LlamaIndexTS
