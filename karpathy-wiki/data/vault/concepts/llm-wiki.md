---
title: LLM Wiki
type: concept
created: 2025-01-06
updated: 2025-01-06
source: raw/input-1783482064470.md
tags: [llm, knowledge-base, wiki, ai]
---

# LLM Wiki

**LLM Wiki** 是一个基于大语言模型的知识库系统，由 Karpathy 提出。其核心理念是 **"用 LLM 编译知识"**——利用 AI 自动从原始资料编译生成结构化页面，从而大幅降低知识库的维护成本。

## 核心组件

### [[harness]] — Harness
Harness 是 LLM Agent 的运行时，包裹 LLM 并提供工具调用循环、状态管理、重试、预算控制等能力。核心公式：

> **Agent = LLM + Harness**

### [[vault]] — Vault
Vault 是知识库的存储层，使用 Markdown 文件存储页面。页面分为四类：

- **entity**（实体）— 人、物、项目
- **concept**（概念）— 方法、理论、技术
- **comparison**（对比）— 多实体/多概念对照
- **query**（查询/问答）— 归档的高价值问答

### 双向链接
页面间通过 `[[页面名]]` 语法互相引用，形成知识图谱。

## 与传统 Wiki 的区别

| 特性 | 传统 Wiki | LLM Wiki |
|------|-----------|----------|
| 页面编写方式 | 人工编写 | AI 自动编译 |
| 维护成本 | 高 | 低 |
| 知识图谱 | 依赖人工链接 | 自动建立双向链接 |

## 相关概念
- [[harness]] — LLM Agent 运行时
- [[vault]] — 知识库存储层
