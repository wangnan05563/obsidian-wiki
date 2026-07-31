---
title: RAG (Retrieval-Augmented Generation)
type: concept
created: 2024-11-22
updated: 2024-11-22
source: wiki-batch-1784833360965-2-file3.md
tags: [LLM, Retrieval, Generation, AI]
---

# RAG (Retrieval-Augmented Generation)

## 简介
检索增强生成（Retrieval-Augmented Generation, RAG）是一种结合信息检索和文本生成的 AI 技术架构。它通过在生成回答之前先从外部知识库中检索相关文档，来增强大语言模型（LLM）的输出质量和准确性。

## 核心流程
1. **索引 (Indexing)**：将知识库中的文档进行预处理和向量化，建立索引结构。
2. **检索 (Retrieval)**：当用户提出问题时，系统从索引中检索出与问题最相关的 Top-K 个文档片段。
3. **增强生成 (Augmented Generation)**：将检索到的相关文档作为上下文，连同用户问题一起输入给 LLM，由 LLM 基于这些信息生成最终回答。

## 优势
- **减少幻觉**：通过提供真实的外部参考文档，降低 LLM 编造信息的可能性。
- **知识更新**：无需重新训练模型即可通过更新知识库来提供最新的信息。
- **可追溯性**：生成的回答可以追溯到具体的来源文档，提高可信度。

## 相关概念
- [[LLM]]：RAG 的核心生成组件。
- [[向量数据库]]：常用于存储和检索嵌入向量。
