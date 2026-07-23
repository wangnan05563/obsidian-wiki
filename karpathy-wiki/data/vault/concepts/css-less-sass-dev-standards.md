---
title: CSS/LESS/SASS 开发规范
type: concept
created: 2025-01-22
updated: 2025-01-22
source: raw/wiki-batch-1784698732960-11-____-______.md
tags: [编码规范, CSS, LESS, SASS, 前端]
---

# CSS/LESS/SASS 开发规范

恒生电子前端编码规范中关于 CSS、LESS 和 SASS 开发的规范部分。

## 命名规范

- 使用有意义的类名和 ID
- 遵循 BEM 或其他命名约定

## 语法规则

- 使用简写属性时需注意覆盖问题
- 选择器层级不宜过深

## 代码风格

- 花括号前加空格
- 属性与值之间加空格
- 每条声明后加分号

## 样式兼容性

- 考虑浏览器兼容性，添加必要的前缀
- 使用 Autoprefixer 等工具

## 选择器权重（样式覆盖）

- 避免使用 `!important`
- 合理利用选择器优先级

## 声明简写

- 合理使用 CSS 简写属性（如 `margin`, `padding`, `background` 等）

## CSS 动画

- 使用 `transform` 和 `opacity` 进行动画以提高性能
- 合理使用 `@keyframes`

## 声明顺序

- 按照特定顺序排列 CSS 声明（定位 → 盒模型 → 排版 → 视觉 → 其他）

## 字体规则

- 指定字体栈（font stack）
- 使用系统字体或无衬线字体

## Hack 规范

- 尽量避免使用 CSS hack
- 使用特性检测代替

## 相关页面

- [[hundsun-frontend-coding-standards|恒生电子前端编码规范]]
- [[html-template-dev-standards|HTML/TEMPLATE 开发规范]]
- [[frontend-request-standards|前端请求调用规范]]
