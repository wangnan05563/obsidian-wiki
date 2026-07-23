---
title: 恒生电子前端编码规范
type: concept
created: 2025-01-22
updated: 2025-01-22
source: raw/wiki-batch-1784698732960-11-____-______.md
tags: [编码规范, 前端, HTML, CSS, JavaScript, Vue]
---

# 恒生电子前端编码规范

恒生电子股份有限公司（Hundsun Electronics）制定的前端编码规范，由 **EPG 研发组** 编制，批准日期为 **2022/10/20**。旨在为前端开发人员提供统一的编码规范，以更快、更高效、更规范地完成繁重、复杂、多样化的任务。

## 规范目的

- 降低每个组员介入项目的门槛成本
- 提高工作效率及协同开发的便捷性
- 高度统一的代码风格

## 约束等级定义

| 约束等级 | 约束效力 | 强制性 |
| --- | --- | --- |
| 【强制】 | 违反将被认为代码存在严重缺陷 | 前端程序必须遵守 |
| 【推荐】 | 违反将被认为代码存在轻微缺陷 | 根据产品特性选择性遵守 |
| 【参考】 | 违反可被认为代码存在优化空间 | 参考使用 |

## 环境要求

- **浏览器**：推荐使用 [[Chrome]] 浏览器；Vue.js 技术栈推荐安装 Vue.js devtools 插件
- **Node.js**：推荐使用 LTS 版本，可使用 nvm 或 nvm-windows 管理多版本
- **编辑器**：推荐使用 [[Visual Studio Code]] (VS Code) 进行代码编写
- **格式化插件**：推荐安装 Prettier - Code formatter
- **Tab 设置**：VS Code 中设置 Tab 大小为 2 个空格

## 规范分类

### 1. [[html-template-dev-standards|HTML/TEMPLATE 开发规范]]

涵盖通用语法、HTML5 Doctype、语言属性、字符编码、CSS/JS 文件引入、标签精简、属性顺序、语义化、注释、多媒体回溯等。

### 2. [[css-less-sass-dev-standards|CSS/LESS/SASS 开发规范]]

涵盖命名规范、语法规则、代码风格、样式兼容性、选择器权重、声明简写、CSS 动画、声明顺序、字体规则、Hack 规范等。

### 3. [[js-es6-dev-standards|JS/ES6 开发规范]]

涵盖命名规则、语法规范、代码风格、数组/对象操作、null 使用、文档注释等。

### 4. Vue 开发规范

涵盖 Vue 命名规范、文件夹命名规范、语法规范、组件/实例选项顺序、元素特性顺序、单文件组件顶级元素顺序等。

### 5. [[frontend-request-standards|前端请求调用规范]]

涵盖前端与后端接口请求调用的规范约定。

## 详细规范

参见以下子页面：

- [[html-template-dev-standards|HTML/TEMPLATE 开发规范]]
- [[css-less-sass-dev-standards|CSS/LESS/SASS 开发规范]]
- [[js-es6-dev-standards|JS/ES6 开发规范]]
- [[vue-dev-standards|Vue 开发规范]]
- [[frontend-request-standards|前端请求调用规范]]

## 相关项目

- [[hundsun-bill-trade-v5-frontend]] — 恒生电子 HUNDSUN 票据交易管理平台 V5.0 前端开发指导，基于 Vue.js + H-UI 技术栈的实际项目开发指南
