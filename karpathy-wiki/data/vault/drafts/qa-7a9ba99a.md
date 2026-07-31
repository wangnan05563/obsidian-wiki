---
title: 线上服务内存泄漏，每隔 6 小时 OOM 一次，如何排查？
type: qa
created: '2026-07-23'
updated: '2026-07-23'
source: 'qq-chat:29ed41f9-b304-4fd3-8ac3-77908e9dd545'
tags:
  - 调试
  - 错误处理
status: draft
confidence: medium
answerer: '运维B, 运维C'
ts: '2026-07-20T20:00:00Z'
original_refs:
  - 线上服务内存泄漏，每隔 6 小时 OOM 一次，如何排查？
  - 先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。
  - Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline 分析。
---
## 问题

线上服务内存泄漏，每隔 6 小时 OOM 一次，如何排查？

## 答案

先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因包括闭包持有、事件监听器未解绑、定时器未清理。Node.js 环境下可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline 分析。

## 上下文

针对线上服务定时OOM问题，交流了堆快照分析与Chrome DevTools内存面板排查方法，最终确认为定时器未清理导致。

## 原文引用

- > 线上服务内存泄漏，每隔 6 小时 OOM 一次，如何排查？
- > 先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。
- > Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline 分析。
