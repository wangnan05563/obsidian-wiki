---
title: 大语言模型（LLM）
type: concept
created: 2024-12-01
updated: 2024-12-01
source: raw/input-1783483802520.md
tags: [llm, large-language-model, ai, nlp]
---

# 大语言模型（LLM）

**大语言模型**（Large Language Model，LLM）是一种基于 Transformer 架构、在大规模文本语料上预训练的深度学习模型，能够理解和生成自然语言文本。

## 在 RAG 中的作用

在 [[rag|RAG]]（检索增强生成）系统中，LLM 作为**生成引擎**，负责接收增强后的提示（包含用户查询 + 检索到的外部知识），并生成最终回答。LLM 的语言理解与生成能力直接影响 RAG 系统的输出质量和自然度。

## 主流模型

- GPT-4 / GPT-4o（OpenAI）
- Claude 3 / Claude 3.5（Anthropic）
- Llama 3（Meta）
- Gemini（Google）
- Qwen（阿里巴巴）

## 相关概念

- [[rag|RAG（检索增强生成）]]
- [[embedding|嵌入]]
