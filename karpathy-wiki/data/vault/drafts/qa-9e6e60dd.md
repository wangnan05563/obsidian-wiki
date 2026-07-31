---
title: 线上服务内存泄漏，每隔 6 小时 OOM 一次，如何排查？
type: qa
created: '2026-07-27'
updated: '2026-07-27'
source: 'qq-chat:943ee5fb-29e6-4bb5-90ef-94d99b6a2302'
tags:
  - 错误处理
  - 调试
status: draft
confidence: medium
answerer: 运维B
ts: '2026-07-20T20:00:30Z'
original_refs:
  - 先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。
  - >-
    补充：Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline
    分析。
  - 按这个方案定位到了，是定时器未清理导致的。修复方案：在组件销毁时 clearInterval。
---
## 问题

线上服务内存泄漏，每隔 6 小时 OOM 一次，如何排查？

## 答案

先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。补充：Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline 分析。按这个方案定位到了，是定时器未清理导致的。修复方案：在组件销毁时 clearInterval。

## 上下文

运维A询问线上服务内存泄漏排查方法，运维B和运维C给出具体排查步骤，运维A确认定位到问题并给出修复方案。

## 原文引用

- > 先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。
- > 补充：Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline 分析。
- > 按这个方案定位到了，是定时器未清理导致的。修复方案：在组件销毁时 clearInterval。
