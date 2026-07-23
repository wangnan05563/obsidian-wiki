---
title: Batch Compile Testing
type: concept
created: 2025-04-21
updated: 2025-04-17
source: raw/wiki-batch-1784719195367-19-test-20.md
tags: [testing, batch-processing, compilation, wiki]
---

# Batch Compile Testing

**Batch Compile Testing** is a methodology used to validate the automated compilation of raw source materials into structured Markdown Wiki pages. It involves processing multiple documents in sequence to verify the correctness of the compilation pipeline.

## Process

1. Read raw material files from the `raw/` directory
2. Determine the appropriate page type (entity, concept, comparison, query)
3. Generate pages with proper frontmatter, content, and [[双向链接|bidirectional links]]
4. Append summary entries to `index.md`
5. Append operation logs to `log.md`

## Related

- [[Batch Compile Test]] — 一组用于验证知识库编译管道的自动化测试用例集合
- [[batch-compile-test]] — 批量编译测试，自动化验证系统能否同时处理多个原始资料文件并生成结构化的 Wiki 页面
- [[Batch Compile Test 19]] — 批次编译测试中的第19个测试文档，用于验证简短内容场景下的编译能力
- [[Test Document 20]] is one of the test documents used in this process
- The compilation process relies on [[LLM]] to extract entities and determine page types
