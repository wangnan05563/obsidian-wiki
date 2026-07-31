---
title: 内存泄漏排查与修复方案
type: solution
created: '2026-07-27'
updated: '2026-07-27'
source: 'qq-chat:943ee5fb-29e6-4bb5-90ef-94d99b6a2302'
tags:
  - solution
status: draft
confidence: medium
ts: '2026-07-20T20:02:00Z'
original_refs:
  - 先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。
  - >-
    补充：Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline
    分析。
  - 按这个方案定位到了，是定时器未清理导致的。修复方案：在组件销毁时 clearInterval。
---
## 背景

线上服务每 6 小时 OOM，经多人讨论后定位为定时器未清理导致。

## 步骤

1. 先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。
2. Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline 分析。
3. 定位原因后，在组件销毁时 clearInterval。

## 注意事项

注意闭包持有、事件监听器未解绑也是常见原因，需一并排查。

## 原文引用

- > 先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。
- > 补充：Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline 分析。
- > 按这个方案定位到了，是定时器未清理导致的。修复方案：在组件销毁时 clearInterval。
