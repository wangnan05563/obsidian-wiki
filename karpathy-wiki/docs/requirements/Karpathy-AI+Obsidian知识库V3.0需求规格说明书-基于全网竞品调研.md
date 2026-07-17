# Karpathy-AI + Obsidian 知识库 V3.0 需求规格说明书（基于全网竞品调研）

| 项目 | 内容 |
| --- | --- |
| 文档名称 | Karpathy-AI + Obsidian 知识库 V3.0 需求规格说明书（基于全网竞品调研） |
| 文档版本 | V3.0（全网竞品调研驱动的演进需求版） |
| 编制日期 | 2026-07-17 |
| 文档状态 | 草案 |
| 变更说明 | V2.2（2026-07-07）确立 Harness 独立组件化基线；V3.0 基于 2026 年 7 月全网 22 个竞品调研，识别 30+ 可借鉴功能点，新增 FR-09 ~ FR-16 共 8 项演进需求，作为 V2.2 的增量扩展，不替代 V2.2 |
| 与 V2.2 的关系 | **增量扩展**。V2.2 的 FR-01 ~ FR-08、NFR-01 ~ NFR-06 全部保留为基准；V3.0 仅追加从竞品调研提炼的演进需求 FR-09 ~ FR-16。设计与实施时 V2.2 优先，V3.0 按优先级渐进落地 |
| 参考来源 | Karpathy 2026-04-03 LLM Knowledge Bases 长帖与 Gist；全网竞品官网与深度测评；项目 vault 概念文档；V2.2 SRS |

---

## 1. 引言

### 1.1 编写目的

本规格说明书基于 **2026 年 7 月全网竞品调研**，将"可借鉴功能点"转化为可验收的演进需求，作为 V2.2 SRS 的增量扩展，为后续迭代设计与实施提供依据。

**核心定位**：
- 不重新定义项目目标、用户画像、范围边界（沿用 V2.2 第 2 章）。
- 不修改 V2.2 的 FR-01 ~ FR-08、NFR-01 ~ NFR-06（保留为基准）。
- 仅追加 FR-09 ~ FR-16 共 8 项演进需求，每项含 AC 验收标准。
- 每项演进需求标注"借鉴来源竞品"与"差异化护城河"。

读者对象：知识库搭建者、AI Agent 配置者、前端/后端开发、评审与验收人员。

### 1.2 项目背景（含 2026 年关键事件）

V2.2 编制以来，AI 知识库赛道发生 4 件影响本项目的关键事件：

1. **Karpathy 正式提出 LLM Knowledge Bases 方法论（2026-04-03）**：Andrej Karpathy 在 X 发布长帖 "LLM Knowledge Bases" 并放出 GitHub Gist，明确"让 LLM 充当全职图书管理员，持续编译原始资料为结构化 Markdown 知识库，日常只读已编译页面，节省约 90% Token"——本项目路线被原作者确认。
2. **Google NotebookLM 更名为 Gemini Notebook（2026-07-16）**：100 万 token 上下文、Deep Research、AI 视频生成、可定制 AI 播客、数据表格、智能体——多模态内容生成成为差异化壁垒。
3. **Notion 3.0 / 3.2 发布（2025 年底 ~ 2026-01-20）**：核心是"你分配任务，Agent 来干活"，AI Agent 成为标配；Notion AI Connectors 让 Notion 成为联邦搜索 Hub。
4. **Obsidian AI Agent 生态爆发（2026 年）**：Smart Connections（语义关联）、Copilot（笔记内对话）、Web Clipper、多个开源 AI Agent 项目，让 Obsidian 从"被动存储"转向"主动思考"。

**对本项目的影响**：
- LLM Wiki 路线被验证，但需补强多模态、Agent 工作流、联邦搜索等能力，避免被大厂"上下文窗口无限化 + Agent 工作流"路线盖过。
- 本地优先 + 数据主权 + Markdown 原生仍是核心差异化护城河，但需在 AI 字段自动化、视图多样性、Skill 生态上补课。

### 1.3 术语与缩略语（V3.0 新增）

| 术语 | 含义 |
| --- | --- |
| LLM Knowledge Bases | Karpathy 2026-04-03 正式提出的方法论，本项目路线的原作者命名 |
| Gemini Notebook | 原 NotebookLM，2026-07-16 更名 |
| AI Connector | Notion 提出的联邦搜索机制，跨外部数据源统一问答 |
| AI 字段 | Notion / 飞书的多维表格 AI 自动填充字段，对应本项目 frontmatter `ai_*` 字段 |
| Skill Adapter | 飞书 Skill 理念，扩展 V2.2 的 EngineAdapter 为"模型+范围+系统提示词+工具集" |
| MCP | Model Context Protocol，2026 年成为外部工具调用事实标准 |
| Loop Component | Microsoft Loop 的可移植同步块，跨页面实时同步 |
| 实体图谱 | 从笔记内容 NLP 抽取实体（人/项目/概念/事件）建立关系图谱，区别于双向链接图谱 |

### 1.4 参考资料与竞品来源

**方法论源头**：
- Karpathy 2026-04-03 X 长帖 "LLM Knowledge Bases"
- Karpathy GitHub Gist
- 飞书 Wiki《Karpathy-AI+Obsidian 知识库教程-栗氪聊AI》

**竞品官网与文档**（详见附录 A）：
- AI 原生 PKM：Heptabase / Reflect / Tana / Capacities / Mem.ai / Notion AI
- 开源 RAG：AnythingLLM / Open WebUI / RagFlow / Quivr / khoj / Cherry Studio / Dify
- 大厂 AI：Gemini Notebook / 飞书 AI / 印象笔记 AI / WPS AI / MS Copilot+Loop+OneNote
- Obsidian 生态：Smart Connections / Copilot / Web Clipper

---

## 2. 项目概述（沿用 V2.2，仅补 2.4）

### 2.1 ~ 2.3 沿用 V2.2

详见 V2.2 SRS 第 2 章。

### 2.4 V3.0 演进目标（新增）

在 V2.2 已确立的"本地优先 + Markdown 原生 + AI 自动维护 + Web 前端 + 最低使用门槛 + Harness 独立组件化"基础上，V3.0 增加 3 项演进目标：

1. **多模态内容生成**：从单一文本问答扩展到"播客音频 / 思维导图 / FAQ / Timeline / 学习指南"多模态输出，借鉴 Gemini Notebook Audio Overview 模式。
2. **AI Agent 工作流化**：将 Query 从"单轮/多轮对话"升级为"任务编排器"，支持多步任务规划与中途介入，借鉴 Notion Agent / 飞书 Skill。
3. **类型化对象 + 实体图谱**：从"扁平 Markdown + 双链"升级为"类型化对象 + 实体图谱"，借鉴 Tana Supertags / Capacities Object Types / MS Graph。

V3.0 演进**不改变**核心定位（LLM Wiki 路线、本地优先、Markdown 原生、Harness 独立组件），仅在周边能力补课。

---

## 3. 全网竞品调研概览

### 3.1 调研范围

本次调研覆盖 4 大类共 22 个产品：

| 类别 | 产品数 | 产品清单 | 调研目的 |
| --- | --- | --- | --- |
| AI 原生 PKM | 6 | Heptabase / Reflect / Tana / Capacities / Mem.ai / Notion AI | 借鉴 PKM 数据组织与 AI 内联交互 |
| 开源 RAG/知识库 | 7 | AnythingLLM / Open WebUI / RagFlow / Quivr / khoj / Cherry Studio / Dify | 借鉴工作流编排、文档摄入、多模型管理 |
| 大厂 AI 知识库 | 6 | Gemini Notebook / 飞书 AI / Notion AI / 印象笔记 AI / WPS AI / MS Copilot+Loop+OneNote | 借鉴多模态生成、Skill 生态、企业合规 |
| Obsidian 生态 AI 插件 | 3+ | Smart Connections / Copilot / Web Clipper | 借鉴语义关联、剪藏链路 |

### 3.2 调研方法

- **网络搜索**：WebSearch 多轮查询 2026 年最新功能与深度测评
- **项目内对照**：读取 vault 概念文档与 V2.2 SRS，确保对标基准一致
- **三组并行 subagent 调研**：AI 原生 PKM / 开源 RAG / 大厂 AI 各一组，每组输出功能矩阵 + 可借鉴点 + 差异化分析
- **时效声明**：调研基于 2025-08 训练知识 + 2026 年公开网络信息，2025-08 ~ 2026-07 之间的更新可能未完全覆盖

### 3.3 关键发现

**发现 1：LLM Wiki 路线独特**——22 个竞品中**无一**采用"预处理编译结构化页面"路线，全部是 RAG（查询时检索 chunk）或 Agent（工具调用）路线。本项目在"知识工程"赛道上无直接竞品，差异化明显。

**发现 2：周边能力差距明显**——本项目在多模态生成、AI 字段自动化、视图多样性、Skill 生态、联邦搜索等"周边能力"上落后于大厂与开源方案，需补课。

**发现 3：2026 年 4 大趋势不可忽视**：
- AI Agent 工作流化（Notion Agent / 飞书 Skill / MS Copilot Studio）
- 多模态内容生成（Gemini Notebook 播客+视频）
- 上下文窗口无限化（Gemini 100 万 token）
- MCP 协议成为标准（Dify / RagFlow / Notion 推断支持）

**发现 4：本项目护城河仍稳固**——本地优先 + 数据主权 + Markdown 原生 + 结构化编译仍是 22 个竞品不具备的组合，但需在"周边能力"上补课以避免被大厂盖过。

---

## 4. 竞品深度对比分析

### 4.1 AI 原生 PKM 工具对比

| 维度 | Heptabase | Reflect | Tana | Capacities | Mem.ai | Notion AI |
| --- | --- | --- | --- | --- | --- | --- |
| 核心定位 | 白板-first 视觉思考 | 极简 AI 原生笔记 | Supertags 结构化 | 对象-first 知识管理 | AI 自动整理笔记 | 数据库+块级 AI |
| AI 写作辅助 | ✅ AI Card | ✅ 内联 AI | ✅ Tana AI | ✅ AI Assistant | ✅ AI 写作 | ✅ 内联 AI |
| AI 问答/Chat | ✅ | ✅ | ✅ | ✅ | ✅ Mem Chat | ✅ Q&A |
| AI 自动整理/标签 | ❌ 手动 | ⚠️ 有限 | ✅ Supertags 推断 | ⚠️ AI 辅助分类 | ✅ 自动（核心） | ✅ Auto-fill |
| 知识图谱可视化 | ✅ 白板（核心） | ❌ 弱 | ✅ Graph view | ✅ Graph view | ⚠️ 弱 | ❌ 依赖 relation |
| 数据主权/本地化 | ⚠️ 云端为主 | ❌ 纯云端 | ❌ 纯云端 | ❌ 纯云端 | ❌ 纯云端 | ❌ 纯云端 |
| 离线可用 | ⚠️ 部分 | ❌ | ❌ | ❌ | ❌ | ❌ |

**关键借鉴点**：
- **Heptabase** → 白板视图作为知识容器的二级抽象层
- **Tana** → Supertags 类型化对象系统（携带字段 schema）
- **Capacities** → AI Daily Note 自动对象提取 + 双链
- **Mem.ai** → AI 自动关联（Auto-linking）+ 语义搜索
- **Notion AI** → AI Auto-fill 数据库字段 + 块级 AI 操作

### 4.2 开源 RAG/知识库方案对比

| 维度 | AnythingLLM | Open WebUI | RagFlow | Quivr | khoj | Cherry Studio | Dify |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 核心定位 | 企业级知识库 | 多模型前端 | 深度文档理解 RAG | 第二大脑 | 个人第二大脑 | 多模型客户端 | LLM 应用平台 |
| 架构 | RAG+Agent | RAG+Chat | RAG+GraphRAG | RAG+Agent | RAG+Search+Agent | RAG+Chat | Workflow+Agent+RAG |
| 文档处理 | 中（含音频） | 中 | **强（OCR/表格/版面）** | 中（含音视频） | 中（含 Obsidian） | 中 | 中 |
| 工作流编排 | Agent Flows | Pipelines | 可视化 DAG | LangGraph | 简单 | 助手系统 | **最强（YAML DSL）** |
| 多模型 | 20+ | OpenAI 兼容全覆盖 | 全覆盖 | 中 | 中（含 offline） | **全覆盖** | **全覆盖** |
| 部署 | Docker/桌面/云 | Docker/pip/云 | Docker | Docker/云 | **桌面 App 全平台** | Tauri 桌面 | Docker/K8s/云 |
| 多用户 | 强（角色+SSO） | 强（LDAP/OAuth） | 中（团队） | 中 | 弱（单用户） | 无 | 强（workspace） |
| 结构化编译 Markdown | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 双向链接/知识图谱 | ❌ | ❌ | ✅（GraphRAG） | ❌ | ❌ | ❌ | ❌ |

**关键借鉴点**：
- **AnythingLLM** → Workspace 隔离 + Connector 体系 + Embed Widget
- **Open WebUI** → Tools/Functions 即服务 + Pipelines（OpenAI 兼容 API 工作流代理）
- **RagFlow** → 深度文档解析（OCR/版面/表格）+ GraphRAG 关系抽取 + chunk 级增量更新
- **khoj** → Obsidian vault 监听/索引 + Desktop App 跨平台
- **Dify** → YAML DSL 声明式 Workflow + Prompt IDE + Annotations（few-shot）+ Logs/Monitor

### 4.3 大厂 AI 知识库对比

| 维度 | Gemini Notebook | 飞书 AI | Notion AI | 印象笔记 AI | WPS AI | MS Copilot+Loop |
| --- | --- | --- | --- | --- | --- | --- |
| 核心定位 | 个人研究助手 | 企业协作+知识库 | 一体化工作空间 | 本土化 PKM | 国内办公全场景 | 企业生态嵌入 |
| 上下文规模 | 单本 50 源 → 100 万 token | 企业级全量 | 工作区全量 | 个人全库 | 文档级+知识库级 | M365 全工作域 |
| 多模态生成 | **播客+视频（核心壁垒）** | 文生图+语音转写 | 文生图+文件解析 | OCR+语音 | OCR+语音+文生图 | 文生图+语音+会议 |
| AI Agent | ✅ 智能体 | ✅ Skill 生态 | ✅ Notion 3.0 Agent | 有限 | 智能文档 Agent | ✅ Copilot Studio |
| 多端支持 | Web+iOS+Android | 全平台 | 全平台 | 全平台 | 全平台 | 全平台 |
| 数据主权 | Google Cloud | 字节国内 | AWS 多区域 | 国内数据中心 | 国内数据中心 | Azure 多区域 |
| 集成生态 | Google 套件 | 飞书套件+TRAE | Connectors+MCP | 印象生态 | WPS 套件 | M365+Graph+Copilot Studio |

**关键借鉴点**：
- **Gemini Notebook** → 源引用机制 + Audio Overview 播客 + Discover Sources 推荐 + Notebook 作为上下文窗口
- **飞书 AI** → 多维表格 AI 字段 + Skill 生态 + 智能伙伴绑定知识库 + 会议转写→知识链路
- **Notion AI** → Database View 多视图 + AI Auto-fill + Connectors 联邦搜索 + Synced Block 同步块
- **印象笔记 AI** → OCR 入库链路 + 全平台剪藏 + 智能标签 + 智能笔记本动态视图
- **WPS AI** → PDF 智能对话 + AI 模板市场 + 智能校对 + 信创国产化适配
- **MS Copilot+Loop** → Loop Component 同步块 + Microsoft Graph 数据图谱 + Copilot Pages 动态笔记 + Sensitivity Labels

### 4.4 Obsidian 生态 AI 插件对比

| 插件 | 核心能力 | 与本项目关系 |
| --- | --- | --- |
| Smart Connections | 语义关联推荐笔记 | 可借鉴其语义索引机制，但本项目走"编译时双链"而非"运行时语义" |
| Copilot | 笔记内对话 + AI 写作 | 可借鉴块级 AI 交互，本项目已在 Query.vue 实现对话 |
| Web Clipper | 浏览器剪藏到 Vault | 可作为 Ingest.vue 的"网页源"扩展入口 |
| 2026 新增 AI Agent 项目 | 把 AI Agent 接进 Obsidian | 验证本项目路线可行，但本项目走"自研引擎+Web 前端"差异化 |

### 4.5 综合功能矩阵：本项目 vs 22 个竞品

| 维度 | 本项目 V2.2 | 22 个竞品平均水平 | 差距 |
| --- | --- | --- | --- |
| 核心路线 | LLM Wiki（编译） | RAG / Agent | ✅ 独特 |
| 数据主权 | 完全本地 | 多为云端 | ✅ 领先 |
| Markdown 原生 | ✅ | 多数 ❌ | ✅ 领先 |
| 双向链接图谱 | ✅ | 仅 RagFlow GraphRAG | ✅ 领先 |
| 多模态生成 | ❌ | Gemini Notebook 领先 | ❌ 落后 |
| AI 字段自动化 | ❌ | Notion/飞书 标配 | ❌ 落后 |
| 视图多样性 | 列表+图谱 | Notion 多视图 | ❌ 落后 |
| Skill 生态 | EngineAdapter | 飞书/MS 标配 | ⚠️ 需扩展 |
| 联邦搜索 | ❌ | Notion Connectors | ❌ 落后 |
| 工作流编排 | TS 硬编码 | Dify YAML DSL | ❌ 落后 |
| Prompt IDE | ❌ | Dify 标配 | ❌ 落后 |
| 文档摄入 | 仅 Markdown | RagFlow 强 | ❌ 落后 |
| 应用监控 | 基础日志 | Dify 全链路 | ❌ 落后 |

**结论**：本项目在"核心路线 + 数据主权 + Markdown 原生"3 项护城河上领先，在"多模态 + AI 字段 + 视图 + Skill + 联邦搜索 + 工作流 + Prompt IDE + 文档摄入 + 监控"9 项周边能力上落后，需在 V3.0 渐进补齐。

---

## 5. 2026 年 AI 知识库关键趋势

基于 22 个竞品调研，提炼 2026 年 AI 知识库 10 大趋势：

| # | 趋势 | 强度 | 驱动因素 | 对本项目启示 |
| --- | --- | --- | --- | --- |
| T1 | AI Agent 工作流化 | 强 | 模型推理能力提升 + 用户期望升级 | Query.vue 升级为任务编排器 |
| T2 | 多模态内容生成 | 强 | TTS/视频生成模型成熟 | Audio Overview 播客生成切入 |
| T3 | 上下文窗口无限化 | 强 | Gemini 100 万 token | 本地优先架构反而成为优势 |
| T4 | MCP 协议成为标准 | 强 | 生态开放 + 工具复用 | 暴露 MCP Server 接口 |
| T5 | 数据主权需求上升 | 中 | 合规要求 + 敏感度提升 | 本项目天然契合，作为差异化卖点 |
| T6 | AI 字段自动化填充 | 强 | 用户期望"AI 做杂活" | frontmatter `ai_*` 字段切入 |
| T7 | 知识图谱+实体抽取 | 中 | NLP 抽取成熟 | 从双链图谱升级到实体图谱 |
| T8 | 跨源联邦搜索 | 中 | 数据分散 + 统一搜索 | 长期接入 GitHub/书签/外部文件夹 |
| T9 | 模板市场+Skill 生态 | 中 | 低代码定制 Agent | 提示词模板库 + Skill Adapter |
| T10 | 实时协作+同步块 | 弱 | 团队协作需求 | 对个人项目优先级低 |

---

### 4.3 大厂 AI 知识库对比

| 维度 | Gemini Notebook | 飞书 AI | Notion AI | 印象笔记 AI | WPS AI | MS Copilot+Loop |
| --- | --- | --- | --- | --- | --- | --- |
| 核心定位 | 个人研究助手 | 企业协作+知识库 | 一体化工作空间 | 本土化 PKM | 国内办公全场景 | 企业生态嵌入 |
| 上下文规模 | 单本 50 源 → 100 万 token | 企业级全量 | 工作区全量 | 个人全库 | 文档级+知识库级 | M365 全工作域 |
| 多模态生成 | **播客+视频（核心壁垒）** | 文生图+语音转写 | 文生图+文件解析 | OCR+语音 | OCR+语音+文生图 | 文生图+语音+会议 |
| AI Agent | ✅ 智能体 | ✅ Skill 生态 | ✅ Notion 3.0 Agent | 有限 | 智能文档 Agent | ✅ Copilot Studio |
| 多端支持 | Web+iOS+Android | 全平台 | 全平台 | 全平台 | 全平台 | 全平台 |
| 数据主权 | Google Cloud | 字节国内 | AWS 多区域 | 国内数据中心 | 国内数据中心 | Azure 多区域 |
| 集成生态 | Google 套件 | 飞书套件+TRAE | Connectors+MCP | 印象生态 | WPS 套件 | M365+Graph+Copilot Studio |

**关键借鉴点**：
- **Gemini Notebook** → 源引用机制 + Audio Overview 播客 + Discover Sources 推荐 + Notebook 作为上下文窗口
- **飞书 AI** → 多维表格 AI 字段 + Skill 生态 + 智能伙伴绑定知识库 + 会议转写→知识链路
- **Notion AI** → Database View 多视图 + AI Auto-fill + Connectors 联邦搜索 + Synced Block 同步块
- **印象笔记 AI** → OCR 入库链路 + 全平台剪藏 + 智能标签 + 智能笔记本动态视图
- **WPS AI** → PDF 智能对话 + AI 模板市场 + 智能校对 + 信创国产化适配
- **MS Copilot+Loop** → Loop Component 同步块 + Microsoft Graph 数据图谱 + Copilot Pages 动态笔记 + Sensitivity Labels

### 4.4 Obsidian 生态 AI 插件对比

| 插件 | 核心能力 | 与本项目关系 |
| --- | --- | --- |
| Smart Connections | 语义关联推荐笔记 | 可借鉴其语义索引机制，但本项目走"编译时双链"而非"运行时语义" |
| Copilot | 笔记内对话 + AI 写作 | 可借鉴块级 AI 交互，本项目已在 Query.vue 实现对话 |
| Web Clipper | 浏览器剪藏到 Vault | 可作为 Ingest.vue 的"网页源"扩展入口 |
| 2026 新增 AI Agent 项目 | 把 AI Agent 接进 Obsidian | 验证本项目路线可行，但本项目走"自研引擎+Web 前端"差异化 |

### 4.5 综合功能矩阵：本项目 vs 22 个竞品

| 维度 | 本项目 V2.2 | 22 个竞品平均水平 | 差距 |
| --- | --- | --- | --- |
| 核心路线 | LLM Wiki（编译） | RAG / Agent | ✅ 独特 |
| 数据主权 | 完全本地 | 多为云端 | ✅ 领先 |
| Markdown 原生 | ✅ | 多数 ❌ | ✅ 领先 |
| 双向链接图谱 | ✅ | 仅 RagFlow GraphRAG | ✅ 领先 |
| 多模态生成 | ❌ | Gemini Notebook 领先 | ❌ 落后 |
| AI 字段自动化 | ❌ | Notion/飞书 标配 | ❌ 落后 |
| 视图多样性 | 列表+图谱 | Notion 多视图 | ❌ 落后 |
| Skill 生态 | EngineAdapter | 飞书/MS 标配 | ⚠️ 需扩展 |
| 联邦搜索 | ❌ | Notion Connectors | ❌ 落后 |
| 工作流编排 | TS 硬编码 | Dify YAML DSL | ❌ 落后 |
| Prompt IDE | ❌ | Dify 标配 | ❌ 落后 |
| 文档摄入 | 仅 Markdown | RagFlow 强 | ❌ 落后 |
| 应用监控 | 基础日志 | Dify 全链路 | ❌ 落后 |

**结论**：本项目在"核心路线 + 数据主权 + Markdown 原生"3 项护城河上领先，在"多模态 + AI 字段 + 视图 + Skill + 联邦搜索 + 工作流 + Prompt IDE + 文档摄入 + 监控"9 项周边能力上落后，需在 V3.0 渐进补齐。

---

## 5. 2026 年 AI 知识库关键趋势

基于 22 个竞品调研，提炼 2026 年 AI 知识库 10 大趋势：

| # | 趋势 | 强度 | 驱动因素 | 对本项目启示 |
| --- | --- | --- | --- | --- |
| T1 | AI Agent 工作流化 | 强 | 模型推理能力提升 + 用户期望升级 | Query.vue 升级为任务编排器 |
| T2 | 多模态内容生成 | 强 | TTS/视频生成模型成熟 | Audio Overview 播客生成切入 |
| T3 | 上下文窗口无限化 | 强 | Gemini 100 万 token | 本地优先架构反而成为优势 |
| T4 | MCP 协议成为标准 | 强 | 生态开放 + 工具复用 | 暴露 MCP Server 接口 |
| T5 | 数据主权需求上升 | 中 | 合规要求 + 敏感度提升 | 本项目天然契合，作为差异化卖点 |
| T6 | AI 字段自动化填充 | 强 | 用户期望"AI 做杂活" | frontmatter `ai_*` 字段切入 |
| T7 | 知识图谱+实体抽取 | 中 | NLP 抽取成熟 | 从双链图谱升级到实体图谱 |
| T8 | 跨源联邦搜索 | 中 | 数据分散 + 统一搜索 | 长期接入 GitHub/书签/外部文件夹 |
| T9 | 模板市场+Skill 生态 | 中 | 低代码定制 Agent | 提示词模板库 + Skill Adapter |
| T10 | 实时协作+同步块 | 弱 | 团队协作需求 | 对个人项目优先级低 |

---
## 6. 可借鉴功能点汇总（按优先级分级）

> 优先级标注：**P0** 立即可做（高价值低成本） / **P1** 短期规划（1-2 月） / **P2** 中期规划（3-6 月） / **P3** 长期规划（6+ 月）

### 6.1 P0 立即可做（4 项）

| # | 功能点 | 借鉴来源 | 实施建议 |
| --- | --- | --- | --- |
| P0-1 | 强化 `RefsList.vue`：hover 卡片预览 + 跳转锚点高亮 | Gemini Notebook 源引用 | 答案下方平铺引用卡片，hover 预览源笔记，点击跳转带 `#line` 锚点高亮 |
| P0-2 | AI 自动打标签 | 印象笔记 / Capacities | 笔记保存时触发 LLM 扫描内容，frontmatter `tags` 字段自动填充，用户确认后写入 |
| P0-3 | Discover Sources 推荐相关笔记 | Gemini Notebook | `Graph.vue` 节点点击时推荐"邻近但未连接"的笔记，形成知识发现闭环 |
| P0-4 | Query 输出模式选择器 | Gemini Notebook Study Guide | `Query.vue` 增加"问答 / 摘要 / Mind Map / FAQ / Timeline"输出模式切换 |

### 6.2 P1 短期规划（8 项）

| # | 功能点 | 借鉴来源 | 实施建议 |
| --- | --- | --- | --- |
| P1-1 | AI 伙伴预设（Skill Adapter） | 飞书 Skill / MS Copilot | 扩展 EngineAdapter 为"模型+范围+系统提示词+工具集" |
| P1-2 | frontmatter `ai_*` 字段批处理 | Notion Auto-fill / 飞书 AI 字段 | 扩展 `compile-workflow.ts`，批处理填充 `ai_summary` / `ai_tags` / `ai_questions` |
| P1-3 | PDF 智能对话完整链路 | WPS PDF 对话 / RagFlow 深度解析 | `Ingest.vue` 增加 PDF 输入源，PyMuPDF + OCR 解析 |
| P1-4 | 看板视图 + 动态智能视图 | Notion Database View / 印象智能笔记本 | `Browse.vue` 增加"看板视图"（按 frontmatter 字段分列）+ 保存当前筛选为虚拟文件夹 |
| P1-5 | OCR 入库（图片/PDF 扫描件） | 印象 OCR / WPS OCR | `Ingest.vue` 集成 PaddleOCR（开源、中文友好）或腾讯云/阿里云 OCR |
| P1-6 | YAML DSL 声明式 Workflow | Dify Workflow DSL | 将 compile/query/health-check workflow 从 TS 硬编码改为 YAML 声明式 |
| P1-7 | Prompt IDE | Dify Prompt IDE | `Config.vue` 增加 Prompt 调试页，独立迭代 `prompts/compile.md` 等 |
| P1-8 | 命令系统（`/command`） | Quivr Command | 用户在 chat 中显式触发 workflow，比纯自然语言更可控 |

### 6.3 P2 中期规划（10 项）

| # | 功能点 | 借鉴来源 | 实施建议 |
| --- | --- | --- | --- |
| P2-1 | Audio Overview 播客生成 | Gemini Notebook | 集成 OpenAI TTS / 火山引擎 / Minimax，新增"播客视图"按主题生成 5-10 分钟音频 |
| P2-2 | AI Agent 任务模式 | Notion Agent / 飞书 Skill | `Query.vue` 升级为"任务编排器"，支持任务规划/中途介入/结果审查 |
| P2-3 | 实体图谱（人/项目/概念/事件） | MS Graph / 印象图记 | NLP 抽取实体，强化 `Graph.vue` 从双链图谱升级到实体图谱 |
| P2-4 | 类型化对象系统 | Tana Supertags / Capacities Object Types | 定义核心对象类型 schema（Paper/Concept/Person/Project/Insight）+ Templater 模板 + Dataview 查询视图 |
| P2-5 | Chunk-level / 文件级增量更新 | RagFlow / khoj | 优化 `compile-cache.ts`，chunk 级去重与增量 |
| P2-6 | GraphRAG 关系抽取 | RagFlow GraphRAG | 增强 entity 页面间关系抽取，与双向链接互补 |
| P2-7 | Pipelines（OpenAI 兼容 API 工作流代理） | Open WebUI Pipelines | compile workflow 暴露为 OpenAI 兼容端点，前端零成本接入 |
| P2-8 | Workspace / Brain 多知识库切换 | AnythingLLM Workspace / Quivr Brain | 支持多 vault 切换（如"工作"/"学习"/"个人"） |
| P2-9 | Annotations（few-shot 标注数据集） | Dify Annotations | 为 compile workflow 提供高质量示例 |
| P2-10 | Logs + Monitor 应用级可观测性 | Dify Logs/Monitor | compile/query 全链路追踪 |

### 6.4 P3 长期规划（8 项）

| # | 功能点 | 借鉴来源 | 实施建议 |
| --- | --- | --- | --- |
| P3-1 | MCP Server 接口 | Dify / Notion / MS（推断） | 暴露 Vault 给外部 Agent（如 Claude Desktop）访问 |
| P3-2 | Connectors 联邦搜索 | Notion AI Connectors / MS Graph | 接入 GitHub 仓库 / 本地文件夹 / Notion 导出 / 浏览器书签 |
| P3-3 | 浏览器剪藏扩展 | 印象剪藏 / Obsidian Web Clipper | 将网页内容剪藏为 Markdown 直接写入 Vault |
| P3-4 | 国产大模型本地部署支持 | WPS 信创 / khoj offline | 支持 Qwen / ChatGLM 本地推理 |
| P3-5 | Embed Widget 嵌入式挂件 | AnythingLLM Embed | 把 query 能力嵌入到任意网页 |
| P3-6 | 多模态摄入（音视频转录） | Quivr / AnythingLLM | `Ingest.vue` 增加"音频源/视频源"，集成 Whisper API |
| P3-7 | AI 模板市场 | WPS 模板市场 / 飞书 Skill | `Config.vue` 新增"模板管理"页，按场景预设提示词模板 |
| P3-8 | 桌面端跨平台（移动端 App） | khoj Desktop App / Cherry Studio Tauri | iOS/Android 移动端剪藏+查询 |

---
## 7. 演进需求规格（V3.0 新增 FR-09 ~ FR-16）

> 以下 8 项演进需求对应 P0 ~ P2 共 22 个可借鉴功能点。每项需求含 AC 验收标准，标注借鉴来源竞品与差异化护城河。

### 7.1 多模态内容生成需求（FR-09）

**需求编号**：FR-09
**需求名称**：多模态内容生成（播客 / 思维导图 / FAQ / Timeline）
**优先级**：高（P0+P2）
**借鉴来源**：Gemini Notebook Audio Overview / Study Guide / Mind Map
**差异化护城河**：本地 Markdown 原生 + 国产 TTS 模型，不依赖 Google Cloud

**描述**：
将 Query 从"纯文本问答"扩展为"多模态输出"。用户提问后可选择输出模式：问答 / 摘要 / Mind Map / FAQ / Timeline / 播客音频。

**子需求**：
- FR-09-1：Query 输出模式选择器（P0）
- FR-09-2：Mind Map / FAQ / Timeline 结构化输出（P0）
- FR-09-3：Audio Overview 播客生成（P2）

**验收标准**：
- AC-09-1：`Query.vue` 须提供"输出模式"选择器，至少支持问答 / 摘要 / Mind Map / FAQ / Timeline 五种模式。
- AC-09-2：Mind Map 模式须输出 Mermaid mindmap 语法，前端渲染为思维导图。
- AC-09-3：FAQ 模式须输出 ≥ 5 个 Q&A 对，每对带 `[[页面名]]` 引用。
- AC-09-4：Timeline 模式须按时间排序输出事件列表，每个事件带 `created` 字段与 `[[页面名]]` 引用。
- AC-09-5：播客生成须集成至少 1 个 TTS API（OpenAI / 火山引擎 / Minimax），输出 ≥ 5 分钟对话式音频。
- AC-09-6：播客生成须支持"主题范围限定"（按 tag/folder），避免全库噪音。
- AC-09-7：播客生成须保存为 `queries/podcast-{timestamp}.md` 含音频文件路径与脚本。
- AC-09-8：所有多模态输出须可一键归档至 `queries/` 目录，含 frontmatter `type: query`、`output_mode`、`generated_at`。

### 7.2 AI 字段自动化需求（FR-10）

**需求编号**：FR-10
**需求名称**：frontmatter `ai_*` 字段自动填充
**优先级**：高（P0+P1）
**借鉴来源**：Notion AI Auto-fill / 飞书多维表格 AI 字段 / 印象智能标签
**差异化护城河**：本地 Markdown frontmatter，零云端依赖

**描述**：
为笔记 frontmatter 引入 `ai_*` 字段，由后台工作流自动填充并随笔记内容更新刷新。用户可定义字段 schema 与填充策略。

**子需求**：
- FR-10-1：AI 自动打标签（P0）
- FR-10-2：`ai_summary` / `ai_questions` / `ai_sentiment` 字段批处理（P1）

**验收标准**：
- AC-10-1：笔记保存时须触发 LLM 扫描内容，自动填充 frontmatter `tags` 字段（若为空或用户启用"自动模式"）。
- AC-10-2：AI 标签建议须以"待确认"状态呈现，用户一键确认后写入，不得静默覆盖用户已填标签。
- AC-10-3：`ai_summary` 字段须由 `compile-workflow.ts` 批处理填充，内容为 ≤ 100 字摘要。
- AC-10-4：`ai_questions` 字段须由 LLM 生成 ≥ 3 个该笔记可回答的高价值问题。
- AC-10-5：`ai_sentiment` 字段须为枚举值（positive/neutral/negative/mixed）。
- AC-10-6：字段 schema 须可在 `Config.vue` 中可视化编辑，定义字段名、类型、填充策略、触发时机。
- AC-10-7：字段填充须支持三种触发模式：保存时触发 / 手动触发 / 定时任务。
- AC-10-8：字段填充失败须记录至 `log.md`，不得阻塞笔记保存。

---
### 7.3 视图多样性需求（FR-11）

**需求编号**：FR-11
**需求名称**：Browse 多视图模式（看板 / 日历 / 画廊 / 动态智能视图）
**优先级**：中（P1）
**借鉴来源**：Notion Database View / 印象智能笔记本
**差异化护城河**：基于 frontmatter 字段的纯 Markdown 视图，零数据库依赖

**描述**：
`Browse.vue` 从单一列表视图扩展为多视图模式，支持按 frontmatter 字段分列、按日期分组、按封面图展示、保存当前筛选为虚拟文件夹。

**验收标准**：
- AC-11-1：`Browse.vue` 须提供视图模式切换器，至少支持列表 / 看板 / 日历 / 画廊四种视图。
- AC-11-2：看板视图须按 frontmatter 字段（如 `type` / `status` / `tags`）分列，支持拖拽跨列移动（修改 frontmatter 字段值）。
- AC-11-3：日历视图须按 `created` 或 `updated` 字段分组，支持点击日期跳转。
- AC-11-4：画廊视图须显示笔记 frontmatter `cover` 字段（若有）或首图，无图笔记显示默认占位图。
- AC-11-5：所有视图须支持"保存当前筛选为虚拟文件夹"，保存的筛选条件存入 `.wiki/views/` 目录，可作为侧边栏快捷入口。
- AC-11-6：虚拟文件夹须支持编辑、删除、重命名，不影响底层 Markdown 文件。
- AC-11-7：视图模式与筛选条件须持久化至 localStorage，刷新后保持。

### 7.4 AI 伙伴与 Skill Adapter 需求（FR-12）

**需求编号**：FR-12
**需求名称**：AI 伙伴预设（Skill Adapter = 模型+范围+系统提示词+工具集）
**优先级**：高（P1）
**借鉴来源**：飞书 Skill / MS Copilot Studio / Cherry Studio 助手系统
**差异化护城河**：Skill 定义为 Markdown 文件，可版本管理、可分享

**描述**：
扩展 V2.2 的 EngineAdapter 为"Skill Adapter"——每个 AI 伙伴自带 system prompt、引用范围（tag/folder）、输出格式、工具集，用户在 `Config.vue` 中切换 Skill 而不仅是切换模型。

**验收标准**：
- AC-12-1：须提供"AI 伙伴管理"页（`Config.vue` 扩展），支持创建/编辑/删除/复制 AI 伙伴。
- AC-12-2：每个 AI 伙伴须可配置：LLM 模型、引用范围（tag/folder/all）、system prompt、输出格式（问答/摘要/播客脚本等）、工具集（compile/query/web_search 等子集）。
- AC-12-3：AI 伙伴定义须保存为 Markdown 文件（`skills/{name}.md`）含 frontmatter，可 Git 版本管理、可分享、可从模板创建。
- AC-12-4：`Query.vue` 须支持"当前 AI 伙伴"切换器，切换后立即生效（system prompt、范围、工具集全部更新）。
- AC-12-5：AI 伙伴的引用范围须严格执行——若范围限定为 `folder: concepts/`，问答时不得检索其他目录。
- AC-12-6：须提供至少 3 个内置 AI 伙伴模板：通用问答 / 文献综述 / 学习卡片生成。
- AC-12-7：AI 伙伴须支持"导入/导出"为 `.skill.json` 文件，便于跨 Vault 共享。

---
### 7.5 文档摄入增强需求（FR-13）

**需求编号**：FR-13
**需求名称**：PDF / OCR / 音频多源摄入
**优先级**：中（P1+P2）
**借鉴来源**：WPS PDF 对话 / 印象 OCR / RagFlow 深度解析 / Quivr 音视频
**差异化护城河**：本地 OCR（PaddleOCR）+ 国产语音服务，不依赖海外云

**描述**：
扩展 `Ingest.vue` 的输入源，从单一 Markdown 扩展到 PDF / 图片 / 音频 / 视频 / 网页 URL，每类输入源配置专用解析管线。

**子需求**：
- FR-13-1：PDF 智能对话完整链路（P1）
- FR-13-2：OCR 入库（图片/PDF 扫描件）（P1）
- FR-13-3：音频/视频转写入库（P2）

**验收标准**：
- AC-13-1：`Ingest.vue` 须支持 PDF 文件上传，解析后存入 `raw/papers/` 或 `raw/articles/`（按 frontmatter `type` 判定）。
- AC-13-2：PDF 解析须保留版面结构（标题层级、列表、表格），不得输出纯文本扁平流。
- AC-13-3：PDF 表格须解析为 Markdown table，扫描件 PDF 须通过 OCR 提取文字。
- AC-13-4：图片上传须通过 OCR（PaddleOCR 或腾讯云/阿里云 OCR）提取文字，存入 `raw/articles/`。
- AC-13-5：音频/视频上传须通过 Whisper API 或国内语音服务转写为文字，存入 `raw/articles/`。
- AC-13-6：网页 URL 输入须通过 web-search 工具抓取正文，剥离导航/广告/脚本。
- AC-13-7：所有非 Markdown 输入源解析后须生成"原始资料摘要卡片"（含标题、来源、字数、解析方式、解析时间），存入 `raw/` 对应子目录。
- AC-13-8：解析失败须给出明确错误信息与修复建议（如"PDF 加密，请提供密码"），不得静默失败。

### 7.6 工作流编排与可观测性需求（FR-14）

**需求编号**：FR-14
**需求名称**：YAML DSL 声明式 Workflow + Prompt IDE + Logs/Monitor
**优先级**：中（P1+P2）
**借鉴来源**：Dify Workflow DSL / Prompt IDE / Logs
**差异化护城河**：Workflow 定义为 YAML 文件，可 Git 版本管理、可分享、可热加载

**描述**：
将 compile/query/health-check workflow 从 TS 硬编码改为 YAML 声明式定义，提供 Prompt 独立调试环境与应用级可观测性。

**子需求**：
- FR-14-1：YAML DSL 声明式 Workflow（P1）
- FR-14-2：Prompt IDE（P1）
- FR-14-3：Logs + Monitor 应用级可观测性（P2）

**验收标准**：
- AC-14-1：`workflows/` 目录须存放 `compile.yaml` / `query.yaml` / `health-check.yaml` 三类工作流定义文件。
- AC-14-2：YAML schema 须定义 `steps`（步骤列表）、`hooks`（前置/后置 Hook）、`budget`（max_steps + token_budget）、`tools`（工具集）、`prompt_template`（prompt 文件引用）。
- AC-14-3：YAML 修改后须热加载生效，无需重启服务。
- AC-14-4：`Config.vue` 须提供 Prompt IDE 页，支持编辑 `prompts/compile.md` 等并即时预览渲染结果。
- AC-14-5：Prompt IDE 须支持"试运行"——输入测试资料，执行 compile 一次，查看输出。
- AC-14-6：所有 compile/query/health-check 执行须记录至 `logs/runs/` 目录，含 run_id、workflow 名、开始/结束时间、token 消耗、步数、状态、错误（若有）。
- AC-14-7：`Dashboard.vue` 须展示"运行历史"可视化列表，支持按 workflow 名/状态/时间筛选。
- AC-14-8：运行失败须可在 Dashboard 中查看错误详情与堆栈，并提供"重试"按钮。

---
### 7.7 类型化对象与实体图谱需求（FR-15）

**需求编号**：FR-15
**需求名称**：类型化对象系统 + 实体图谱（人/项目/概念/事件）
**优先级**：中（P2）
**借鉴来源**：Tana Supertags / Capacities Object Types / MS Graph
**差异化护城河**：基于 Markdown frontmatter + 双向链接，零数据库依赖

**描述**：
为 vault 定义核心对象类型 schema（Paper / Concept / Person / Project / Insight / Event），每类配独立 template + Dataview 查询视图。强化 `Graph.vue` 从"双链图谱"升级到"实体图谱"（NLP 抽取实体并建立关系）。

**验收标准**：
- AC-15-1：须在 `SCHEMA.md` 中定义 ≥ 6 类核心对象类型，每类含独立 frontmatter 字段集（如 Person 含 `name` / `role` / `organization` / `related_projects`）。
- AC-15-2：每类对象须提供独立 Templater 模板，新建笔记时可选择类型自动套用。
- AC-15-3：`Browse.vue` 须支持按对象类型筛选与分组展示。
- AC-15-4：compile-workflow 须能根据原始资料内容自动推断对象类型并填充 frontmatter。
- AC-15-5：`Graph.vue` 须支持"实体图谱视图"——节点按对象类型着色，边按关系类型（如 `author_of` / `participant_in` / `related_to`）标注。
- AC-15-6：实体关系须由 NLP 抽取（如"张三是项目X的负责人"自动建立 Person→Project 的 `leader_of` 关系），存入 `.wiki/relations.json`。
- AC-15-7：实体图谱须支持按关系类型过滤显示，支持点击节点跳转到对应笔记。

### 7.8 Discover Sources 与联邦搜索需求（FR-16）

**需求编号**：FR-16
**需求名称**：Discover Sources 推荐 + 联邦搜索（外部数据源接入）
**优先级**：低（P0+P3）
**借鉴来源**：Gemini Notebook Discover Sources / Notion AI Connectors
**差异化护城河**：本地优先 + 外部源元数据缓存，不强制云端聚合

**描述**：
两阶段需求：短期实现"Discover Sources 推荐"（vault 内相关笔记推荐）；长期实现"联邦搜索"（接入 GitHub / 本地文件夹 / 浏览器书签等外部源）。

**子需求**：
- FR-16-1：Discover Sources 推荐（P0）
- FR-16-2：联邦搜索（P3）

**验收标准**：
- AC-16-1：`Graph.vue` 节点点击时须在侧边栏推荐"邻近但未连接"的 ≥ 3 个相关笔记（基于双链拓扑与语义相似度）。
- AC-16-2：推荐理由须显式标注（如"同标签"/"同作者"/"语义相似度 0.85"）。
- AC-16-3：推荐笔记须支持"一键建立双链"，自动在两篇笔记 frontmatter 或正文中插入 `[[页面名]]`。
- AC-16-4：`Query.vue` 须提供"联邦搜索"开关（默认关闭），开启后可检索外部数据源。
- AC-16-5：外部数据源接入须通过 `Config.vue` 配置 Connector（GitHub repo / 本地文件夹路径 / 浏览器书签导出文件），元数据缓存至 `.wiki/connectors/`。
- AC-16-6：联邦搜索结果须分组展示（vault 内 / GitHub / 本地 / 书签），每组独立引用与跳转。
- AC-16-7：外部源结果须标注"外部"标识与源类型，跳转时打开外部链接（如 GitHub commit URL）。

---
## 8. 非功能需求更新（V3.0 增补）

### 8.1 NFR-07 多模态性能（新增）

| 指标 | 要求 |
| --- | --- |
| 播客生成（5 分钟音频）耗时 | ≤ 60 秒（不含模型推理） |
| Mind Map / FAQ / Timeline 生成 | ≤ 10 秒（流式首字 ≤ 3 秒） |
| PDF 解析（100 页）耗时 | ≤ 30 秒 |
| OCR 单图识别 | ≤ 5 秒 |
| 音频转写（10 分钟音频） | ≤ 60 秒 |

### 8.2 NFR-08 可观测性（新增）

- NFR-08-1：所有 compile/query/health-check 运行须记录 run_id、耗时、token 消耗、状态。
- NFR-08-2：运行历史须可在 Dashboard 中查询 ≥ 30 天。
- NFR-08-3：错误须包含堆栈与上下文，支持"重试"。
- NFR-08-4：token 消耗须按模型/工作流分维度统计，可在 Dashboard 中可视化。

### 8.3 NFR-09 Skill 可分享性（新增）

- NFR-09-1：AI 伙伴定义须为 Markdown 文件，可 Git 版本管理。
- NFR-09-2：AI 伙伴须支持"导入/导出"为 `.skill.json` 文件。
- NFR-09-3：YAML workflow 定义须可分享与热加载。

### 8.4 NFR-10 隐私与合规增强（新增）

- NFR-10-1：所有 AI 字段填充与多模态生成须明确告知数据上传范围。
- NFR-10-2：敏感笔记（frontmatter `sensitivity: confidential`）须支持"仅本地处理"开关，跳过 LLM 调用。
- NFR-10-3：播客生成须支持"仅本地 TTS 模型"选项（如 Edge-TTS 离线）。
- NFR-10-4：联邦搜索外部源结果须明确标注数据流向，用户可禁用。

---

## 9. 演进路线图

### 9.1 V3.0 分阶段交付计划

| 阶段 | 周期 | 目标 | 关键交付 | 验收依据 |
| --- | --- | --- | --- | --- |
| 阶段3a：P0 快速补课 | 2-4 周 | 落地 4 项 P0 功能，缩小与大厂基础体验差距 | RefsList 强化 + AI 标签 + Discover Sources + Query 输出模式 | FR-09-1~2 / FR-10-1 / FR-16-1 |
| 阶段3b：P1 系统化补课 | 1-2 月 | 落地 8 项 P1 功能，建立 Skill 生态与多视图 | Skill Adapter + AI 字段批处理 + PDF 对话 + 多视图 + OCR + YAML DSL + Prompt IDE + 命令系统 | FR-10-2~8 / FR-11 / FR-12 / FR-13-1~2 / FR-14-1~2 |
| 阶段3c：P2 多模态+图谱 | 3-6 月 | 落地 10 项 P2 功能，建立差异化壁垒 | 播客生成 + AI Agent 任务模式 + 实体图谱 + 类型化对象 + 增量更新 + GraphRAG + Pipelines + 多 vault + Annotations + Logs | FR-09-3~8 / FR-13-3 / FR-14-3 / FR-15 |
| 阶段3d：P3 生态化 | 6+ 月 | 落地 8 项 P3 功能，建立生态护城河 | MCP Server + Connectors 联邦搜索 + 浏览器剪藏 + 本地模型 + Embed Widget + 音视频 + 模板市场 + 移动端 | FR-16-2~7 |

### 9.2 阶段依赖关系

```
阶段3a（P0）→ 阶段3b（P1）→ 阶段3c（P2）→ 阶段3d（P3）
                ↓
            FR-10（AI 字段）依赖 FR-12（Skill Adapter）定义字段 schema
            FR-13（文档摄入）依赖 FR-14（YAML DSL）定义解析 workflow
            FR-15（实体图谱）依赖 FR-10（AI 字段）填充类型字段
```

### 9.3 回退保障

- 若阶段3a 未达 AC-09-1~2 / AC-10-1 / AC-16-1，可继续使用 V2.2 当前 Query/Browse/Graph 实现，不阻塞主流程。
- 若阶段3b 未达 AC-12-1~7，可继续使用 V2.2 的 EngineAdapter 单一模型切换，不阻塞 FR-10/FR-11。
- 若阶段3c 未达 AC-09-3~8（播客生成），可仅保留文本输出模式，多模态延后。
- 若阶段3d 未达 AC-16-4~7（联邦搜索），可仅保留 vault 内 Discover Sources 推荐，外部源接入延后。

---
## 10. 风险与差异化护城河

### 10.1 V3.0 新增风险

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| 多模态生成成本失控 | 播客/视频生成 token 与 API 费用高 | budget 双上限（max_steps + token_budget）；本地 TTS 优先；按需生成非实时 |
| AI 字段填充质量不稳定 | frontmatter 字段污染 | "待确认"状态 + 用户一键确认；不得静默覆盖；失败记录至 log |
| YAML DSL 学习成本 | 用户难上手 | 提供可视化 Workflow 编辑器（借鉴 Dify React Flow）；内置模板 |
| 实体图谱抽取精度 | NLP 抽取错误关系 | 置信度阈值 + 用户确认机制；关系可编辑可删除 |
| 联邦搜索外部源依赖 | 外部 API 限流/变更 | Connector 缓存 + 降级策略；外部源禁用开关 |
| 多视图性能 | 大规模 vault 卡顿 | 虚拟滚动 + 按目录分页加载；视图索引缓存 |
| 与 V2.2 已有功能冲突 | 双轨维护成本 | V3.0 增量扩展不修改 V2.2；FR-09~16 全部为新增 AC，与 FR-01~08 无冲突 |
| 工期与稳定性 | 8 项 FR 一次性交付风险大 | 严格按 P0→P1→P2→P3 分阶段交付；每阶段独立可验收 |

### 10.2 V3.0 差异化护城河（22 个竞品均不具备）

| 维度 | 本项目 V3.0 | 22 个竞品 |
| --- | --- | --- |
| 核心路线 | LLM Wiki（预处理编译） | RAG / Agent |
| 数据主权 | 完全本地 Markdown | 多为云端 |
| 多模态生成 | 本地 TTS + 国产模型 + Markdown 原生 | Gemini Notebook 依赖 Google Cloud |
| AI 字段 | frontmatter `ai_*` + 用户确认 + Git 可追溯 | Notion/飞书 数据库字段 + 云端 |
| Skill 生态 | Markdown 定义 + 可分享 + 可版本管理 | 飞书 Skill 闭源 / MS Copilot Studio 低代码 |
| 视图多样性 | 纯 Markdown frontmatter 驱动，零数据库 | Notion Database 重依赖 |
| 实体图谱 | 双向链接 + NLP 抽取 + 本地缓存 | MS Graph 企业级 / 印象图记 闭源 |
| 工作流编排 | YAML DSL + Git 版本管理 + 热加载 | Dify YAML 但定位为开发者平台 |
| 联邦搜索 | 本地优先 + 外部源元数据缓存 | Notion Connectors 云端聚合 |

### 10.3 须坚守的核心（避免路线漂移）

借鉴 22 个竞品时，**只借鉴周边能力**（文档摄入、UI、工作流编排、监控、多模态生成），**不借鉴核心架构**：

1. **不退化 compile 为查询时 RAG**——LLM Wiki 的灵魂是预处理编译。
2. **不放弃结构化页面输出**——vault 四类页面模板不能丢。
3. **不放弃双向链接图谱**——不能用 GraphRAG 隐式图替代显式 `[[链接]]`。
4. **不放弃 Harness 抽象**——Agent = LLM + Harness 是核心。
5. **不放弃 health-check-fix workflow**——自我修复是 LLM Wiki 区别于静态 RAG 的关键。

---

## 11. 阶段交接声明

- 当前阶段：V3.0 全网竞品调研与演进需求编制 ✅ 已完成
- 下一阶段：V3.0 P0 项实施（RefsList 强化 / AI 标签 / Discover Sources / Query 输出模式）
- 下一阶段智能体：全栈开发智能体
- 下一阶段技能：`wiki-code-dev` / `frontend-design` / `brainstorming`
- 交接上下文：
  1. 本规格说明书 V3.0 作为 V2.2 的增量扩展，新增 FR-09 ~ FR-16 共 8 项演进需求与 NFR-07 ~ NFR-10 共 4 项非功能需求。
  2. 22 个竞品调研结论：本项目在"核心路线 + 数据主权 + Markdown 原生"3 项护城河领先，在"多模态 + AI 字段 + 视图 + Skill + 联邦搜索 + 工作流 + Prompt IDE + 文档摄入 + 监控"9 项周边能力落后。
  3. P0 项 4 条建议立即实施，预计 2-4 周完成；P1 项 8 条建议 1-2 月完成；P2 项 10 条建议 3-6 月完成；P3 项 8 条建议 6+ 月长期规划。
  4. 项目已有 `RefsList.vue` / `Graph.vue` / `Browse.vue` / `Query.vue` / `Config.vue` / `Ingest.vue` / `compile-workflow.ts` / `EngineAdapter` / `Dashboard.vue` 等关键组件，可作为 P0/P1 项的改造基础。
  5. **关键提醒**：V3.0 增量扩展不修改 V2.2 的 FR-01~08 / NFR-01~06，设计与实施时 V2.2 优先，V3.0 按优先级渐进落地。
  6. **调研时效声明**：本次调研基于 2025-08 训练知识 + 2026 年公开网络信息，2025-08 ~ 2026-07 之间的更新可能未完全覆盖。建议对 P0 项的具体功能细节二次确认（如 NotebookLM 播客生成 API 是否开放、飞书 Skill 接口规范、Dify YAML DSL schema 等）。

---
## 附录 A：竞品资料索引

### A.1 方法论源头

| 资源 | 来源 |
| --- | --- |
| Karpathy LLM Knowledge Bases 长帖 | Karpathy 2026-04-03 X 发布 |
| Karpathy GitHub Gist | https://gist.github.com/karpathy |
| 飞书 Wiki《Karpathy-AI+Obsidian 知识库教程-栗氪聊AI》 | https://my.feishu.cn/wiki/LLtjwi38FiuWvKkgfPYcWiGFnab |

### A.2 AI 原生 PKM 工具

| 竞品 | 官网 | 关键特征 |
| --- | --- | --- |
| Heptabase | https://heptabase.com | 白板-first 视觉思考，AI Card 上下文锚定 |
| Reflect | https://reflect.app | 极简 AI 原生，会议转录端到端 |
| Tana | https://tana.inc | Supertags 类型化对象，AI Agent 节点 |
| Capacities | https://capacities.io | 对象-first，AI Daily Note 自动对象提取 |
| Mem.ai | https://mem.ai | AI 自动关联，Smart Search 语义检索 |
| Notion AI | https://www.notion.so/product/ai | Notion 3.0 Agent，AI Auto-fill，Connectors 联邦搜索 |

### A.3 开源 RAG/知识库方案

| 竞品 | GitHub | 关键特征 |
| --- | --- | --- |
| AnythingLLM | https://github.com/Mintplex-Labs/anything-llm | Workspace 隔离 + Connector 体系 + Embed Widget |
| Open WebUI | https://github.com/open-webui/open-webui | Tools/Functions 即服务 + Pipelines |
| RagFlow | https://github.com/infiniflow/ragflow | 深度文档解析 + GraphRAG + 可视化 DAG |
| Quivr | https://github.com/QuivrHQ/quivr | Brain 多知识库 + 命令系统 + LangGraph |
| khoj | https://github.com/khoj-ai/khoj | Obsidian 深度集成 + Desktop App 全平台 |
| Cherry Studio | https://github.com/CherryHQ/cherry-studio | Tauri 桌面 + 多模型供应商统一管理 |
| Dify | https://github.com/langgenius/dify | YAML DSL Workflow + Prompt IDE + Logs/Monitor |

### A.4 大厂 AI 知识库

| 竞品 | 官网 | 关键特征 |
| --- | --- | --- |
| Gemini Notebook（原 NotebookLM） | https://notebooklm.google.com | 100 万 token + Audio Overview 播客 + Deep Research + AI 视频 |
| 飞书 AI | https://www.feishu.cn | 多维表格 AI 字段 + Skill 生态 + 智能伙伴 + 会议转写 |
| Notion AI | https://www.notion.so/product/ai | Notion 3.0 Agent + AI Connectors + Database View 多视图 |
| 印象笔记 AI | https://www.yinxiang.com | OCR + 全平台剪藏 + 智能标签 + 印象图记 |
| WPS AI | https://ai.wps.cn | PDF 智能对话 + AI 模板市场 + 信创国产化 |
| MS Copilot + Loop + OneNote | https://copilot.microsoft.com | Loop Component 同步块 + Microsoft Graph + Copilot Studio |

### A.5 Obsidian 生态 AI 插件

| 插件 | 来源 | 关键特征 |
| --- | --- | --- |
| Smart Connections | Obsidian 社区市场 | 语义关联推荐笔记 |
| Copilot | Obsidian 社区市场 | 笔记内对话 + AI 写作 |
| Web Clipper | Obsidian 官方 | 浏览器剪藏到 Vault |

---

## 附录 B：V2.2 → V3.0 变更摘要

| 维度 | V2.2 | V3.0 |
| --- | --- | --- |
| 文档定位 | 基线需求规格 | 基线 + 竞品调研驱动的增量演进 |
| 竞品分析 | 7 个（NotebookLM/Notion/AnythingLLM/Hermes/Codex 等） | 22 个（4 大类，含 AI 原生 PKM / 开源 RAG / 大厂 / Obsidian 生态） |
| 功能需求 | FR-01 ~ FR-08（8 项） | FR-01 ~ FR-16（16 项，新增 8 项演进需求） |
| 非功能需求 | NFR-01 ~ NFR-06（6 项） | NFR-01 ~ NFR-10（10 项，新增多模态性能/可观测性/可分享性/隐私增强） |
| 趋势分析 | 无 | 10 大趋势 + 强度评级 |
| 可借鉴功能点 | 隐式 | 显式分级 30 项（P0/P1/P2/P3） |
| 演进路线图 | V2.1 阶段1-3 路线图 | V3.0 阶段3a-3d 路线图（增量） |
| 差异化护城河 | 6 项核心指标 | 9 项护城河 + 5 项须坚守的核心 |
| Karpathy 方法论确认 | 引用飞书 Wiki | 引用 Karpathy 2026-04-03 长帖（原作者确认） |

---

## 附录 C：调研覆盖度自评

| 调研维度 | 覆盖度 | 说明 |
| --- | --- | --- |
| AI 原生 PKM 工具 | 高 | 6 个产品全覆盖，含 2025-2026 最新功能 |
| 开源 RAG/知识库 | 高 | 7 个产品全覆盖，含 Dify/RagFlow 2026 MCP 趋势 |
| 大厂 AI 知识库 | 中高 | 6 个产品覆盖，NotebookLM 2026-07 更名已确认 |
| Obsidian 生态 AI 插件 | 中 | 3 个主流插件覆盖，2026 新增 AI Agent 项目仅网络提及 |
| 2026 年最新功能时效 | 中 | 训练知识截止 2025-08，2026 信息来自 WebSearch 公开网络，可能未完全覆盖 |
| 可借鉴功能点优先级 | 中高 | 基于 V2.2 项目当前状态与项目记忆推断，建议二次确认 |

---

**文档结束**