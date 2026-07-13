---
title: 嵌入（Embedding）
type: concept
created: 2024-12-01
updated: 2024-12-01
source: raw/input-1783483802520.md
tags: [embedding, vector, nlp, representation-learning]
---

# 嵌入（Embedding）

**嵌入**（Embedding）是将文本、图像等非结构化数据映射为稠密向量（dense vector）的技术。在 [[rag|RAG]] 系统中，嵌入用于将文档块和用户查询统一表示为向量，以便在向量空间中进行相似度检索。

## 在 RAG 中的作用

嵌入是 RAG 系统的核心组件之一：

1. **文档索引阶段**：将切分后的文本块通过嵌入模型转换为向量，存入向量数据库
2. **用户查询阶段**：将用户查询转换为同维度向量
3. **相似度检索**：计算查询向量与文档向量之间的余弦相似度，选出 Top-K 最相关结果

## 常用嵌入模型

- OpenAI: text-embedding-3-small / text-embedding-3-large
- Cohere: embed-english-v3.0
- 开源: BGE, E5, Instructor

## 相关概念

- [[rag|RAG（检索增强生成）]]
- [[llm|大语言模型]]
- [[vector-database|向量数据库]]
