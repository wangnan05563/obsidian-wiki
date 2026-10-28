# 编译失败重试与幂等（T03591）

面向 `POST /api/compile`、`POST /api/compile/batch`、`POST /api/compile/retry` 三个端点的接口口径。
实现：`api/src/compile-idempotency.ts`（幂等表）、`api/src/routes/compile.ts`（路由）、
`api/src/utils/llm-error.ts`（可重试判定）、`frontend/src/stores/compile.ts`（前端状态流转）。

## 1. 为什么需要

生产批量编译 40 份文档时，LLM 侧 429/超时会让部分文件失败。旧链路的问题：

- 失败后没有任何「再来一次」的入口，用户只能回到投递页重新上传几十份文件；
- 同一份内容在网络慢时容易被重复提交，两个 SSE 流各自触发一轮 LLM 调用（token 双倍消耗），
  并在 `index.md` / `log.md` 追加时互相竞争（虽被 `withCompileLock` 串行化，但会排队很久）。

因此做了两件事：**幂等去重**（同一内容只允许一个执行者）与**免上传重试**（用 `raw/` 存档重编）。

## 2. 幂等语义

幂等表是进程内内存表（`CompileIdempotency`），按内容指纹记录三种状态：

| 状态 | 含义 | 新请求的处置 |
| --- | --- | --- |
| `running` | 同内容正在编译 | 不新建任务，SSE 回 `deduped`（单文件）或 `batch_deduped`（批量）事件，携带当前进度快照后收流 |
| `done` | 已成功 | 允许重新执行；`CompileCache` 会命中缓存直接短路，不重复消耗 token |
| `failed` | 已失败/中断 | 允许重新执行（这就是「重试」） |

- **TTL 30 分钟**：`running` 条目超过 30 分钟视为僵死（进程崩溃、请求悬挂），不再拦截新请求，
  避免「一次崩溃永久挡住同一份内容」。
- **收口条件**：只有本次占位 token 仍然有效时才写终态，过期重入的旧任务不会覆盖新任务状态。
- **中断**：客户端断开（`isAborted()`）按 `failed` 收口，用户可以直接再点重试。
- **为什么在内存**：幂等要挡的是并发/连续重复提交；成功结果由 `CompileCache` 持久化回放，
  失败本就该允许重跑。落盘反而要处理陈旧 `running` 记录，风险更高。

### 幂等 Key 生成规则

| 场景 | Key |
| --- | --- |
| 单文件（multipart） | `sha256(上传字节)` 取前 32 位十六进制 |
| 文本 / URL（JSON） | `sha256(type + '\0' + content)` 取前 32 位 |
| 批量 | 对每个文件的 Key 升序排序后 `sha256(join('\0'))` 取前 32 位（与选择顺序无关） |
| 免上传重试 | `sha256('retry' + '\0' + rawPath)` 取前 32 位 |

重试按 `rawPath` 而不是正文：路由层不读 vault，拿不到正文；而 `raw/<name>` 本身就是
「当前存档的那份内容」的唯一标识（同名会覆盖写）。改动 Key 规则必须同步本节。

## 3. 可重试语义（retryable）

失败事件带 `retryable: boolean`，判定见 `isRetryableLlmError`：

- **可重试**：`service_down`（5xx / 错误页）、`timeout`、`rate_limit`（429）；
  `unknown` 但错误文本显式命中 429 / ECONNRESET / fetch failed 等连接特征时也算。
- **不可重试**：`auth`（401/403）、`request_too_large`（413）——不换配置或不分批，重试多少次都一样。

失败事件同时回带 `data.rawPath`（存档路径）。前端只在「可重试 且 有 rawPath」时才显示重试按钮。

## 4. 接口

### 4.1 `POST /api/compile`

- 入参：`multipart/form-data`（`file` 字段）或 JSON `{ type: 'url'|'text', content, rawPath? }`
- 出参：SSE，事件 `progress` / `page` / `done` / `error`；幂等命中有额外事件 `deduped`
- `deduped` 载荷：`{ step: 'deduped', status: 'running', message, data: { state, startedAt, step?, message? } }`

### 4.2 `POST /api/compile/batch`

- 入参：`multipart/form-data`，`files` 多值
- 出参：SSE，事件 `batch_start` / `file_start` / `progress` / `page` / `file_done` /
  `file_error` / `file_complete` / `batch_done` / `error`；幂等命中有额外事件 `batch_deduped`
- `file_error` 载荷新增 `retryable` 与 `data.rawPath`（旧后端缺失时前端保持隐藏重试入口）

### 4.3 `POST /api/compile/retry`（T03591 新增）

- 入参 JSON：

  ```json
  { "rawPath": "raw/中国票据业务系统接口规范V1.4.md", "fileName": "中国票据业务系统接口规范V1.4.md", "fileIndex": 3, "fileCount": 40 }
  ```

  | 字段 | 必填 | 说明 |
  | --- | --- | --- |
  | `rawPath` | 是 | 必须是 `raw/<name>.md`（单级目录、正斜杠、`.md` 结尾），否则 400 |
  | `fileName` | 否 | 批量分组的展示名，仅回填事件 `data.fileName` |
  | `fileIndex` | 否 | 提供时按批量语义回推 `file_done` / `file_error`；否则回 `done` |
  | `fileCount` | 否 | 同上，仅回填事件 `data` |

- 出参：SSE。提供 `fileIndex` 时事件与批量模式一致（`progress`/`page`/`file_done`/`file_error`），
  否则与单文件一致（`progress`/`page`/`done`/`error`）；幂等命中回 `deduped`。
- 引擎未实现 `EngineAdapter.compileFromRaw` 时返回 501（前端据此不再展示重试入口）。
- 重试复用 `withCompileLock`，与普通编译串行；事件同样每 15s 一次心跳注释。

## 5. 前端行为

- **批量分组**：失败时记录 `rawPath` / `retryable`，卡片头出现「重试」；重试期间按钮 `loading` 且
  全部分组按钮禁用；每次重试在时间线追加「第 N 次重试」并累计 `attempts`，上一轮记录保留可追溯。
- **单文件**：失败且 `retryable` 时页头出现「重试」，复用 `pendingPayload` 重新提交，时间线保留。
- **幂等命中**：显示中性提示「已复用进行中的编译」，不进入失败态；分组重试命中幂等时提示
  「相同资料已有重试正在进行」，不误报连接断开。
- **重试结果**：全部分组落定后重算整体结果——全部成功才 `isDone`，否则提示剩余失败数。

## 6. 测试

- `api/test/compile-idempotency.test.ts`：状态流转、TTL、旧 token 不覆盖、并发占位、Key 规则。
- `api/test/compile-retry-route.test.ts`：重试入口校验/422 分支、事件形状、并发去重、批量重试上下文。
- `frontend/test/compile-retry-idempotency.test.ts`：重试预置、分组重试成败、幂等命中、源码守护。
