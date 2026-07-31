---
title: Docker 容器如何设置时区？我按官方文档设了 TZ 环境变量但没生效。
type: qa
created: '2026-07-23'
updated: '2026-07-23'
source: 'qq-chat:673f40bc-f6ae-4263-a7eb-2e6a6286e570'
tags: [配置, 部署]
status: published
confidence: medium
answerer: 回答者
ts: '2026-07-20T12:00:30Z'
original_refs:
  - |
    Docker 容器如何设置时区？
    我按官方文档设了 TZ 环境变量但没生效。
  - |
    除了 TZ 还需要安装 tzdata 包。
    Alpine 镜像用 apk add tzdata。
    Debian 镜像用 apt-get install tzdata。
---

## 问题

Docker 容器如何设置时区？我按官方文档设了 TZ 环境变量但没生效。

## 答案

仅设置 TZ 环境变量往往不够，还需要在镜像中安装对应的时区数据软件包 `tzdata`。不同 Linux 发行版的安装命令如下：

- **Alpine 镜像**：`apk add tzdata`
- **Debian/Ubuntu 镜像**：`apt-get install tzdata`

安装完成后，容器内的进程即可正确识别和使用 TZ 环境变量设定的时区。

## 上下文

用户反馈仅设置 TZ 变量无效，回答者补充必须安装 tzdata 包并给出不同发行版的安装命令。

## 相关主题

- [[Docker 镜像最佳实践]]
- [[容器环境配置]]
