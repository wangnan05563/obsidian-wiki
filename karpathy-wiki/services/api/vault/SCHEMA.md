# 知识库页面规范 SCHEMA

## 页面类型
- entity: 实体页（人/物/项目）
- concept: 概念页（方法/理论/技术）
- comparison: 对比页（多实体/多概念对照）
- query: 归档的高价值问答

## frontmatter 必填字段
```yaml
---
title: 页面标题
type: entity|concept|comparison|query
created: YYYY-MM-DD
updated: YYYY-MM-DD
source: 原始资料来源（URL 或文件名）
tags: [tag1, tag2]
---
```

## 双向链接
- 使用 [[页面名]] 链接到其他页面
- 文件名与页面名一致（例如 [[llm-wiki]] 对应 concepts/llm-wiki.md）

## 目录约定
- entities/ 实体
- concepts/ 概念
- comparisons/ 对比
- queries/ 归档问答
- raw/ 原始资料存档
