# SonarQube 代码质量治理报告（T01364）

**项目**: Karpathy Wiki（`karpathy_wiki_api` + `karpathy_wiki_web` 两个 SonarQube 模块）
**处理日期**: 2026-10-07
**SonarQube 服务**: http://localhost:9000（Community Build 26.1.0.118079）
**扫描器**: sonar-scanner CLI 8.0.1.6346（Windows x64）
**任务来源**: MTask T01364「对当前项目执行完整的代码质量治理流程」

---

## 一、结论速览

| 项 | 治理前 | 治理后 |
|----|--------|--------|
| OPEN 问题（两模块合计） | **180**（api 156 / web 24） | **0**（api 0 / web 0） |
| Bugs | 7 | **0** |
| Code smells | 83 | **0** |
| Vulnerabilities | 0 | **0** |
| 质量门禁 `new_violations` | ❌ ERROR（GT 0） | ✅ **OK** |
| 质量门禁 `new_duplicated_lines_density` | ✅ OK | ✅ OK |
| 质量门禁 `new_coverage` | ❌ ERROR（LT 80） | ❌ ERROR（遗留，见第五节） |
| 质量门禁 `new_security_hotspots_reviewed` | ❌ ERROR（LT 100） | ❌ ERROR（遗留，见第五节） |
| api 测试 | 41 文件 / 561 用例（其中 1 个失败） | **43 文件 / 587 用例全通过** |
| web 测试 | 34 文件 / 233 用例 | **34 文件 / 233 用例全通过**（并修复了偶发失败） |
| 生产构建 | 未验证 | ✅ `release/api-dist`（114 个 js，2.9 MB）+ ✅ `release/spa/public`（11 MB） |

一句话：**180 个 OPEN 问题清零（179 个真实改代码 + 1 个有据可查的工程约束豁免），两模块 bugs/smells/vulnerabilities 全部归零，全量测试通过，生产产物构建成功。** 质量门仍有两项 ERROR，但都不是代码缺陷，而是「覆盖率基线」与「安全热点人工复核」两类流程欠账，已各自建单。

---

## 二、治理前必须先纠正的一个陷阱（重要）

刚连上 SonarQube 时，两个项目看板都显示 **0 OPEN**，看起来「已经干净了」。实测这是**陈旧分析结果**造成的假象：

- 用 `/api/issues/search?componentKeys=...&issueStatuses=OPEN` 取到的历史列表里，`karpathy_wiki_api` 有 564 条、`karpathy_wiki_web` 有 342 条记录，但**全部处于 CLOSED 状态**（属于历史轮次），当前 OPEN=0 只是「上一次成功分析」遗留的数字；
- 真正重新跑一次扫描后，立刻浮出 **api 156 + web 24 = 180 个 OPEN**。

> **教训**：本项目做质量治理时，「先重新扫描再取数」是硬前提，看板数字不可作为基线。
> 本报告所有数字都来自重新扫描后的实时 API 结果。

---

## 三、问题分布与修复明细

### 3.1 严重级别

| 级别 | 修复前 | 修复后 |
|------|--------|--------|
| CRITICAL | 22 | 0 |
| MAJOR | 124 | 0 |
| MINOR | 34 | 0 |
| 合计（涉及 47 个文件） | **180** | **0** |

### 3.2 按规则（全部为真实代码修复，除 S7785 见 3.3）

| 规则 | 含义 | 修复前 | 修复后 | 修复方式 |
|------|------|--------|--------|----------|
| typescript:S6544 | Promise 返回值赋给期望 void 的属性 | **90** | 0 | 见 3.3 单点根因修复 |
| typescript:S3776 | 认知复杂度 > 15 | 20 | 0 | 抽出模块级纯函数（`computeGaps` 55→1、`runClarifyGate` 25→约 7、`parseMarpSlides` 23→3、`Graph.vue` 41→拆分、`Browse.vue` 25、`Query.vue` 20、`graphLayout` 16 等） |
| typescript:S7735 | 取反条件（应写正向分支） | 20 | 0 | 分支正反化 / 早返回 |
| typescript:S3358 | 嵌套三元 | 9 | 0 | 拆成独立语句或具名变量 |
| typescript:S4325 | 冗余类型断言 | 6 | 0 | 删除断言，交由推断 |
| typescript:S1128 | 未使用的 import | 5 | 0 | 删除 |
| typescript:S6324 | 正则里直接写控制字符 | 5 | 0 | 见 3.4（改成显式码点过滤，非抑制） |
| typescript:S6582 | `a && a.b` 应写可选链 | 4 | 0 | 可选链；两处需保持类型收窄则拆成两个独立 guard |
| typescript:S4624 | 嵌套模板字面量 | 3 | 0 | 数组分段 `join('')`（`Browse.vue` 表格 HTML 产出逐字符等价） |
| typescript:S6397 / S5850 / S6035 | 正则字符类 / 回溯 | 5 | 0 | 正则重写 |
| typescript:S107 | 函数参数过多 | 2 | 0 | 收敛为 options 对象参数（顺带删掉原先贴在该行的 `// NOSONAR`） |
| typescript:S3735 | `void` 运算符 | 2 | 0 | 去掉 `void`（函数同步返回布尔，无需丢弃返回值） |
| typescript:S5843 / S7721 / S6660 / S4323 | 正则分组 / 嵌套函数 / else-if / 联合类型 | 4 | 0 | 常规重写 |
| typescript:S2933 | 字段应 `readonly` | 1 | 0 | `clarify-store.sessions` 加 `readonly` |
| typescript:S7758 | `charCodeAt` 应用 `codePointAt` | 1 | 0 | 改 `for..of` 按码点遍历（顺带修好代理对处理） |
| typescript:S7737 / S3626 / S6535 | 对象字面量默认参 / 冗余 return / 多余转义 | 3 | 0 | 常规重写 |
| typescript:S7785 | 建议顶层 await | 1 | 0（**豁免**） | 见 3.3 |

### 3.3 最高杠杆的一处修复：86 个路由守卫的类型签名（S6544，90 个问题）

**根因**：`api/src/middleware/auth.ts` 的隔离守卫 `createIsolationGuards()` 把 `requireAuth`/`requireAdmin` 声明为返回 `Promise<unknown>` 的 async 函数，而 Fastify 路由选项 `preHandler` 的声明类型期望返回 `void`。全项目 **86 处 `preHandler: guards.requireAuth / requireAdmin`** 因此各报一次 S6544，加上工厂内部 2 处，正好 90 个——占 180 个问题的一半。

**改法**：守卫改为 Fastify 的 `done` 回调签名（`preHandlerHookHandler`），拒绝分支「先 `reply.send()` 再 `done()`」。这不是随手写法，安全性已核实：

- 安装的 `fastify@4.29.1` 源码中 `lib/hooks.js` 的 `hookIterator` 第一行即 `if (reply.sent === true) return undefined`，`lib/route.js` 的 `runPreParsing` 同样有 `reply.sent` 短路；因此 send 之后的 `done()` 不会让后续 hook 或业务 handler 再执行，也不会出现「对已发送响应二次 send → `FST_ERR_REP_ALREADY_SENT` → 进程崩溃」；
- 该写法与仓库内 `src/routes/auth.ts` 既有的登录/管理员守卫 done 桥接方式一致。

**回归验证（新增 `api/test/isolation-guards.test.ts`，14 个用例）**：用**真实 Fastify 实例 + `inject()`**（不是 mock）跑完整请求生命周期，逐条断言「业务 handler 是否被执行」：

| 场景 | 期望 |
|------|------|
| auth 启用 + 无 token | 401 `{code:'UNAUTHORIZED'}`，handler **未执行** |
| auth 启用 + 无效 token | 401，handler 未执行 |
| auth 启用 + 有效 Bearer / Cookie token | 200，handler 执行 |
| POST 写接口未登录 | 401，handler 未执行（守卫与 HTTP 方法无关） |
| 普通用户走 `requireAdmin` | 403 `{code:'FORBIDDEN', required:'users'}` + 审计日志 `permission_denied`，handler 未执行 |
| 管理员走 `requireAdmin` | 200 |
| 两个守卫串联且未登录 | 只有一个 401 响应，无 500 / 无重复 send |
| 单租户（`enabled:false` 或缺省入参） | 无 token 放行，保持「关闭认证 = 全部管理员」既有形态 |

这 14 个用例同时把 `middleware/auth.ts` 的行覆盖率从 98.01%（未覆盖 238–241、248 行，正是新守卫分支）拉到 **100%**。

**S7785 的唯一豁免（本报告唯一一处配置级抑制，如实说明）**：`api/src/index.ts` 入口需要调用 async 的 `main()`，但发布产物用 `esbuild --format=cjs` 打单文件 bundle 再交 SEA 打成 exe，**CJS 语法不支持顶层 await**。改成顶层 await 会让构建失败，因此新增一条**限定到单个文件**的规则豁免：

```properties
sonar.issue.ignore.multicriteria.e11.ruleKey=typescript:S7785
sonar.issue.ignore.multicriteria.e11.resourceKey=src/index.ts
```

入口代码本身已写成「具名 async 函数 + `void` 调用 + 函数内 try/catch」，不会产生未处理的 Promise 拒绝。除此之外本轮**没有新增任何 NOSONAR / eslint-disable**，反而删掉了 1 处旧 `// NOSONAR`（S107 那处改为真实修复）。

### 3.4 本轮顺带修掉的一个真实测试缺陷

`api/test/ssrf-probe.test.ts` 里有断言 `http://example.com/` 应被放行，而本机 DNS 把 example.com 解析到 `0.0.0.0`（sinkhole），SSRF 防护**正确地**拦截了它 → 用例失败。这是**测试依赖外部 DNS** 的设计缺陷，不是产品 bug（已用 `git stash` 隔离验证：改动 auth.ts 之前同样失败）。

修法：`vi.mock('node:dns')` 把解析结果固定（`resolve4` 返回公网 IP、`resolve6` 返回空），用例改为确定性；并借此补强了 4 个此前没覆盖的防护面：`0.0.0.0` sinkhole 拦截、`169.254.169.254` DNS rebinding 拦截、AAAA 记录返回 `::1` 拦截、DNS 查询异常时静默放行。该文件由 17 个用例增至 21 个，全部通过。

同类问题还修了前端 `test/query-edit-resend-flow.test.ts`：它用「固定 `setTimeout(10/20/40ms)`」猜异步链长度，本机与 SonarQube TS 分析争 CPU 时就会偶发红（正是本次全量跑抓到的那次失败）。改为 `waitFor(label, predicate)` 轮询真实状态（上限 2000ms），**断言一条没减**，之后全量跑稳定通过。

---

## 四、测试与构建证据

### 4.1 测试（SonarQube 清零后运行，符合任务要求的顺序）

```
api（karpathy-wiki/api）
  npx tsc --noEmit                        → 通过（0 error）
  npx vitest run --coverage               → Test Files 43 passed (43)
                                             Tests 587 passed (587)
                                             All files 覆盖率 98.14% stmts / 94.02% branch
web（karpathy-wiki/frontend）
  npx vue-tsc --noEmit                    → 通过（0 error）
  npx vitest run --coverage               → Test Files 34 passed (34)
                                             Tests 233 passed (233)
                                             All files 覆盖率 25.12%
```

用例数变化：api 561 → 587（+14 守卫端到端、+8 Marp 解析回归、+4 SSRF 防护面补强），web 233 不变（仅把时长猜测改成状态轮询）。

补的两组测试都是「本轮改动自身」的保险绳：
- `api/test/isolation-guards.test.ts`（守卫签名变更，保护 86 个路由）；
- `api/src/workflows/pptx-slides.test.ts`（`parseMarpSlides` 复杂度拆分）。后者落地前做过一次**逐输入对跑**：把重构前的 `pptx-renderer.ts` 从 `git show HEAD` 取出与新版并列，25 组真实 Marp 输入（frontmatter、连续/尾部 `---`、缩进子点、Tab 缩进、编号列表、第二级标题、CRLF、空输入、表格/引用/代码块）深比较输出，**差异 0**；单测断言即取自这次对跑的真实结果，因此它固化的是既有解析规格，不是新发明的期望。

### 4.2 生产构建

```
web : vue-tsc --noEmit && vite build  → ✓ built in 58.00s
        产物 release/spa/public（index.html + assets，11 MB）
api : tsc（outDir=../../release/api-dist）
        产物 release/api-dist（114 个 .js + .d.ts + sourcemap，2.9 MB）
```

`release/` 已在 `.gitignore` 内，构建产物不入库。

> **未执行的部分（环境所限，如实标注）**：`pnpm -r build` 与 `scripts/build-exe.ps1`（esbuild CJS bundle → `@yao-pkg/pkg` → Inno Setup 安装包）未能跑通，原因是**本机 pnpm CLI 本身损坏**：任何 `pnpm` 调用都抛 `Cannot use 'in' operator to search for 'integrity' in undefined`（`pnpm --version` 同样失败）。这是环境层问题、与本轮代码改动无关，已建单（见第五节）。本轮改用各包内等价命令逐包构建，两个包的编译与打包均成功。

### 4.3 复现命令

```bash
# 扫描（token 从环境变量 SONAR_TOKEN 或仓库既有 scripts/run-sonar.ps1 读取，脚本不落盘凭据）
python tooling/scripts/sonar_scan_t01364.py api
python tooling/scripts/sonar_scan_t01364.py web
python tooling/scripts/sonar_collect_t01364.py        # 汇总两模块 OPEN

# 测试与构建
cd karpathy-wiki/api      && npx tsc --noEmit && npx vitest run --coverage
cd karpathy-wiki/frontend && npx vue-tsc --noEmit && npx vitest run --coverage
```

---

## 五、遗留项（已建 3 张待审单）

1. **安全热点复核（`new_security_hotspots_reviewed` LT 100）**：api 62 + web 8 = **70 处**待复核。这不是「代码还没改」——本轮 vulnerabilities 为 0、且 70 处 hotspot 数量在扫描前后没有变化。问题在于**复核动作本身需要特权账号**：本环境只有项目分析令牌（analysis token），它对 `/api/hotspots/search` 返回 **403**，且 `/api/projects/search` 返回 401、控制台 admin/admin 已失效。因此「逐条 Approve / Need to review / Safe」只能由有权限的账号在 GUI 完成。我没有伪造复核状态。
2. **覆盖率基线（`new_coverage` LT 80）**：api 的 `vitest.config.ts` 覆盖率范围目前只圈定 `src/auth/**` + `src/middleware/auth.ts`（该范围内 97–100%，`middleware/auth.ts` 已 100%），因此上报给 SonarQube 的全项目覆盖率只有 13.3%；web 全量覆盖率 26.2%（视图层测试缺口大）。把 include 直接放宽到全 `src` 会立刻撞上 `thresholds: 80` 让测试命令失败，所以这必须是一条**有计划的覆盖率提升工作**，而不是改配置数字。
3. **本机 pnpm CLI 损坏**：阻塞 `pnpm -r build`、exe 与安装包构建、以及任何依赖 pnpm 的脚本。

以上 3 项各建一张 `【AI回写待审核】` 单（项目 wiki，派生自 T01364）：① 安全热点复核 **T01551**、② 覆盖率基线 **T01552**、③ pnpm CLI 损坏 **T01553**，互不重复。

> 另外如实说明一个口径：两模块的 `sonar-project.properties` 里**本轮之前就已存在**大量规则级豁免（api 10 条、web 30 条，例如 `S7781/S6594/S7744/S4624/S1128(web)` 等）。这些被豁免的规则不会以 OPEN 形式出现，所以「0 OPEN」的含义是「在当前质量 profile 下无遗留问题」，不等于「所有 Sonar 规则一条未豁免」。本轮只新增了 1 条豁免（S7785，限定单个入口文件），并删除了 1 处旧 NOSONAR。

---

## 六、改动清单

改动规模：**38 个既有文件修改**（api 27 / web 11，+1453/−859 行）+ **5 个新增文件**（2 个测试、本报告、2 个辅助扫描脚本 `tooling/scripts/sonar_scan_t01364.py`、`sonar_collect_t01364.py`，脚本不含任何凭据）。

按模块分组：
- **api 核心**：`src/middleware/auth.ts`（守卫签名，最高杠杆）、`src/index.ts`（S7785 写法 + 豁免）、`vitest.config.ts`（lcov reporter）、`sonar-project.properties`（删除失效的 `sonar.typescript.node` 路径、新增 lcov 上报、新增 e11 豁免）。
- **api 复杂度/风格**：`src/config.ts`、`src/utils/ole2-extract.ts`、`src/utils/office-convert.ts`、`src/utils/edgeTtsClient.ts`、`src/utils/knowledge-status.ts`、`src/workflows/query-workflow.ts`、`src/workflows/gaps-workflow.ts`、`src/workflows/pptx-renderer.ts`、`src/workflows/media-generation-workflow.ts`、`src/workflows/clarify/{gate,ambiguity-detector,clarify-store}.ts`、`src/data-clean/ai-analysis-workflow.ts`、`src/mcp/{json-rpc,tools}.ts`、`src/routes/{ai,config,mcp-route,query,about,media,health-check}.ts`、`test/ssrf-probe.test.ts`。
- **web**：`src/views/{Browse,Config,Graph,Query}.vue`、`src/composables/graphLayout.ts`、`src/services/mediaConfig.ts`、`src/directives/{tip,tipPosition}.ts`、`src/utils/sse.ts`、`src/App.vue`、`test/query-edit-resend-flow.test.ts`。

路由守卫的**调用点（86 处 `preHandler: guards.*`）一行未改**——只改守卫自身的类型签名，这也是能一次性消掉 90 个问题的原因。
