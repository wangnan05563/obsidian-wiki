---
title: 线上服务内存泄漏(OOM)排查与修复步骤
type: solution
created: '2026-07-23'
updated: '2026-07-23'
source: 'qq-chat:b8618810-bcd1-4c06-aec4-3406c0131033'
tags:
  - solution
status: draft
confidence: medium
ts: '2026-07-20T20:02:00Z'
original_refs:
  - 先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。
  - Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline 分析。
  - 按这个方案定位到了，是定时器未清理导致的。修复方案：在组件销毁时 clearInterval。
---
## 背景

线上服务每隔 6 小时触发一次 OOM 崩溃，经多人讨论形成标准化排查流程。

## 步骤

1. 使用 heapdump 抓取堆快照，对比泄漏前后的对象数量变化。
2. 结合常见原因逐一排查：检查未释放的闭包、未解绑的事件监听器、未清理的定时器。
3. Node.js 环境可通过 --inspect 参数启动，连接 Chrome DevTools 的 Memory 面板进行 Allocation Timeline 分析。
4. 定位具体泄漏点后实施修复，例如在组件销毁生命周期中调用 clearInterval 清理定时器。

## 注意事项

heapdump 可能引发短暂卡顿，建议在实际业务低峰期执行；--inspect 调试端口需注意网络安全限制，避免暴露至公网。

## 原文引用

- > 先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。
- > Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline 分析。
- > 按这个方案定位到了，是定时器未清理导致的。修复方案：在组件销毁时 clearInterval。
