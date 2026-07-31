---
title: Docker 容器如何设置时区？
type: qa
created: '2026-07-23'
updated: '2026-07-23'
source: 'qq-chat:8f915b7c-6ae4-420e-b297-98f6eb73b50d'
tags:
  - 配置
  - 部署
status: draft
confidence: medium
answerer: 回答者
ts: '2026-07-20T12:00:30Z'
original_refs:
  - |-
    Docker 容器如何设置时区？
    我按官方文档设了 TZ 环境变量但没生效。
  - |-
    除了 TZ 还需要安装 tzdata 包。
    Alpine 镜像用 apk add tzdata。
    Debian 镜像用 apt-get install tzdata。
---

## 问题

Docker 容器如何设置时区？我按官方文档设了 TZ 环境变量但没生效。

## 答案

除了 TZ 还需要安装 tzdata 包。Alpine 镜像用 `apk add tzdata`。Debian 镜像用 `apt-get install tzdata`。

## 上下文

用户反馈仅设置 TZ 变量无效，回答者补充必须安装 tzdata 包并给出不同发行版的安装命令。

## 原文引用

- > Docker 容器如何设置时区？
我按官方文档设了 TZ 环境变量但没生效。
- > 除了 TZ 还需要安装 tzdata 包。
Alpine 镜像用 apk add tzdata。
Debian 镜像用 apt-get install tzdata。

