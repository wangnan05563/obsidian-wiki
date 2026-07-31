---
title: 如何配置环境变量？
type: qa
created: 2026-07-27
updated: 2026-07-27
source: qq-chat:3adee648-34ea-4c20-9889-7135ab20c022
tags: [配置, 环境变量, dotenv]
status: published
confidence: medium
answerer: 李四
ts: 2026-07-20T14:30:20Z
original_refs:
  - 在项目根目录创建 .env 文件，按 KEY=VALUE 格式写入配置，重启服务后生效。
---

## 问题

如何配置环境变量？

## 答案

在项目根目录创建 `.env` 文件，按 `KEY=VALUE` 格式写入配置，重启服务后生效。

## 补充说明

生产环境建议使用 [[dotenv]] 库来加载环境变量，这样可以更安全地管理不同环境的配置。

## 上下文

张三询问环境变量配置方法，李四给出了基本步骤，王五补充了生产环境建议使用 dotenv 库加载。

## 原文引用

> 在项目根目录创建 .env 文件，按 KEY=VALUE 格式写入配置，重启服务后生效。
