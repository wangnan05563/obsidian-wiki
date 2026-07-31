---
title: Docker 容器如何设置时区？我按官方文档设了 TZ 环境变量但没生效。
type: qa
created: '2026-07-27'
updated: '2026-07-27'
source: 'qq-chat:ba3684cc-193d-4f11-995b-8c0945e1c5d9'
tags:
  - 配置
  - 错误处理
status: draft
confidence: medium
answerer: 回答者
ts: '2026-07-20T12:00:30Z'
original_refs:
  - 除了 TZ 还需要安装 tzdata 包。
  - Alpine 镜像用 apk add tzdata。
  - Debian 镜像用 apt-get install tzdata。
  - 搞定，谢谢！
---
## 问题

Docker 容器如何设置时区？我按官方文档设了 TZ 环境变量但没生效。

## 答案

除了 TZ 还需要安装 tzdata 包。Alpine 镜像用 apk add tzdata。Debian 镜像用 apt-get install tzdata。

## 上下文

提问者在 Docker 容器中设置时区失败，解答者给出针对不同基础镜像的安装方法。

## 原文引用

- > 除了 TZ 还需要安装 tzdata 包。
- > Alpine 镜像用 apk add tzdata。
- > Debian 镜像用 apt-get install tzdata。
- > 搞定，谢谢！
