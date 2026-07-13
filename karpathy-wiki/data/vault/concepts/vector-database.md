---
title: 向量数据库
type: concept
created: 2024-12-01
updated: 2024-12-01
source: raw/input-1783483802520.md
tags: [vector-database, vector-search, database, rag]
---

# 向量数据库

**向量数据库**是一种专门用于存储和检索向量嵌入的数据库系统，支持高效的近似最近邻（ANN）搜索。它是 [[rag|RAG]] 系统的核心基础设施。

## 在 RAG 中的作用

向量数据库在 RAG 流程中承担以下职责：

1. **存储向量嵌入**：保存文档块经嵌入模型转换后的稠密向量
2. **相似度检索**：接收用户查询向量，快速返回 Top-K 最相似的文档块
3. **元数据过滤**：支持按文档来源、时间等元数据条件过滤检索结果

## 主流向量数据库

- Pinecone（托管服务）
- Weaviate
- Qdrant
- Milvus
- Chroma（轻量级，适合原型开发）
- pgvector（PostgreSQL 扩展）

## 相关概念

- [[rag|RAG（检索增强生成）]]
- [[embedding|嵌入]]
- [[llm|大语言模型]]
