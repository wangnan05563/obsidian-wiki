---
title: LLM Wiki
type: concept
created: 2025-01-13
updated: 2025-04-21
source: raw/LLM Wiki.md
tags: [llm, wiki, knowledge-base]
---

# LLM Wiki

**LLM Wiki** 是一个基于[[llm|大语言模型]]的知识库 Wiki 系统，能够自动将原始资料编译为结构化的 Markdown 页面，并维护页面间的双向链接关系。

## 功能特性

- 支持实体 (entity)、概念 (concept)、对比 (comparison) 等页面类型
- 自动提取原始资料中的关键信息，借助 [[llm-entity-extraction]] 技术识别核心实体
- 生成符合 [[SCHEMA]] 规范的 frontmatter
- 建立 [[双向链接]] 关系网络

## 相关页面

- [[batch-compile-testing]] — 批量编译测试方法
- [[llm-entity-extraction]] — LLM 实体抽取技术
