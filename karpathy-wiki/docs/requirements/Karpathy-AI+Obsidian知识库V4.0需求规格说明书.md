# Karpathy-AI + Obsidian 知识库 V4.0 需求规格说明书（P0 精选）

| 字段 | 值 |
| --- | --- |
| 文档名称 | Karpathy-AI + Obsidian 知识库 V4.0 需求规格说明书 |
| 文档版本 | V4.0（P0 精选，仅含 FR-17 ~ FR-19，修订版） |
| 编制日期 | 2026-08-31（修订：2026-08-31，依据 V4.0 SRS 评审报告 §5 清单） |
| 文档状态 | 评审通过，可作实施基准 |
| 编制依据 | 《竞品对标优化建议-2026-08-31》P0 三项 / V3.1 核心约束 §6 / 未实现功能清单（V3.1 全量完成基线） / 《V4.0 SRS 评审报告》 |
| 需求基线 | V3.1（tsc + vue-tsc 0 报错，15 文件 / 294 测试 / 0 失败） |
| 范围 | V4.0 首波 P0 三项：知识缺口检测 / 知识时效标注 / 引用置信复核。P1/P2 项（合意闭环 UI 等 8 项）不在本 SRS 范围，待后续版本编制 |
| 修订说明 | 已修正 3 项 P0 事实性错误（stale 时间基准 / authority 类别映射 / 字段改名 knowledge_class）与 4 项 P1 设计缺陷，详见各节"修订"标注 |

---

## 1. 引言

### 1.1 背景

V3.1 路线图 16 项需求已全部交付。基于 GitHub MCP 竞品调研（llm-wiki / claude-obsidian / obsidian-second-brain），提炼出 11 项可借鉴优化项。本 SRS 仅细化其中 P0 三项——均为"高价值低成本"项，基于现有数据结构与工作流扩展，不引入新存储、不改变 vault 四类页面模板。

### 1.2 需求来源对照

| 优化项编号 | 竞品来源 | 本 SRS 需求编号 |
| --- | --- | --- |
| 优化项 #1 知识缺口 / 孤岛检测 | llm-wiki（graph insights: knowledge gaps） | FR-17 |
| 优化项 #2 声明时效标注 | obsidian-second-brain（OKM: timeless/dated/pointer） | FR-18 |
| 优化项 #3 引用置信与复核状态 | claude-obsidian（claim ledger: authority/confidence/review） | FR-19 |

### 1.3 术语

| 术语 | 定义 |
| --- | --- |
| 孤立节点 | 双链图中度为 0 的页面（无入链也无出链） |
| 低密度子图 | **大小 ≥ 3 且平均度数 < 2 的连通分量**（修订：排除二元互链对误报——任意两页互链即构成平均度数 1 的分量，不构成"社区"） |
| 知识时效分类 | 单篇页面的知识有效期分类（frontmatter 字段 `knowledge_class`）：`timeless`（长期有效）/ `dated`（有明确时效）/ `pointer`（指向外部源的中转页）。**命名修订**：原稿 `freshness` 已被 `PageQualityScore.category.freshness`（质量评分数值维度）占用，改名以消除同名异义 |
| 引用置信 | 问答引用某页面时的可信度信号：`authority`（来源类别权威度）/ `confidence`（内容完整度）/ `review`（是否已人工复核） |

### 1.4 与现有子系统的边界声明

| 现有子系统 | 边界 |
| --- | --- |
| data-clean quality-scanner 的 freshness 评分（数值，权重 10，基于 lastModified） | 与本 SRS `knowledge_status`（状态枚举）**并存、互不替代**：前者是数据清洗质量分，后者是知识有效期状态。health-check 的"过期复核"检查项仅消费 `knowledge_status` |
| FR-16-1 Discover Sources 推荐（单页面视角，节点右键） | FR-17 检测项 ③ **复用** discover-workflow 的标签匹配维度计算，仅消费其结果做全图聚合；UI 入口独立（Graph 侧边栏 vs 节点右键），实施时不得重复开发匹配逻辑 |

---

## 2. 约束（继承 V3.1 §6，8 项全部有效）

本 SRS 全部需求在以下约束内设计：

1. 不退化 compile 为查询时 RAG
2. 不放弃结构化页面输出（vault 四类页面模板）
3. 不放弃双向链接图谱（不用隐式图替代显式 `[[链接]]`）
4. 不放弃 Harness 抽象
5. 不放弃 health-check-fix workflow
6. 禁止引入独立 NER 模型或向量库
7. 禁止跨源 RAG
8. 禁止依赖 Obsidian 专属插件（核心功能须 Web 零安装可用）

---
## 3. 功能需求

### 3.1 FR-17 知识缺口检测（P0）

#### 3.1.1 用户价值

知识库规模增长后，用户无法感知"哪些页面成了孤岛""哪些主题群之间缺少连接"。LLM 分析双链拓扑结构，主动提示知识缺口与孤立页面，帮助用户补全知识网络，提升双链图谱的连通质量。

#### 3.1.2 实现路径

| 项 | 设计 |
| --- | --- |
| 数据源 | 复用 `VaultService.buildLinkGraph()` 已缓存的 `{nodes, edges}`，零额外扫描 |
| 检测算法（拓扑层，纯本地计算） | ① 度为 0 的孤立节点 ② **大小 ≥ 3 且平均度数 < 2** 的低密度连通分量 ③ 同标签但无双链的页面对（**复用 discover-workflow 匹配维度计算**，仅做全图聚合，边界见 §1.4） |
| 语义层（LLM，可选触发） | 将拓扑层检测结果（页面名 + 标签 + 邻居摘要）送入 LLM，生成"缺口主题建议"（如"这两个社区都在讨论 Docker，但缺少 [[容器]] 桥接页"） |
| 输出 | **建议列表，仅建议不覆盖**——不自动创建页面、不自动添加双链 |
| API 形态 | `GET /api/graph/gaps`（拓扑层，限流 300 req/min 档）；`POST /api/graph/gaps/analyze`（LLM 语义层，SSE 流式） |
| 前端 | Graph.vue 侧边栏新增"缺口洞察"面板：孤岛列表 + 低密度社区列表 + LLM 建议；点击条目定位到对应节点 |
| 落盘 | 不落盘。结果为运行时计算（与 discover 推荐一致的"建议态"定位） |

#### 3.1.3 禁止路径

- 禁止引入语义向量相似度做缺口判断（拓扑 + 标签 + LLM 离线分析即可）
- 禁止自动创建桥接页或自动写入 `related:` 字段（区别于 FR-16-1 的一键建立双链，缺口检测仅提示）

#### 3.1.4 验收标准

- AC-17-1：`GET /api/graph/gaps` 须返回孤立节点列表（度为 0）与低密度社区列表（**大小 ≥ 3 且平均度数 < 2**），计算基于 `buildLinkGraph()` 缓存数据，**不得引入向量相似度计算**。
- AC-17-2：页面总数低于配置阈值（config.json `graph.gapsMinPages`，**默认 20**）时，接口须返回空列表与 `reason: "insufficient-data"` 提示，而非报错。
- AC-17-3：`POST /api/graph/gaps/analyze` 须以 SSE 流式返回 LLM 缺口建议，每条建议须包含：涉及页面路径、建议主题、建议理由；建议**仅展示，不写入任何页面**。
- AC-17-4：Graph.vue "缺口洞察"面板须默认折叠，点击条目可在图上高亮定位对应节点（复用现有节点选中交互）。
- AC-17-5：LLM 分析失败（超时/接口错误）时，拓扑层结果须仍可独立展示，前端显示降级提示而非空白。
- AC-17-6：面板文案与状态色须使用 CSS 变量（适配 6 套主题），禁止硬编码颜色。

### 3.2 FR-18 知识时效标注（P0）

#### 3.2.1 用户价值

知识库会积累"曾经为真"的过期事实。借鉴竞品 OKM 机制，为每篇页面标注知识有效期分类，让用户在浏览和问答时能感知"这条知识是否新鲜"，过期页面由 health-check 引导复核，防止陈旧知识污染答案。

#### 3.2.2 实现路径

| 项 | 设计 |
| --- | --- |
| frontmatter 扩展 | 新增两个字段（向后兼容，缺省不显示）：`knowledge_class: timeless \| dated \| pointer` 与 `knowledge_status: ok \| stale \| unknown`（**修订**：原稿字段名 `freshness` 已被质量评分维度占用，改名消除同名异义） |
| 填写时机 | compile 阶段：LLM 在生成页面时顺带判定 `knowledge_class`（写入 prompt 输出结构，与 FR-15-4 type 推断同一扩展点）；`knowledge_status` 由规则判定（见下） |
| status 判定规则（**修订**：含复核保质期） | `stale` 判定优先级链：`knowledge_class == dated` 且（`updated` 距今 > staleDays）且（无 `reviewed_at` 或 `reviewed_at` 距今 > staleDays）→ `stale`；否则 `class == timeless/pointer` → `ok`；无 `knowledge_class` → `unknown`。时间基准为现有 frontmatter `updated` 字段（**修订**：原稿 `date` 字段不存在于现有 SCHEMA） |
| 复检时机 | health-check-fix workflow 扩展检查项：扫描 `knowledge_status: stale` 页面，输出复核建议清单（不自动修改正文，可一键在 frontmatter 追加 `reviewed_at`） |
| 问答消费 | query-workflow 检索页面时，若命中 `stale` 页面，refs 条目附时效标记（见 FR-19，两需求共用引用数据结构） |
| 前端 | Browse.vue 列表项时效角标（timeless 不显示 / ok 绿点 / stale 橙点 / unknown 灰点）；Health.vue 增"过期复核"检查项入口 |
| 配置 | `knowledge.freshnessStaleDays`（默认 365）/ `graph.gapsMinPages` / 检查开关全部走 config.json，禁止硬编码 |

#### 3.2.3 禁止路径

- 禁止自动删除或重写"过期"页面正文（仅标记与建议，删除权在用户）
- 禁止在查询时实时调用 LLM 判定时效（判定必须发生在 compile / health-check 离线阶段）
- 禁止复用 / 修改 `PageQualityScore.category.freshness` 数值字段承载本需求状态（与 data-clean 质量评分并存，见 §1.4）

#### 3.2.4 验收标准

- AC-18-1：compile 生成的页面 frontmatter 须含 `knowledge_class` 字段（三值枚举），由 LLM 在 compile 阶段判定写入，**不得在查询阶段实时判定**；LLM 输出非法枚举值时回退 `unknown`，不阻断 compile。
- AC-18-2：`knowledge_status` 须由确定性优先级链计算（§3.2.2），时间基准为 frontmatter `updated` 字段，阈值从 config.json `knowledge.freshnessStaleDays` 读取，**禁止硬编码**。
- AC-18-3：存量页面（无 `knowledge_class` 字段）须正常兼容：status 显示 `unknown`，不报错、不强制迁移。
- AC-18-4：health-check 须新增"过期复核"检查项：列出全部 `stale` 页面，支持批量在 frontmatter 追加 `reviewed_at: <ISO 日期>`；追加后若距今未超 staleDays，status 重算为 `ok`；**reviewed_at 本身超过 staleDays 后页面再次进入 `stale`**（复核保质期语义）。**不修改正文**。
- AC-18-5：Browse.vue 列表须显示时效角标，角标颜色使用 CSS 变量，hover 显示"距今时长 + 状态说明"。
- AC-18-6：问答引用 `stale` 页面时，RefsList 对应条目须显示过期标记，答案不受阻（正常引用，仅提示）。

---
### 3.3 FR-19 引用置信与复核状态（P0）

#### 3.3.1 用户价值

当前问答引用仅展示"引用了哪些页面"，用户无法判断引用质量。借鉴竞品 claim ledger，为每个引用补充来源权威度、内容完整度、复核状态三信号，让答案可信度可见。

#### 3.3.2 实现路径

| 项 | 设计 |
| --- | --- |
| 数据结构升级 | `query-workflow.ts` 现有 `refs: string[]` 升级为兼容双形态：`string \| { path, authority, confidence, review, knowledge_status }`（旧 string 形态继续接受，v1→v2 兼容映射，与对话流 ChatMessage 迁移同一模式） |
| 信号计算（纯规则，无 LLM 额外调用） | `authority`：基于 frontmatter `source` **类别值映射权威度**（**修订**：现有 `source` 取值为类别枚举 `web / manual / qq-chat` 等，非 URL，无域名可分类）——映射表（如 `web` → high / `manual` → medium / `qq-chat` → low）配置于 config.json；`confidence`：页面完整度信号（frontmatter 字段完整数 / 正文字数阈值）；`review`：是否存在 `reviewed_at` 字段 |
| 传输 | SSE chunk `refs` 字段升级为对象数组，前端 RefsList 渲染三信号图标 |
| 前端 | RefsList 每条引用追加三个小图标（权威度盾牌 / 完整度圆环 / 复核对勾），hover 显示说明文案；配合 FR-18 的 stale 标记 |
| 持久化 | 会话归档 `/api/conversations` 存储对象形态 refs，旧会话读取时做兼容映射 |

#### 3.3.3 禁止路径

- 禁止在查询时实时调用 LLM 评估置信度（三信号全部由 frontmatter 规则计算，查询路径零额外 LLM 开销）
- 禁止因引用置信低而过滤/隐藏引用（全部引用保持展示，信号仅提示）

#### 3.3.4 验收标准

- AC-19-1：refs 数据结构升级须**向后兼容**：后端与前端均接受旧 `string[]` 形态（映射为全 `unknown` 信号），旧会话加载不报错。
- AC-19-2：`authority` 映射规则（source 类别 → 权威度等级）须配置于 config.json，**禁止硬编码**；映射表未覆盖的类别显示 `unknown`（**修订**：无域名分类设计，因 source 字段无 URL 信息）。
- AC-19-3：三信号计算须为**纯内存规则实现**（代码评审确认无 IO / 无 LLM 调用），查询路径不引入额外网络开销。
- AC-19-4：RefsList 须展示三信号图标，图标使用开源图标库（与现有 MessageToolbar 同源），颜色使用 CSS 变量。
- AC-19-5：`/api/conversations` 写入与读取须支持对象形态 refs，并提供旧格式读取兼容（读取时 string → 对象映射）。
- AC-19-6：低置信引用不得被隐藏或过滤，全部引用条目保持可见。

---

## 4. 需求间依赖

```
FR-18 知识时效标注 ──┐
                       ├──→ FR-19 引用置信（共用 knowledge_status 信号与 refs 数据结构）
FR-19 自身规则信号 ──┘

FR-17 知识缺口检测（独立，无依赖，可并行开发）
```

建议开发顺序：FR-18 → FR-19（共享数据结构先行）→ FR-17（独立并行）。

---

## 5. 非功能需求

| 编号 | 需求 |
| --- | --- |
| NFR-17-1 | `GET /api/graph/gaps` 响应 ≤ 500ms（复用 buildLinkGraph 缓存，不含 LLM） |
| NFR-18-1 | compile 单页因 knowledge_class 判定新增的 LLM token 开销 ≤ 输出结构扩展的最小增量（与 type 推断合并判定，不单独发起请求） |
| NFR-19-1 | 三信号计算纯内存规则，查询路径不引入额外 IO / LLM 调用 |
| NFR-V4-1 | 全部新增配置项（authority 映射表 / staleDays / gapsMinPages / 开关）走 config.json，遵守"零硬编码"项目约束 |
| NFR-V4-2 | 全部新增 UI 元素使用 CSS 变量，适配 6 套主题 |
| NFR-V4-3 | 新增 API 遵守分级限流：GET 300 req/min、POST（LLM 触发类）60 req/min |
| NFR-V4-4 | 新增 .vue/.ts 文件 UTF-8（无 BOM）编码 |

---

## 6. 测试计划

| 需求 | 测试类型 | 覆盖点 |
| --- | --- | --- |
| FR-17 | 单元 + E2E | 孤立节点 / 低密度社区（≥3 且平均度 < 2）计算正确性；二元互链对不误报；小知识库空返回；SSE 降级路径；面板折叠交互 |
| FR-18 | 单元 + E2E | LLM 输出解析（knowledge_class 枚举校验 + 非法值回退）；stale 优先级链（含 reviewed_at 保质期）；staleDays 阈值规则；存量页面兼容；health-check 一键 reviewed_at；Browse 角标 |
| FR-19 | 单元 + E2E | refs 双形态兼容映射；source 类别 → authority 映射；conversations 读写兼容；RefsList 图标渲染 |
| prompt 回归 | 结构验证 | **compile.md prompt 修改后的输出结构回归验证**（frontmatter 新增 knowledge_class 后，既有字段 title/type/created/updated/source/tags 输出不回归） |
| 回归 | 全量 | tsc + vue-tsc 0 报错；现有 294 单测 0 失败；对话流 E2E（63 项）不回归 |

---

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| LLM 输出 knowledge_class 枚举不稳定 | 与 FR-15-4 同模式：输出结构 schema 校验 + 非法值回退 `unknown`，不阻断 compile |
| refs 数据结构升级引发旧会话解析错误 | 兼容双形态（AC-19-1/19-5），参照 ChatMessage v1→v2 迁移函数模式 |
| authority 类别映射粒度粗（3 档） | 单用户本地知识库场景下够用；未覆盖类别归 `unknown`，宁保守不误判；后续如需 URL 级分类，须先扩展 frontmatter `source_url` 字段（本版本不做） |
| 缺口检测在超大图（200+ 节点）性能 | 拓扑计算复用缓存图数据，O(V+E) 复杂度；LLM 分析仅对 top 孤岛/社区摘要截断送入 |
| SSE refs 对象形态对旧客户端无版本协商 | 单用户本地应用场景可接受；前端与后端同步发布，不做版本协商（已知取舍） |

---

## 8. 阶段交接声明

- 当前阶段：V4.0 SRS 评审与修订 ✅ 已完成（评审结论：3 项 P0 事实性错误 + 4 项 P1 设计缺陷全部修正）
- 下一阶段：V4.0 实施计划编制（里程碑拆分 / 测试用例细化）
- 下一阶段智能体：实施规划工程师
- 下一阶段技能：writing-plans / test-driven-development
- 交接上下文：
  1. 本 SRS 覆盖 P0 三项：FR-17 知识缺口检测 / FR-18 知识时效标注 / FR-19 引用置信复核
  2. 代码锚点：`vault.buildLinkGraph()` / `discover-workflow.ts`（FR-17，检测项③复用其匹配计算）；`compile-workflow.ts` frontmatter 扩展点 + `prompts/compile.md`（FR-18，新增 knowledge_class 字段）+ `health-check-fix-workflow.ts`（FR-18 复检）；`query-workflow.ts` refs 结构 + RefsList（FR-19）
  3. 关键数据契约：frontmatter 新增 `knowledge_class` / `knowledge_status` / `reviewed_at`；stale 判定基准 `updated` 字段；authority 基于 `source` 类别映射（config.json）
  4. 依赖关系：FR-18 → FR-19 共享数据结构，建议开发顺序 FR-18 → FR-19 → FR-17（并行）
  5. 全部需求已通过 V3.1 §6 八项核心约束校验
  6. P1/P2 共 8 项优化不在本 SRS 范围，待 V4.1+ 编制

---
**文档结束**