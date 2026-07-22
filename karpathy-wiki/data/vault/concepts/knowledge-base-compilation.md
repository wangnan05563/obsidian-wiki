---
title: 知识库编译
type: concept
created: 2025-07-05
updated: 2025-07-05
source: 知识库编译规范
tags: [编译, 知识库, 工作流]
---

# 知识库编译

**知识库编译** 是指将原始资料（raw 文件）按照 [[SCHEMA]] 规范自动化为结构化 Wiki 页面的过程。

## 流程

1. 读取原始资料
2. 判定页面类型（entity / concept / comparison / query）
3. 生成带有 frontmatter 的 Markdown 页面
4. 建立双向链接
5. 更新 index.md 和 log.md

## 相关页面

- [[批量编译测试]] — 验证 SSE 流式响应的测试用例
- [[frontmatter 规范]] — 页面元数据规范
