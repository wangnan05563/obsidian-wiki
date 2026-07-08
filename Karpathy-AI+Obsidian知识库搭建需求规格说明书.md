# Karpathy-AI + Obsidian 知识库搭建需求规格说明书

| 项目 | 内容 |
| --- | --- |
| 文档名称 | Karpathy-AI + Obsidian 知识库搭建需求规格说明书 |
| 文档版本 | V2.2（工具链国产化 + Web 前端 + 低门槛 + 渐进自研 + Harness 独立组件化版） |
| 编制日期 | 2026-07-07 |
| 文档状态 | 草案 |
| 变更说明 | V1.0 基础版；V2.0 将 Claude Code/Claudian 替换为 TRAE 工具链 + 自研 Web 前端，强化"降低使用门槛"目标；V2.1 基于 AI 引擎自研评估，确立"TRAE CLI 验证 → 自研专用引擎"渐进路线；V2.2 采纳 Harness 架构，将运行时控制系统提取为独立可复用组件（`@wiki/harness`），可独立运行并复用到其他项目 |
| 参考来源 | 飞书 Wiki《Karpathy-AI+Obsidian 知识库教程-栗氪聊AI》+ 全网竞品调研 + TRAE 官方文档 |

---

## 1. 引言

### 1.1 编写目的

本规格说明书旨在明确"Karpathy-AI + Obsidian 知识库"（以下简称"本知识库"）的功能边界、架构规范、AI 工作流、Web 前端、非功能性要求，为后续设计、实施、验收提供唯一权威依据。

V2.1 相对 V1.0 的核心调整：
1. **工具链国产化**：移除 Claude Code、Claudian、cc switch，替换为 **TRAE CLI（阶段1 AI 引擎）+ 自研专用引擎（阶段2 目标）+ TRAE Work（可选可视化操作台）+ 自研 Web 前端**。
2. **完善 Web 前端**：新增独立的 Web 前端需求章节，用户无需安装 Obsidian、无需命令行操作即可使用。
3. **最低使用门槛**：将"降低门槛"从隐性目标提升为显性约束，贯穿全部需求。
4. **AI 引擎渐进自研**（V2.1 新增）：基于自研评估结论——本场景窄且固定（3 类任务 + 文件读写），通用 Agent 过重，自研专用引擎更简约、更自主。采用"TRAE CLI 验证 → 自研专用引擎"渐进路线，详见 5.5 节 FR-05。
5. **Harness 独立组件化**（V2.2 新增）：自研引擎采用 Harness 架构（裁剪版），并将运行时控制系统提取为独立可复用组件包 `@wiki/harness`，可独立运行、独立发布、复用到其他项目。本知识库项目是它的首个使用方，但非唯一使用方。详见 5.5 节 FR-05 与 5.8 节 FR-08。

读者对象：知识库搭建者、AI Agent 配置者、前端/后端开发、评审与验收人员。

### 1.2 项目背景

Andrej Karpathy 提出的 **LLM Wiki** 理念：让 LLM 充当"全职图书管理员"，将原始资料持续编译为结构化、可生长的 Markdown 知识库，日常交互只读取已编译页面，可节省约 90% Token。

飞书 Wiki《Karpathy-AI+Obsidian 知识库教程-栗氪聊AI》原方案采用 **Obsidian + Claude Code + Claudian** 工具链。鉴于以下原因，V2.0 进行国产化与前端化升级：

- Claude Code 存在合规与可用性风险（参见 2026 年 7 月阿里内部通知"植入后门安全风险"事件）。
- Claudian 为单点桥接插件，强耦合 Obsidian，无法满足"Web 端零安装使用"的门槛要求。
- cc switch 仅解决模型切换，TRAE 原生支持多模型后端，无需额外工具。

**TRAE 工具链适配性**（依据 TRAE 官方文档 docs.trae.cn）：
- **TRAE CLI**：命令行 AI Agent，独立于 IDE，支持 Skills 与 MCP，可承担 LLM Wiki 的"编译/查询/体检"三类任务，阶段1 用于快速验证。
- **TRAE Work**：AI 原生工作台，提供 Web/桌面/移动多端，支持 MCP 与 Skills，可作为可选的可视化操作台与多端入口。
- **TRAE IDE / Plugin**：开发者场景的辅助入口，非终端用户必备。

**AI 引擎自研评估结论**（V2.1）：经评估，本知识库场景窄且固定（仅 compile/query/health-check 三类任务，唯一工具为文件读写，无浏览器自动化、代码执行、多智能体协作），TRAE CLI 的通用能力（Skill 生态、MCP 协议、多 Agent 编排）对本场景过重。自研一个约 1500-2500 行的"LLM Wiki 专用执行器"难度中等偏低、无技术黑盒；编译质量取决于模型与 prompt（与引擎无关），自研不会降低质量，反而提升可维护性与扩展性。故确立"TRAE CLI 验证 → 自研专用引擎"渐进路线，详见 5.5 节 FR-05 与第 12 章阶段路线图。

**Harness 架构与独立组件化结论**（V2.2）：经评估，Harness 架构（`Agent = LLM + Harness`）与本项目高度适配——七大组件中六个强适配（工具循环/状态外置/错误重试/预算控制/记忆检索/确定性 Hook），且精准缓解 V2.1 三类自研风险（工期稳定性、死循环/Token 超限、prompt 等价性）。进一步决策：将 Harness 运行时控制系统提取为**独立可复用组件包 `@wiki/harness`**，与知识库业务逻辑解耦，可独立运行、独立发布、复用到其他 LLM 应用项目。本知识库项目是其首个使用方，但非唯一使用方。裁剪原则：保留 loop/state/retry/budget/hook 五项核心，去掉沙箱/长程调度/复杂记忆检索。详见 5.5 节 FR-05 与 5.8 节 FR-08。

### 1.3 术语与缩略语

| 术语 | 含义 |
| --- | --- |
| LLM Wiki | Karpathy 提出的"用 LLM 持续维护 Markdown 知识库"方法论 |
| Vault | 知识库根目录，本质是普通 Markdown 文件夹 |
| SCHEMA.md | 知识库规则与约定文件，约束 LLM 写入行为 |
| Entity / Concept / Comparison | 实体页 / 概念页 / 对比页 |
| TRAE CLI | TRAE 命令行 AI Agent，本方案的 AI 引擎 |
| TRAE Work | TRAE 独立 AI 工作台，多端可视化入口 |
| MCP | Model Context Protocol，Agent 调用外部工具的标准协议 |
| Skill | Agent 可复用能力包，封装提示词与工作流 |
| RAG | 检索增强生成 |
| Harness | 包裹 LLM 的运行时控制系统（loop/state/retry/budget/hook），本项目提取为独立可复用组件 `@wiki/harness` |
| `@wiki/harness` | 本项目自研的独立 Harness 组件包，可独立运行、独立发布、复用到其他 LLM 应用 |

### 1.4 参考资料与竞品来源

- 飞书 Wiki：`https://my.feishu.cn/wiki/LLtjwi38FiuWvKkgfPYcWiGFnab`
- TRAE 官方文档索引：`https://docs.trae.cn/llms.txt`
- TRAE CLI 文档：`https://docs.trae.cn/cli`
- TRAE Work 介绍：`https://www.trae.cn/work`
- Karpathy LLM Wiki Gist 与 `andrej-karpathy-skills` 开源项目
- Hermes + Obsidian + LLM Wiki 联动方案
- NotebookLM、Notion、AnythingLLM、Quartz、Obsidian-zola 等竞品公开资料

---

## 2. 项目概述

### 2.1 项目目标

构建一个**本地优先、Markdown 原生、AI 自动维护、Web 前端可视化、最低使用门槛**的个人/团队知识库。核心目标：

1. **自动生长**：原始资料投递后，AI 自动完成摘要、归档、关联链接、概念页生成。
2. **结构化**：遵循 Karpathy LLM Wiki 目录与 Schema 规范，避免"扁平化笔记堆"。
3. **Token 高效**：日常检索与问答基于已编译 Wiki 页面，而非原始全文，节省 ≥ 80% Token。
4. **Web 前端可视化**：提供完善 Web 页面，无需安装 Obsidian 即可浏览、检索、问答、投递。
5. **数据主权**：所有内容以 Markdown 本地存储，零锁定，可迁移。
6. **最低使用门槛**：一键安装、Web 化操作、向导式初始化，**新手 15 分钟内完成搭建并产出第一条知识**。
7. **工具链国产化与自主可控**：核心 AI 引擎由 TRAE CLI（阶段1）渐进过渡为自研专用引擎（阶段2），桥接层自研，无海外依赖，代码可审计。**运行时控制系统提取为独立可复用组件 `@wiki/harness`**，形成可沉淀的技术资产。

### 2.2 用户画像

| 角色 | 主要诉求 | 典型场景 | 门槛要求 |
| --- | --- | --- | --- |
| 终端用户（研究者/创作者） | 浏览、检索、问答、投递 | 阅读 paper 后一键入库 | 仅需浏览器，零命令行 |
| 知识库管理员 | 配置 Schema、体检、迁移 | 维护目录规范 | 一键脚本 + Web 配置页 |
| 开发者 | 扩展 Skill、二次开发 | 接入新模型/新数据源 | 标准接口 + 文档 |

### 2.3 范围边界

**包含：**
- 知识库目录结构与 Schema 规范
- AI 工作流（摄入、编译、查询、体检）
- **Web 前端**（浏览、检索、问答、投递、体检可视化、配置）
- 工具链选型与集成（TRAE CLI / TRAE Work / 自研桥接 API / Quartz 或自研前端）
- 一键安装与部署方案
- 非功能性需求与验收标准

**不包含（二期）：**
- 团队级权限管理、SSO
- 移动端原生 App（依赖 TRAE Work 移动端或 PWA）
- 自训模型与向量库建设（明确采用 LLM Wiki 路线而非 RAG）

---

## 3. 竞品深度对比分析

### 3.1 竞品选型矩阵（含工具链维度）

| 方案 | AI 引擎 | 桥接/前端 | 数据存储 | AI 自动化 | 可视化 | 数据主权 | 国产化 | 开源/付费 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **本方案 V2.0** | TRAE CLI | 自研 Web 前端 | 本地 Markdown | 高（四步法） | Web 图谱 + Obsidian 可选 | 完全本地 | 完全国产 | 自研 + 开源组件 |
| V1.0 原方案 | Claude Code | Claudian（Obsidian 插件） | 本地 Markdown | 高 | Obsidian | 完全本地 | 否（海外） | 部分开源 |
| Hermes + Obsidian | Hermes Agent | Obsidian | 本地 Markdown | 高（飞书网关） | Obsidian | 完全本地 | 否（海外依赖） | 开源 |
| Google NotebookLM | Google AI | Web | 云端 | 高 | Web | 云端托管 | 否 | 免费+Pro |
| Notion | Notion AI | Web | 云端 | 中 | 数据库/看板 | 云端托管 | 否 | 免费+付费 |
| AnythingLLM | 自选 LLM | Web | 本地+向量库 | 中（RAG） | Web | 可本地 | 部分 | 开源 |
| Codex + Obsidian + 飞书 | Codex | Obsidian+飞书 | 本地 Markdown | 中高 | Obsidian | 本地 | 否 | 部分开源 |

### 3.2 关键维度深度对比

#### 3.2.1 工具链国产化与合规

- **V1.0（Claude Code）**：2026 年 7 月阿里内部通知指出"存在植入后门的安全风险"，国产替代已无回头路。
- **本方案 V2.0（TRAE CLI）**：字节跳动出品，国内访问快、中文友好、免费、支持 Skills/MCP，原生多模型后端，合规可控。

#### 3.2.2 使用门槛

- **V1.0 / Hermes 方案**：用户须安装 Obsidian + Claude Code + Claudian + cc switch，命令行操作，新手搭建 30+ 分钟。
- **本方案 V2.0**：一键安装脚本启动后端 + Web 前端，用户仅需浏览器访问 `localhost:port`，新手 15 分钟内可用。

#### 3.2.3 数据主权与可迁移性

- **NotebookLM / Notion**：云端托管，供应商锁定。
- **本方案**：Vault 为普通 Markdown 文件夹，零锁定，跨平台无损迁移。

#### 3.2.4 AI 维护自动化程度

- **NotebookLM**：AI 围绕静态材料问答，不主动重构知识库。
- **本方案**：采用 Karpathy 四步法，TRAE CLI 主动编译原始资料为结构化页面，自动维护 index、log、概念页、对比页。

#### 3.2.5 Token 效率

- **传统 RAG（AnythingLLM 等）**：每次检索向量化召回，长文档 Token 消耗高。
- **本方案**：日常交互只读已编译 Wiki 页面，原始资料仅在"编译"阶段读取一次，节省约 90% Token。

#### 3.2.6 Web 前端可视化

- **V1.0 / Hermes**：依赖 Obsidian 客户端，无独立 Web 前端。
- **NotebookLM / Notion / AnythingLLM**：原生 Web，但数据云端托管。
- **本方案**：自研 Web 前端 + 本地数据主权，二者兼得。

### 3.3 竞品分析结论

综合国产化、使用门槛、数据主权、AI 自动化、Token 效率、Web 前端六项核心指标，**本方案 V2.0 选择"Karpathy LLM Wiki 理念 + Obsidian 容器（可选）+ TRAE CLI（AI 引擎）+ 自研 Web 前端（桥接与可视化）"**。差异化优势：**全国产工具链 + 本地数据主权 + 结构化自动生长 + Token 高效 + Web 零安装使用 + 全透明可校验**。

---

## 4. 总体架构需求

### 4.1 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     用户访问层（Web 前端）                    │
│   浏览 / 检索 / 问答 / 投递 / 体检可视化 / 配置               │
│   技术栈：Vue 3 + Vite + Pinia + 开源 UI 组件库               │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP API（REST + SSE 流式）
┌───────────────▼─────────────────────────────────────────────┐
│                  自研桥接 API 层（后端）                      │
│   路由分发 / 鉴权 / 文件读写 / TRAE CLI 调用封装              │
│   技术栈：Node.js (Fastify) 或 Python (FastAPI)              │
└───────┬───────────────────────────────┬─────────────────────┘
        │                               │
        │ 子进程调用                     │ MCP / Skill
┌───────▼───────────────┐   ┌──────────▼──────────────────────┐
│   TRAE CLI（AI 引擎）  │   │   TRAE Work（可选操作台）        │
│   编译 / 查询 / 体检   │   │   多端可视化 / Skill 管理        │
└───────┬───────────────┘   └───────────────────────────────────┘
        │ 读写
┌───────▼─────────────────────────────────────────────────────┐
│              知识库 Vault（本地 Markdown 文件）               │
│   SCHEMA.md / index.md / log.md / raw / entities /           │
│   concepts / comparisons / queries                           │
└─────────────────────────────────────────────────────────────┘
        │ 可选打开
┌───────▼─────────────────────────────────────────────────────┐
│   Obsidian（可选高级编辑器，非必需）                          │
└─────────────────────────────────────────────────────────────┘
```

**阶段2 目标架构（自研引擎落地后，五层简化为四层，Harness 独立组件化）**：

```
┌─────────────────────────────────────────────────────────────┐
│                     用户访问层（Web 前端）                    │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP API（REST + SSE 流式）
┌───────────────▼─────────────────────────────────────────────┐
│    知识库业务层（桥接 API + 工作流编排 + LLM Wiki 专用工具）  │
│    compile/query/health-check 工作流 / Markdown 解析 /        │
│    双向链接 / 路由分发 / 鉴权                                │
└───────┬───────────────────────────────────────┬─────────────┘
        │ 依赖（npm/pip 包引用）                 │
┌───────▼───────────────────┐   ┌────────────────▼──────────────┐
│  @wiki/harness（独立组件） │   │  TRAE Work（可选操作台）       │
│  loop / state / retry /    │   │  多端可视化 / Skill 管理       │
│  budget / hook / LLM 适配器│   └────────────────────────────────┘
└───────┬───────────────────┘
        │ 读写
┌───────▼─────────────────────────────────────────────────────┐
│              知识库 Vault（本地 Markdown 文件）               │
└─────────────────────────────────────────────────────────────┘
        │ 可选打开
┌───────▼─────────────────────────────────────────────────────┐
│   Obsidian（可选高级编辑器，非必需）                          │
└─────────────────────────────────────────────────────────────┘
```

注 1：阶段2 将 TRAE CLI 的子进程调用边界消除，业务层通过包引用方式调用 `@wiki/harness`，无进程间通信开销。
注 2：`@wiki/harness` 作为**独立组件包**，与知识库业务层解耦，可被其他 LLM 应用项目直接引用，详见 5.8 节 FR-08。

### 4.2 分层职责

| 层 | 职责 | 阶段1 | 阶段2 |
| --- | --- | --- | --- |
| Web 前端 | 用户唯一交互入口，所有操作按钮化 | 必备 | 必备 |
| 知识库业务层 | 工作流编排、Markdown 解析、双向链接、路由、鉴权 | 桥接 API 必备 | 必备（含原桥接 API） |
| `@wiki/harness` | 运行时控制（loop/state/retry/budget/hook）+ LLM 适配器 | TRAE CLI 承载 | **独立组件包** |
| TRAE Work | 多端可视化操作台、Skill 管理 | 可选 | 可选 |
| Vault | 本地 Markdown 知识库 | 必备 | 必备 |
| Obsidian | 高级本地编辑、复杂图谱 | 可选 | 可选 |

### 4.3 `@wiki/harness` 独立组件包定位

`@wiki/harness` 是本项目自研的独立可复用组件包，定位为**轻量级 LLM Agent 运行时**：

- **独立仓库**：单独的 Git 仓库与 npm/pip 包，独立版本号，独立 CHANGELOG。
- **独立运行**：可不依赖本知识库项目单独运行，提供 CLI 与编程 API 两种使用方式。
- **零业务耦合**：不包含任何 Markdown/知识库/Obsidian 专用逻辑，仅提供通用 Harness 能力。
- **可复用**：其他 LLM 应用项目（如代码生成、数据分析、文档处理）可直接引用。
- **本知识库项目是其首个使用方，但非唯一使用方**。

详细需求见 5.8 节 FR-08。

---

## 5. 功能需求

### 5.1 知识库结构需求（FR-01）

**需求编号**：FR-01
**需求名称**：知识库目录与 Schema 规范
**优先级**：高

**目录结构要求**：

```
my-wiki/
├── SCHEMA.md          # 知识库规则与约定（约束 AI 写入行为）
├── index.md           # 内容目录，每页一行摘要
├── log.md             # 操作日志
├── raw/               # 原始资料
│   ├── articles/      # 文章
│   ├── papers/        # 论文
│   └── assets/        # 图片等附件
├── entities/          # 实体页（人物、公司、产品、模型）
├── concepts/          # 概念/主题页
├── comparisons/       # 对比分析页
└── queries/           # 高价值查询结果归档
```

**验收标准**：
- AC-01-1：Vault 根目录必须存在上述全部一级目录与文件。
- AC-01-2：`SCHEMA.md` 须明确定义每类页面的 frontmatter 字段、命名规则、链接规范。
- AC-01-3：`index.md` 每新增一页须自动追加一行摘要，格式为 `- [[页面名]] — 一句话摘要`。
- AC-01-4：`log.md` 须记录每次 AI 操作的时间、类型、影响文件。
- AC-01-5：初始化命令须一键生成上述完整结构（无需手动 mkdir）。

### 5.2 AI 摄入与编译需求（FR-02）

**需求编号**：FR-02
**需求名称**：原始资料自动摄入与编译
**优先级**：高

**编译流程要求（Karpathy 四步法）**：
1. **编译原始资料**：读取 `raw/` 中的新材料，提取要点。
2. **构建结构化 Wiki**：在 `entities/`、`concepts/`、`comparisons/` 中创建或更新页面，建立双向链接。
3. **自然语言交互**：用户提问，AI 基于已编译页面回答。
4. **知识库体检**：扫描孤立页面、断链、过期信息，输出体检报告至 `log.md`。

**验收标准**：
- AC-02-1：投递一篇新文章后，AI 须在 `raw/articles/` 存档原文，并在 `concepts/` 或 `entities/` 生成至少一个摘要页。
- AC-02-2：生成的页面须包含 frontmatter（`title`、`type`、`created`、`updated`、`source`、`tags`）。
- AC-02-3：新页面须与已有页面建立至少 1 条双向链接（若主题相关）。
- AC-02-4：每次编译后须在 `index.md` 追加摘要行，在 `log.md` 追加操作记录。
- AC-02-5：体检命令须输出孤立页面、断链、30 天未更新页面三类报告。
- AC-02-6：**编译过程须支持 SSE 流式输出进度**，前端实时显示"读取中→提取要点→生成页面→更新索引"。

### 5.3 检索与问答需求（FR-03）

**需求编号**：FR-03
**需求名称**：基于 Wiki 的自然语言检索与问答
**优先级**：高

**验收标准**：
- AC-03-1：提问后 AI 须返回答案 + 至少 1 个 `[[页面名]]` 内部引用，前端可点击跳转。
- AC-03-2：当知识库无相关内容时，AI 须明确回复"知识库未覆盖"，不得编造。
- AC-03-3：单次问答的输入 Token 须以已编译页面为准，不得直接读取 `raw/` 全文（除非用户显式要求）。
- AC-03-4：高价值问答经用户确认后，可一键归档至 `queries/` 目录。
- AC-03-5：**问答须支持 SSE 流式输出**，答案逐字呈现。

### 5.4 Web 前端需求（FR-04）★ 新增

**需求编号**：FR-04
**需求名称**：Web 前端可视化与操作
**优先级**：高

**描述**：
提供完善 Web 前端，用户无需安装 Obsidian、无需命令行即可完成全部操作。

**页面模块要求**：

| 模块 | 核心功能 |
| --- | --- |
| 首页 / 仪表盘 | 知识库统计（页面数、最近编译、健康度）、快捷入口 |
| 知识浏览 | Markdown 渲染、目录树、双向链接面板、面包屑导航 |
| 全文检索 | 关键词搜索、按 tag/type 过滤、结果高亮 |
| 图谱视图 | 页面关联网络可视化（D3/vis.js），支持缩放/过滤/点击跳转 |
| AI 对话 | 聊天界面、流式回答、引用跳转、归档按钮 |
| 资料投递 | 文件上传 / URL 粘贴 / 文本粘贴，进度可视化 |
| 体检报告 | 孤立页/断链/过期页三类报告，可视化列表 + 一键修复建议 |
| 配置中心 | Schema 编辑、模型切换、路径配置、日志查看 |

**验收标准**：
- AC-04-1：浏览器访问 `http://localhost:port` 即可使用全部功能，无需安装任何客户端。
- AC-04-2：Markdown 渲染须支持标题、列表、表格、代码块、数学公式、双向链接 `[[页面名]]`、图片。
- AC-04-3：图谱视图须展示全部页面的双向链接网络，支持按目录/tag 过滤。
- AC-04-4：资料投递须支持拖拽上传、URL 粘贴、富文本粘贴三种方式。
- AC-04-5：AI 对话须支持流式输出、引用点击跳转、历史会话保存。
- AC-04-6：体检报告须以可视化列表呈现，提供"一键修复"按钮（自动调用 AI 修复断链等）。
- AC-04-7：配置中心须支持 Web 端修改 Schema，保存后立即生效。
- AC-04-8：**前端须符合用户偏好**：开源 UI 组件库、清新明亮扁平风、马卡龙配色（浅粉/浅青）、大圆角、磨砂玻璃质感、卡通机器人 IP。
- AC-04-9：**响应式设计**，桌面/平板/移动端均可正常使用。

### 5.5 AI 引擎集成需求（FR-05）★ 渐进自研 + Harness 独立组件化

**需求编号**：FR-05
**需求名称**：AI 引擎集成（TRAE CLI 验证 → 自研 `@wiki/harness` + 业务层）
**优先级**：高

**描述**：
AI 引擎采用渐进路线：**阶段1 用 TRAE CLI 快速验证 LLM Wiki 工作流与 prompt；阶段2 自研独立组件包 `@wiki/harness` 承载运行时控制，知识库业务层基于该组件实现 compile/query/health-check 工作流**。完全移除 Claude Code、Claudian、cc switch。

**架构分层原则（V2.2）**：
- `@wiki/harness`（独立组件）：通用运行时控制（loop/state/retry/budget/hook）+ LLM 适配器，零业务耦合，可独立运行、独立发布、复用到其他项目。详细需求见 5.8 节 FR-08。
- 知识库业务层：LLM Wiki 专用逻辑（Markdown 解析、双向链接、SCHEMA 注入、工作流编排、桥接 API），依赖 `@wiki/harness`。

**自研评估依据**（详见《AI 引擎自研评估报告》与《Harness 架构适用性评估》）：
- 本场景窄且固定（3 类任务 + 文件读写），TRAE CLI 通用能力过重。
- Harness 架构七大组件中六个强适配，精准缓解工期稳定性、死循环/Token 超限、prompt 等价性三类风险。
- 将 Harness 提取为独立组件，知识库业务层只关注场景逻辑，符合"简约至上"与"可复用"原则。

**阶段1 验收标准（TRAE CLI）**：
- AC-05-1：TRAE CLI 可在 Vault 根目录运行，读取 `SCHEMA.md` 作为行为约束。
- AC-05-2：桥接 API 层须封装 TRAE CLI 的"编译/查询/体检"三类命令为 REST 接口，支持 SSE 流式输出。
- AC-05-3：TRAE CLI 须通过 Skill 形式承载 LLM Wiki 工作流（一个 Skill = 一类任务）。
- AC-05-4：模型后端切换通过 TRAE 原生配置完成，无需 cc switch 等第三方工具。
- AC-05-5：须支持至少 2 个国产模型后端（GLM、Qwen、DeepSeek），切换后行为一致。
- AC-05-6：TRAE Work（如启用）须可通过 MCP 接入本知识库，作为多端可视化操作入口。
- AC-05-7：**桥接 API 层须预留 AI 引擎可替换接口**（适配器模式），未来可平滑切换至自研 `@wiki/harness` 或其他 Agent。

**阶段2 验收标准（自研 `@wiki/harness` + 业务层）**：

*A. `@wiki/harness` 独立组件验收（详见 FR-08）*：
- AC-05-8：`@wiki/harness` 须作为独立包发布（npm/pip），可被本项目与其他项目独立引用。
- AC-05-9：`@wiki/harness` 须实现五项核心机制：tool loop、state、retry、budget（max_steps + token_budget 双上限）、deterministic hook。
- AC-05-10：`@wiki/harness` 须提供 LLM 适配器（OpenAI 兼容 API + SSE 流式），支持 GLM/Qwen/DeepSeek 切换。
- AC-05-11：`@wiki/harness` 须提供 CLI 与编程 API 两种使用方式，可脱离知识库项目独立运行。
- AC-05-12：`@wiki/harness` 不得包含任何 Markdown/知识库/Obsidian 专用逻辑（零业务耦合）。

*B. 知识库业务层验收*：
- AC-05-13：业务层须基于 `@wiki/harness` 实现 compile/query/health-check 三类工作流，通过 deterministic hook 串联固定步骤（读 SCHEMA → 读 raw → 提取 → 生成页面 → 更新 index/log）。
- AC-05-14：业务层须实现 Markdown frontmatter 解析与 `[[wikilink]]` 双向链接提取/反向索引，作为 `@wiki/harness` 的工具注册。
- AC-05-15：业务层须与桥接 API 同语言合并为一层，消除子进程调用边界。
- AC-05-16：业务层的 prompt 与工作流须与阶段1 TRAE CLI Skill 等价，编译质量持平。
- AC-05-17：业务层须支持阶段1 已验证的全部国产模型后端，切换后行为一致。
- AC-05-18：切换自研组件后，FR-02/FR-03/FR-04 全部验收项须重新通过，无功能回归。

**回退保障**：若阶段2 未达 AC-05-8 ~ AC-05-18，可继续使用阶段1 TRAE CLI，需规不强制切换时间点。

### 5.6 一键安装与部署需求（FR-06）★ 新增

**需求编号**：FR-06
**需求名称**：一键安装与部署
**优先级**：高

**描述**：
提供一键安装与部署方案，最大化降低使用门槛。

**验收标准**：
- AC-06-1：提供 Windows 一键安装脚本（`.bat` / `.ps1`），双击即可完成环境检查、依赖安装、服务启动。
- AC-06-2：提供 macOS/Linux 一键安装脚本（`.sh`）。
- AC-06-3：提供 Docker Compose 部署方案，`docker compose up` 一键启动全部服务。
- AC-06-4：提供桌面端打包（Tauri/Electron），双击图标启动。
- AC-06-5：首次启动须进入**向导式初始化**：选择 Vault 路径 → 选择模型 → 生成 Schema → 完成。
- AC-06-6：安装过程须可视化显示进度，失败时给出明确错误信息与修复建议。
- AC-06-7：默认配置开箱即用，零配置即可使用全部核心功能。

### 5.7 飞书网关增强需求（FR-07，可选/二期）

**需求编号**：FR-07
**需求名称**：飞书转发自动入库
**优先级**：低（二期）

**验收标准**：
- AC-07-1：飞书转发文章后，AI 须自动抓取内容并按 FR-02 流程入库。
- AC-07-2：低价值内容须被识别并跳过，不污染知识库。
- AC-07-3：入库结果须通过飞书回执通知用户。

### 5.8 `@wiki/harness` 独立可复用组件需求（FR-08）★ V2.2 新增

**需求编号**：FR-08
**需求名称**：`@wiki/harness` 独立可复用组件
**优先级**：高

**描述**：
将 LLM Agent 运行时控制系统提取为独立可复用组件包 `@wiki/harness`，与知识库业务逻辑解耦，可独立运行、独立发布、复用到其他 LLM 应用项目。本知识库项目是其首个使用方，但非唯一使用方。

**设计原则**：
1. **零业务耦合**：不包含任何 Markdown/知识库/Obsidian/SCHEMA 专用逻辑，仅提供通用 Harness 能力。
2. **独立仓库**：单独 Git 仓库、独立版本号、独立 CHANGELOG、独立测试套件。
3. **独立运行**：提供 CLI 与编程 API 两种使用方式，可脱离任何业务项目单独运行。
4. **可复用**：其他 LLM 应用项目（代码生成、数据分析、文档处理等）可直接引用。
5. **裁剪版 Harness**：保留 loop/state/retry/budget/hook 五项核心，去掉沙箱/长程调度/复杂记忆检索。

**核心模块要求**：

| 模块 | 能力 | 说明 |
| --- | --- | --- |
| tool loop | 工具调用循环 | LLM 决定调用哪个工具 → 执行 → 结果回填 → 下一轮，支持 Function Calling |
| state | 状态管理 | 运行状态持久化与外置（文件/内存均可），支持中断恢复 |
| retry | 错误处理与重试 | 工具失败/模型超时/格式错误自动重试，可配置重试次数与退避策略 |
| budget | 预算控制 | max_steps（循环步数上限）+ token_budget（Token 上限）双上限，超限自动终止 |
| deterministic hook | 确定性 Hook | 在工作流特定阶段注入固定逻辑（不交 LLM 自由决策），如前置/后置处理 |
| LLM 适配器 | 模型抽象层 | OpenAI 兼容 API + SSE 流式，支持 GLM/Qwen/DeepSeek 等切换 |

**使用方式要求**：

```typescript
// 编程 API 示例（其他项目复用 @wiki/harness）
import { Harness } from '@wiki/harness';

const harness = new Harness({
  llm: { provider: 'glm', model: 'glm-4-plus', apiKey: process.env.GLM_KEY },
  tools: [myTool1, myTool2],
  budget: { maxSteps: 20, tokenBudget: 50000 },
  hooks: { beforeLoop: loadContext, afterStep: persistState }
});

const result = await harness.run({ task: '用户任务描述' });
```

```bash
# CLI 示例（独立运行）
@wiki/harness run --task "完成任务X" --tools ./tools.toml --budget.maxSteps 20
```

**验收标准**：
- AC-08-1：`@wiki/harness` 须有独立 Git 仓库，独立版本号（遵循 SemVer），独立 CHANGELOG。
- AC-08-2：`@wiki/harness` 须发布为 npm 包（或 pip 包），其他项目可通过 `npm install @wiki/harness` 安装使用。
- AC-08-3：`@wiki/harness` 须提供 CLI 入口，可脱离任何业务项目独立运行，完成一次完整的 LLM + 工具调用循环。
- AC-08-4：`@wiki/harness` 须提供编程 API，其他项目可通过 `new Harness(config)` 方式引用。
- AC-08-5：`@wiki/harness` 须实现 tool loop（Function Calling 协议、工具注册、结果回填、循环终止条件）。
- AC-08-6：`@wiki/harness` 须实现 state（运行状态持久化，支持中断后恢复）。
- AC-08-7：`@wiki/harness` 须实现 retry（工具失败/模型超时自动重试，可配置次数与退避）。
- AC-08-8：`@wiki/harness` 须实现 budget（max_steps + token_budget 双上限，超限自动终止并返回部分结果）。
- AC-08-9：`@wiki/harness` 须实现 deterministic hook（支持 beforeLoop/beforeStep/afterStep/afterLoop 四类 Hook）。
- AC-08-10：`@wiki/harness` 须提供 LLM 适配器，支持至少 2 个国产模型后端（GLM/Qwen/DeepSeek），切换仅需改 config。
- AC-08-11：`@wiki/harness` 不得依赖任何 Markdown/知识库/Obsidian/SCHEMA 专用库（零业务耦合，可由静态分析工具校验）。
- AC-08-12：`@wiki/harness` 须有独立测试套件，核心机制覆盖率 ≥ 80%。
- AC-08-13：`@wiki/harness` 须有独立 README 与 API 文档，含至少 1 个非知识库场景的使用示例（如代码生成、文档摘要）。
- AC-08-14：本知识库项目的阶段2 业务层须通过 `npm install @wiki/harness` 引用，不得内联复制 Harness 代码。

**复用场景示例**（非本项目，用于验证通用性）：
- 代码生成 Agent：用 `@wiki/harness` + 代码读写工具，实现"需求 → 生成代码 → 测试 → 提交"循环。
- 文档摘要 Agent：用 `@wiki/harness` + 文档解析工具，实现批量文档摘要与归档。
- 数据分析 Agent：用 `@wiki/harness` + SQL/Python 执行工具，实现自然语言数据分析。

---

## 6. 非功能需求

### 6.1 性能需求（NFR-01）

| 指标 | 要求 |
| --- | --- |
| 单篇资料编译耗时 | ≤ 60 秒（3000 字文章基准） |
| 单次问答响应首字 | ≤ 3 秒（流式） |
| 体检命令（1000 页规模） | ≤ 120 秒 |
| 单次问答输入 Token | 较原始全文节省 ≥ 80% |
| Web 首屏加载 | ≤ 2 秒（本地） |
| 图谱渲染（1000 节点） | ≤ 3 秒 |

### 6.2 数据安全与主权（NFR-02）

- NFR-02-1：所有知识库内容须以 Markdown 文件本地存储，不依赖任何云端服务。
- NFR-02-2：AI 调用外部 API 时须明确告知数据上传范围；敏感资料支持"仅本地处理"开关。
- NFR-02-3：Vault 须支持 Git 版本管理，可回溯任意时间点状态。
- NFR-02-4：Web 前端默认仅监听 `localhost`，对外暴露须显式开启并要求鉴权。

### 6.3 可维护性（NFR-03）

- NFR-03-1：`SCHEMA.md` 须作为单一事实来源，AI 行为变更只需修改此文件。
- NFR-03-2：所有 AI 操作须记录至 `log.md`，可审计。
- NFR-03-3：知识库结构变更须提供迁移脚本或迁移指引。
- NFR-03-4：桥接 API 层须预留 AI 引擎可替换接口。

### 6.4 可移植性（NFR-04）

- NFR-04-1：Vault 须可在 Windows / macOS / Linux 间无损迁移。
- NFR-04-2：不使用 Obsidian 专属语法（如 `![[embed]]`）作为知识库核心结构，保证纯 Markdown 兼容性。
- NFR-04-3：AI 引擎可替换（TRAE CLI → 其他 Agent），只需遵循 `SCHEMA.md` 约定。
- NFR-04-4：Web 前端与桥接 API 须跨平台运行（Node/Python 跨平台）。

### 6.5 可用性与低门槛（NFR-05）★ 强化

- NFR-05-1：**新手搭建耗时（含工具安装）≤ 15 分钟**（V1.0 为 30 分钟）。
- NFR-05-2：日常使用仅需"投递资料"与"提问"两类操作，全部 Web 化，零命令行。
- NFR-05-3：须提供《快速上手指南》覆盖安装、初始化、首次编译全流程，含截图。
- NFR-05-4：Web 前端须提供引导式空状态（首次进入无数据时，指引投递第一篇资料）。
- NFR-05-5：所有错误提示须给出可操作的修复建议，禁止显示纯技术栈报错。
- NFR-05-6：提供"演示模式"，内置示例知识库，用户可立即体验全部功能而无需自备资料。
- NFR-05-7：配置项提供合理默认值，关键配置（Vault 路径、模型）才需用户填写。

### 6.6 国产化合规（NFR-06）★ 新增

- NFR-06-1：核心 AI 引擎须为国产工具（TRAE CLI，阶段1）或自研专用引擎（阶段2），不依赖海外 AI 编程工具。
- NFR-06-2：模型后端须支持国产模型（GLM/Qwen/DeepSeek 等）。
- NFR-06-3：不依赖任何被列入合规风险清单的海外工具（Claude Code、Claudian 等）。
- NFR-06-4：自研组件源代码须自主可控，关键模块开源或可审计。

---

## 7. 工具链与依赖需求

### 7.1 工具清单（V2.1 国产化 + 渐进自研版）

| 工具 | 用途 | 来源 | 必备/可选 |
| --- | --- | --- | --- |
| TRAE CLI | AI 引擎，执行编译/查询/体检 | https://docs.trae.cn/cli | 必备 |
| TRAE Work | 多端可视化操作台、Skill 管理 | https://www.trae.cn/work | 可选 |
| 自研桥接 API 层 | 封装 TRAE CLI，提供 REST/SSE | 自研 | 必备 |
| 自研 Web 前端 | 用户唯一交互入口 | 自研 | 必备 |
| `@wiki/harness` | 独立可复用 LLM Agent 运行时组件包（loop/state/retry/budget/hook） | 自研（独立仓库） | 阶段2 必备，可独立复用 |
| 知识库业务层 | 基于 `@wiki/harness` 实现 compile/query/health-check 工作流 | 自研 | 阶段2 必备 |
| Node.js / Python | 桥接 API 层运行时 | 官网 | 必备 |
| Quartz 或自研静态生成 | 知识库公开站点发布（可选） | 开源 | 可选 |
| Obsidian | 高级本地编辑、复杂图谱 | https://obsidian.md/zh/ | 可选 |
| Dataview（Obsidian 插件） | 结构化查询 | Obsidian 社区市场 | 可选 |
| Git | 版本管理 | 系统自带 | 可选（推荐） |
| Docker | 容器化部署 | https://docker.com | 可选 |
| Tauri / Electron | 桌面端打包 | 开源 | 可选 |

### 7.2 已移除工具（相对 V1.0）

| 移除工具 | 移除原因 | 替代方案 |
| --- | --- | --- |
| Claude Code | 合规风险、海外依赖 | TRAE CLI |
| Claudian | 强耦合 Obsidian、无 Web 入口 | 自研桥接 API + Web 前端 |
| cc switch | 第三方切换工具、多余 | TRAE 原生多模型配置 |

### 7.3 模型后端要求

- 须支持 TRAE 原生接入的国产模型：GLM、Qwen、DeepSeek 等。
- 编译任务对长上下文能力要求较高，建议选用 ≥ 128K 上下文模型。
- 模型切换通过 TRAE 配置完成，无需额外工具。

### 7.4 技术栈建议

| 层 | 推荐技术栈 | 备选 |
| --- | --- | --- |
| Web 前端 | Vue 3 + Vite + Pinia + 开源 UI 组件库 | React + Next.js |
| Markdown 渲染 | markdown-it + KaTeX（公式）+ 双向链接解析 | |
| 图谱可视化 | vis.js / D3.js | cytoscape.js |
| 桥接 API | Node.js (Fastify) | Python (FastAPI) |
| TRAE CLI 调用 | 子进程 + SSE 流式 | MCP Server |
| 桌面打包 | Tauri（轻量） | Electron |
| 部署 | Docker Compose | 裸机脚本 |

---

## 8. 知识库 Schema 规范要求

### 8.1 SCHEMA.md 须包含的内容

1. **页面类型定义**：明确 `entity` / `concept` / `comparison` / `query` 四类页面字段。
2. **命名规则**：文件名采用 `kebab-case`，中文标题写入 frontmatter `title` 字段。
3. **frontmatter 模板**：每页须包含 `title`、`type`、`created`、`updated`、`source`、`tags`。
4. **链接规范**：内部引用统一使用 `[[页面名]]`，外部引用使用标准 Markdown 链接。
5. **写入约束**：AI 仅可在 `raw/`、`entities/`、`concepts/`、`comparisons/`、`queries/`、`index.md`、`log.md` 内写入；不得修改 `SCHEMA.md` 自身。
6. **可视化编辑**：`SCHEMA.md` 须支持 Web 端可视化编辑与版本对比。

### 8.2 index.md 格式要求

```markdown
# 知识库目录

- [[页面名]] — 一句话摘要
- [[页面名]] — 一句话摘要
```

### 8.3 log.md 格式要求

```markdown
# 操作日志

## YYYY-MM-DD HH:MM
- 操作类型：compile / query / health-check
- 影响文件：path/to/file.md
- 备注：简短说明
```

---

## 9. AI 工作流需求

### 9.1 编译工作流（WF-01）

```
用户在 Web 前端投递资料（文件/URL/文本）
   ↓
桥接 API 层接收，存入 raw/
   ↓
桥接 API 层调用 TRAE CLI（Skill: compile）
   ↓
TRAE CLI 读取 SCHEMA.md（获取写入约束）
   ↓
TRAE CLI 读取原始资料（raw/）
   ↓
TRAE CLI 提取要点，判定页面类型（entity/concept/comparison）
   ↓
TRAE CLI 创建/更新对应页面，建立双向链接
   ↓
TRAE CLI 更新 index.md（追加摘要行）
   ↓
TRAE CLI 更新 log.md（追加操作记录）
   ↓
桥接 API 层 SSE 流式回传进度与结果
   ↓
Web 前端实时显示 + 完成后刷新知识列表
```

### 9.2 问答工作流（WF-02）

```
用户在 Web 前端提问
   ↓
桥接 API 层调用 TRAE CLI（Skill: query）
   ↓
TRAE CLI 读取 index.md（获取知识库全貌）
   ↓
TRAE CLI 按关键词匹配相关页面（仅读已编译页面）
   ↓
TRAE CLI 流式生成答案 + [[页面名]] 引用
   ↓
桥接 API 层 SSE 流式回传
   ↓
Web 前端逐字呈现 + 引用可点击跳转
   ↓
若用户确认高价值 → 一键归档至 queries/
```

### 9.3 体检工作流（WF-03）

```
用户在 Web 前端点击"体检"
   ↓
桥接 API 层调用 TRAE CLI（Skill: health-check）
   ↓
TRAE CLI 扫描全库
   ↓
输出三类报告：
  - 孤立页面（无入链）
  - 断链（指向不存在的页面）
  - 过期页面（30 天未更新）
   ↓
桥接 API 层回传结构化报告
   ↓
Web 前端可视化呈现 + 提供"一键修复"按钮
   ↓
记录至 log.md
```

---

## 10. 验收标准汇总

| 需求 | 验收项 | 优先级 |
| --- | --- | --- |
| FR-01 | 目录结构与 Schema 完整，一键初始化 | 高 |
| FR-02 | 单篇资料自动编译入库，SSE 流式进度 | 高 |
| FR-03 | 基于 Wiki 的问答 + 引用 + 流式输出 | 高 |
| FR-04 | Web 前端 8 大模块全部可用，响应式 | 高 |
| FR-05 | TRAE CLI + 桥接 API 集成，引擎可替换 | 高 |
| FR-06 | 一键安装（Win/Mac/Linux/Docker/桌面） | 高 |
| FR-07 | 飞书网关自动入库 | 低 |
| NFR-01 | 性能指标达标 | 高 |
| NFR-02 | 本地存储 + Git 版本管理 + localhost 限制 | 高 |
| NFR-03 | SCHEMA.md 单一事实来源 + log 可审计 | 高 |
| NFR-04 | 跨平台无损迁移 + 引擎可替换 | 中 |
| NFR-05 | 15 分钟内完成搭建 + 演示模式 | 高 |
| NFR-06 | 全国产工具链 + 国产模型支持 | 高 |

---

## 11. 风险与约束

### 11.1 风险

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| TRAE CLI 能力不及 Claude Code | 编译质量下降 | Skill 强约束 + 人工抽检 + 体检工作流；预留引擎可替换接口 |
| 国产模型长上下文能力差异 | 长资料编译截断 | 分段编译 + 摘要合并；选用 ≥ 128K 上下文模型 |
| 自研桥接 API 开发成本 | 工期延长 | 优先实现核心三接口（compile/query/health-check），其余迭代 |
| Web 前端图谱渲染性能 | 大规模知识库卡顿 | 节点聚类 + 按目录过滤 + 虚拟渲染 |
| 知识库膨胀后图谱混乱 | 可视化失效 | 定期体检 + 概念合并 + 分目录过滤 |
| Docker 桌面端未安装 | 一键部署失败 | 提供 Docker 缺失时的裸机脚本回退 |
| 自研引擎工期与稳定性 | 阶段2 延期、初期不稳定 | 分阶段交付，MVP 先用 TRAE CLI 验证 prompt；预留引擎可替换接口可回退 |
| 自研引擎工具调用死循环 / Token 超限 | 编译卡死或成本失控 | 循环步数上限 + Token 预算 + 充分测试（AC-05-10） |
| 自研引擎 prompt 等价性 | 阶段2 编译质量回落 | 阶段1 沉淀的 prompt 资产直接移植，AC-05-16 强制质量持平 |
| `@wiki/harness` 独立维护成本 | 组件包维护分散精力 | 场景窄通用性强；独立仓库 + 语义化版本 + 测试覆盖 ≥80% 控制质量；长期可形成技术资产 |
| `@wiki/harness` 零耦合校验失效 | 业务逻辑渗入组件 | AC-08-11 用静态分析工具校验零 Markdown/知识库依赖 |

### 11.2 约束

- 本期仅支持单用户本地使用，不支持多人并发写入。
- 不自建向量库，不实现 RAG 检索（明确采用 LLM Wiki 路线）。
- 移动端依赖 Web 响应式或 TRAE Work 移动端，不做原生开发。
- 核心工具链须国产化，不依赖海外 AI 编程工具。

---

## 12. 阶段交接声明

- 当前阶段：需求规格编制（V2.1 国产化 + Web 前端 + 渐进自研版） ✅ 已完成
- 下一阶段：方案设计与开发实施（阶段1 TRAE CLI 验证优先）
- 下一阶段智能体：全栈开发智能体
- 下一阶段技能：web-dev-trae / fullstack-developer / 前端设计技能
- 交接上下文：本规格说明书 V2.1 作为唯一需求基准。下一阶段须依据 FR-01 ~ FR-06 与 NFR-01 ~ NFR-06 进行设计与实施。AI 引擎按渐进路线执行：阶段1 优先用 TRAE CLI + Skill 跑通 compile/query/health-check 并固化 prompt（约 1 周）；阶段2 基于验证成果自研专用引擎替换（约 4-6 周）。重点交付：①阶段1 TRAE CLI Skill ②自研桥接 API（REST+SSE，预留引擎可替换接口）③Web 前端 8 大模块 ④一键安装脚本 ⑤阶段2 自研专用引擎。FR-07 列为二期。

### 12.1 AI 引擎阶段路线图

| 阶段 | 周期 | 目标 | 关键交付 | 验收依据 |
| --- | --- | --- | --- | --- |
| 阶段1：TRAE CLI 验证 | 约 1 周 | 验证 LLM Wiki 方法论可行，沉淀 prompt 与工作流资产 | TRAE CLI Skill（compile/query/health-check）+ 桥接 API MVP | AC-05-1 ~ AC-05-7 |
| 阶段2：自研 `@wiki/harness` + 业务层 | 约 4-6 周 | 自研独立组件包 `@wiki/harness`（运行时控制）+ 知识库业务层（工作流）替换 TRAE CLI | `@wiki/harness` 独立包 + 业务层 | AC-05-8 ~ AC-05-18 + AC-08-1 ~ AC-08-14 |
| 阶段3：迭代优化 | 持续 | 增量更新、并发体检、断点续传等专项优化 | 性能与功能增强 | NFR-01 持续达标 |

**回退保障**：若阶段2 未达 AC-05-8 ~ AC-05-16，可继续使用阶段1 TRAE CLI，需规不强制切换时间点。

---

## 附录 A：竞品资料索引

| 竞品 | 关键特征 | 参考来源 |
| --- | --- | --- |
| Karpathy LLM Wiki | 四步法、节省 90% Token | Karpathy Gist + GitHub 开源项目 |
| Hermes + Obsidian + LLM Wiki | 开源 Agent、飞书网关 | Hermes Agent 官方 + 实操教程 |
| TRAE CLI / Work | 国产 AI Agent、Skills/MCP | https://docs.trae.cn/ |
| Qwen Code + DeepSeek | 国产 AI 编程组合 | 公开教程 |
| Google NotebookLM | AI 摘要/问答/播客、云端 | NotebookLM 官网 |
| Notion | 一体化协作、数据库 | Notion 官网 |
| AnythingLLM | 开源 RAG、本地部署 | AnythingLLM GitHub |
| Quartz / Obsidian-zola | Markdown 静态站点生成 | 开源社区 |

## 附录 B：V1.0 → V2.0 变更摘要

| 维度 | V1.0 | V2.0 |
| --- | --- | --- |
| AI 引擎 | Claude Code（海外） | TRAE CLI（国产） |
| 桥接层 | Claudian（Obsidian 插件） | 自研桥接 API（REST+SSE） |
| 模型切换 | cc switch（第三方） | TRAE 原生配置 |
| 用户入口 | Obsidian 客户端（须安装） | Web 前端（浏览器零安装）+ Obsidian 可选 |
| 前端页面 | 无 | 8 大模块（仪表盘/浏览/检索/图谱/对话/投递/体检/配置） |
| 安装方式 | 手动多工具安装 | 一键脚本 + Docker + 桌面端 |
| 新手搭建 | 30 分钟 | 15 分钟 |
| 国产化 | 否 | 完全国产 |
| 演示模式 | 无 | 内置示例知识库 |

## 附录 B2：V2.1 → V2.2 变更摘要

| 维度 | V2.1 | V2.2 |
| --- | --- | --- |
| 阶段2 引擎结构 | 自研专用引擎（单体内聚，与桥接 API 合并） | 自研 `@wiki/harness`（独立组件包）+ 知识库业务层（依赖该组件） |
| Harness 架构 | 未明确 | 明确采用裁剪版 Harness（loop/state/retry/budget/hook） |
| 组件独立性 | 引擎内嵌于知识库项目 | `@wiki/harness` 独立仓库、独立版本、独立发布、可复用到其他项目 |
| FR-05 验收 | 16 条 AC | 18 条 AC（拆分为 Harness 组件验收 A 组 + 业务层验收 B 组） |
| FR-08 | 无 | 新增 14 条 AC，覆盖独立包发布/CLI/编程 API/五项核心机制/零耦合校验/测试覆盖/复用示例 |
| 架构层数 | 阶段2 四层（Web→业务→Vault→Obsidian） | 阶段2 四层，但业务层与 `@wiki/harness` 通过包引用解耦 |
| 工具清单 | 自研专用引擎一项 | 拆分为 `@wiki/harness` + 知识库业务层两项 |
| 风险 | 三类自研风险 | 新增 `@wiki/harness` 独立维护成本与零耦合校验风险 |
| 复用性 | 仅服务本知识库 | `@wiki/harness` 可服务代码生成/文档摘要/数据分析等其他 LLM Agent 项目 |

## 附录 C：飞书原文核心要点摘录

> 来源：飞书 Wiki《Karpathy-AI+Obsidian 知识库教程-栗氪聊AI》

- 工具安装：Obsidian、Claude Code、cc switch（非官方订阅推荐）、Claudian。
- 核心理念：基于 Karpathy LLM Wiki 方法，用 AI 维护结构化 Markdown 知识库。
- V1.0 工具链公式：Obsidian（容器）+ Claude Code（AI 引擎）+ Claudian（桥接）。
- V2.1 工具链公式（阶段1）：**Vault（本地 Markdown）+ TRAE CLI（AI 引擎）+ 自研桥接 API + Web 前端（零安装入口）+ Obsidian（可选高级编辑）**。
- V2.1 工具链公式（阶段2）：**Vault（本地 Markdown）+ 自研专用引擎（与桥接 API 合并）+ Web 前端 + Obsidian（可选高级编辑）**。
- V2.2 工具链公式（阶段2）：**Vault（本地 Markdown）+ `@wiki/harness`（独立组件包）+ 知识库业务层 + Web 前端 + Obsidian（可选高级编辑）**，其中 `@wiki/harness` 可被其他 LLM 项目直接复用。
