# 知识库页面规范 SCHEMA

## 页面类型
- entity: 实体页（人/物/项目）
- concept: 概念页（方法/理论/技术）
- comparison: 对比页（多实体/多概念对照）
- query: 归档的高价值问答
- qa: 业务问答页（QQ 聊天记录抽取的单问题 + 答案 + 原文引用）
- solution: 方案沉淀页（QQ 聊天记录抽取的背景 + 步骤 + 注意事项 + 原文引用）

## frontmatter 必填字段
```yaml
---
title: 页面标题
type: entity|concept|comparison|query|qa|solution
created: YYYY-MM-DD
updated: YYYY-MM-DD
source: 原始资料来源（URL 或文件名，QQ 导入格式为 qq-chat:<rawId>）
tags: [tag1, tag2]
---
```

## frontmatter 扩展字段（QQ 导入子系统使用）
```yaml
---
# status: draft 待人工审核，published 已审核发布
status: draft|published
# confidence: 信息可信度，QQ 来源默认 medium（借鉴 Hermes）
confidence: high|medium|low
# contested: 是否存在争议答案（多人给出不同解答时标注）
contested: false
# original_refs: 原文片段引用数组（RAG 证据约束，禁止编造）
original_refs: ["原文片段1", "原文片段2"]
# expires_at: 业务方案时效性（可选，过期方案可在 healthCheck 标记）
expires_at: YYYY-MM-DD
# answerer: 答复者昵称（仅 qa 类型，脱敏后保留）
answerer: 昵称
# ts: 对应原文消息的 ISO8601 时间戳（qa/solution 类型）
ts: 2026-07-20T14:30:15Z
---
```

## frontmatter 实体关系字段（FR-15-6，compile 阶段 LLM 抽取）
```yaml
---
# entities: 本页与其它实体的关系列表（仅 compile 阶段由 LLM 抽取，不引入独立 NER 模型）
# - name: 相关实体页面名（不含 .md 后缀，必须与正文 [[页面名]] 一致）
# - relation: 关系类型（snake_case），常用值：leader_of / member_of / depends_on / created_by / related_to
entities: [{name: "项目X", relation: "leader_of"}, {name: "团队A", relation: "member_of"}]
---
```

**抽取约束**：
- 仅抽取原始资料中明确出现的关系，禁止编造
- `name` 必须在正文 `[[双向链接]]` 中出现，保证图谱拓扑一致
- 若本页不涉及任何实体关系，frontmatter 中不要写 `entities` 字段

## 双向链接
- 使用 [[页面名]] 链接到其他页面
- 文件名与页面名一致（例如 [[llm-wiki]] 对应 concepts/llm-wiki.md）
- 每个页面至少包含 1 条双向链接（compile 阶段由 LLM 建立）

## 目录约定
- entities/ 实体
- concepts/ 概念
- comparisons/ 对比
- queries/ 归档问答
- qa/ QQ 导入业务问答（draft → published 流转）
- solutions/ QQ 导入方案沉淀（draft → published 流转）
- drafts/ QQ 导入候选 draft 存放（待人工审核，不参与正式链接图）
- raw/ 原始资料存档

## QQ 导入子系统状态机
1. 抽取阶段：LLM 从脱敏对话流抽取 qa_pairs/solutions，写入 drafts/ 目录，status=draft
2. 人工审核：Browse 视图按 status=draft 过滤，审核通过后触发 compile
3. compile 阶段：LLM 组织为体系化 qa/ 或 solutions/ 页面，status 改为 published，建立双向链接
4. published 页面进入正常知识库流通（query/graph/healthCheck）
