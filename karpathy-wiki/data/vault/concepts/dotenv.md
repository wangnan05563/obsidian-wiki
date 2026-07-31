---
title: dotenv
type: concept
created: 2026-07-27
updated: 2026-07-27
source: qq-chat:c34f9a4c-957b-4400-a185-733864d54ef6
tags: [环境变量, 配置管理, dotenv]
---

## 概述

dotenv 是一种从 `.env` 文件加载环境变量的工具/库模式，广泛用于各类编程语言和框架中，帮助开发者将配置与代码分离。

## 工作原理

1. 在项目根目录放置 `.env` 文件，以 `KEY=VALUE` 格式书写配置项。
2. 应用启动时，dotenv 库读取该文件并将变量注入到进程的环境变量中。
3. 代码中通过标准环境变量 API 读取（如 Node.js 的 `process.env`、Python 的 `os.getenv`）。

## 常见实现

- **Node.js**: `dotenv` 包（npm 下载量最高的包之一）
- **Python**: `python-dotenv` 库
- **Ruby**: `dotenv` gem
- **PHP**: `vlucas/phpdotenv`
- **Go**: `godotenv`

## 最佳实践

- 永远不要将 `.env` 文件提交到 Git 仓库，应通过 `.gitignore` 排除。
- 提供 `.env.example` 作为模板，列出所有需要的键名和示例值（不含真实敏感数据）。
- 命名规范：全大写、下划线分隔，如 `DATABASE_HOST`。

## 相关页面

- [[如何配置环境变量？请详细说明步骤。]] — 环境变量配置步骤详解
- [[环境变量管理最佳实践]] — 多环境配置方案
