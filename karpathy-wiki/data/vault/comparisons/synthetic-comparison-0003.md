---
title: synthetic-comparison-0003
type: comparison
created: 2026-08-09
updated: 2026-08-09
source: synthetic-test-data
tags: [RAG, 设计, 架构, 工作流]
---
# synthetic-comparison-0003

这是性能测试用合成页面（comparison 类型）。用于验证 P2 缓存机制在大 vault 场景下的有效性。

## 背景

本文档由 gen-large-vault.mjs 脚本生成，内容为模板化占位文本，仅用于压力测试。通过批量生成 1000+ 页面并测量关键端点响应时间，可验证 stat 缓存、增量图构建、brotli 压缩等改进项在高数据量下的稳定性。

## 相关链接

- [[synthetic-entity-0124]] 相关参考
- [[test-document-series]] 相关参考
- [[synthetic-concept-0254]] 相关参考
- [[ecds-migration-interface-spec]] 相关参考

## 总结

合成页面，无实际业务含义。测试完成后将通过 restore-vault 恢复原始数据。
