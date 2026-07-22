---
title: 知识库编译器
type: concept
created: 2025-01-22
updated: 2025-01-22
source: raw/wiki-batch-1784696431804-2-test3.txt
tags: [compiler, tool, knowledge-base]
---

# 知识库编译器

**知识库编译器（Wiki Compiler）** 是一个自动化工具，负责将原始资料编译为结构化的 Markdown Wiki 页面，并维护知识库的索引与日志系统。

## 功能

- 读取 `raw/` 目录下的原始资料文件
- 判定页面类型（entity/concept/comparison/query）
- 生成带有 frontmatter 的标准 Wiki 页面
- 建立双向链接 [[batch-compile-testing]]
- 更新 `index.md` 和 `log.md`

## 相关页面

- [[batch-compile-testing]] — 批量编译测试
- [[SCHEMA]] — 知识库页面规范
