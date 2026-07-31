---
title: Docker 容器如何设置时区？
type: qa
created: '2026-07-27'
updated: '2026-07-27'
source: 'qq-chat:c79810cd-9c21-49df-a4f2-247cbd60290f'
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
  - 搞定，谢谢！
---
## 问题

Docker 容器如何设置时区？

## 答案

除了 TZ 还需要安装 tzdata 包。Alpine 镜像用 apk add tzdata。Debian 镜像用 apt-get install tzdata。

## 上下文

提问者说设置了 TZ 环境变量没生效，回答指出需要额外安装 tzdata 包，并给出不同基础镜像的安装命令。

## 原文引用

- > Docker 容器如何设置时区？
我按官方文档设了 TZ 环境变量但没生效。
- > 除了 TZ 还需要安装 tzdata 包。
Alpine 镜像用 apk add tzdata。
Debian 镜像用 apt-get install tzdata。
- > 搞定，谢谢！
