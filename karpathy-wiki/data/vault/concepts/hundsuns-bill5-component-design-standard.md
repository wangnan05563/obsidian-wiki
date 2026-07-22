---
title: 恒生票据5.0 组件设计规范
type: concept
created: 2026-03-23
updated: 2026-03-23
source: raw/wiki-batch-1784698464932-4-HUNDSUN__________V5.0-JAVA____20260323.md
tags: [编码规范, 组件设计, Java, 恒生, 票据系统]
---

# 恒生票据5.0 组件设计规范

## 概述

组件设计规范定义了恒生票据5.0平台中各模块的包层次结构、各层组件的设计细则，确保系统架构的统一性和可维护性。

## 模块包层次规范

包名统一采用小写，类名采用驼峰原则（首字母大写）。统一的结构如下：

```
com.hundsuns.bill5.{module}.{layer}
```

示例：
- `com.hundsuns.bill5.user.controller`
- `com.hundsuns.bill5.user.service`
- `com.hundsuns.bill5.user.atom`
- `com.hundsuns.bill5.user.dao`

## Controller设计规范

- 负责请求接收和响应返回
- 进行参数基础校验
- 调用Service层处理业务逻辑
- 不包含业务逻辑实现

## Service设计规范

- 核心业务逻辑编排
- 可调用多个Atom或Dao组件
- 支持事务管理
- 方法命名遵循统一规约

## Atom设计规范

- 原子服务层（Atomic Service Layer）
- 提供可复用的最小业务操作单元
- 一个Atom方法完成一个不可分割的业务操作
- 不允许跨模块调用Atom

## Dao设计规范

- 数据访问层（Data Access Object）
- 封装对数据库的CRUD操作
- 使用MyBatis等ORM框架
- 不包含业务逻辑
- SQL语句应遵循数据库规约

## DTO设计规范

- 数据传输对象，用于层间数据传递
- 避免在DTO中包含业务逻辑
- 各层间的DTO应保持清晰边界

## DO设计规范

- 数据对象，与数据库表结构对应
- 通常使用ORM注解映射
- 字段与表字段一一对应

## 相关页面

- [[hundsuns-bill5-java-coding-standard]] — 总纲规范
- [[hundsuns-bill5-application-layering]] — 应用分层规范
- [[hundsuns-bill5-exception-code-standard]] — 异常码规范
