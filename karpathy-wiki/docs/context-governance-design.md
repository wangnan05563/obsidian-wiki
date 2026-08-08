# 知识库问答 · 上下文记忆治理模块 · 设计规格

> 对应需求：在上下文窗口长度受限场景下，对对话历史做**主动治理**——
> 语义压缩（提炼关键信息、缩减 token）、清理冗余/重复/低价值内容、
> 按主题/时间相关性重组排序、并设定容量阈值与淘汰策略，接近上限时自动触发，
> 确保关键信息不丢失且整体上下文连贯可用。
>
> 实现位置：`api/src/engine/context-governor.ts`（治理引擎）、
> `api/src/engine/thread-memory-store.ts`（存储层折叠 `compactMemory`）、
> `api/src/routes/threads.ts`（治理预览/显式折叠端点）、
> `api/src/routes/query.ts`（问答前注入治理后的 history）、
> `api/src/config.ts` / `api/src/types.ts`（配置项）、
> `api/src/index.ts`（装配 `governorConfig`）。

---

## 1. 目标与约束

| 目标 | 说明 |
| --- | --- |
| 语义压缩 | 对早期历史抽取关键信息折叠为「历史摘要」，缩减 token 占用 |
| 清理 | 去重（近似重复）+ 剔除低价值（空/纯符号/问候黑名单） |
| 重组 | 按主题相关性或时间序重排，优化模型注意力分配 |
| 容量阈值与淘汰 | 接近 token/消息上限自动触发治理；超阈值时从最旧非关键消息淘汰 |
| 关键信息保真 | 最近窗口原文永保；早期内容折叠为摘要而非丢弃；既有摘要合并防重复 |
| 连贯可用 | 治理前/后历史均以 `用户:/助手:` 行注入 LLM（见 query-workflow），合成摘要安全 |
| 纯函数/确定性 | 核心引擎不依赖 LLM，可离线、可单测、可复现 |
| 数据仅本地 | 治理全程在本地完成，无任何对外传输 |

**设计边界**
- 治理作用在「注入 LLM 的上下文视图」上；线程记忆原始落盘（`memory.json`）**不被改写**，除非显式调用存储层 `compactMemory` 做折叠。
- 默认启用（`DEFAULT_GOVERNOR_CONFIG.enabled = true`，可被 `config.json` 的 `contextGovernor` 覆盖或在 `config.contextGovernor.enabled=false` 时彻底关闭）。

---

## 2. 治理管线四阶段

```
原始历史 HistoryMessage[]
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│ 阶段一 cleanup：去重 + 剔除低价值（始终执行，安全、非破坏性）   │
│   - isDuplicate：Jaccard≥阈值 且 无"显著实体差异"(数字/[[引用]) │
│   - isLowValue：空 / 纯标点符号 / 命中问候黑名单（不按长度删）  │
└─────────────────────────────────────────────────────────────┘
      │  kept[]
      ▼
  判断是否触发（triggered）：
    投影 token > warnRatio × maxTokens  或  消息数 > maxMessages
      │
      ├─ 未触发 ──► 仅做相关性重组（若有 question + reorderMode=relevance）
      │             原文透传（可能因清理略缩短），不压缩不淘汰
      │
      └─ 触发 ──►
          ┌───────────────────────────────────────────────────┐
          │ 阶段二 compress：超出 recencyWindow 的最旧历史       │
          │   → extractiveCompress 折叠为「历史摘要」(合成助手)  │
          │   与既有持久化摘要(来自 compactMemory) 合并          │
          ├───────────────────────────────────────────────────┤
          │ 阶段三 reorder：摘要置顶 + 最近窗口置尾；             │
          │   其余按与 question 的主题重叠降序（relevance 模式）  │
          ├───────────────────────────────────────────────────┤
          │ 阶段四 evict：token/消息数超限时，从最旧非保护消息    │
          │   开始裁剪，直至预算内或仅剩保护集                    │
          └───────────────────────────────────────────────────┘
      │
      ▼
注入 LLM 的最终上下文 GovernedContext { messages, summary, stats }
```

---

## 3. 配置项（`ContextGovernorConfig`）

默认值见 `DEFAULT_GOVERNOR_CONFIG`，可被 `config.json` 的 `contextGovernor` 浅合并覆盖：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时 `govern()` 原样透传 |
| `maxTokens` | `5000` | token 硬上限；超此值强制淘汰（保护摘要+最近窗口除外） |
| `warnRatio` | `0.75` | 预警比例；投影 token > `warnRatio×maxTokens` 触发治理 |
| `recencyWindow` | `12` | 末尾 N 条消息始终保留原文（不参与压缩/淘汰，保证连贯） |
| `maxMessages` | `30` | 消息数硬上限（`0`=不限）；超出则按淘汰策略裁剪 |
| `compressionStrategy` | `'extractive'` | 抽取式（确定性，无需 LLM）；`'llm'` 调用注入的 `summarizer` |
| `summaryMaxChars` | `1200` | 压缩摘要最大字符数（防摘要自身膨胀） |
| `dedupThreshold` | `0.85` | 去重相似度阈值（归一化 token Jaccard） |
| `minContentChars` | `10` | **保留字段**（不再用于硬性删除；见 §4.1 说明） |
| `lowValuePatterns` | 见源码 | 低价值短语黑名单（好的/谢谢/收到/…），精确匹配即剔除 |
| `reorderMode` | `'chronological'` | `chronological` 保持时间序；`relevance` 按主题相关性降序 |

---

## 4. 关键算法

### 4.1 清理（cleanup）—— 安全、非破坏性
- **去重 `isDuplicate(a,b,threshold)`**：先计算归一化 token 集合（见 §5）的 Jaccard 相似度，≥阈值再判定；但若两条消息在「显著实体」（含数字或 `[[页面引用]]`）上存在差异，即便字面高度相似（如模板化内容「概念0」vs「概念1」），也视为**不同内容、不判重**——避免误删仅主题编号不同的真实问答。
- **低价值 `isLowValue`**：命中以下任一即视为低价值：
  1. 空内容或纯空白；
  2. 去除空白/标点/符号后无任何实质内容（字母数字或 CJK）——即「纯符号」噪声；
  3. 精确命中问候/确认黑名单（去空白后）。
  **不以「长度短」作为删除依据**：短消息（如「继续」「如何部署」）只要含实质语义即保留，以免在小上下文中误删用户真实提问、破坏连贯性。`minContentChars` 字段保留用于微调与向后兼容，但不再用于硬性截断。

### 4.2 语义压缩（compress）—— 净缩减 + 保真
- 按 `user/assistant` 配对为轮次；每轮保留问题（截断至 120 字）+ 回答**抽取关键句**。
- 抽取式压缩 `extractiveCompress`：对每轮回答，预算为其原始长度的 **30%（下限 40 字）** 抽取关键句（含数字/结论标记/代码/链接的句子加权）。
- **压缩率保证**：摘要整体恒小于被折叠内容的原文（调试实测：40 条≈1800 token 历史 → 摘要≈960 token），确保 token **净缩减**而非膨胀。
- 既有持久化摘要（来自存储层 `compactMemory`）通过 `mergeSummaries` 与新压缩内容合并，避免重复摘要、并受 `summaryMaxChars` 约束。

### 4.3 重组（reorder）
- `chronological`（默认）：保持时间序，最连贯。
- `relevance`：仅当提供 `question` 时生效；摘要消息恒置顶，最近 `recencyWindow` 条恒置尾（保证即时上下文连贯），其余按与问题的 token 重叠数降序排列。
- 重组不改变预算、不丢弃消息，代价极低，故未触发时也可安全执行。

### 4.4 淘汰（evict）—— 关键信息保护
- **连贯性底线 `coherenceFloor = min(recencyWindow, 4)`**：至少保留「摘要 + 最近 4 条」，其余较旧的非关键消息在预算受限时允许淘汰。
- 消息数超限：仅当消息总数 **超过** `maxMessages` 时才裁剪（而非一味裁到保护集）。
- token 超限：从最旧非保护位置（跳过摘要）开始裁剪，直至 ≤ `maxTokens` 或仅剩保护内容。

---

## 5. Token 估算与相似度
- `estimateTokens(text)`：CJK 表意文字（U+3400–U+9FFF）≈ 1 token/字；连续拉丁/数字串按 4 字符≈1 token。
  > 注意：`CJK_RE` **仅匹配表意文字**，刻意排除全角标点（U+3000/U+FF00 区段）与符号——否则「。`」「！」等会被当作语义 token，导致去重 Jaccard 因标点差异跌破阈值（实测 11/13≈0.846 < 0.85 漏判）。
- `tokenize(text)`：CJK 单字 + 拉丁词（`[a-z0-9]+`）构成归一化 token 集合，用于 Jaccard 相似度与相关性打分。

---

## 6. 与既有线程/记忆的集成

```
/api/query (携带 threadId)
   │
   ├─ store.getHistoryContext(threadId)  → 原始 HistoryMessage[]（优先后端记忆，否则回退前端透传）
   ├─ store.getMemorySummary(threadId)   → 既有持久化摘要（来自 compactMemory）
   ├─ govern(rawHistory, { question, config, existingSummary })
   │       └─ 返回 governed.messages（可能含置顶「历史摘要」合成消息）
   ├─ input.history = governed.messages   （注入 LLM）
   └─ done 事件回传 governorStats（压缩/清理/淘汰统计，便于前端/运维观测）
```

- `query.ts` 中 `govern()` 在记忆注入之后、送入 adapter 之前执行；`governorConfig` 由 `index.ts` 解析 `config.contextGovernor ?? DEFAULT_GOVERNOR_CONFIG` 后下发。
- 存储层 `compactMemory(threadId, { keepRecent?, summaryMaxChars? })`：把超出 `keepRecent` 的最旧记忆条目折叠进 `memory.json` 的 `summary` 字段（抽取式压缩），属**显式**主动治理；治理预览端点读取该摘要并与其余条目一起参与 `govern`。

### REST 端点（新增于 `threads.ts`）
| 方法 / 路径 | 作用 |
| --- | --- |
| `GET /api/threads/:id/context?question=` | **非破坏性**预览治理后的注入上下文：返回 `context`（治理消息）、`summary`、`stats` |
| `POST /api/threads/:id/compact` | **显式折叠**记忆：body `{ keepRecent?, summaryMaxChars? }`，调用 `store.compactMemory` |

---

## 7. 测试覆盖
- 单元测试 `api/test/context-governor.test.ts`（12 项）：token 估算、清理（去重/低价值）、`extractiveCompress` 净缩减+保真、相关性重组、容量淘汰主流程（触发/未触发/关闭/既有摘要合并/预算极紧淘汰）。
- 集成测试 `api/test/thread-query-integration.test.ts`（6 项）：已补充传入 `governorConfig`，验证问答历史经治理后仍连贯注入。
- 全量 `npm test`（api）372 项全部通过，无回归。

### 调试中修复的两个真实缺陷
1. **`CJK_RE` 误含全角标点** → 去重 Jaccard 因「。`/`！`」差异跌破阈值漏判。收紧为仅表意文字后修复。
2. **`isLowValue` 长度硬删** → 默认 `minContentChars:10` 在小上下文中误删短提问（如「甲」「旧历史」）。改为仅按空/纯符号/黑名单判定后修复。
