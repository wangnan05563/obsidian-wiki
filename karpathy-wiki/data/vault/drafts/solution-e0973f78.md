---
title: Node.js 内存泄漏排查与修复方案
type: solution
created: '2026-07-27'
updated: '2026-07-27'
source: 'qq-chat:aa40d127-79e6-4b50-85dd-1b9c0646abf2'
tags:
  - solution
status: draft
confidence: medium
ts: '2026-07-20T20:00:30Z'
original_refs:
  - 先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。
  - >-
    补充：Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline
    分析。
  - 是定时器未清理导致的。修复方案：在组件销毁时 clearInterval。
---
## 背景

线上服务出现内存泄漏，每隔6小时OOM一次，经讨论定位为定时器未清理导致。

## 步骤

1. 使用 heapdump 抓取堆快照，对比泄漏前后的对象数量，判断是否有异常增长的对象。
2. 使用 Node.js --inspect 连接 Chrome DevTools 的 Memory 面板进行 Allocation Timeline 分析，找到泄漏源头。
3. 确认为定时器未清理后，在组件销毁时调用 clearInterval 进行修复。

## 注意事项

排查时要关注闭包持有、事件监听器未解绑等常见原因，避免遗漏。修复后监控确认内存回收正常。

## 原文引用

- > 先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。
- > 补充：Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline 分析。
- > 是定时器未清理导致的。修复方案：在组件销毁时 clearInterval。
