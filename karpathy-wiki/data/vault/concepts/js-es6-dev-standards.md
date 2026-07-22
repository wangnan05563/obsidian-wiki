---
title: JS/ES6 开发规范
type: concept
created: 2025-01-22
updated: 2025-01-22
source: raw/wiki-batch-1784698732960-11-____-______.md
tags: [编码规范, JavaScript, ES6, 前端]
---

# JS/ES6 开发规范

恒生电子前端编码规范中关于 JavaScript 和 ES6 开发的规范部分。

## 命名规范

- 变量和函数使用 camelCase 命名
- 常量使用全大写加下划线（UPPER_SNAKE_CASE）
- 类名使用 PascalCase
- 私有属性和方法使用下划线 `_` 前缀

## 语法规范

- 使用 `let` 和 `const` 代替 `var`
- 优先使用箭头函数
- 使用模板字符串代替字符串拼接
- 使用解构赋值
- 使用展开运算符（spread operator）

## 代码风格

- 使用分号
- 合理使用空格和空行
- 控制行长度

## 数组、对象

- 使用字面量创建数组和对象
- 使用 `Array` 的迭代方法（`map`, `filter`, `reduce` 等）代替 `for` 循环
- 使用对象解构

## 使用 null

- 明确区分 `null` 和 `undefined`
- 使用 `null` 表示有意为空的值

## 文档注释

- 使用 JSDoc 风格注释
- 为函数和方法添加参数和返回值说明

## 相关页面

- [[恒生电子前端编码规范]]
- [[Vue 开发规范]]
