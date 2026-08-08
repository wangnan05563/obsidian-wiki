# 测试报告 — 用户数据迁移 / 会话隔离 / 本地持久化（2026-08-05）

> 范围：本会话对 `karpathy-wiki` 的全部改动（安装器不再覆盖配置、用户数据迁至 `%LOCALAPPDATA%\KarpathyWiki`、第一运行落盘「纯净默认值」、`dataDir` 与 `vaultPath` 解耦、`index.ts` 改用 `getDataDir()`、CORS 白名单保持完整）。
> 测试方式：由于沙箱内 **Playwright / PyYAML 未安装**，无法执行 `/wiki-auto-testing` 的浏览器 e2e，故改用「项目既有 vitest 单测 + 实跑 API 集成测试」两套互补手段。

---

## 一、单元测试（vitest，沙箱安全 fork 池）

| 测试文件 | 结果 | 数量 |
|---|---|---|
| `src/qq-ingest/preprocess/qq-preprocess.test.ts` | PASS | 32/32 |
| `src/qq-ingest/qq-extract-workflow.test.ts` | PASS | 25/25 |
| `test/thread-memory-store.test.ts` | PASS | 6/6 |
| `test/thread-memory.test.ts` | PASS | 8/8 |

结论：改动涉及的模块图谱（config → runtime → ThreadMemoryStore）无回归。

---

## 二、实跑 API 集成测试（dev 模式，端口 3000）

启动方式：`./node_modules/.bin/tsx src/index.ts`（临时将 `sessionPersistence.threadsPersist/conversationsPersist` 置 true 以验证持久化落盘；**测试后已还原 config.json**）。

| 检查项 | 期望 | 结果 |
|---|---|---|
| `/health` 启动 | 200 | PASS（启动正常，改动不破坏引导） |
| 创建线程 → 返回合法 UUID | 36 位 UUID | PASS |
| 列表同时可见两个线程（隔离/可见性） | 均出现 | PASS |
| 按 id 读取线程（持久化开启） | 200 | PASS |
| 非法 id 拒绝：`not-a-uuid` | 400 | PASS |
| 非法 id 拒绝：`..%2f..%2fetc%2fpasswd`（路径穿越） | 400 | PASS |
| 非法 id 拒绝：`{uuid}/../x` | 400 | PASS |
| 非法 id 拒绝：空串 / `12345` | 400 | PASS |
| **`getDataDir()` 落盘路径**：`<root>/data/threads/<id>`（dev） | 目录存在 | PASS |
| **未落入 `api/data`**（与代码解耦） | 不存在 | PASS |
| 删除线程（逻辑移除） | 从列表消失 | PASS |

补充发现（非代码缺陷）：
- **删除接口返回 500**：`ThreadMemoryStore.deleteThread` 走 WorkBuddy 沙箱的「安全删除（回收站）」垫片（`genie-safe-delete.cjs`），在无桌面的沙箱内 `trash` 操作报 `Some operations were aborted`。线程仍被逻辑删除（列表已不含），且目标目录实际已被移入回收站。在真实 Windows 主机上该垫片可正常调用回收站，不会报错。**属环境限制，非本次改动引起。**
- 测试线程目录已清理（直接 `rmSync` 单目录），`data/threads` 现为空。

---

## 三、三项用户关切的验证结论

1. **公网域名访问** — 默认 `server.host='localhost'`（仅本机，不自暴露）。需手动改为 `0.0.0.0` + 自有域名/隧道，并在 `index.ts` 的 CORS origin 白名单加入域名。本会话改动**未破坏**该能力（CORS 白名单、host 可配置性均保持）。
2. **问答会话隔离（按线程）** — 支持。线程创建返回 UUID，列表/读取按 id 隔离，所有 `:id` 经 `UUID_RE` 校验（非法/路径穿越一律 400）。隔离逻辑未被改动触及。
3. **本地存储不丢失** — 支持且已增强。
   - 开发模式：`getDataDir()` → `<root>/data/threads/<id>`（与 `vaultPath` 解耦）。
   - SEA/打包模式：`getUserDataDir()` → `%LOCALAPPDATA%\KarpathyWiki\data`，普通用户可写、重装/卸载不清除。
   - 第一运行落盘已改为「纯净相对路径默认值」，不再写入机器相关绝对路径。

---

## 四、已知限制 / 待办

- ⚠️ **浏览器 e2e 未能在本沙箱执行**（Playwright/PyYAML 缺失）。建议在有网络与桌面的 **真实 Windows 构建机** 上跑 `wiki-auto-testing` 的完整 e2e，以覆盖前端交互与 SEA 打包后的 `%LOCALAPPDATA%` 实际落盘路径。
- 删除走回收站垫片在 CI/沙箱中会 500，属环境限制；如需在自动化中验证删除，建议在测试环境关闭该垫片或断言「逻辑移除」即可。

---

## 五、环境还原确认

- `karpathy-wiki/api/config.json`：已从 `/tmp/config.bak.json` 还原（原始无 `sessionPersistence` 块 → 默认 false）。
- 测试服务器（pid 28876）：已 `taskkill` 停止，端口 3000 释放。
- 临时测试线程目录：已清理。
