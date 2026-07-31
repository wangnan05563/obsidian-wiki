---
title: 环境变量配置流程
type: solution
created: '2026-07-27'
updated: '2026-07-27'
source: 'qq-chat:3adee648-34ea-4c20-9889-7135ab20c022'
tags:
  - solution
status: draft
confidence: medium
ts: '2026-07-20T14:31:00Z'
original_refs:
  - 在项目根目录创建 .env 文件，按 KEY=VALUE 格式写入配置，重启服务后生效。
  - 补充一下，生产环境建议用 dotenv 库加载，避免硬编码。
---
## 背景

讨论如何配置环境变量，涉及基本步骤和生产环境最佳实践。

## 步骤

1. 在项目根目录创建 .env 文件
2. 按 KEY=VALUE 格式写入配置
3. 重启服务后生效
4. 生产环境建议用 dotenv 库加载，避免硬编码

## 注意事项

生产环境注意使用dotenv等库安全加载，避免硬编码。

## 原文引用

- > 在项目根目录创建 .env 文件，按 KEY=VALUE 格式写入配置，重启服务后生效。
- > 补充一下，生产环境建议用 dotenv 库加载，避免硬编码。
