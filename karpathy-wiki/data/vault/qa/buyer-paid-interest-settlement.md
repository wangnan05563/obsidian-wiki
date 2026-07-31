---
title: 意向询价买方付息应答结算金额问题
type: qa
created: 2026-07-29T00:00:00.000Z
updated: 2026-07-29T00:00:00.000Z
source: 'qq-chat:5f1bd3b1-b799-470d-9c13-2be3d3667480'
tags:
  - 错误处理
  - api
  - 调试
  - 买方付息
  - 结算金额
status: published
confidence: medium
contested: false
answerer: 票交所-覃舒桐
ts: 2025-11-14T17:40:21.000Z
original_refs:
  - 买方付息应答的时候也要减去利息吗
  - 你们先试下、
entities:
  - name: 买方付息
    relation: related_to
  - name: 结算金额
    relation: related_to
  - name: 票面金额
    relation: related_to
---

## 问题

意向询价申请走[[买方付息]]，应答报文上送[[结算金额]]等于[[票面金额]]被拒绝，提示结算金额错误。[[结算金额]]应该怎么送才对？

## 答案

买方付息应答时，结算金额需减去利息金额，不能直接等于票面金额。

## 背景

工商银行在买方付息询价应答时报结算金额错误，经向票交所老师咨询，确认买方付息场景下结算金额的计算方式与正常付息不同，需扣除利息部分。

## 原文引用

- > 买方付息应答的时候也要减去利息吗
- > 你们先试下、
