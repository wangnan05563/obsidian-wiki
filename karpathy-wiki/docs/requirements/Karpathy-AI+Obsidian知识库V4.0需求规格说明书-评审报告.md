# Karpathy-AI + Obsidian 知识库 V4.0 SRS 评审报告

| 字段 | 值 |
| --- | --- |
| 评审对象 | 《Karpathy-AI+Obsidian知识库V4.0需求规格说明书》V4.0 P0 精选（2026-08-31） |
| 评审依据 | V3.1 SRS 修订补丁 §6 核心约束 / 竞品对标优化建议-2026-08-31 / 现有源码（types.ts / compile.md prompt / quality-scanner.ts / search-util.ts / health-check-fix-workflow.ts） |
| 评审日期 | 2026-08-31 |
| 评审方法 | 文档内部自洽性 + **与现有代码逐项事实核查**（frontmatter 实际字段 / 现有命名占用 / 现有功能边界） |
| 评审结论 | **方向正确但存在 3 项 P0 事实性错误**：三项需求与 V3.1 约束对齐良好、优先级判断合理，但 FR-18/FR-19 的数据基础与现有 SCHEMA 不符，须修订后方可作为实施基准 |

---

## 1. 评审结论概览

| 维度 | 评分 | 说明 |
| --- | --- | --- |
| 文档结构完整性 | ✅ 优 | 需求来源对照 / 术语表 / 禁止路径 / 验收标准 / 测试计划 / 风险对策齐备 |
| 与 V3.1 §6 约束一致性 | ✅ 优 | 8 项约束逐条校验通过，禁止路径明确（离线判定 / 仅建议不落盘） |
| 与现有代码事实一致性 | ❌ 差 | **3 项 P0**：FR-18 依赖不存在的 `date` 字段；FR-19 域名分类无数据支撑；`freshness` 命名已被占用 |
| 需求间依赖与开发顺序 | ✅ 优 | FR-18→FR-19 共享数据结构的依赖分析正确，FR-17 独立可并行 |
| 验收标准可测性 | ⚠️ 良 | 大部分 AC 可测，但 AC-19-3 计时验收方式不可靠，AC-17-2 含硬编码魔法数字 |
| 与现有功能边界 | ⚠️ 良 | FR-17 "同标签无双链页面对"与 FR-16-1 discover 推荐重叠未声明边界 |
| 过度设计风险 | ✅ 优 | 无过度设计；建议态定位（不落盘 / 不自动修改）克制合理 |

**总体结论**：V4.0 SRS 作为"P0 精选需求清单"方向正确、克制合理，优于 V3.0 初稿的"30+ 功能大而全"模式。但因编写时未对 frontmatter 实际字段做源码核查，**FR-18 与 FR-19 的实现路径建立在与现有 SCHEMA 不符的假设之上**，须修订 3 项 P0 后方可作为实施基准。

---

## 2. P0 事实性错误（必须修正后才能实施）

### P0-1：FR-18 依赖不存在的 `date` 字段

**位置**：SRS §3.2.2 AC-18-2 vs 现有 SCHEMA

**问题描述**：

SRS 的 stale 判定规则为"`dated` 且 `date` 距今超过阈值 → `stale`"。但现有 compile prompt（`api/src/prompts/compile.md`）生成的 frontmatter 字段为：

```
title, type, created, updated, source, tags
```

**不存在 `date` 字段**。时间信息实际存储于 `created`（创建时间）与 `updated`（最后更新时间）。

**修复建议**：

stale 规则改基于 `updated` 字段：`freshness: dated` 且 `updated` 距今超过 `freshnessStaleDays` → `stale`。同时 AC-18-2 同步修订。语义也更合理——"过期"应以最后一次内容更新时间为基准，而非创建时间。

---

### P0-2：FR-19 authority 域名分类无数据支撑

**位置**：SRS §3.3.2 vs `search-util.ts` / `qq-preprocess.ts` / `compile.md`

**问题描述**：

SRS 设计 `authority` 信号为"源页面 frontmatter `source` 字段**域名分类**（官方域名高 / 个人博客中 / qq-chat 低，域名白名单走 config.json）"。

但现有 `frontmatter.source` 的实际值是**来源类别字符串**，不是 URL：

| 实际取值 | 出处 |
| --- | --- |
| `qq-chat` / `qq-chat-exporter` | qq-preprocess.ts |
| `web` | compile.md prompt 约定 |
| `manual` | search-util.ts 注释（"qq-chat", "web", "manual"） |

**没有域名信息可分类**。URL 原始信息仅存在于 `raw/` 源文件路径/内容中，未透传到页面 frontmatter。

**修复建议**（二选一）：

1. **方案 A（推荐，零结构变更）**：authority 直接基于 `source` 类别映射（`web` → high / `manual` → medium / `qq-chat` → low），config.json 维护类别→等级映射表。诚实反映现有数据粒度。
2. **方案 B（扩展字段）**：compile 时将原始 URL 写入 frontmatter 新增 `source_url` 字段，再按域名白名单分类。改动更大，收益有限——单用户本地知识库场景下，类别粒度已够用。

建议采用方案 A，并将 SRS 中"域名白名单"表述全部改为"来源类别→权威度映射表"。

---

### P0-3：`freshness` 命名冲突，且与现有质量扫描的 freshness 概念重叠未处理

**位置**：SRS §3.2.2 vs `types.ts` L546 / `quality-scanner.ts`

**问题描述**：

两个问题：

1. **命名占用**：`types.ts` 的 `PageQualityScore.category.freshness: number` 已使用 `freshness`（质量评分维度，权重 10）。FR-18 新增 frontmatter 字段 `freshness: timeless|dated|pointer` 与之同名异义，前端与文档语境下必然混淆。
2. **概念重叠未声明**：`quality-scanner.ts`（data-clean 子系统）已有 freshness 评分维度（基于 `lastModified` 计算新鲜度得分）。FR-18 引入的时效状态体系与该评分的边界、关系（替代？并存？互相参考？）SRS 未做任何说明。

**修复建议**：

1. frontmatter 新字段改名为 **`knowledge_class`**（timeless/dated/pointer）与 **`knowledge_status`**（ok/stale/unknown），或 `fact_type` / `fact_status`，与质量评分的 `freshness` 彻底区分。推荐 `knowledge_class`，语义贴近竞品 OKM 的"事实时效分类"本意。
2. SRS 新增一节"与 data-clean 质量扫描的关系"：明确 quality-scanner 的 freshness 评分（数值）与 knowledge_status（状态枚举）并存、互不替代；health-check 的"过期复核"检查项仅消费 `knowledge_status`。

---

## 3. P1 设计缺陷（建议修订）

### P1-1：低密度子图定义会产生大量误报

**位置**：SRS §1.3 术语 / §3.1.2 / AC-17-1

**问题描述**：

"平均度数 < 2 的连通分量"作为低密度社区判定：**任意两个互链页面构成大小为 2 的分量，平均度数恰为 1**——所有二元互链对都会被报告为"低密度社区"，误报率极高。

**修复建议**：定义收紧为"连通分量大小 ≥ 3 且平均度数 < 2"，或改用更合理的度量（如分量大小 ≥ 3 且无任何内部节点度 ≥ 3）。

---

### P1-2：AC-18-2 与 AC-18-4 规则矛盾

**位置**：SRS §3.2.4

**问题描述**：

- AC-18-2：`freshness_status` 须由**确定性规则**计算（dated + date 超阈值 → stale）
- AC-18-4：追加 `reviewed_at` 后 status **重算为 ok**

但 AC-18-2 的规则公式中没有 `reviewed_at` 的位置——"重算"后仍满足 dated + 超阈值条件，按 AC-18-2 应仍是 stale。两条 AC 对同一状态给出矛盾判定，规则优先级未定义。

**修复建议**：stale 规则显式定义优先级链：

```
stale = (knowledge_class == dated)
        && (updated 距今 > staleDays)
        && (无 reviewed_at || reviewed_at 距今 > staleDays)
```

即"人工复核本身也有保质期"——复核超过同样阈值后再次进入 stale，避免一次复核永久免检。此语义也更符合竞品 OKM 的设计初衷。

---

### P1-3：AC-17-2 魔法数字违反零硬编码约束

**位置**：SRS AC-17-2（"< 20 个页面"）

**问题描述**：阈值 20 硬编码在 AC 中，与 NFR-V4-1（全部配置走 config.json）自相矛盾。

**修复建议**：改为 `config.json` 配置项（如 `graph.gapsMinPages`，默认 20），AC 措辞改为"低于配置阈值时返回 insufficient-data"。

---

### P1-4：FR-17 与 FR-16-1 discover 功能边界未声明

**位置**：SRS §3.1.2 检测算法 ③

**问题描述**：FR-17 的拓扑层检测项 ③"同标签但无双链的页面对"与已交付的 FR-16-1 Discover Sources（右键推荐邻近未连接页面，一键建立双链）在算法维度上完全同源，功能上重叠。SRS 未声明两者边界（差异：discover 是单页面视角的右键推荐，gaps 是全图视角的缺口清单）。

**修复建议**：§3.1.2 明确"检测项 ③ 复用 discover-workflow 的匹配维度计算，仅消费其计算结果做全图聚合，UI 入口独立（Graph 侧边栏 vs 节点右键）"，避免实施时重复开发匹配逻辑。

---

## 4. P2 轻微问题（可选修订）

| # | 问题 | 建议 |
| --- | --- | --- |
| 1 | AC-19-3 "延迟增量 < 50ms 以单测计时验证"——单测计时受 CI 环境波动影响大，验收不可靠 | 改为"纯内存规则实现 + 代码评审确认无 IO/LLM 调用"，删除计时验收 |
| 2 | refs 对象内 `freshness_status` 字段与 frontmatter 字段同名，但一个是查询时信号、一个是存储字段，命名易混淆 | 若采纳 P0-3 改名，refs 对象内同步改为 `knowledge_status` |
| 3 | FR-18 涉及 `prompts/compile.md` 修改（freshness 判定并入输出结构），测试计划未覆盖 prompt 等价性验证 | 测试计划补充"compile prompt 修改后的结构回归验证" |
| 4 | SSE chunk refs 双形态升级后，`/api/query` 旧客户端（非本前端）无版本协商机制 | 单用户本地应用场景下可接受，不做处理，但建议 SRS 风险节注明 |

---

## 5. 修订清单汇总

| 编号 | 关联需求 | 动作 | 修订后状态 |
| --- | --- | --- | --- |
| P0-1 | FR-18 | stale 规则时间基准 `date` → `updated` | 须修订 |
| P0-2 | FR-19 | authority 改为"来源类别→权威度映射"（方案 A），删除域名白名单设计 | 须修订 |
| P0-3 | FR-18 / FR-19 | frontmatter 字段改名 `knowledge_class` / `knowledge_status`；新增与 quality-scanner 的边界声明 | 须修订 |
| P1-1 | FR-17 | 低密度社区定义收紧（分量 ≥ 3） | 建议修订 |
| P1-2 | FR-18 | stale 规则补充 reviewed_at 优先级链 | 建议修订 |
| P1-3 | FR-17 | 阈值 20 走 config.json | 建议修订 |
| P1-4 | FR-17 | 声明与 discover 的边界 | 建议修订 |
| P2-1~4 | FR-18 / FR-19 | 验收方式与命名同步微调 | 可选 |

---

## 6. 评审结论

**结论**：V4.0 SRS **方向正确、规模克制、约束对齐**，但 **3 项 P0 事实性错误**（数据字段假设与现有 SCHEMA 不符）使其当前不可直接作为实施基准。

**处置建议**：

1. 依据本报告 §5 修订清单更新 V4.0 SRS（预计涉及 §1.3 术语 / §3.1~3.3 实现路径与 AC / §5 NFR / §7 风险）
2. 修订后状态改为"评审通过，可作实施基准"
3. P1-2 的"复核保质期"语义变更建议在修订时向用户确认（涉及产品语义决策）

---

## 7. 阶段交接声明

- 当前阶段：V4.0 SRS 评审 ✅ 已完成（结论：修订后通过）
- 下一阶段：V4.0 SRS 修订（依据本报告 §5 清单）
- 下一阶段智能体：需求分析工程师
- 下一阶段技能：writing-plans
- 交接上下文：
  1. 评审发现 3 项 P0 事实性错误（date 字段不存在 / source 无域名 / freshness 命名冲突），均已有明确修复方案
  2. 事实核查依据：compile.md prompt（frontmatter 实际字段）、search-util.ts（source 取值枚举）、types.ts L546（freshness 命名占用）、quality-scanner.ts（现有 freshness 评分维度）
  3. P1-2"复核保质期"为产品语义决策点，修订前须用户确认
  4. 修订完成后进入 V4.0 实施计划编制

---
**文档结束**