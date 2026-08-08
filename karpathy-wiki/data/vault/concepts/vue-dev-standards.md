---
title: Vue 开发规范
type: concept
created: 2025-01-22
updated: 2025-01-22
source: raw/____-______.md
tags: [编码规范, Vue, 前端]
---

# Vue 开发规范

恒生电子前端编码规范中关于 Vue.js 开发的规范部分。

## Vue 命名规范

- 组件名使用 PascalCase
- 组件文件名使用 PascalCase 或 kebab-case
- 混入（mixins）使用 camelCase
- 指令使用 kebab-case

## 文件夹命名规范

- 按照功能模块组织文件夹
- 公共组件放在 `components/` 目录
- 页面组件放在 `views/` 或 `pages/` 目录

## 语法规范

- 单文件组件（.vue）使用 `<template>`, `<script>`, `<style>` 结构
- 使用 `scoped` 属性限制样式作用域
- 优先使用计算属性（computed）代替方法（methods）进行数据派生
- 使用 `v-for` 时指定 `:key`
- 避免在 `v-if` 和 `v-for` 同时使用

## 组件/实例的选项的顺序

1. `name`
2. `components`
3. `mixins`
4. `props`
5. `data`
6. `computed`
7. `watch`
8. 生命周期钩子（`created`, `mounted` 等）
9. `methods`

## 元素特性的顺序

1. 指令（`v-if`, `v-for`, `v-model` 等）
2. 绑定属性（`:prop`）
3. 事件绑定（`@event`）
4. 普通属性（`class`, `id`, `style` 等）

## 单文件组件的顶级元素的顺序

1. `<template>`
2. `<script>`
3. `<style>`

## 相关页面

- [[hundsun-frontend-coding-standards|恒生电子前端编码规范]]
- [[js-es6-dev-standards|JS/ES6 开发规范]]
- [[html-template-dev-standards|HTML/TEMPLATE 开发规范]]
- [[frontend-request-standards|前端请求调用规范]]
