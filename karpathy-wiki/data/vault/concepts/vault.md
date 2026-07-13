---
title: Vault
type: concept
created: 2025-01-06
updated: 2025-01-06
source: raw/input-1783482064470.md
tags: [llm, storage, knowledge-base, markdown]
---

# Vault

**Vault** 是 [[LLM Wiki]] 知识库的存储层，使用 Markdown 文件来组织和管理所有页面。

## 页面分类

Vault 中的页面按类型存放在不同目录中：

| 类型 | 目录 | 说明 |
|------|------|------|
| entity | `entities/` | 人、物、项目 |
| concept | `concepts/` | 方法、理论、技术 |
| comparison | `comparisons/` | 多实体/多概念对照 |
| query | `queries/` | 归档的高价值问答 |

## 双向链接机制

页面间通过 `[[页面名]]` 语法互相引用，形成知识图谱。例如：
- `[[harness]]` 指向 concepts/harness.md
- `[[llm-wiki]]` 指向 concepts/llm-wiki.md

## 与 Harness 的关系

[[harness]] 调用 LLM 将原始资料编译为结构化页面，然后写入 Vault 进行持久化存储。Vault 中的页面通过双向链接互联，形成一个可导航的知识网络。
