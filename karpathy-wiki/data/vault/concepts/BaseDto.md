---
title: BaseDto
type: concept
created: 2025-01-30
updated: 2025-01-30
tags: [恒生电子, 票据交易, Java, DTO]
---

# BaseDto

**BaseDto** 是恒生电子票据交易管理平台 V5.0 后端开发中使用的基类数据传输对象（DTO），包含三个预留字段 `reserve1`、`reserve2`、`reserve3`，用于个性化开发场景下的前端传参扩展。

## 用途

- 当产品 DTO 中的预留字段不足时，可继承 BaseDto 获得额外三个预留字段
- 适用于 [[hundsun-bill-trading-platform-v5]] 平台的后端开发

## 相关页面

- [[hundsun-bill-trading-platform-v5]] — 恒生电子票据交易管理平台 V5.0 后端开发平台
