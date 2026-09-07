# Karpathy-Wiki Linux 部署可行性评估

> 对应任务：T00224「评估服务是否能部署到 linux 服务器上，编写 linux 版本部署打包脚本」
> 评估对象：Karpathy-AI+Obsidian 知识库（Fastify 后端 + Vue 3/Vite SPA 前端）
> 结论：**可部署**，配合 `scripts/deploy-linux/deploy.sh` 即可完成 Linux 服务化运行。

## 1. 系统依赖兼容性

| 依赖             | 形态                                                         | Linux 可用性                                       |
| -------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| 后端运行时          | Node.js 18+（esbuild target=node18 与开发 tsx 均依赖）             | ✅ 官方源/apt/yum/dnf 均可用                           |
| 后端依赖           | `adm-zip` `pdf-parse` `chokidar` `gray-matter` `fastify` 等 | ✅ 纯 JS，无原生 binding，无需编译                         |
| 前端             | Vue 3 + Vite（`vue-tsc` + `vite build`）                     | ✅ 跨平台，输出静态 SPA 由后端伺服                            |
| 打包链            | `esbuild` + `@yao-pkg/pkg`（`--sea`）                        | ✅ 本身跨平台，可出 Linux ELF（`target node18-linux-x64`） |
| git            | 后端经 child\_process 调用收集 schema/静态信息                        | ⚠️ 建议安装；缺失仅相关功能降级，**不影响核心问答**                   |
| ffmpeg         | 视频转写 / TTS 后处理（可选）                                         | ⚠️ 可选，缺失时对应功能自动降级                               |
| Tailscale `ln` | 隧道（tunnel）功能，Windows 专属定位                                  | ⚠️ 可选；Linux 对应 `tailscale`，且该功能默认不参与问答          |

**检出/安装中唯一必须处理的点是根** **`package.json`** **门依赖**：`@wiki/harness` 以
`file:D:/code/.../wiki-harness`（Windows 绝对盘符）声明，Linux 上无法 resolve 会导致
`pnpm install` 失败。`deploy.sh install` 已用 `sed` 自动改写为相对路径
`file:../wiki-harness`（`api/package.json` 本就用相对路径，不受影响）。

## 2. 资源需求评估

- **最小配置**：1 vCPU / 1 GB RAM / 2 GB 磁盘足够；问答质量取决于远端 LLM 服务，本地仅做编排与轻量向量。

- **构建期**：`pnpm install` + `vite build` + esbuild 打包，峰值内存约 1 GB，构建节点建议 ≥2 GB。

- 无需 GPU；Vault 为本地 Markdown 文件，不依赖数据库。

## 3. 端口与服务配置

- 生产默认监听 `3000`（`config.json → server.host=localhost, port=3000`），SPA 由 API 内置
  `@fastify/static` 伺服（单端口，无需 Nginx）。

- SPA 静态资源探测顺序最终回退到 `getApiDir()/../frontend/dist`，因此在仓库就地运行时
  `vite build` 产物即可被直接访问，**无需额外拷贝**。

- 若需外网访问，将 `server.host` 改为 `0.0.0.0` 并在安全组放行 3000；更高端口可改 `config.json`。

## 4. 权限与安全

- 端口 3000 > 1024，**无需 root 运行**；`deploy.sh install-service` 默认用非 root 用户 + systemd。

- 后端含鉴权（adminToken / 用户口令），请勿将 `config.json` 的 API Key 暴露到公网。

- 建议 systemd 隔离（`KillMode=mixed` + 专用用户），日志走 journald 统一轮转。

## 5. 部署链路（就地运行，零目录重排）

`deploy.sh` 基于**就地运行**策略：systemd 用 `node api/.build/bundle.cjs`，
工作目录固定仓库根。`runtime.ts` 以「向上查找 `llm-presets.json`」定位 api/，故：

- `config.json` / `llm-presets.json` / `src/prompts/` → 命中现有 `api/` 布局

- 数据目录 → 仓库 `data/`（`getDataDir()` = `getApiDir()/../data`）

- 用户数据（SEA 模式回退 `os.homedir()`）→ `~/KarpathyWiki`

命令一览：

```bash
sudo ./deploy.sh install             # 系统依赖 + 修正 harness 路径 + pnpm install
./deploy.sh build                    # 前端 SPA + esbuild 后端 bundle.cjs
./deploy.sh pkg                      # 可选：打单个 Linux ELF
sudo ./deploy.sh install-service     # 写 systemd 单元并启动
./deploy.sh start | stop | restart | status
./deploy.sh logs                     # journalctl 查看日志
./deploy.sh selfcheck                # 体检与排障提示
```

## 6. 结论

- **可部署**。瓶颈仅有一处（根 package.json 的 Windows 绝对路径 harness 引用），脚本已自动修正。

- 核心问答链路不依赖任何 Linux 缺失的可选组件；ffmpeg/Tailscale 缺失只影响相应扩展功能。

- 后续如需容器化，可将上述 build + bundle + systemd 步骤等效封装为 `Dockerfile` + `docker-compose`，
  数据卷挂载仓库 `data/` 即可平滑迁移。

## 关联文件

- `scripts/deploy-linux/deploy.sh` — Linux 部署打包脚本（Bash 4+，apt/yum/dnf）

- 参照 Windows 打包：`scripts/build-exe.ps1`

- 路径解析：`api/src/utils/runtime.ts`；SPA 伺服：`api/src/spa-static.ts`

