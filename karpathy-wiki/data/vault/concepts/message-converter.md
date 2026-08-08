---
title: 消息转换
type: concept
created: 2025-01-20
updated: 2025-01-20
source: raw/HUNDSUN__________V5.0-______-2.md
tags: [HUNDSUN, 消息转换, MessageConverter, 接口开发]
---

# 消息转换

**消息转换**（Message Converter）是 [[HUNDSUN票据交易管理平台]] 中负责内部 JSON 消息与外部系统报文之间双向转换的机制。

## 核心接口

接口 `MessageConverter` 定义了两个核心方法：

- **`toMessage`** — 内部 JSON 转换成外部消息
- **`fromMessage`** — 外部消息转换成内部 JSON

## 命名约定

采用**约定优于配置**（Convention over Configuration）规则：
- 类名 = `{接口编号}MessageConverter`
- 同时也是 Spring Bean 的名称

## 接出消息转换（Outbound）

接出消息转换除转换消息外，还需指定该接口所路由的 [[消息通道]]。

### 继承体系

| 基类 | 适用通讯方式 |
|------|------------|
| `AbstractMessageRequestReplyConverter` | 通用基类 |
| `AbstractJmsMessageRequestReplyConverter` | IBM MQ 消息通道 |
| `AbstractTcpMessageRequestReplyConverter` | TCP 消息通道 |
| `AbstractHttpMessageRequestReplyConverter` | HTTP 消息通道 |

开发者需重写以下方法：
- `toMessage` / `fromMessage` — 消息转换
- `getDestination` — 指定接出消息通道

## 接入消息转换（Inbound）

接入消息转换需指定外部接口服务与内部服务的映射关系。

### 核心组件

| 组件 | 职责 |
|------|------|
| `AbstractMessageApplyResponseConverter` | 转换消息 + 服务码映射 |
| `AbstractMessageInterceptor` | 拦截外部消息，获取外部服务码并设定内部功能号 |
| `AbstractExceptionHandler` | 异常处理，返回通用失败消息 |

### 需重写的方法

- **`getFunctionIdMapping`** — 外部服务码与内部功能号的映射关系（外部服务码从起始至末尾前，内部功能号在数组末尾）
- **`preInvoke`** — 消息预处理，获取外部服务码并设定内部功能号
- **`postInvoke`**（可选）— 响应消息后置处理
- **`handleFailure`** — 异常处理，返回通用失败消息

> ⚠️ 接入消息处理时需要在 `@Component` 注解下额外添加 `@Primary` 注解。
