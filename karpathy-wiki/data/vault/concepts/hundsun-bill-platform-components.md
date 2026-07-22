---
title: 恒生票据交易管理平台V5.0前端组件
type: concept
created: 2025-01-17
updated: 2025-01-17
source: wiki-batch-1784698656770-9-HUNDSUN__________V5.0-________.md
tags: [恒生电子, 票据交易, 前端组件, Vue, UI组件库]
---

# 恒生票据交易管理平台V5.0前端组件

恒生电子股份有限公司开发的 **票据交易管理平台V5.0** 提供了一套完整的前端 UI 组件体系，基于 Vue 框架构建，覆盖票据业务中常见的输入、选择、金额、日期、弹窗等场景。

## 组件分类

### 1. 文本框（Input）

| 组件名 | 说明 |
|--------|------|
| [[commonInput]] | 通用文本框，支持 text/textarea、图标搜索事件 |
| [[batchNo]] | 批次号文本框 |
| [[billNo]] | 票据号码文本框，根据票据介质和种类区分校验规则 |
| [[acptBankName]] | 承兑人开户行行名文本框 |
| [[acptName]] | 承兑人全称文本框 |
| [[socCode]] | 统一社会信用代码文本框 |
| [[orgCode]] | 组织机构代码文本框 |

### 2. 下拉菜单（Dropdown）

| 组件名 | 说明 |
|--------|------|
| [[commonDropdown]] | 通用下拉菜单，支持默认 slot 和自定义 slot |

### 3. 下拉框（Select）

| 组件名 | 说明 |
|--------|------|
| [[commonSelect]] | 通用下拉框，支持单选/多选/搜索，数据可来自数据字典或后台 |
| [[billClass]] | 票据介质下拉框 |
| [[billType]] | 票据种类下拉框 |
| [[busiType]] | 业务类型下拉框 |
| [[channelSelect]] | 渠道下拉框 |

### 4. 金额框（Amount Field）

| 组件名 | 说明 |
|--------|------|
| [[commonTypeField]] | 通用金额框 |
| [[commonTypeFieldRange]] | 通用金额范围框 |
| [[billMoneyRange]] | 票据金额范围框 |

### 5. 利率框（Rate Field）

| 组件名 | 说明 |
|--------|------|
| [[commonRate]] | 通用利率框 |
| [[commonRateRange]] | 通用利率范围框 |

### 6. 日期框（Date Picker）

| 组件名 | 说明 |
|--------|------|
| [[commonDatePicker]] | 通用日期框 |
| [[commonTimePicker]] | 通用时间框 |
| [[remitDtRange]] | 出票日期范围框 |
| [[dueDtRange]] | 汇票到期日范围框 |

### 7. 单选框（Radio）

| 组件名 | 说明 |
|--------|------|
| [[isCommitRadio]] | 是否已提交互斥单选框 |

### 8. 弹窗（Modal）

| 组件名 | 说明 |
|--------|------|
| [[commonTree]] | 通用树弹窗 |
| [[cpesBranchMsgbox]] | 票交机构弹窗 |
| [[custCorpMsgBox]] | 企业客户弹窗 |

### 9. 通用业务组件（Business Components）

| 组件名 | 说明 |
|--------|------|
| [[simpleSelectLink]] | 联想组件 |
| [[showBranch]] | 机构弹出框组件 |
| [[showEcdsBranch]] | ECDS机构弹出框组件 |
| [[showCpesBranch]] | 票交机构弹出框组件 |
| [[showCustCorp]] | 企业客户弹出框组件 |
| [[showProduct]] | 产品名称弹出框组件 |

### 10. 通用组件（Common Components）

| 组件名 | 说明 |
|--------|------|
| [[queryBtn]] | 表单查询按钮 |
| [[Hdatagrid]] | 表格组件 |

## 技术特点

- **基于 Vue 框架**，组件以 Vue 单文件组件形式提供
- **支持数据字典**：下拉框组件支持从数据字典或后台接口获取选项数据
- **业务专用校验**：如 `billNo` 组件根据票据介质（纸票/电票）和票据种类（银票/商票）自动切换校验规则
- **国际化支持**：组件通过 `$t()` 函数调用多语言资源
- **通用性与专用性结合**：提供通用组件（commonInput/commonSelect）用于不常用字段，也提供专用业务组件（billNo/billClass）用于高频字段

## 相关实体

- [[恒生电子]] — 组件所属公司
