---
title: 如何配置环境变量？请详细说明步骤。
type: qa
created: 2026-07-27
updated: 2026-07-27
source: qq-chat:c34f9a4c-957b-4400-a185-733864d54ef6
tags: [配置, 环境变量, dotenv]
status: published
confidence: medium
contested: false
original_refs:
  - 如何配置环境变量？请详细说明步骤。
  - 在项目根目录创建 .env 文件，按 KEY=VALUE 格式写入配置，重启服务后生效。
answerer: 李四
ts: 2026-07-20T14:30:20Z
---

## 问题

如何配置环境变量？请详细说明步骤。

## 答案

在项目根目录创建 `.env` 文件，按 `KEY=VALUE` 格式写入配置，重启服务后生效。

## 补充说明

- `.env` 文件通常不应提交到版本控制（已加入 `.gitignore`），以避免泄露敏感信息如 API 密钥、数据库密码等。
- 不同框架/语言加载 `.env` 的方式有所不同，例如 Node.js 使用 `dotenv` 包，Python 使用 `python-dotenv` 库。
- 配置项命名建议使用全大写加下划线风格（如 `DATABASE_URL`、`SECRET_KEY`）。
- 如需多环境配置，可考虑 `.env.development`、`.env.production` 等文件配合相应加载逻辑。
- 修改 `.env` 文件后必须重启服务才能生效。

## 相关概念

- [[dotenv]] — 环境变量管理工具/库
- [[环境变量管理最佳实践]] — 多环境配置方案

## 原文引用

> 如何配置环境变量？请详细说明步骤。

> 在项目根目录创建 .env 文件，按 KEY=VALUE 格式写入配置，重启服务后生效。
