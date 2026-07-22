---
title: HTML/TEMPLATE 开发规范
type: concept
created: 2025-01-22
updated: 2025-01-22
source: raw/wiki-batch-1784698732960-11-____-______.md
tags: [编码规范, HTML, 前端]
---

# HTML/TEMPLATE 开发规范

恒生电子前端编码规范中关于 HTML 和模板开发的规范部分。

## 通用语法

### 【强制】缩进使用两个空格代替 Tab
前端代码层级较深，使用短缩进有利于利用屏幕空间，提升效率。

### HTML5 Doctype
使用标准的 HTML5 doctype 声明。

### 语言属性
在 `<html>` 标签上正确设置 `lang` 属性。

### 字符编码
使用 UTF-8 字符编码，通过 `<meta charset="UTF-8">` 声明。

### 引入 CSS 和 JavaScript 文件
- CSS 文件在 `<head>` 中引入
- JavaScript 文件在 body 底部引入

### 减少标签的数量
尽可能减少不必要的嵌套标签。

### 属性顺序
按照特定优先级顺序排列 HTML 属性，提高可读性。

### 语义化
使用语义化标签（如 `<header>`, `<nav>`, `<main>`, `<footer>` 等）。

### 注释
合理使用注释，提高代码可维护性。

### 多媒体回溯
为多媒体元素提供回退内容。

## 相关页面

- [[恒生电子前端编码规范]]
- [[CSS/LESS/SASS 开发规范]]
