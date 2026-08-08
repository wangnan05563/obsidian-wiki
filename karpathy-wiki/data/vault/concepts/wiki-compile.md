---
title: Wiki Compile
type: concept
created: 2025-01-14
updated: 2025-01-14
source: raw/test-14.md
tags: [compilation, knowledge-base, pipeline]
---

# Wiki Compile

**Wiki Compile** is a pipeline process that transforms raw source materials into structured Markdown Wiki pages within a knowledge base. It follows a defined set of steps including reading the [[SCHEMA]], parsing raw files, determining page types (entity, concept, comparison, or query), generating frontmatter, establishing [[bidirectional-linking]], and updating index and log files.

## Workflow

1. Read SCHEMA.md for page specifications
2. Read raw material files from the `raw/` directory
3. Determine page type based on content
4. Generate pages with proper frontmatter
5. Establish bidirectional links between related pages
6. Append summary entries to [[index]]
7. Record operations in [[log]]

## Related

- [[Test Document 14]] — a test case for this pipeline
- [[batch-compile-testing]] — testing methodology for batch compilation
