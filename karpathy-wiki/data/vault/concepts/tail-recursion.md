---
title: 尾递归
type: concept
created: 2025-11-21T00:00:00.000Z
updated: '2026-07-27'
source: raw/input-1785166708570.md
tags:
  - 递归
  - 尾递归
  - 优化
  - 编程
status: published
confidence: medium
contested: false
ai_tags:
  - tail-call-optimization
  - functional-programming
  - compiler-optimization
  - 栈溢出
  - 空间复杂度
---

# 尾递归

**尾递归（Tail Recursion）** 是指递归调用发生在函数的最后一步（尾部位置）的递归形式。编译器或解释器可以对尾递归进行优化（TCO，Tail Call Optimization），将其转换为迭代，从而避免栈溢出。

## 与普通递归的区别

- 普通递归在递归调用后还有额外的计算步骤（如 `n * factorial(n-1)` 中的乘法）
- 尾递归的递归调用是函数的最后一步，无需额外计算
- 尾递归可被优化为循环，空间复杂度 O(1)

## 示例

```python
# 普通递归
def factorial(n):
    if n == 0:
        return 1
    return n * factorial(n - 1)

# 尾递归
def factorial_tail(n, acc=1):
    if n == 0:
        return acc
    return factorial_tail(n - 1, n * acc)
```

## 相关概念

- [[递归]] — 尾递归是递归的一种特殊形式
- [[栈溢出]] — 尾递归优化可避免栈溢出
