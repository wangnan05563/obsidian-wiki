# 数据清洗仪表板使用指南

**版本**: v1.0  
**日期**: 2026-07-26  
**适用对象**: 系统管理员、知识库维护人员  

---

## 目录

1. [概述](#1-概述)
2. [访问仪表板](#2-访问仪表板)
3. [功能模块](#3-功能模块)
   - [3.1 页面质量扫描](#31-页面质量扫描)
   - [3.2 编译前预检](#32-编译前预检)
   - [3.3 重复检测与合并](#33-重复检测与合并)
   - [3.4 Frontmatter 修复](#34-frontmatter-修复)
   - [3.5 批量归档](#35-批量归档)
   - [3.6 永久删除](#36-永久删除)
   - [3.7 定期调度](#37-定期调度)
4. [REST API 参考](#4-rest-api-参考)
5. [最佳实践](#5-最佳实践)
6. [故障排查](#6-故障排查)
7. [安全须知](#7-安全须知)

---

## 1. 概述

Karpathy-Wiki 数据清洗子系统提供一套可视化的仪表板（DataClean.vue），帮助管理员：

- **评估**知识库页面质量，发现低质量、缺失元数据的文件
- **检测**重复或高度相似的页面对
- **修复** frontmatter 元数据缺失问题
- **归档**不再活跃使用的历史页面
- **删除**确认无用的临时文件
- **预检**编译前的完整性检查
- **自动调度**定期的质量扫描任务

所有写操作（归档、删除、合并、修复）**默认以 dry-run 模式执行**，不会修改任何文件。仅在确认无误后开启正式操作。

---

## 2. 访问仪表板

### 前提条件

- Karpathy-Wiki 服务已启动（API 和前端）
- 管理员角色（cleanup 权限）

### 操作步骤

1. 登录 Karpathy-Wiki 管理界面
2. 在顶部导航栏找到 **「数据清洗」** 菜单项（位于"技能管理"和"帮助文档"之间）
3. 点击该菜单项，进入 DataClean.vue 仪表板

---

## 3. 功能模块

### 3.1 页面质量扫描

这是最常用的核心功能，用于全面评估知识库中所有页面的质量状况。

#### 如何操作

1. 在仪表板顶部点击 **「🔄 刷新」** 按钮
2. 扫描引擎会自动遍历 entities/、concepts/、comparisons/ 三个目录下的所有 .md 文件
3. 扫描完成后，页面会以表格形式展示，包含：
   - 文件路径
   - 页面标题
   - 质量评分（0–100）
   - 字数统计
   - 内部链接数量
   - 是否包含有效 frontmatter
4. 状态指示器显示：
   - 🟢 **Has FM** — 包含有效的 frontmatter
   - 🔴 **No FM** — 缺失 frontmatter，需要修复

#### 质量评分规则

| 维度 | 满分 | 说明 |
|------|------|------|
| 内容长度 | 20分 | 每10个单词计1分（上限20） |
| 内部链接 | 25分 | 每个 [[wikilink]] 计25分（上限25） |
| Frontmatter | 25分 | 包含 type + title 即得25分 |
| 引用/认证 | 20分 | 预留接口，用于外部引用检测 |
| 重复率 | 0分 | 由去重模块补充更新 |
| 新鲜度 | 10分 | 基于最后修改时间的权重 |

#### 解读评分等级

| 分数范围 | 等级 | 颜色 | 建议操作 |
|----------|------|------|----------|
| 80–100 | 优秀 (Excellent) | 🟢 绿色 | 无需处理 |
| 60–79 | 良好 (Good) | 🔵 蓝色 | 可优化但非必须 |
| 40–59 | 待改进 (Needs Work) | 🟠 橙色 | 建议检查并补充信息 |
| <40 | 较差 (Poor) | 🔴 红色 | 优先处理：缺失 frontmatter、内容过短等 |

---

### 3.2 编译前预检

在执行知识库编译之前，运行预检可以确保没有严重问题会影响编译流程。

#### 如何操作

1. 点击工具栏中的 **「Precheck」** 按钮
2. 预检将检查以下项目：
   - 所有文件的 YAML frontmatter 语法有效性
   - 内部链接 [[target]] 是否指向存在的页面
   - 文件的 UTF-8 BOM 标记问题
3. 结果以 Alert 框展示：
   - **PASSED**：所有检查通过
   - **ISSUES FOUND**：列出错误数和警告数

#### 注意事项

- 预检是只读操作，不会修改任何文件
- 如果发现 frontmatter 解析失败，会在编译时直接报错
- 未解析的链接仅作为警告，不影响编译

---

### 3.3 重复检测与合并

#### 重复检测

1. 点击 **「Dedup」** 按钮启动去重检测
2. 系统比较所有页面的标题和内容，识别高度相似的页面对
3. 检测结果以 Warning 卡片列表展示，每条包含：
   - 两个页面的标题对比
   - 相似度百分比
   - 匹配原因说明

#### 合并操作

对于确认需要合并的重复页面：

1. 在重复检测结果的对应卡片旁点击 **「Merge into [页面名]」** 按钮
2. 确认对话框中预览合并操作的影响
3. 确认合并后：
   - **保留**高质量页面（质量分较高的一方）
   - **合并**低质量页面的 frontmatter 和正文到高质量页面
   - **自动更新**高质量页面内的内部链接，将指向低质量页面的 [[引用]] 改为指向高质量页面
   - **归档**低质量页面到 rchive/YYYY-MM-DD/ 目录

#### 合并后的内容结构

合并后的高质量标准页面内容格式如下：

`markdown
---
title: "主页面标题"
type: entity
# ...其他 frontmatter...
---

# 主内容...

---
## Merged from 被合并页面标题

# 被合并页面的内容...
`

---

### 3.4 Frontmatter 修复

当批量页面缺少规范的 frontmatter 时，使用此功能自动补充。

#### 如何操作

1. 在质量扫描表中勾选需要修复的文件（支持多选）
2. 点击工具栏中的 **「Fix Frontmatter」** 按钮
3. 系统将按以下规则补充缺失字段：

| 字段 | 取值规则 |
|------|----------|
| 	itle | 从 H1 标题提取；若无则用文件名 |
| 	ype | 根据所在目录映射：entities→entity, concepts→concept, comparisons→comparison |
| updated | 当前日期 |
| created | 与 updated 相同 |
| 	ags | 空数组（后续手动补充） |
| source | 文件相对路径 |

4. 修复过程会记录到审计日志 .harness/data-clean-audit.log

---

### 3.5 批量归档

将不活跃页面移入归档目录。归档不是删除——文件保存在 rchive/YYYY-MM-DD/ 下，可随时恢复。

#### 如何操作

1. 在扫描结果中勾选要归档的文件
2. 点击 **「Archive」** 按钮
3. 在确认对话框中点击 **「Archive」** 确认
4. 文件被移动到日期命名的子目录中
5. 归档操作不可撤销（除非手动从 archive 目录移回原位置）

#### 归档路径示例

`
archive/
├── 2026-07-26/
│   ├── old-entity.md
│   └── duplicate-concept.md
└── 2026-07-25/
    └── obsolete-comparison.md
`

---

### 3.6 永久删除

直接从文件系统中删除文件。**此操作不可恢复**，请谨慎使用。

#### 如何操作

通过 REST API 调用（仪表板暂未内置删除按钮以防误操作）：

`ash
curl -X DELETE http://localhost:3000/api/data-clean/delete \
  -H 'Content-Type: application/json' \
  -d '{"files": ["concepts/obsolete.md"], "dry_run": false}'
`

#### 安全机制

- 默认 dry_run=true，只输出将要删除的文件名
- 必须显式设置 dry_run=false 才真正删除

---

### 3.7 定期调度

配置自动的质量扫描计划，无需人工干预即可保持知识库健康。

#### 创建调度

通过 REST API：

`ash
curl -X POST http://localhost:3000/api/data-clean/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "cron": "every 6 hours",
    "enabled": true
  }'
`

#### 支持的 cron 表达式

| 格式 | 示例 | 说明 |
|------|------|------|
| every N min | every 30 min | 每 N 分钟执行一次 |
| every N hour | every 6 hour | 每 N 小时执行一次 |
| every N day | every 1 day | 每 N 天执行一次 |

#### 管理调度

| 操作 | 端点 | 说明 |
|------|------|------|
| 获取列表 | GET /api/data-clean/schedules | 返回所有调度计划 |
| 启用/禁用 | PUT /api/data-clean/schedules/:id | 发送 { "enabled": false } |
| 删除调度 | DELETE /api/data-clean/schedules/:id | 移除并停止 |
| 立即执行 | POST /api/data-clean/schedules/:id/run | 手动触发一次扫描 |

#### 配置文件

调度配置持久化在项目根目录的 data-clean-schedules.json 文件中，格式为 JSON 数组。

---

## 4. REST API 参考

所有端点前缀：/api/data-clean

### 4.1 质量扫描

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /pages | 扫描所有页面并返回质量评分 |

**响应示例：**
`json
[
  {
    "path": "concepts/transformers.md",
    "title": "Transformers",
    "qualityScore": 85,
    "category": { "length": 80, "links": 75, "frontmatter": 90, "citations": 60, "duplicate": 100, "freshness": 70 },
    "metadata": {
      "wordCount": 3420, "lineCount": 120, "internalLinks": 12,
      "inboundLinks": 5, "lastModified": "2026-07-20T10:00:00Z",
      "hasFrontmatter": true, "isDraft": false, "fileSizeBytes": 18500,
      "hasBom": false, "encoding": "utf-8", "directory": "concepts"
    },
    "issues": [],
    "suggestions": []
  }
]
`

### 4.2 去重检测

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | /deduplicate | 运行去重检测 |

**响应示例：**
`json
{
  "matches": [
    {
      "pageA": { "path": "concepts/llm.md", "title": "LLM", "qualityScore": 85 },
      "pageB": { "path": "entities/llm-wiki.md", "title": "LLM Wiki", "qualityScore": 42 },
      "similarity": 0.92,
      "matchType": "near-duplicate",
      "reason": "Similar page name"
    }
  ],
  "scannedPages": 135,
  "uniquePages": 133,
  "duplicateGroups": {}
}
`

### 4.3 归档

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | /archive | 批量归档文件 |

**请求体：**
`json
{
  "files": ["concepts/dup1.md", "entities/old.md"],
  "dry_run": true
}
`

### 4.4 合并重复页面

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | /merge | 合并两个重复页面 |

**请求体：**
`json
{
  "pageA": { "path": "concepts/llm.md", "title": "LLM", "qualityScore": 85 },
  "pageB": { "path": "entities/llm-wiki.md", "title": "LLM Wiki", "qualityScore": 42 },
  "similarity": 0.92,
  "matchType": "near-duplicate",
  "reason": "相似主题页面",
  "archive_kept": true,
  "dry_run": false
}
`

### 4.5 永久删除

| 方法 | 路径 | 描述 |
|------|------|------|
| DELETE | /delete | 永久删除文件 |

**请求体：**
`json
{
  "files": ["drafts/temp-note.md"],
  "dry_run": true
}
`

### 4.6 Frontmatter 修复

| 方法 | 路径 | 描述 |
|------|------|------|
| PUT | /fix-frontmatter | 批量修复 frontmatter |

**请求体：**
`json
{
  "paths": ["concepts/missing-fm.md"],
  "dry_run": false
}
`

### 4.7 编译前预检

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /precheck | 验证知识库完整性 |

**响应示例：**
`json
{
  "passed": true,
  "scannedFiles": 135,
  "errors": [],
  "warnings": ["entities/old.md: Unresolved link [[unknown-page]]"],
  "blocked": false
}
`

### 4.8 定期调度

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /schedules | 获取所有调度计划 |
| POST | /schedules | 创建新的调度计划 |
| PUT | /schedules/:id | 更新调度计划 |
| DELETE | /schedules/:id | 删除调度计划 |
| POST | /schedules/:id/run | 手动触发一次扫描 |

---

## 5. 最佳实践

### 日常维护流程

1. **每周**：运行一次质量扫描，关注 Needs Work (<40) 的页面
2. **每次新增内容后**：运行 frontmatter 修复，确保新页面符合规范
3. **每月**：运行预检 + 去重检测，清理冗余页面
4. **季度**：审查归档目录，确认是否有需要永久删除的文件

### 操作建议

- **始终先干跑 (dry_run=true)**：所有写操作默认启用干跑模式
- **分批操作**：避免一次性勾选过多文件，建议每次不超过 20 个
- **合并前先备份**：在重要合并前，先复制相关文件到 archive
- **关注 inbound links**：质量报告中 inboundLinks=0 的页面可能是孤立页面
- **利用预检**：编译流程前运行预检，避免编译失败

### 性能提示

- 全量扫描约需 < 30 秒（135 个正式页 + raw 文件）
- 巨型 PDF 文件（> 50k 词）仅扫描元数据，不做全文分析
- 调度器默认 6 小时运行一次扫描，可根据需要调整频率

---

## 6. 故障排查

### 常见问题

**Q: 扫描结果为空？**

A: 检查 vault 目录中是否存在 entities/、concepts/、comparisons/ 目录且含有 .md 文件。

**Q: 去重检测未找到已知重复页面？**

A: 当前去重基于文件名+内容相似度算法（MinHash + LSH）。确保两个文件的标题确实相似，且内容重叠度高（≥90%）。

**Q: 合并操作失败？**

A: 检查两个文件是否均可读取，以及目标目录的写入权限。查看服务器日志中的 [MERGE ERROR] 条目获取详细信息。

**Q: 预检显示大量未解析链接？**

A: 这是正常现象，特别是刚导入大量内容尚未建立内部链接时。只需确认这些页面确实存在于 vault 中但尚未被引用。

**Q: 调度器未按预期执行？**

A: 确认 data-clean-schedules.json 文件存在且可读写。检查 cron 表达式格式是否正确。

---

## 7. 安全须知

### 权限控制

- 数据清洗仪表板复用现有的 cleanup 权限控制
- 仅限管理员和具有 cleanup 权限的用户访问
- 菜单可见性根据用户角色过滤

### 操作审计

所有写操作均记录到审计日志：.harness/data-clean-audit.log

日志格式为 JSONL，每条包含：
`json
{
  "timestamp": "2026-07-26T10:00:00.000Z",
  "operation": "archive",
  "files": ["concepts/old.md"],
  "dry_run": false,
  "result": "success",
  "user": "admin"
}
`

### 安全建议

- **不要跳过 dry_run 直接执行正式操作**：首次使用前务必先进行干跑测试
- **定期检查审计日志**：确认所有操作的可追溯性
- **备份 vault**：在执行批量操作前，建议对整个 vault 目录做备份
- **谨慎使用删除**：永久删除操作不可撤销