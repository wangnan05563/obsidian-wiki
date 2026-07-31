---
title: 贴现通摘牌签收完成后收到Cas001002，清算失败的原因是什么？
type: qa
created: 2026-07-29T00:00:00.000Z
updated: 2026-07-29T00:00:00.000Z
source: 'qq-chat:5f1bd3b1-b799-470d-9c13-2be3d3667480'
tags:
  - 贴现通
  - 清算失败
  - Cas001002
  - 大额切日
  - 委托日期非法
status: published
confidence: medium
contested: false
answerer: 票交所-覃舒桐
ts: 2025-12-15T17:33:33.000Z
original_refs:
  - 大额切日了吧，报委托日期非法
entities:
  - name: 贴现通
    relation: related_to
  - name: 大连银行
    relation: related_to
  - name: 曹燕秋
    relation: related_to
  - name: 覃舒桐
    relation: related_to
---

## 问题

贴现通摘牌签收完成后收到 **Cas001002**，清算失败的原因是什么？

## 答案

大额切日导致委托日期非法，造成清算失败。

## 详细说明

当 [[贴现通]] 摘牌签收完成后，如果收到 Cas001002 错误码，清算失败，通常是因为**大额支付系统已经切日**（即跨过了清算时间点），导致报委托日期非法。

### 涉及角色

- **提问者**：[[大连银行]] - [[曹燕秋]]
- **答复者**：[[票交所]] - [[覃舒桐]]

## 原文引用

> 大额切日了吧，报委托日期非法

## 相关概念

- [[贴现通]] — 票据贴现撮合平台
- Cas001002 — 清算失败错误码
- [[大额切日]] — 大额支付系统日切处理
