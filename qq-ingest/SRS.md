# QQ 聊天记录 → Obsidian 知识库 需求规格说明书 (SRS)

- 文档版本: v1.1 (v1.0 评审后修订，已修复 REVIEW §7.4 全部 8 项建议)
- 日期: 2026-07-22
- 状态: 评审通过
- 适用项目: Karpathy-Wiki (karpathy-wiki/)
- 子系统位置: qq-ingest/

---

## 1. 背景与目标

### 1.1 背景

Karpathy-Wiki 已具备完整的"原始资料 → AI 编译 → 体系化页面"流水线，原始入口见 [compile-workflow.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/workflows/compile-workflow.ts)。现有用例面向技术文档/Markdown，信噪比高。QQ 群聊记录信噪比极低 (90%+ 噪声)，且含隐私数据，直接灌入会导致 token 浪费、提炼质量下降、知识库污染与合规风险。

### 1.2 目标

将 QQ 聊天记录通过三段式流水线 (预清洗 → 价值抽取 → 体系化编译) 转化为知识库内的体系化业务问答与方案沉淀页面，复用现有 compile 能力，新增隔离子系统 qq-ingest/。

### 1.3 非目标

- 不支持微信/钉钉等其他 IM (架构预留扩展点，但本期不实现)
- 不做 QQ 客户端实时监听 (仅接受导出文件)
- 不做向量检索/RAG (沿用现有 compile-then-query 范式)
- 不修改现有 compile.ts 路由主流程

---

## 2. 竞品调研与亮点融入

调研对象涵盖 Karpathy LLM Wiki 三层架构、Hermes + Obsidian 实战方案、有道云笔记 + LLM Wiki、2026 RAG 最佳实践、Microsoft Presidio PII 脱敏框架、qq-chat-exporter 等开源工具。提炼以下亮点融入本规格:

| 竞品/方案 | 融入点 | 本规格对应章节 |
|---|---|---|
| Karpathy LLM Wiki 三层架构 | raw/ 不可变 + SCHEMA.md 强制 + 双向链接 ≥1 | §6.3 复用现有约束 |
| Hermes + Obsidian 实战 | `confidence: high/medium/low` + `contested: bool` frontmatter 字段;bulk 模式避免重复更新 | §5.2 frontmatter 扩展、§7.4 批量预处理 |
| 有道云笔记 + LLM Wiki | 聊天→笔记→AI 提炼→关联过往笔记的"知识复利"路径 | §6.3 compile 阶段强制建立与已有 entities/concepts 的双向链接 |
| 2026 RAG 最佳实践 | "证据约束"原则:抽取必须保留原文片段，禁止 LLM 综合多源编造 | §5.2 prompt 约束、§6.2 frontmatter original_refs 字段 |
| Microsoft Presidio | NER + 正则 + 规则 + 校验组合拳;脱敏在 LLM 输入前 + 输出后各做一次 | §5.1 双向脱敏、§7.2 脱敏模块设计 |
| qq-chat-exporter | JSON 格式作为预清洗优先输入格式 | §5.1 输入格式适配 |
| Hermes 四个实战坑 | 全部已在本项目硬约束中规避 (raw 不可变/SCHEMA 先定/路径同步/bulk 模式) | §8 风险与规避 |

参考链接:
- [Microsoft Presidio](https://github.com/microsoft/presidio)
- [Karpathy LLM Wiki 概念](http://m.toutiao.com/group/7658105252222206505/)
- [Hermes + Obsidian 实战](http://m.toutiao.com/group/7640720178661098030/)
- [2026 RAG 最佳实践](http://m.toutiao.com/group/7665217052864447016/)
- [有道云笔记 + LLM Wiki](http://m.toutiao.com/group/7663467774773133878/)
- [QQ 聊天记录导出工具](https://post.m.smzdm.com/p/aqk2ovnk/)

---

## 3. 整体架构

### 3.1 架构选型

采用**方案 A:独立子系统模式**。在项目根新建 `qq-ingest/` 子目录，包含独立的预处理、抽取、Schema 扩展模块，通过新增 `/api/qq-ingest/*` 路由族对接，复用 `VaultService` 与 `compileWorkflow`。

### 3.2 三段式流水线

```
[QQ 导出文件 (.txt/.json)]
        ↓
   阶段1: 预清洗 (qq-preprocess.ts)
   - 格式归一化
   - 噪声过滤
   - PII 脱敏 (强制)
        ↓
[结构化中间格式 JSON: raw/qq-<群名>-<日期>.json]
        ↓
   阶段2: 价值抽取 (qq-extract.md prompt)
   - LLM 识别 Q&A 配对
   - LLM 识别方案沉淀
   - 输出候选 draft
        ↓
[候选 Q&A JSON: status=draft]
        ↓
   阶段3: 体系化编译 (复用 compileWorkflow)
   - AI 组织为 qa/、solutions/ 页面
   - 建立双向链接
   - 更新 index.md/log.md
        ↓
[Obsidian 知识库页面]
```

### 3.3 子系统目录结构

```
qq-ingest/
├── SRS.md                    (本文件)
├── REVIEW.md                 (评审报告)
├── preprocess/
│   └── qq-preprocess.ts      (阶段1 实现，待开发)
├── extract/
│   └── qq-extract.md         (阶段2 prompt，待开发)
└── schema-extend/
    └── SCHEMA-qq.md          (阶段3 schema 扩展说明，待开发)
```

注:实现代码将在评审通过后于开发阶段创建，本规格仅定义接口与约束。

**构建归属**:qq-ingest/ 源码物理位置独立，但通过 `karpathy-wiki/api/tsconfig.json` 的 paths 映射纳入 api 构建体系 (如 `"@qq-ingest/*": ["../../qq-ingest/*"]`)。不引入独立 package.json，避免 pnpm workspace 复杂化。前端无构建归属变化 (Tab 内嵌现有 Ingest.vue)。

---

## 4. 功能需求

### 4.1 用户故事

| ID | 角色 | 故事 | 优先级 |
|---|---|---|---|
| US-1 | 知识库管理员 | 我能上传 QQ 导出的 .txt 或 .json 文件，系统自动完成预清洗 | P0 |
| US-2 | 知识库管理员 | 上传后能在前端看到清洗进度 (过滤条数、脱敏条数、保留条数) | P0 |
| US-3 | 知识库管理员 | 清洗后的对话流自动进入价值抽取，识别出业务 Q&A 与方案沉淀 | P0 |
| US-4 | 知识库管理员 | 抽取结果以 draft 状态入库，我能在 Browse 视图按 status 过滤审核 | P0 |
| US-5 | 知识库管理员 | 审核通过的 draft 能触发 compile，组织为体系化 qa/ 或 solutions/ 页面 | P0 |
| US-6 | 知识库管理员 | 所有 QQ 来源页面带 source: qq-chat 标识，可按来源过滤/清理 | P1 |
| US-7 | 知识库管理员 | 我能在 Config 视图配置脱敏规则、噪声过滤规则、批量上限 | P1 |
| US-8 | 隐私合规官 | 原始 QQ 文件不进入 LLM，仅脱敏后中间格式参与抽取 | P0 |
| US-9 | 隐私合规官 | 抽取输出再次经过脱敏扫描，防止 LLM 记忆泄漏 | P0 |

### 4.2 功能清单

| ID | 功能 | 模块 |
|---|---|---|
| F-1 | QQ .txt/.json 解析与格式归一化 | preprocess |
| F-2 | 噪声过滤 (表情/短回应/系统消息/链接) | preprocess |
| F-3 | PII 脱敏 (手机号/身份证/邮箱/银行卡) | preprocess |
| F-4 | 中间格式 JSON 输出与 raw/ 存档 | preprocess |
| F-5 | qq-extract.md prompt 加载与执行 | extract |
| F-6 | 候选 Q&A JSON 解析与 draft 页面写入 | extract |
| F-7 | 抽取输出二次脱敏扫描 | extract |
| F-8 | 复用 compileWorkflow 编译 draft → 正式页面 | schema-extend |
| F-9 | SCHEMA.md 扩展 qa/、solutions/ 目录规范 | schema-extend |
| F-10 | VaultService 白名单扩展 qa/、solutions/ | schema-extend |
| F-11 | /api/qq-ingest/* 路由族 (upload/preview/extract/compile) | routes |
| F-12 | 前端 Ingest.vue 新增 "QQ 聊天记录" Tab | frontend |
| F-13 | Config.vue 新增 QQ 配置面板 | frontend |
| F-14 | Browse.vue 按 source/status 过滤 | frontend |

---

## 5. 详细需求 - 三环节覆盖

### 5.1 环节1:预清洗 (qq-preprocess.ts)

#### 5.1.1 输入格式适配

优先支持 JSON 格式 (qq-chat-exporter 等工具产物)，兜底支持 QQ 自带消息管理器导出的 .txt。

**JSON 输入 Schema** (建议):
```json
{
  "meta": {
    "source": "qq-chat-exporter",
    "chatName": "群名/好友昵称",
    "exportTime": "2026-07-22T10:00:00Z"
  },
  "messages": [
    {
      "timestamp": "2026-07-20 14:30:15",
      "speaker": "张三",
      "type": "text|image|file|system",
      "content": "消息正文"
    }
  ]
}
```

**TXT 输入格式** (QQ 自带消息管理器):
```
2026-07-20 14:30:15 张三<xxx@qq.com>
消息正文
2026-07-20 14:30:20 李四<yyy@qq.com>
下一条消息
```

#### 5.1.2 噪声过滤规则 (配置化，config.json → qq.noise_rules)

| 规则 ID | 描述 | 默认开关 |
|---|---|---|
| NR-1 | 纯表情/图片占位符 (`[图片]`、`[表情]`、`[动画表情]`) | on |
| NR-2 | 短回应 (<5 字且不含 `?`/`!`) | on |
| NR-3 | 系统消息 (含"撤回了""加入了""修改了群名"等关键词) | on |
| NR-4 | 纯链接消息 (整条匹配 `https?://`) | on |
| NR-5 | 纯数字/纯标点 | on |
| NR-6 | 重复刷屏 (同一发言人连续 5 条相同内容) | on |

过滤规则在配置中可开关，遵循项目"配置驱动"硬约束。

#### 5.1.3 PII 脱敏规则 (强制，不可关闭)

参考 Microsoft Presidio "NER + 正则 + 规则 + 校验" 组合拳范式，因中文场景 Presidio 默认模型支持不足，本期采用纯正则规则集 (后续可扩展 NER)。

| PII 类型 | 正则模式 (示例) | 替换为 |
|---|---|---|
| 手机号 | `1[3-9]\d{9}` | `[REDACTED-PHONE]` |
| 身份证 (18 位) | `\d{17}[\dXx]` | `[REDACTED-ID]` |
| 邮箱 | `[\w.-]+@[\w.-]+\.\w+` | `[REDACTED-EMAIL]` |
| 银行卡 (16-19 位) | `\d{16,19}` (带 Luhn 校验可选) | `[REDACTED-CARD]` |
| QQ 号 (上下文含"QQ/扣扣/qq号") | `(?<=QQ|扣扣|qq号|企鹅)\s*[0-9]{5,11}` | `[REDACTED-QQ]` |

**双向脱敏** (借鉴 Presidio):
1. **输入脱敏**:预清洗阶段对原始对话流执行，脱敏后内容进入 LLM
2. **输出脱敏**:抽取阶段输出 JSON 前再次扫描，防止 LLM 记忆还原 PII

#### 5.1.4 中间格式输出

```json
{
  "meta": {
    "source": "qq-chat",
    "chatName": "群名",
    "dateRange": "2026-07-01~2026-07-20",
    "originalCount": 1500,
    "filteredCount": 120,
    "redactedCount": 8
  },
  "messages": [
    {
      "ts": "2026-07-20T14:30:15Z",
      "speaker": "张三",
      "content": "脱敏后的消息内容",
      "type": "text"
    }
  ]
}
```

落盘路径:`data/vault/raw/qq-<chatName>-<dateRange>.json`，复用 `VaultService.archiveRaw`。

### 5.2 环节2:价值抽取 (qq-extract.md)

#### 5.2.1 Prompt 设计原则

借鉴 2026 RAG 最佳实践"证据约束"原则，禁止 LLM 综合多源编造。

#### 5.2.1a 长文本分块策略

清洗后对话流可能超出 LLM 上下文窗口 (如 10000+ 条消息)。分块策略:
1. **时间窗口分块** (默认):按自然日切分，单日超过阈值 (默认 200 条清洗后消息) 再按小时切分
2. **话题聚类分块** (可选，M2+ 迭代):基于关键词相似度聚类，需额外实现聚类算法
3. **块间衔接**:分块抽取结果合并去重 (相同 question 不同块均抽取时，保留 answerer 最多/最早的一条)
4. **分块阈值配置化**:config.json → qq.chunk_threshold (默认 200)

#### 5.2.2 Prompt 结构 (概要)

```markdown
# QQ 聊天记录价值抽取 prompt

你是一个业务问答抽取器。读取脱敏后的对话流，识别两类高价值信息:

## 任务
1. **业务问答对**:有明确问题 + 明确解答的配对
2. **方案沉淀**:多人讨论后形成的经验总结/操作步骤

## 输出 Schema (JSON)
{
  "qa_pairs": [
    {
      "question": "问题原文(可轻度改写)",
      "answer": "答案原文(可轻度改写)",
      "answerer": "解答人",
      "ts": "时间戳",
      "context": "上下文简述(<=100字)",
      "original_refs": ["原始消息片段引用(必须保留)"],
      "tags": ["业务领域标签"]
    }
  ],
  "solutions": [
    {
      "title": "方案标题",
      "background": "背景",
      "steps": ["步骤1", "步骤2"],
      "caveats": "注意事项",
      "original_refs": ["原文引用"],
      "ts": "时间戳"
    }
  ]
}

## 约束
- 必须保留 original_refs 原文片段，禁止编造
- 拒绝无明确解答的问题(不要输出只有 question 没有 answer 的项)
- 时间戳保留原值，便于后续失效判断
- answerer 仅用脱敏后的 speaker 字段，不还原真实身份
- tags 从现有 SCHEMA.md 标签体系选取，不允许发明新标签
```

#### 5.2.3 输出处理

- 抽取输出 JSON 经 F-7 二次脱敏扫描
- 每个 qa_pair 写入 `qa/<slug>.md`，frontmatter `status: draft`、`source: qq-chat`、`confidence: medium` (借鉴 Hermes)
- 每个 solution 写入 `solutions/<slug>.md`，同上 frontmatter
- 不直接更新 index.md (待人工审核通过后由 compile 阶段更新)

### 5.3 环节3:体系化编译 (复用 + 扩展)

#### 5.3.1 SCHEMA.md 扩展

新增 `qa/` 与 `solutions/` 目录规范:

```markdown
## 页面类型 (扩展)
- qa: 业务问答页 (单问题 + 答案 + 适用场景 + 原文引用 + 失效时间)
- solution: 方案沉淀页 (背景 + 方案 + 步骤 + 注意事项 + 原文引用)

## frontmatter 扩展字段
- source: qq-chat (标识来源，便于过滤/清理)
- status: draft|published (draft 待审核，published 已审核)
- confidence: high|medium|low (借鉴 Hermes，QQ 来源默认 medium)
- contested: bool (是否有争议，借鉴 Hermes)
- original_refs: string[] (原文引用，RAG 证据约束)
- expires_at: YYYY-MM-DD (可选，业务方案时效性)
```

#### 5.3.2 VaultService 白名单扩展

修改 [vault-service.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/vault/vault-service.ts):
- `WRITE_ALLOWED_DIRS` 新增 `'qa', 'solutions'`
- `PAGE_DIRS` 同步扩展为 `['entities', 'concepts', 'comparisons', 'queries', 'qa', 'solutions']`

#### 5.3.3 复用 compileWorkflow

draft 页面作为 compile 输入，AI 组织为体系化页面:
- 建立 `[[相关概念]]`、`[[相关实体]]` 双向链接 (复用现有约束 ≥1)
- 合并重复 Q&A
- 标记 `status: published` 后更新 index.md

**CompileInput 适配**:draft 路径作为 `type: 'file'` 输入触发 compile (零接口改动)。compileWorkflow 读取 draft .md 文件 → 存档 raw → harness.run。draft 的 frontmatter (source/status/confidence/original_refs) 由 LLM 在 compile 阶段保留并补充双向链接。

**draft → published 状态机**:
1. 抽取阶段写入 draft 页面，`status: draft`
2. 人工审核:前端 Browse 视图按 `status: draft` 过滤，提供"发布"按钮
3. 点击"发布"触发 `/api/qq-ingest/compile/:draftPath`，compile 完成后 AI 将 `status` 改为 `published` 并更新 index.md
4. published 页面进入正常知识库流通 (query/graph/healthCheck)
5. 拒绝发布:人工删除 draft 文件或保留 draft 状态待后续处理

---

## 6. 接口需求

### 6.1 路由族 (新增 /api/qq-ingest/*)

| 方法 | 路径 | 功能 | 响应 |
|---|---|---|---|
| POST | /api/qq-ingest/upload | 上传 QQ 文件，触发预清洗 | SSE 流 (过滤/脱敏/存档进度) |
| GET | /api/qq-ingest/preview/:rawId | 预览清洗后中间格式 | JSON |
| POST | /api/qq-ingest/extract/:rawId | 触发价值抽取 | SSE 流 (LLM 步骤进度) |
| GET | /api/qq-ingest/drafts | 列出 draft 状态页面 | JSON |
| POST | /api/qq-ingest/compile/:draftPath | 触发单 draft 编译为正式页面 | SSE 流 (复用 compile 事件) |
| POST | /api/qq-ingest/compile/batch | 批量编译多个 draft | SSE 流 |

路由注册遵循项目硬约束:在 [index.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/index.ts) 显式 `registerQqIngestRoute`，避免 404。

### 6.2 配置扩展 (config.json → qq 字段)

```json
{
  "qq": {
    "noise_rules": {
      "NR-1": true,
      "NR-2": true,
      "NR-3": true,
      "NR-4": true,
      "NR-5": true,
      "NR-6": true
    },
    "privacy_patterns": {
      "phone": "1[3-9]\\d{9}",
      "id_card": "\\d{17}[\\dXx]",
      "email": "[\\w.-]+@[\\w.-]+\\.\\w+",
      "card": "\\d{16,19}",
      "qq": "(?<=QQ|扣扣|qq号|企鹅)\\s*[0-9]{5,11}"
    },
    "max_batch_size": 20,
    "chunk_threshold": 200,
    "extract_model": "glm-4-plus",
    "extract_token_budget": 50000
  }
}
```

**token 预算**:`extract_token_budget` 默认 50000，与全局 `budget.tokenBudget` 解耦。抽取阶段消耗 token 独立统计，便于成本核算与限流。若未配置则回退至全局 `budget.tokenBudget`。

在 [config.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/config.ts) 的 `defaultConfig()` 与 `AppConfig` 接口扩展 `qq` 字段，遵循现有 `saveXxxConfig` 范式新增 `saveQqConfig`。

### 6.3 类型扩展 (types.ts)

在 [types.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/types.ts) 新增:

```typescript
export interface QqConfig {
  noise_rules: Record<string, boolean>;
  privacy_patterns: Record<string, string>;
  max_batch_size: number;
  chunk_threshold: number;
  extract_model: string;
  extract_token_budget: number;
}

export interface QqPreprocessResult {
  rawId: string;
  meta: {
    chatName: string;
    dateRange: string;
    originalCount: number;
    filteredCount: number;
    redactedCount: number;
  };
  rawPath: string;
}

export interface QqExtractResult {
  qaPairs: QaPair[];
  solutions: QqSolution[];
}

export interface QaPair {
  question: string;
  answer: string;
  answerer: string;
  ts: string;
  context: string;
  original_refs: string[];
  tags: string[];
}

export interface QqSolution {
  title: string;
  background: string;
  steps: string[];
  caveats: string;
  original_refs: string[];
  ts: string;
}
```

`AppConfig` 接口扩展:`qq?: QqConfig`。

---

## 7. 非功能需求

### 7.1 性能

- 单文件预清洗 < 3s (10000 条消息内)
- 价值抽取 SSE 流式输出，首事件 < 5s
- 批量编译复用现有 withCompileLock 串行队列，避免 index.md/log.md 竞态

### 7.2 安全

- 路径越界:复用 `VaultService.resolve` 校验
- PII 脱敏:强制 + 双向 (输入 + 输出)
- LLM 写入边界:复用 `WRITE_ALLOWED_DIRS` 白名单
- 路径穿越:rawId 限 UUID 格式，draftPath 校验白名单目录

### 7.3 可维护性

- 配置驱动:所有规则在 config.json → qq 字段
- 目录约定:qq-ingest/ 子系统独立，不污染现有 compile 流水线
- 编码:UTF-8 无 BOM (项目硬约束)

### 7.4 可扩展性

- 输入格式:预清洗模块按格式分发器模式设计，新增微信/钉钉仅需新增 parser
- 脱敏规则:正则规则集配置化，后续可扩展 NER 模型适配器
- Schema 扩展:qa/、solutions/ 加入后，未来新增 cases/、playbooks/ 同范式

### 7.5 可靠性

- 预清洗失败:返回 400 + 错误明细，不污染 vault
- 抽取失败:复用 compile-workflow 的 draft 标记机制 (§12.3-6)
- 编译失败:复用现有 markPagesAsDraft + 断点续传

---

## 8. 风险与规避

| 风险 | 影响 | 规避措施 |
|---|---|---|
| QQ 导出格式多样 | 解析失败 | 优先 JSON，TXT 兜底;格式不识别返回 400 + 提示 |
| LLM 抽取质量不稳定 | 知识库噪声 | draft 状态 + 人工审核;prompt 迭代调优 |
| PII 残留 | 合规风险 | 双向脱敏 + 抽取输出二次扫描 |
| token 消耗过大 | 成本失控 | 复用 CompileCache;批量上限 max_batch_size=20 |
| QQ 来源页面污染主知识库 | 知识库混乱 | source: qq-chat 标识 + 前端按来源过滤 + cleanup 路由扩展清理 |
| 抽取无明确解答的问题 | 知识库被未解决问题污染 | prompt 约束拒绝输出无 answer 的项 |
| 时效性失效 | 旧方案误导 | frontmatter expires_at 字段 + healthCheck 扩展扫描 |
| Hermes 四坑 (raw 改动/SCHEMA 不定/路径不同步/单条 ingest) | 知识库损坏 | 项目硬约束已全部规避 (§2 竞品表) |

---

## 9. 验收标准

| ID | 验收项 | 验证方式 |
|---|---|---|
| AC-1 | 上传 .txt/.json 文件，预清洗输出中间格式 JSON | 单元测试 + 手工上传 |
| AC-2 | 中间格式 JSON 中无 PII 残留 (手机号/身份证/邮箱/银行卡) | 正则扫描中间格式 |
| AC-3 | 噪声过滤按配置生效，可关闭单条规则 | 配置变更 + 重新预处理 |
| AC-4 | 抽取输出 JSON 符合 Schema，含 original_refs | JSON Schema 校验 |
| AC-5 | draft 页面写入 qa/ 或 solutions/，frontmatter 完整 | 文件读取 + frontmatter 解析 |
| AC-6 | draft 页面经 compile 后，建立至少 1 条双向链接 | buildLinkGraph 验证 |
| AC-7 | 所有 QQ 来源页面 source: qq-chat | grep 扫描 |
| AC-8 | /api/qq-ingest/* 路由注册无 404 | curl 验证 |
| AC-9 | QQ 配置可在 Config.vue 编辑并持久化 | 前端操作 + config.json 读取 |
| AC-10 | Browse.vue 可按 source/status 过滤 | 前端操作验证 |

---

## 10. 里程碑 (概要)

| 里程碑 | 内容 |
|---|---|
| M1 | 预清洗模块 + 路由 + 单元测试 |
| M2 | 价值抽取 prompt + draft 写入 + 二次脱敏 |
| M3 | SCHEMA/VaultService 扩展 + compile 集成 |
| M4 | 前端 Ingest/Config/Browse 适配 |
| M5 | 端到端测试 + 小样本 (5-10 文件) 回归 |

注:本规格不含时间估算，遵循项目"避免时间预测"原则。

---

## 11. 术语表

| 术语 | 定义 |
|---|---|
| PII | Personally Identifiable Information，个人可识别信息 |
| NER | Named Entity Recognition，命名实体识别 |
| draft | 草稿状态页面，待人工审核 |
| compile | 编译，AI 将原始资料组织为体系化 Wiki 页面 |
| raw/ | 原始资料存档目录，不可变 |
| evidence constraint | 证据约束，LLM 输出必须基于原文引用 |

---

## 12. 附录

### 12.1 与现有架构的集成点

| 现有模块 | 集成方式 | 修改程度 |
|---|---|---|
| [compile-workflow.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/workflows/compile-workflow.ts) | 复用 compileWorkflow + bridgeHarnessToEvents | 无修改 |
| [vault-service.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/vault/vault-service.ts) | 扩展白名单 + PAGE_DIRS | 2 行修改 |
| [config.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/config.ts) | 扩展 defaultConfig + saveQqConfig | 新增 ~30 行 |
| [types.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/types.ts) | 新增 QqConfig/QqPreprocessResult 等 | 新增 ~50 行 |
| [index.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/index.ts) | 注册 registerQqIngestRoute | 1 行 |
| [compile.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/prompts/compile.md) | 新增 qq-extract.md (不动 compile.md) | 新增文件 |
| [health-check-fix-workflow.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/workflows/health-check-fix-workflow.ts) | 扫描范围同步扩展 qa/solutions (复用 PAGE_DIRS) | 0-2 行 (若硬编码 PAGE_DIRS 则改) |
| [cleanup.ts](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/routes/cleanup.ts) | raw_archive 清理支持按 source: qq-chat 过滤 | 新增 ~20 行 |
| [Ingest.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/views/Ingest.vue) | 新增 Tab | 新增 ~100 行 |
| [Config.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/views/Config.vue) | 新增 QQ 配置面板 | 新增 ~80 行 |
| [Browse.vue](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/frontend/src/views/Browse.vue) | 新增 source/status 过滤 + "发布"按钮 | 新增 ~50 行 |

### 12.2 不修改的现有模块

- compile.ts 路由主流程
- query.ts / query-workflow.ts
- health-check.ts 路由 (仅 health-check-fix-workflow.ts 同步 PAGE_DIRS)

---

文档结束。请配合 [REVIEW.md](file:///d:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/qq-ingest/REVIEW.md) 评审报告一并审阅。
