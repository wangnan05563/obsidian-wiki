---
title: RAG（检索增强生成）
type: concept
created: 2024-12-01
updated: 2024-12-01
source: raw/input-1783483802520.md
tags: [rag, retrieval-augmented-generation, llm, information-retrieval]
---

# RAG（检索增强生成）

**RAG**（Retrieval-Augmented Generation，检索增强生成）是一种结合信息检索与文本生成的技术范式，旨在让 [[LLM|大语言模型]] 在生成回答时能够引用外部知识库中的最新、最相关信息，从而提升生成内容的准确性、时效性和可溯源性。

## 核心流程

RAG 系统通常包含以下四个步骤：

1. **索引（Indexing）** — 将文档切分为固定大小的文本块（chunking），并生成向量嵌入（embedding）存储到向量数据库中。
2. **检索（Retrieval）** — 用户查询到来时，将其转换为向量，在向量数据库中执行相似度搜索，选出 Top-K 最相关文本块。
3. **增强（Augmentation）** — 将检索到的文本块与原始用户查询拼接为增强提示（augmented prompt）。
4. **生成（Generation）** — 将增强提示送入 [[LLM|大语言模型]]，由其生成最终回答。

## 关键组件

| 组件 | 说明 |
|------|------|
| 向量数据库 | 存储文档嵌入，支持高效相似度检索 |
| 嵌入模型 | 将文本转化为稠密向量（如 text-embedding-3-small） |
| 检索策略 | 包括 Top-K、MMR（最大边际相关性）等 |
| 大语言模型 | 基于增强提示生成回答（如 GPT-4、Claude） |

## 优势

- **知识时效性**：无需重新训练模型即可引入最新信息
- **可溯源**：生成结果可追溯到原始文档，提升可信度
- **降低幻觉**：通过外部知识约束模型输出，减少捏造内容
- **领域适配**：可快速将通用 LLM 适配到特定领域知识库

## 相关概念

- [[embedding|嵌入]] — 将文本映射为向量的技术
- [[llm|大语言模型]] — RAG 中的生成引擎
- [[vector-database|向量数据库]] — RAG 的核心存储基础设施
