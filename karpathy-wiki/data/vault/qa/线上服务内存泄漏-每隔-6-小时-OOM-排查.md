---
title: 线上服务内存泄漏，每隔 6 小时 OOM 一次，如何排查？
type: qa
created: "2026-07-23"
updated: "2026-07-23"
source: "qq-chat:29ed41f9-b304-4fd3-8ac3-77908e9dd545"
tags:
  - 调试
  - 错误处理
status: published
confidence: medium
contested: false
original_refs:
  - "线上服务内存泄漏，每隔 6 小时 OOM 一次，如何排查？"
  - "先用 heapdump 抓取堆快照，对比泄漏前后的对象数量。常见原因：闭包持有、事件监听器未解绑、定时器未清理。"
  - "Node.js 可用 --inspect 连接 Chrome DevTools 的 Memory 面板做 Allocation Timeline 分析。"
answerer: "运维B, 运维C"
ts: "2026-07-20T20:00:00Z"
---

## 问题

线上服务内存泄漏，每隔 6 小时 OOM 一次，如何排查？

## 答案

面对周期性 OOM（Out Of Memory）问题，排查的核心在于定位内存持续增长且未被释放的对象。以下是具体的排查步骤与常见原因：

1. **抓取堆快照 (Heap Dump)**：
   使用工具（如 Node.js 环境下的 `heapdump` 模块）在服务运行过程中抓取堆快照。重点对比“泄漏前”和“泄漏后”快照中的对象数量变化，找出增长异常的类或对象。

2. **分析常见泄漏源**：
   *   **闭包持有**：检查是否有内部函数持有了外部作用域的大对象引用，导致垃圾回收机制无法释放。
   *   **事件监听器未解绑**：确保在组件销毁或不再需要时，正确移除了所有注册的事件监听器。
   *   **定时器未清理**：检查 `setInterval` 或 `setTimeout` 是否在不需要时停止了执行，这是导致周期性内存累积的常见原因。

3. **使用 Chrome DevTools 深入分析**：
   对于 Node.js 服务，可以启动时使用 `--inspect` 参数，然后通过 Chrome 浏览器的 DevTools 连接该服务。利用 **Memory 面板** 中的 **Allocation Timeline** 功能，可以直观地观察内存分配随时间的变化轨迹，精准定位内存分配热点。

## 上下文

针对线上服务定时 OOM 问题，交流了堆快照分析与 Chrome DevTools 内存面板排查方法，最终确认为定时器未清理导致。

## 参考链接

*   [[调试]]
*   [[错误处理]]