---
title: MySQL vs Oracle 数据库编码实践对比
type: comparison
created: 2025-01-21
updated: 2025-01-21
source: 恒生电子《数据库编码规范》
tags: [数据库, MySQL, Oracle, 对比, 编码规范]
---

# MySQL vs Oracle 数据库编码实践对比

基于[[hundsun-db-coding-standards|恒生电子数据库编码规范]]，对比两大主流数据库在编码规范上的异同。

## 设计规范对比

| 维度 | MySQL | Oracle |
|------|-------|--------|
| 存储引擎 | InnoDB 推荐（支持事务、行级锁） | 原生支持事务、PL/SQL |
| 数据类型 | 更丰富的内置类型 | 更复杂的类型体系 |
| 序列/自增 | AUTO_INCREMENT | SEQUENCE 对象 |

## 语法规范对比

| 语法项 | MySQL | Oracle |
|--------|-------|--------|
| 字符串连接 | CONCAT() 或 `\|\|`（需设置模式） | `\|\|` 操作符 |
| 分页查询 | LIMIT … OFFSET … | ROWNUM / FETCH FIRST |
| 日期函数 | DATE_FORMAT(), NOW() | TO_DATE(), SYSDATE |
| NULL 排序 | ASC 时 NULL 在前 | ASC 时 NULL 在后 |

## 脚本规范对比

| 脚本项 | MySQL | Oracle |
|--------|-------|--------|
| 块结构 | 无原生匿名块 | BEGIN … END; |
| 异常处理 | 有限支持 | EXCEPTION 块 |
| 存储过程语法 | DELIMITER / CREATE PROCEDURE | CREATE OR REPLACE PROCEDURE |

## 对象命名规则（均适用）

两者统一遵循 [[hundsun-db-coding-standards]] 的前缀规则：

- 表：无前缀
- 临时表：`t_` 或 `tmp_`
- 视图：`v_`（不建议使用）
- 索引：`idx_`
- 唯一索引：`uk_`
- 主键：`pk_`

## 相关页面

- [[hundsun-db-coding-standards]]
- [[MySQL]]
- [[Oracle]]
