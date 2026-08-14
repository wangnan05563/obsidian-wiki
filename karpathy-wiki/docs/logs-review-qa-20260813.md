# Logs Review — 最近一次问答（/api/query）环节核查

- 日志源：`logs/api-dev.log`（pino 结构化 JSON，更新于 08-13 21:32）
- 范围：最近一次 `/api/query` 请求及其生命周期（按 `reqId` + 时间窗追踪）
- 方法论：从 `logs-review` 技能适配到本项目（技能自带 `config.yaml` 指向 xianyu_hunter，已按 karpathy-wiki 实际日志格式重做提取）

## 1. 结论速览

| 项 | 结果 |
|---|---|
| 最近一次问答 | `req-4i`，`POST /api/query`，**HTTP 200**，无 WARN/ERROR |
| 耗时 | **142,976 ms（≈143 s）** ⚠️ 偏长 |
| 各环节可观测性 | ❌ **无法核查**（pipeline 未输出任何 stage 日志） |
| 历史异常 | 3× 404（陈旧后端，已恢复）、6× 401（鉴权预期）、1× 400（BYOK 缺失预期） |

## 2. 最近一次问答环节追踪（req-4i）

后端访问日志仅记录请求生命周期，**无内部 stage 事件**：

```
[INFO] 1786627974563  incoming request        (POST /api/query)
[INFO] 1786628117539  request completed 200   elapsedMs=142976.51
```

- ✅ 请求被接受、鉴权/校验通过（BYOK 配置有效，否则会 400）、LLM 工作流跑完并返回 200。
- ⚠️ **143 秒**才完成。因 SSE 流式输出，用户应能看到逐字呈现，但整体等待仍过长。
- ❌ 无法确定 143s 花在哪一环（检索？思考？工具调用？答案生成？）—— 见 §4。

## 3. 全部 /api/query 完成情况（13 次）

| 时间(本地) | status | elapsed | reqId | 说明 |
|---|---|---|---|---|
| 08-12 16:23:25 | 404 | 16ms | req-1h | 陈旧后端 |
| 08-12 16:34:56 | 200 | **282309ms** | req-25 | ⚠️ 近 5 分钟，极长 |
| 08-13 21:06:59 | 404 | 4ms | req-m | **本次反馈的 404 事件** |
| 08-13 21:11:21 | 401 | 18ms | req-1 | 未带 token（鉴权预期） |
| 08-13 21:11~21:13 | 401 ×5 | <2ms | req-1a/1c/1e/1g/1l | 未带 token（含探针） |
| 08-13 21:35:17 | 200 | 142976ms | **req-4i** | **最近一次，成功但偏慢** |

关键判读：
- **404 全部为陈旧后端所致**（孤儿 :3000 进程返回 404），最近一次 404（21:06:59）在前、成功 200（21:35）在后 → 与上一轮诊断一致：**环境恢复后接口已正常**（实机探针 `/api/query` 现返回 401，非 404）。无需改代码。
- **401 / 400 是预期门禁**：未登录触发 `requireAuth`→401；未配 BYOK→400（后端返回明确引导文案）。非缺陷。

## 4. 核心问题：环节不可观测（P1）

用户诉求是「查看各环节是否存在问题」，但当前日志**无法支撑环节级核查**：

- `grep` 全量日志 `thinking|tool_call|retriev|websearch|followup|adapter|harness` → **0 命中**。
- `routes/query.ts` 无任何 `logger/console` 调用，仅依赖全局 `onRequest/onResponse` 钩子记录 incoming/completed。
- 工作流内部 stage（检索 → 思考 → 工具调用 → 答案流式）由 harness/`queryWorkflow` 产生，本应写入 `data/.harness/logs/<threadId>.log`，但**该目录最新文件停留在 07-29**，当前会话未落盘 → stage 细节完全缺失。

**影响**：143s / 282s 的耗时到底卡在哪一环、是否有思考死循环 / 工具重试 / 检索超时，均无从判断。这是本次 review 最大的盲区，也是后续定位性能问题的前提。

## 5. 优先级与修复建议（待确认后实施）

| 优先级 | 问题 | 建议修复 |
|---|---|---|
| **P1** | 环节不可观测，无法定位慢查询根因 | 在 `queryWorkflow` 中各 stage 出口打**结构化日志**：`event=retrieval/thinking/tool_call/answer`、`phase`、本阶段 `elapsedMs`；并补 **首 token 延迟**（首字节到达时间）。建议用 pino child logger 带 `reqId` + `threadId`，确保落主日志。 |
| **P1** | 最近两次成功问答耗时 143s / 282s | 先靠 P1 的 stage 计时定位瓶颈；常见根因：deep 思考模式、联网搜索工具慢、模型 provider 限速。定位后针对性优化（超时/并发/模型切换）。 |
| **P2** | 404 偶发（陈旧后端） | 沿用已记录的「杀孤儿 :3000 → tsx 重启」纪律；可考虑启动期对 `/api/query` 做自检断言，避免陈旧代码静默服务。 |
| **P3** | harness 线程日志不落盘 | 确认 `data/.harness/logs` 写入路径/开关是否在近期改动中被关闭，恢复当前会话的线程级 stage 日志。 |

## 6. 凭据安全

日志中未发现泄露的 token/密钥（仅 `reqId`/`statusCode`/`elapsedMs` 等元信息）。无需处置。

## 7. 基线状态

本次为全量模式（技能自带 baseline 指向其它项目，未用于本次）。建议后续为 karpathy-wiki 建立独立 `config.yaml`（`logs.current_log: logs/api-dev.log`，`log_format: structured`，`severity_field: level`，`rotate_patterns` 适配 pino 轮转），以便增量 review。
