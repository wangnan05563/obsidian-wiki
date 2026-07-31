---
title: 递归
type: concept
created: 2025-11-21T00:00:00.000Z
updated: '2026-07-27'
source: raw/input-1785166708570.md
tags:
  - 递归
  - 算法
  - 编程
status: published
confidence: medium
contested: false
ai_tags:
  - function-call
  - base-case
  - recursive-case
  - stack-overflow
  - tail-recursion
  - divide-and-conquer
  - tree-traversal
---

# 递归

**递归（Recursion）** 是一种程序设计方法，函数通过调用自身来解决问题。递归的核心思想是将一个复杂问题分解为更小的同类子问题。

## 基本结构

递归函数通常由两部分组成：

1. **基本情况（Base Case）** — 递归终止条件，直接返回结果而不再次调用自身
2. **递归情况（Recursive Case）** — 函数调用自身处理更小规模的子问题

## 示例

```python
def factorial(n):
    # 基本情况
    if n == 0 or n == 1:
        return 1
    # 递归情况
    return n * factorial(n - 1)
```

## 相关概念

- [[分治算法]] — 递归常用于实现分治策略
- [[尾递归]] — 一种特殊的递归形式，编译器可优化为迭代
- [[栈溢出]] — 递归过深可能导致调用栈溢出

## 优缺点

| 优点 | 缺点 |
|------|------|
| 代码简洁、易读 | 性能开销较大（函数调用成本） |
| 适合树/图遍历等自然递归结构 | 可能导致栈溢出 |
| 数学定义直观 | 调试相对困难 |

## 适用场景

- 树的遍历（前序、中序、后序）
- 图的深度优先搜索（DFS）
- 分治算法（归并排序、快速排序）
- 动态规划（带记忆化的递归）
- 回溯算法（N皇后、数独等）
