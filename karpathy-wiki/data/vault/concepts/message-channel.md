---
title: 消息通道
type: concept
created: 2025-01-20
updated: 2025-01-20
source: raw/wiki-batch-1784698573547-7-HUNDSUN__________V5.0-______.md
tags: [HUNDSUN, 消息通道, TCP, HTTP, IBM MQ, 通讯]
---

# 消息通道

**消息通道**（Message Channel）是 [[HUNDSUN票据交易管理平台]] 中用于与外部系统进行通讯的抽象层，目前已实现 TCP、HTTP、IBM MQ 三种通讯方式。

## 启用方式

在 `application.properties` 中配置 `spring.profiles.active` 项，例如：

- `spring.profiles.active=tcp` — 仅启用 TCP 通讯
- `spring.profiles.active=tcp,http` — 同时启用 TCP 和 HTTP 通讯

> ⚠️ 向前兼容说明：启动新版消息通道必须开启配置中心参数 `adapter.is_use_new_message_channel=1`

## 通讯方式

### TCP 通讯
| 配置项 | 说明 |
|--------|------|
| `adapter.tcp.client.host_name` | 外部系统 TCP 服务端 IP |
| `adapter.tcp.client.port` | 外部系统 TCP 服务端端口 |
| `adapter.tcp.server.port` | Adapter TCP 监听端口 |
| `adapter.tcp.netty_log_enable` | 是否启用 Netty 日志功能 |

### HTTP 通讯
支持 HTTP/HTTPS 协议，可配置 SSL 证书、内容压缩、上下文路径等参数。

| 配置项 | 说明 |
|--------|------|
| `adapter.http.client.host_name` | 外部系统 HTTP 服务端 IP |
| `adapter.http.client.port` | 外部系统 HTTP 服务端端口 |
| `adapter.http.client.uri` | 调用 URI |
| `adapter.http.client.ssl_enable` | 是否启用 HTTPS |
| `adapter.http.server.port` | Adapter 监听端口 |
| `adapter.http.server.context_path` | 上下文路径 |

### IBM MQ 通讯
支持 IBM MQ 队列消息传输，可配置队列管理器、通道、认证等。

| 配置项 | 说明 |
|--------|------|
| `adapter.mq.connection_name_list` | MQ IP 和端口列表 |
| `adapter.mq.transport_type` | 消息传输方式 |
| `adapter.mq.ccsid` | 字符集标识（Unix:819, Windows:1381） |
| `adapter.mq.queue_manager` | 队列管理器名称 |
| `adapter.mq.username` / `adapter.mq.password` | 权限认证凭证 |

## 消息通道与消息转换的关系

消息通道与 [[message-converter|消息转换]] 协同工作：消息转换负责报文的格式转换，并指定消息所路由的通道类型（TCP/HTTP/MQ）。

## 扩展机制

Adapter 已实现三种常见通讯方式，更多通讯方式由产品部持续开发集成更新，体现了可扩展的设计思想。
