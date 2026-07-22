---
title: frontmatter 规范
type: concept
created: 2025-07-05
updated: 2025-07-05
source: SCHEMA.md
tags: [规范, frontmatter, 元数据]
---

# frontmatter 规范

**frontmatter 规范** 定义了知识库页面顶部的 YAML 元数据格式。每个页面都必须包含以下字段：

## 必填字段

| 字段 | 说明 | 示例 |
|------|------|------|
| `title` | 页面标题 | `批量编译测试` |
| `type` | 页面类型：entity / concept / comparison / query | `concept` |
| `created` | 创建日期 (YYYY-MM-DD) | `2025-07-05` |
| `updated` | 更新日期 (YYYY-MM-DD) | `2025-07-05` |
| `source` | 原始资料来源 | `raw/wiki-batch-xxx.md` |
| `tags` | 标签列表 | `[测试, 编译]` |

## 相关页面

- [[知识库编译]] — 编译流程规范
- [[批量编译测试]] — 编译测试用例
