---
title: 前端请求调用规范
type: concept
created: 2025-01-22
updated: 2025-01-22
source: raw/wiki-batch-1784698732960-11-____-______.md
tags: [编码规范, API, 前端, 请求]
---

# 前端请求调用规范

恒生电子前端编码规范中关于前端与后端接口请求调用的规范约定。

## 规范要点

- 统一使用封装好的 HTTP 请求工具（如 Axios）
- 统一管理 API 接口地址
- 统一错误处理机制
- 统一请求/响应拦截器设置
- Token 和认证信息的统一管理

## 请求规范

- 使用 RESTful 风格接口
- GET 请求用于数据查询
- POST 请求用于数据创建
- PUT/PATCH 请求用于数据更新
- DELETE 请求用于数据删除

## 错误处理

- 统一处理 HTTP 状态码
- 对业务错误码进行分类处理
- 提供友好的错误提示

## 相关页面

- [[hundsun-frontend-coding-standards|恒生电子前端编码规范]]
- [[js-es6-dev-standards|JS/ES6 开发规范]]
