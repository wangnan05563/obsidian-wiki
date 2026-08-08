---
title: HUNDSUN 票据交易管理平台 V5.0 前端开发指导
type: concept
created: 2025-01-21
updated: 2025-01-21
source: raw/HUNDSUN 票据交易管理平台 V5.0 前端开发指导.md
tags: [恒生电子, HUNDSUN, 前端开发, Vue.js, H-UI, 票据交易]
---

# HUNDSUN 票据交易管理平台 V5.0 前端开发指导

## 概述

恒生电子股份有限公司（HUNDSUN）票据交易管理平台 V5.0 的前端开发指导文档，基于 **Vue.js** 框架和 **H-UI** 组件库构建，涵盖开发环境搭建、工程结构、页面开发、通用组件等完整内容。

## 技术栈

- **Vue.js** — 前端 JavaScript 框架，高效、易用、灵活
- **H-UI** — 恒生 JRES 团队基于 Vue.js 开发的 UI 组件产品，封装常用组件与页面布局
- **ES6** — ECMAScript 6 语法标准，推荐参考阮一峰《ECMAScript 6 入门》
- **Node.js** — 构建打包运行环境
- **npm/cnpm** — 依赖管理（使用淘宝镜像加速）
- **Lodop** — 打印控件，用于凭证模板打印

## 环境搭建

### 安装步骤

1. **安装 Node.js** — 从官网下载安装，自带 npm
2. **安装 Python** — 部分依赖需要 Python 环境
3. **安装淘宝镜像** — `npm install -g cnpm --registry=https://registry.npm.taobao.org`
4. **安装 Git** — 用于拉取前端项目代码

### 项目运行

```bash
# 进入项目目录
cd $bemp/frontend

# 安装依赖
npm install 或 cnpm install

# 资源文件过滤
npm run dll

# 启动开发环境
npm run dev
```

### 内存溢出处理

当打包出现内存溢出时，执行：

```bash
npm install cross-env --save-dev
npm install increase-memory-limit --save-dev
# 修改 package.json 中 fix-memory-limit 的 LIMIT 值
npm run fix-memory-limit
```

## 前端工程结构

```
frontend/
├── api/           # 接口 JS 文件
├── assets/        # 图标等静态资源
├── components/    # 公用自定义组件
├── views/         # 页面视图文件
├── store/         # 状态仓库（Vuex）
└── sysconfig.js   # 后台接口地址配置
```

## 后台模块分类

| 模块 | 说明 |
|------|------|
| Sm | 系统公共 |
| Pc | 功能组件 |
| Shcpe | 票交所对接 |
| Ce | 对公交易 |
| Be | 同业交易 |
| Bm | 业务管理 |
| Pb | 公共业务 |
| Pl | 票据池 |

## 菜单路径规则

路径格式：`/功能系统模块/子模块/具体业务/视图`

示例：`/sm/auth/branch/branchAdmin` → 系统公共/权限管理/机构管理/机构管理员页面

## 页面开发

### 页面布局

典型的"上-左-右"内容管理系统布局：

- **上**：系统状态栏
- **左**：菜单列表
- **右**：工作区（查询表单 → 操作按钮 → 数据列表 → 分页栏）

### 查询表单

使用 H-UI 表单组件，关键约束：

- 表单 class 必须使用 `h-form-search-box`、`h-form-search` 等固定 class
- 表单校验只控制输入长度 `maxlength`
- 输入域超过 3 个需添加"高级"查询按钮

### 操作按钮与新增编辑

包含新增、修改、查看三种模式，通过 `type` 变量区分。弹窗表单需注意：

- 相同父元素的子元素必须有独特 key
- 表单通过 `v-if` 动态控制字段显隐
- 弹窗宽度控制：400/800/1000，支持最大化 `maximize=true`

### 数据列表

封装成表格组件，包含数据表格和分页，通过 `gridData` 属性获取数据。

## 通用组件

### 文件批量导入 CommonFileUpload

支持文件的批量导入上传功能，通过组件调用方式引入。

### 打印凭证（Lodop）

凭证打印采用模板设计方式：

1. **新增模板** — 选择业务打印类型，关联产品
2. **模板设计** — 仅支持 IE 浏览器设计
3. **调用打印** — `this.$print.vochPrint(this, options)`

> 提示：清单分页时需设置 `Offset2Top` 属性控制次页边距偏移。

### 记账分录展示 acctRecord

支持两种模式：
- **显示分录**：弹窗展示记账分录，用户确认后记账
- **不显示分录自动记账**：调用方式一致，改动点在于显示控制

## 相关页面

- [[vuejs]] — Vue.js 框架
- [[h-ui-component-library]] — H-UI 组件库
- [[lodop-print]] — Lodop 打印控件
- [[hundsun-bill-trade-v5-backend]] — 票据交易平台后端
- [[消息通道]] — HUNDSUN 平台中 TCP/HTTP/IBM MQ 三种通讯方式的抽象层，支持多通道并行与 SSL 安全配置
- [[消息转换]] — HUNDSUN 平台中内部 JSON 与外部报文的双向转换机制
- [[hundsun-frontend-coding-standards|恒生电子前端编码规范]] — 恒生电子前端编码规范
- [[恒生票据交易管理平台V5.0前端组件]] — 平台Vue前端组件体系，涵盖文本框、下拉框、金额框、利率框、日期框等10大类业务组件
