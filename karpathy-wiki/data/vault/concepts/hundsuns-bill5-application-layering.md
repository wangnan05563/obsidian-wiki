---
title: 恒生票据5.0 应用分层规范
type: concept
created: 2026-03-23
updated: 2026-03-23
source: raw/wiki-batch-1784698464932-4-HUNDSUN__________V5.0-JAVA____20260323.md
tags: [编码规范, 应用分层, Java, 恒生, 票据系统]
---

# 恒生票据5.0 应用分层规范

## 概述

恒生票据5.0平台定义了标准化的应用分层架构，规范了各层的职责和调用关系，以确保系统的高内聚低耦合。

## 分层架构

票据5.0平台的应用分为以下几层：

| 层次 | 职责 | 说明 |
|------|------|------|
| **Web层** | 前端交互 | 处理HTTP请求、页面渲染 |
| **Controller层** | 请求分发与控制 | 接收请求、参数校验、调用Service |
| **Service层** | 业务逻辑 | 核心业务编排与处理 |
| **Atom层** | 原子服务层 | 可复用的业务原子操作 |
| **Dao层** | 数据访问 | 数据库操作（ORM映射） |

## 各层组件定义

### DTO（Data Transfer Object）

数据传输对象，用于各层之间的数据传输。

### DO（Data Object）

数据对象，与数据库表结构一一对应。

## 各层命名规约

### Service/ATOM/DAO层方法命名

| 操作类型 | 前缀 | 示例 |
|---------|------|------|
| 获取单个对象 | `get` | `getUserById()` |
| 获取多个对象 | `query`/`find` | `queryUsers()` |
| 获取统计值 | `count` | `countActiveUsers()` |
| 插入 | `save`（推荐）/`insert`/`add` | `saveUser()` |
| 删除 | `remove`（推荐）/`delete` | `removeUser()` |
| 修改 | `update` | `updateUser()` |

## 组件调用规范

### Web层调用规范
- Web层只负责前端交互，不包含业务逻辑

### Controller层调用规范
- 接收请求参数，进行基本校验
- 调用Service层处理业务
- 返回响应结果

### Service层调用规范
- 编排业务逻辑
- 可调用Atom层或Dao层

### Atom层调用规范
- 提供可复用的原子业务操作
- 不跨模块调用

### Dao调用规范
- 仅执行数据持久化操作
- 不包含业务逻辑

## 相关页面

- [[hundsuns-bill5-java-coding-standard]] — 总纲规范
- [[hundsuns-bill5-component-design-standard]] — 组件设计规范
- [[hundsuns-bill5-exception-code-standard]] — 异常码规范
