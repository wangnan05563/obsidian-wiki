# Karpathy-Wiki 数据清洗子系统 需求规格说明书 (SRS)

- 文档版本: v1.0
- 日期: 2026-07-25
- 状态: 评审中
- 适用项目: Karpathy-Wiki (karpathy-wiki/)
- 子系统位置: api/src/routes/data-clean.ts + frontend/src/views/DataClean.vue

---

## 1. 背景与目标

### 1.1 背景

Karpathy-Wiki 知识库已具备完整的数据采集成文流水线（原始资料上传 -> AI 编译 -> 体系化页面），在运行过程中暴露出以下严重数据质量问题：

**a) 搜索响应率极低**：系统共 45 条问答对话记录，仅 8 条获得有效回答（响应率 17.8%），39 条返回"知识库未覆盖此问题"或"搜索结果为空"。经分析，大量重复查询（同一问题被问了 36 次）和无效 raw/ 文件占用了搜索空间。

**b) 存储效率极低**：vault 总大小 165 MB，其中 raw/ 目录的巨型 PDF 提取文件占据 164.82 MB（99.9%），而有效知识内容仅 ~0.25 MB。单份 DB2 手册原文达 463,006 词（~1.8 MB），且 0 内部链接、无 frontmatter。

**c) 测试/临时文件混入正式库**：entities/ 中包含 40+ 个 	est-*.md 和 wiki-batch-* 前缀文件（proxy-test、批量导入中间件），这些文件本不应参与正式检索。

**d) 大量近空文件**：111 个正式页面中有 9 个不足 50 字（占比 8.1%），raw/ 中有 11 个接近空文件（< 20 词）。

**e) 编码不一致**：6 个文件带有 UTF-8 BOM，文件名中出现非 ASCII 字符及双下划线残留（如 HUI____________PDF__.md）。

**f) 跨分类重复**：4 个页名同时出现在 entities/ 和 concepts/ 中（batch-compile-test、supply-chain-commercial-paper-platform、中国票据业务系统直连接口规范、恒生电子）。

当前系统已有一套轻量清理机制（[cleanup.ts](file:///D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api/src/routes/cleanup.ts)），仅能按天数清理 .harness/ 下的缓存和日志，以及 ault/raw/input-*.md 归档。**不存在针对知识库页面质量本身的检查、去重、评分和修复机制。**

### 1.2 目标

新增数据清洗子系统，提供 **自动化 + 人工审核** 的知识库页面全生命周期质量管控：

| 目标 | 说明 |
|---|---|
| **T-1 质量扫描** | 对 vault 所有页面自动生成质量评分和报告 |
| **T-2 智能去重** | 基于文本相似度检测重复页面，提供合并建议 |
| **T-3 缺失修复** | 自动补全 missing frontmatter、生成摘要、建议链接补全 |
| **T-4 无效过滤** | 识别并归档零链接、极短、超大文件到待处理队列 |
| **T-5 入口预检** | 在 compile-workflow 中增加质量门控 -- 低于阈值的页面标记为 draft |
| **T-6 定期巡检** | 支持定时任务执行全量扫描 |

### 1.3 非目标

- 不替代现有 compile 工作流的核心逻辑（复用 VaultService 读写接口）
- 不做向量检索/RAG 升级（沿用现有全文检索）
- 不做 LLM 自动生成内容（AI 辅助仅限于质量分析和链接建议）
- 不修改现有 healthCheck 模块（体检报告与数据清洗健康报告分离）
- 不修改 Frontend/Vue 导航结构（作为独立视图 DataClean.vue 嵌入）

---

## 2. 现状数据基线

> 以下数据来自 2026-07-25 的实际仓库扫描结果。

| 指标 | 数值 |
|---|---|
| 正式页面总数（entities + concepts + comparisons） | 135（entities: 42, concepts: 89, comparisons: 4） |
| raw/ 未处理文件 | 168 |
| QA 对话记录 | 45 个 JSON 文件 |
| vault 总存储 | 165.07 MB |
| raw/ 占比 | 164.82 MB (99.8%) |
| 有效内容占比 | 0.25 MB (0.2%) |
| 搜索有响应率 | 17.8%（8/45） |
| 近空页面 (< 50 词） | 9 个 (8.1%) |
| 零内部链接页面 | 1 个正式页面 + 119 个 raw/批处理文件 |
| 缺失 YAML frontmatter 的正式页面 | 0 个（但 raw/ 中 > 70% 缺失） |
| 含 UTF-8 BOM 的文件 | 6 个 |
| 跨分类页名重复 | 4 对 |
| 相同标题的对话重复 | 36 条"什么是机器学习" + 5 条"什么是 LLM Wiki" |
| drafts/ 待审草稿 | 8 个 qa/solution |

### 2.1 典型问题页面示例

以下页面实际存在且属于高质量问题的典型代表：

| 文件路径 | 字数 | 链接数 | 问题代码 | 说明 |
|---|---|---|---|---|
| concepts/base-dto.md | ~84 词 | 3 链接 | --- | 合格页面 |
| concepts/BaseDto.md | ~43 词 | 2 链接 | SHORT_CONTENT | BaseDto 与 base-dto 重复命名 |
| concepts/dense-model.md | ~40 词 | 1 链接 | SHORT_CONTENT | 接近空内容 |
| entities/supply-chain-commercial-paper-platform.md | 28 词 | 0 链接 | SHORT_CONTENT+NO_LINKS | 几乎无用 |
| entities/hundsun.md | 48 词 | 3 链接 | SHORT_CONTENT | 恒生电子描述不足 |
| raw/input-1783483868485.md | 6 词 | 0 链接 | ALMOST_EMPTY | QQ 提取无效片段 |
| raw/wiki-batch-DB2-V5.0.md | 463,006 词 | 0 链接 | GIANT_FILE | DB2 手册原文无结构 |
| raw/wiki-batch-PDF-extract.pdf | 49,716 词 | 0 链接 | GIANT_FILE_NO_YAML | PDF 提取产物 |

### 2.2 对话质量基线

| 对话特征 | 数量 | 百分比 |
|---|---|---|
| 总对话数 | 45 | 100% |
| 有有效回答的对话 | 8 | 17.8% |
| 返回"知识库未覆盖此问题"的对话 | 39 | 86.7% |
| 同一问题重复查询（"什么是机器学习"） | 36 | 80.0% |
| 有 follow-up 追问的对话 | 10 | 22.2% |
| pinned 对话 | 0 | 0.0% |

---

## 3. 功能需求

### 3.1 用户故事

| ID | 角色 | 故事 | 优先级 |
|---|---|---|---|
| US-1 | 知识库管理员 | 我能在前端一键触发全量质量扫描，看到每个页面的质量评分 | P0 |
| US-2 | 知识库管理员 | 我能看到重复页面检测结果，选择两个重复页面进行合并 | P0 |
| US-3 | 知识库管理员 | 扫描完成后，我收到质量报告：包含低分页面列表、零链接页面、超大文件警告 | P0 |
| US-4 | 知识库管理员 | 对于 missing frontmatter 的文件，我可以点击"修复"，系统自动生成结构化元数据 | P1 |
| US-5 | 知识库管理员 | 对于零链接页面，系统会推荐可能的关联页面（基于关键词/同目录文件） | P1 |
| US-6 | 知识库管理员 | 对于 raw/ 中的巨型 PDF 提取文件，我可以一键生成摘要版并删除原文 | P0 |
| US-7 | 知识库管理员 | 测试/临时文件可以批量标记为"归档"，从正式页面目录移至 archive/YYYY-MM-DD/ | P1 |
| US-8 | 知识库管理员 | 编译流水线增加质量门控 -- 新页面若低于阈值自动标记为 draft | P2 |
| US-9 | 知识库管理员 | 我可以通过 /api/data-clean/schedule 配置定期扫描（cron 表达式或固定间隔） | P2 |
| US-10 | 隐私合规官 | 清洗过程自动跳过 status: draft 待审文件，不影响人工审核流程 | P0 |

### 3.2 功能清单

| ID | 功能 | 详细说明 | 优先级 |
|---|---|---|---|
| F-1 | 质量扫描引擎 | 扫描 vault/ 所有目录，计算每个文件的 6 维度质量分 | P0 |
| F-2 | 去重检测 | 基于 shingle-based minhash 检测语义/文本重复页面 | P0 |
| F-3 | 质量报告 API | GET /api/data-clean/report 返回聚合报告 + 明细列表 | P0 |
| F-4 | 前端 Dashboard | DataClean.vue 展示质量分布图、低分页面排序 | P0 |
| F-5 | frontmatter 修复 | 读取页面内容，自动生成 title/type/tags/frontmatter | P1 |
| F-6 | 链接补全建议 | 基于关键词匹配推荐关联页面 | P1 |
| F-7 | 超级文件压缩 | 对 >10000 词的文件生成摘要并保留原文链接 | P0 |
| F-8 | 批量归档操作 | 将低质量/测试文件移动到 archive/YYYY-MM-DD/ 目录 | P0 |
| F-9 | 编译前预检 | POST /api/data-clean/precheck 在 compile 前拦截低质量页面 | P2 |
| F-10 | 定期调度器 | 调用 node-cron 执行定时扫描 | P2 |

### 3.3 质量评分模型

每个页面计算一个 **Quality Score (0-100)**，由以下 6 个维度加权求和：

| 维度 | 权重 | 计算公式 | 说明 |
|---|---|---|---|
| 内容长度 | 20% | min(100, wordCount / 10) | 理想 100+ 词，0 词得 0 分 |
| 内部链接 | 25% | min(100, linkCount * 25) | 0 链接 = 0 分，每多一条链接 +25 分 |
| frontmatter 完整性 | 20% | hasTitle?10 + hasType?10 + hasTags?5 + hasUpdated?5 | YAML 字段检查 |
| 引用次数 | 15% | min(100, inboundLinkCount * 10) | 其他页面引用该页面的次数 |
| 重复度 | 10% | max(0, 100 - duplicateScore) | 0 = 无重复，100 = 完全重复 |
| 新鲜度 | 10% | max(0, 100 - daysSinceLastModified / 365 * 100) | 超过 1 年未更新扣分 |

**分级标准**：

| 等级 | 分数范围 | 颜色标识 | 动作 |
|---|---|---|---|
| Excellent | 80-100 | 绿色 | 无需干预 |
| Good | 60-79 | 蓝色 | 建议优化 |
| NeedsWork | 40-59 | 黄色 | 需关注 |
| Poor | 20-39 | 橙色 | 建议编辑 |
| Critical | 0-19 | 红色 | 需立即处理或归档 |

---

## 4. API 设计

### 4.1 RESTful 端点

| 方法 | 路径 | 说明 | 优先级 |
|---|---|---|---|
| GET | /api/data-clean/report | 获取全量质量报告（聚合+明细） | P0 |
| GET | /api/data-clean/pages | 列出所有页面及其质量分（分页+过滤） | P0 |
| POST | /api/data-clean/deduplicate | 执行去重检测，返回可疑重复对 | P0 |
| POST | /api/data-clean/fix-frontmatter | 批量修复缺失 frontmatter | P1 |
| POST | /api/data-clean/summarize-large | 对超大文件生成摘要 | P0 |
| POST | /api/data-clean/archive | 批量归档文件到 archive/YYYY-MM-DD/ | P0 |
| GET | /api/data-clean/suggest-links | 获取某页面推荐的关联页面 | P1 |
| POST | /api/data-clean/precheck | 编译前质量门控拦截 | P2 |
| GET | /api/data-clean/schedule | 查看/配置定期扫描 | P2 |
| POST | /api/data-clean/schedule/:id | 启动/停止定期扫描任务 | P2 |

### 4.2 请求/响应类型定义（API 层 types.ts 扩展）

#### 4.2.1 PageQualityScore — 单页面质量评分

TypeScript interface for page quality scoring:

\\	ypescript
export interface PageQualityScore {
  path: string;                  // vault/ 内相对路径,如 concepts/llm.md
  title: string;                 // 页面标题(从 frontmatter 或文件名提取)
  qualityScore: number;          // 总分 0-100
  category: {
    length: number;              // 0-100 分量: 内容长度
    links: number;               // 0-100 分量: 内部链接数
    frontmatter: number;         // 0-100 分量: YAML 完整性
    citations: number;           // 0-100 分量: 被引用次数
    duplicate: number;           // 0-100 分量: 重复度惩罚
    freshness: number;           // 0-100 分量: 更新时效性
  };
  metadata: {
    wordCount: number;           // 全文词数（中英文分别统计）
    lineCount: number;           // 行数
    internalLinks: number;       // [[wiki-link]] 链接数
    inboundLinks: number;        // 其他页面引用此页面的次数
    lastModified: string;        // ISO8601 最后修改时间
    hasFrontmatter: boolean;
    isDraft: boolean;            // status=draft 则 true
    fileSizeBytes: number;
    hasBom: boolean;             // UTF-8 BOM 标记检查
    encoding: 'utf-8' | 'gbk' | 'unknown';
    directory: string;           // entities|concepts|comparisons|queries|raw|drafts
  };
  issues: Array<{
    code: string;                // SHORT_CONTENT, NO_LINKS, MISSING_YAML, LARGE_FILE, HAS_BOM, DUPLICATE, CROSS_CATEGORY_DUP
    severity: 'info' | 'warning' | 'error';
    detail: string;
    suggestion?: string;
  }>;
  suggestions: Array<{
    type: 'link_suggestion' | 'content_expand' | 'merge_duplicate' | 'summarize_large';
    detail: string;
    actionable: boolean;
  }>;
}
\
#### 4.2.2 DuplicatePair — 疑似重复页面对

\\	ypescript
export interface DuplicatePair {
  pageA: PageQualityScore;       // 重复对中的第一个页面
  pageB: PageQualityScore;       // 重复对中的第二个页面
  similarity: number;            // 0.0 - 1.0,基于内容相似度
  matchType: 'exact' | 'near-duplicate' | 'semantic-similar';
  reason: string;                // 为何判定为重复的说明
}
\
#### 4.2.3 DataCleanReport — 质量报告完整结构

\\	ypescript
export interface DataCleanReport {
  generatedAt: string;           // ISO8601 报告生成时间
  summary: {
    totalPages: number;          // 正式页面总数（不含 raw/）
    totalPagesRaw: number;       // 含 raw/ 目录
    avgQualityScore: number;     // 平均质量分
    scoreDistribution: {
      excellent: number;         // 80-100 分数量
      good: number;              // 60-79
      needsWork: number;         // 40-59
      poor: number;              // 20-39
      critical: number;          // 0-19
    };
    topIssues: Array<{
      code: string;
      count: number;
      impact: string;            // 简要影响描述
    }>;
    estimatedStorageSavingsMb: number;  // 归档后可释放的存储预估
  };
  pages: PageQualityScore[];     // 按 qualityScore 升序排列（最低分优先展示）
  duplicates: DuplicatePair[];   // 疑似重复页面对列表
}
\
#### 4.2.4 ReportRequest — 质量报告请求参数

\\	ypescript
export interface ReportRequest {
  directory?: string;            // 按目录过滤：entities|concepts|comparisons|queries|raw|all
  minScore?: number;             // 只显示 >= 此分的页面
  sortBy?: 'score' | 'wordCount' | 'lastModified' | 'directory';
  sortOrder?: 'asc' | 'desc';
  limit?: number;                // 最大返回条数（默认 200）
  offset?: number;               // 分页偏移
}
\
#### 4.2.5 DeduplicateResult — 去重检测结果

\\	ypescript
export interface DeduplicateResult {
  matches: DuplicatePair[];      // 检测到的疑似重复对
  scannedPages: number;          // 扫描页数
  uniquePages: number;           // 去重后唯一页面数
  duplicateGroups: Array<{
    pages: string[];             // 同一组的页面路径数组
    representativePath: string;  // 推荐的保留路径
    totalWordsInGroup: number;   // 可节省的冗余字数
  }>;
}
\
#### 4.2.6 FixFrontmatterResult — frontmatter 修复结果

\\	ypescript
export interface FixFrontmatterResult {
  fixed: Array<{
    path: string;
    addedFields: string[];       // 新增的 frontmatter 字段名
    confidence: 'high' | 'medium' | 'low';  // LLM 推断置信度
    preview?: string;            // 预览新生成的 frontmatter
  }>;
  errors: Array<{ path: string; error: string }>;
  dryRun: boolean;
}
\
#### 4.2.7 SummarizeLargeFileResult — 超大文件摘要

\\	ypescript
export interface SummarizeLargeFileResult {
  originalPath: string;          // 源文件路径
  originalSize: number;          // 原文件大小(字节)
  originalWordCount: number;     // 原文词数
  summaryPath: string;           // 生成的摘要文件路径
  summarySize: number;           // 摘要文件大小(字节)
  summaryWordCount: number;      // 摘要词数
  keyTopics: string[];           // 提取的关键主题
  storageSavedBytes: number;     // 释放的存储空间
  movedToArchive: boolean;       // 是否已移至归档
}
\
#### 4.2.8 ArchiveResult — 批量归档结果

\\	ypescript
export interface ArchiveResult {
  archived: Array<{
    from: string;                // 源路径
    to: string;                  // 目标路径
    sizeFreed: number;           // 释放空间(字节)
  }>;
  errors: Array<{ from: string; error: string }>;
  archiveDirectory: string;      // 归档目录,如 archive/2026-07-25/
}
\
#### 4.2.9 LinkSuggestions — 链接建议

\\	ypescript
export interface LinkSuggestions {
  targetPage: string;            // 目标页面路径
  suggestedLinks: Array<{
    targetPath: string;          // 建议链接的目标页面
    reason: string;              // 为什么建议此链接
    overlapKeywords: string[];   // 重叠关键词
  }>;
  orphanPage: boolean;           // 是否为孤立页面（无任何链接）
}
\
#### 4.2.10 PrecheckResult — 编译前预检结果

\\	ypescript
export interface PrecheckResult {
  passed: boolean;               // 是否通过预检
  blockedPages: Array<{
    path: string;
    reason: string;
    currentScore?: number;
  }>;
  warningPages: Array<{
    path: string;
    reason: string;
    currentScore?: number;
  }>;
  recommendedActions: string[];  // 建议的操作（编辑/补充/跳过）
}
\
#### 4.2.11 ScheduleConfig/ScheduleListResponse — 定期调度器

\\	ypescript
export interface ScheduleConfig {
  id: string;                    // 唯一 ID
  enabled: boolean;
  cronExpression: string;        // cron 表达式,如 '0 2 * * 1'(每周一凌晨2点)
  lastRunAt?: string;            // 上次执行时间
  nextRunAt?: string;            // 下次执行时间
  lastRunDurationMs?: number;    // 上次执行耗时(ms)
  reportPath?: string;           // 生成的报告保存路径
}
export interface ScheduleListResponse {
  schedules: ScheduleConfig[];
}
\---

## 5. 非功能性需求

### 5.1 性能要求

| 指标 | 目标值 | 说明 |
|---|---|---|
| 全量扫描耗时 | < 30 秒 | 覆盖 135 正式页面 + 168 raw/文件 |
| 报告生成耗时 | < 5 秒 | GET /api/data-clean/report 响应时间 |
| 去重检测耗时 | < 60 秒 | 基于 minhash 的全文相似度计算 |
| 页面 API 查询 | < 200 ms | GET /api/data-clean/pages (带分页时) |
| 前端渲染 | < 1 秒 | DataClean.vue 加载 + 图表渲染 |

**为什么合理**：当前 search-util.ts 扫描 135 个正式页面的搜索操作在现有系统中已验证可行（毫秒级）。raw/ 目录的文件多数是巨型 PDF 提取文本，跳过其全文分析仅检查元数据（文件大小、行数、BOM）即可大幅降低 IO 开销。

### 5.2 安全要求

- **写入路径白名单**：复用现有 VaultService 的 WRITE_ALLOWED_DIRS（entities/concepts/comparisons/queries/drafts/raw），禁止修改 SCHEMA.md
- **Dry-run 默认**：所有 destructive 操作（archive/delete）必须 dry_run=true 作为默认值，用户手动切换为 false 才实际执行
- **审计日志**：所有写操作（修复 frontmatter、归档、删除）追加记录到 .harness/data-clean-audit.log，JSONL 格式
- **并发保护**：质量门控 precheck 期间锁定对应页面防止并行 compile 修改（参考 session-lock.ts 模式）

### 5.3 可靠性

- **幂等性**：重复执行质量扫描不产生额外副作用（分数计算确定性）
- **回滚能力**：每次 archive 操作前在 archive/YYYY-MM-DD/{action-date}/backup/ 中保存完整副本
- **失败容错**：单文件处理失败不影响其他文件的扫描结果（独立 try/catch，errors[] 收集）

### 5.4 可扩展性

- **模块化评分插件**：每个质量维度可独立扩展（新增自定义 check 函数注册到评分管道）
- **模板化规则**：frontmatter 修复逻辑使用 prompt 模板（类似 compile.md），支持热更新

---

## 6. 集成点

### 6.1 与现有组件的关系

`
[Upload/Ingest] → [data-clean/precheck] → [compile-workflow] → [published pages]
      ↓                          ↓                      ↓
   [raw/archive/]          [quality report]       [Frontend DataClean.vue]
      ↓
[data-clean/deduplicate] → [merge/reject decisions]
`

| 模块 | 关系 | 说明 |
|---|---|---|
| ault-service.ts | 底层读写 | 数据清洗通过 VaultService 接口读写页面，遵循相同白名单约束 |
| cleanup.ts | 互补职责 | cleanup.ts 管存储生命周期（缓存/日志/按天归档），data-clean 管**内容质量**（评分/去重/修复） |
| search-util.ts | 消费方 | 质量报告优化后直接提升 searchPages() 的结果相关性 |
| compile-workflow.ts | 调用方 | precheck API 可在编译前拦截低质量 draft |
| health-check-fix-workflow.ts | 协同方 | healthCheck 发现的悬空链接 brokenLinks 可交给 data-clean 修复 |
| qq-ingest | 上游输入 | QQ 聊天记录抽取后生成的 draft，可通过 data-clean 预检确保基础质量再发布 |
| url-crawl | 上游输入 | URL 爬取产生的 markdown 文件入库前经 precheck 过滤 |

### 6.2 Frontend 集成

DataClean.vue 作为新视图嵌入现有 App.vue 导航系统，添加 menuItems 配置项：

`	ypescript
{ key: 'dataclean', icon: 'dashboard', label: '数据清洗', permission: 'dataclean' }
`

UI 设计参考现有 Cleanup.vue 风格：
- Element Plus 组件库（ElMessage, ElMessageBox, ElStatistic, ElDescriptions）
- Glass-card 霓虹主题样式（沿用 .style.css 中的 var(--*) 变量）
- 质量评分使用 el-progress 环形组件展示
- 低分页面列表使用 el-table 展示，支持排序和筛选

---

## 7. 风险与规避

### 7.1 风险评估矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| 误删重要资料 | 低 | 严重 | 归档前必须 dry-run + 人工确认；保留完整 backup |
| 重复检测误报 | 中 | 中等 | 提供相似度阈值可调（默认 0.85）+ LLM 辅助确认 |
| LLM 成本过高 | 中 | 中等 | 批量处理 + token budget 限制；超大文件仅摘要不全文分析 |
| 扫描期间服务不可用 | 低 | 中等 | 异步 SSE 推送进度，前端轮询；不影响正在进行的问答 |
| frontmatter 自动生成错误 | 中 | 低 | 修复操作始终 dry-run first，预览后确认 |

### 7.2 具体规避方案

#### 误删资料规避
`
archive/
└── 2026-07-25/
    ├── dry-run-preview/     # 预览模式显示的文件列表
    ├── confirmed-delete/    # 用户确认要删除的文件备份
    └── actual-deleted/      # 实际执行后文件的最终备份
`
**流程**：扫描发现 → 列出候选 → dry-run 预览 → 人工确认 → 备份 → 移动/删除 → 审计日志记录

#### LLM 成本控制
- 只对 < 5000 词的文件进行全文语义分析（minhash shingle size=5）
- 超大文件（> 50K 词）仅做结构抽样（每 N 行采样一次）
- 去重比较使用标题+首段前 500 词作为指纹，而非全文

---

## 8. 里程碑与实施计划

### Phase 1: P0 — 核心扫描与报告（预计 Week 1-2）

| 任务 | 工作量 | 产出 |
|---|---|---|
| 开发 PageQualityScore 计算引擎 | 1.5 天 | api/src/data-clean/scanner.ts |
| 实现 REST API 端点 | 1 天 | report, pages, deduplicate |
| 实现 DataClean.vue 前端 | 1.5 天 | 质量分布图、低分页面列表、筛选排序 |
| 集成到 App.vue 导航 | 0.5 天 | 新菜单项 |
| 端到端测试 | 1 天 | 通过验收标准 |

### Phase 2: P0/P1 — 修复与归档操作（预计 Week 2-3）

| 任务 | 工作量 | 产出 |
|---|---|---|
| implement fix-frontmatter | 1 天 | LLM-assisted frontmatter generation |
| implement summarize-large | 1.5 天 | Chunk-based summarization for >10K word files |
| implement archive batch operation | 1 天 | archive/YYYY-MM-DD/ structure with audit log |
| 前端增强 | 1 天 | action buttons on low-score pages |

### Phase 3: P2 — 预检与定期调度（预计 Week 3-4）

| 任务 | 工作量 | 产出 |
|---|---|---|
| implement precheck API | 1 天 | compile-workflow integration hook |
| implement schedule config | 1 天 | node-cron scheduler for periodic scans |
| 定期扫描报告持久化 | 0.5 天 | report files in docs/data-cleaning-reports/ |

### 总工作量估算：~15 人天（3-4 周）

---

## 9. 验收标准

### 9.1 功能验收

- [ ] F-1 质量扫描引擎：扫描 135 正式页面 + 168 raw/文件，30 秒内完成，输出 PageQualityScore 数组
- [ ] F-2 去重检测：正确识别 out entities/concepts 中 4 对跨分类重复页名
- [ ] F-3 质量报告 API：返回 DataCleanReport 包含 scoreDistribution + topIssues + estimatedStorageSavingsMb
- [ ] F-4 前端 Dashboard：展示质量等级分布饼图 + 低分页面列表 + 支持目录筛选
- [ ] F-6 超级文件压缩：对 DB2 手册（463K 词）生成 < 2000 词的摘要，保留原文至 archive/
- [ ] F-8 批量归档：test-document-*.md 共 ~19 个文件成功移动到 archive/YYYY-MM-DD/test-files/
- [ ] US-10 清洗过程自动跳过 status=draft 文件

### 9.2 性能验收

- [ ] GET /api/data-clean/pages 响应 < 200ms（含分页参数）
- [ ] 首次全量扫描 < 30 秒
- [ ] 前端页面加载 < 1 秒（含图表渲染）

### 9.3 安全验收

- [ ] dry_run=true 为所有写操作默认值
- [ ] 写操作仅允许 WRITE_ALLOWED_DIRS 内的目录
- [ ] 每次归档操作都有 .harness/data-clean-audit.log 审计条目
- [ ] 归档文件可在 archive/YYYY-MM-DD/backup/ 中找到完整副本

---

## 10. 里程碑

| 阶段 | 时间 | 交付物 |
|---|---|---|
| M0: 评审通过 | 第 1 周初 | 本 SRS 文档评审签字 |
| M1: 核心扫描+API | 第 2 周末 | scanner.ts + report API + basic UI |
| M2: 修复+归档 | 第 3 周末 | fix-frontmatter + summarize-large + archive |
| M3: 预检+调度 | 第 4 周末 | precheck integration + scheduled scan |
| M4: 生产上线 | 第 5 周初 | 全量运行 1 周无异常后灰度发布 |
---

## 11. 术语表

| 术语 | 定义 |
|---|---|
| Quality Score | 0-100 的页面质量综合评分，由 6 个维度加权计算 |
| Raw Archive | vault/raw/ 中的未处理原始资料（PDF 提取、QQ 聊天记录等） |
| Draft Status | frontmatter 中 status=draft 标记，表示待人工审核状态 |
| Compile Pipeline | 将原始资料通过 LLM 编译为体系化页面的流水线 |
| Vault Directory | data/vault/ 下的正式知识库存储目录 |
| Frontmatter | YAML 格式的文件头部元数据块（标题、类型、标签等） |
| Shingle-based Minhash | 基于文本 n-gram 集合的近似重复检测算法 |
| Inbound Link | 其他页面通过 [[wiki-link]] 引用当前页面的链接数 |
| Outbound Link | 当前页面引用其他页面的 [[wiki-link]] 数量 |
| Orphan Page | internalLinks=0 且 inboundLinks=0 的孤立页面 |
| GIANT_FILE | wordCount > 10,000 的超大文件，需生成摘要 |
| SHORT_CONTENT | wordCount < 50 的近空页面 |
| DRY_RUN | 预览模式：列出操作但不实际执行 |

---

## 12. 附录

### 附录 A：现有页面 Schema 规范

来自 [vault/SCHEMA.md](file:///D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/data/vault/SCHEMA.md)：

`yaml
# 页面类型
- entity: 实体页（人/物/项目）
- concept: 概念页（方法/理论/技术）
- comparison: 对比页（多实体/多概念对照）
- query: 归档的高价值问答
- qa: 业务问答页（QQ 聊天记录抽取）
- solution: 方案沉淀页（QQ 聊天记录抽取）

# frontmatter 必填字段
---
title: 页面标题
type: entity|concept|comparison|query|qa|solution
created: YYYY-MM-DD
updated: YYYY-MM-DD
source: 原始资料来源
tags: [tag1, tag2]
---

# QQ 导入扩展字段
---
status: draft|published
confidence: high|medium|low
contested: false
original_refs: ["原文片段1", "原文片段2"]
expires_at: YYYY-MM-DD
answerer: 昵称
ts: ISO8601
---

# 双向链接约定
- 每个页面至少包含 1 条双向链接
- 使用 [[页面名]] 格式
- 文件名与页面名一致（如 [[llm-wiki]] → concepts/llm-wiki.md）
`

### 附录 B：扫描中发现的低质量页面明细（raw/ 示例）

以下为 raw/ 目录中发现的有问题的典型文件：

| 文件名 | 字数 | 有无 YAML | 有链接? | 问题类别 |
|---|---|---|---|---|
| input-1783483868485.md | 6 词 | 否 | 否 | ALMOST_EMPTY |
| input-1783483802520.md | 6 词 | 否 | 否 | ALMOST_EMPTY |
| wiki-batch-proxy-test1.md | 9 词 | 否 | 否 | ALMOST_EMPTY |
| wiki-batch-proxy-test2.md | 10 词 | 否 | 否 | ALMOST_EMPTY |
| HUNDSUN_V5.0-_DB2_______-20220706.md | 463,006 | 否 | 否 | GIANT_FILE_NO_YAML |
| HUNDSUN_V5.0-_MYSQL_______-20220706.md | 462,411 | 否 | 否 | GIANT_FILE_NO_YAML |
| HUNDSUN_V5.0-_ORACLE_______-20220706.md | 462,411 | 否 | 否 | GIANT_FILE_NO_YAML |
| test-document-1.md | 111 词 | 是 | 3 链接 | TEST_FILE_IN_FORMAL_DIR |

### 附录 C：Storage Impact 详细计算

`
┌───────────────────────────────┬─────────────┬──────────────┐
│ Category                      │ Current MB  │ Post-Cleanup MB │
├───────────────────────────────┼─────────────┼──────────────┤
│ Formal pages (entities+)      │     0.25    │     0.25     │
│ Test files in entities/       │     ~0.01   │     0.00     │
│ drafts/ (8 files)             │     ~0.01   │     ~0.01    │
│ raw/ small files (< 500 words)│     ~0.02   │     ~0.00    │
│ raw/ giant PDF extractions    │    164.82   │     ~0.50    │
│ raw/ backup archive           │     N/A     │     ~5.00    │
├───────────────────────────────┼─────────────┼──────────────┤
│ TOTAL                         │    165.11   │     ~5.76    │
│ SAVINGS                       │             │    ~159.35 MB │
│ % SAVED                       │             │    96.5%     │
└───────────────────────────────┴─────────────┴──────────────┘

Note: Post-cleanup assumes giant PDF files are replaced by ~2K-word summaries each.
Archive copies retained separately for disaster recovery.
`

### 附录 D：现有相关代码参考路径

| 模块 | 文件路径 | 用途 |
|---|---|---|
| VaultService | api/src/vault/vault-service.ts | 页面读写接口、白名单校验 |
| Cleanup Route | api/src/routes/cleanup.ts | 现有缓存/日志清理逻辑 |
| Search Util | api/src/search-util.ts | 全文检索核心函数 searchPages() |
| Compile Workflow | api/src/workflows/compile-workflow.ts | AI 编译流水线入口 |
| Health Check Fix | api/src/workflows/health-check-fix-workflow.ts | 健康体检+修复流程 |
| Frontend Cleanup | frontend/src/views/Cleanup.vue | UI 参考模板（Element Plus + glass-card） |
| Frontend Types | frontend/src/types.ts | API 类型定义（本 SRS 新增类型需追加至此文件） |
| App Navigation | frontend/src/App.vue | menuItems 配置（新增 dataclean tab 需在此注册） |
| Frontend API | frontend/src/utils/apiError.ts | 统一错误处理工具 |
| Encoding Checker | scripts/check-encoding.js | GBK→UTF-8 编码检测已有工具 |
'| SCHEMA.md | data/vault/SCHEMA.md | 页面规范声明 |
