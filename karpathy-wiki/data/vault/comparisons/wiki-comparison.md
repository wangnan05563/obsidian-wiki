---
title: 传统 Wiki vs LLM Wiki 对比
type: comparison
created: 2025-01-06
updated: 2025-01-06
source: raw/input-1783482064470.md
tags: [wiki, comparison, llm, knowledge-base]
---

# 传统 Wiki vs LLM Wiki 对比

## 概述

传统 Wiki（如 MediaWiki）和 [[LLM Wiki]] 都是知识库系统，但在页面生产方式、维护成本和知识图谱构建上存在显著差异。

## 对比表

| 维度 | 传统 Wiki | LLM Wiki |
|------|-----------|----------|
| **页面生产方式** | 人工编写、审核、发布 | AI 自动从原始资料编译生成 |
| **维护成本** | 高 — 需要专人持续更新 | 低 — 更新原始资料后自动重新编译 |
| **知识图谱** | 依赖人工手动建立链接 | 自动建立 [[双向链接]] |
| **页面结构** | 自由格式 | 标准化的 frontmatter + Markdown |
| **扩展性** | 依赖社区贡献者数量 | 依赖 LLM 能力和原始资料质量 |
| **一致性** | 不同编者风格可能不同 | 统一的模板和格式 |

## 核心差异

### 生产方式
传统 Wiki 依赖人工编写，每个页面都需要作者投入时间；而 LLM Wiki 由 [[harness]] 驱动的 AI Agent 自动将 `raw/` 目录中的原始资料编译为结构化页面。

### 存储结构
LLM Wiki 的 [[vault]] 采用标准化的 Markdown 文件组织方式，页面带有 YAML frontmatter 元数据，便于机器处理。

## 适用场景

- **传统 Wiki** 适合需要深度人工审核、社区协作的知识库
- **LLM Wiki** 适合需要快速从大量原始资料生成结构化知识库的场景
