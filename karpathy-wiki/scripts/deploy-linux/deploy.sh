#!/usr/bin/env bash
#
# Karpathy-AI+Obsidian 知识库 —— Linux 部署打包脚本
#
# 目标：把本项目（Fastify 后端 + Vue SPA 前端）一键部署到 Linux 服务器，
# 交付可维护的服务化运维流程：环境检查 → 构建 → (可选打包) → 安装 → 启停 → 日志 → 排障。
# 为什么独立于 Windows 的 build-exe.ps1：原脚本依赖 Windows 专属工具链（w64devkit、
# windres、Inno Setup、.cmd/.bat），且 pkg 打包 target 固定为 win；本项目后端为纯 JS
# 依赖（无原生 binding，adm-zip/pdf-parse/chokidar 等均跨平台），esbuild 与 @yao-pkg/pkg
# 本身跨平台，可平滑迁到 Linux。
#
# 部署策略（就地运行）：
#   systemd 以 node 运行 esbuild 产出的单文件 bundle.cjs，工作目录固定在仓库根。
#   runtime.ts 用「向上查找 llm-presets.json」确定 api/ 根目录，因此 config.json、
#   llm-presets.json、src/prompts/ 全部命中现有 api/ 布局；数据落在仓库 data/；
#   SPA 由 spa-static.ts 探测顺序命中 release/spa/public（vite 构建产物）伺服。零目录重排。
#
# 用法：
#   sudo ./deploy.sh install           # 装系统依赖 + 修正 harness 路径 + pnpm install
#   ./deploy.sh build                  # 构建前端 SPA + esbuild 出后端 bundle.cjs
#   ./deploy.sh pkg                    # 可选：@yao-pkg/pkg 打单个 Linux ELF（资源仍走外部文件）
#   sudo ./deploy.sh install-service   # 写入 systemd 单元并启动
#   ./deploy.sh start | stop | restart | status
#   ./deploy.sh logs [行数]            # 查看日志（默认 follow）
#   ./deploy.sh selfcheck              # 体格检查 + 排障提示
#   ./deploy.sh uninstall
#
# 兼容性：Bash 4.0+；包管理 apt / yum / dnf 自适应；Node 18+（与 esbuild target=node18 对齐）。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"      # git 仓库根（含 wiki-harness 同级）
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"       # karpathy-wiki（含 api/ frontend/ scripts/）
SERVICE_NAME="karpathy-wiki"
RUN_USER="${KARPATHY_USER:-$(logname 2>/dev/null || echo "${USER:-root}")}"
BUNDLE="$PROJECT_DIR/api/.build/bundle.cjs"
NODE_MIN_MAJOR=18

# 终端配色：仅交互终端启用，重定向日志时自动降级为纯文本
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_INFO=$'\033[36m'; C_END=$'\033[0m'
else C_OK=""; C_WARN=""; C_ERR=""; C_INFO=""; C_END=""; fi

info()  { echo "${C_INFO}[INFO]${C_END} $*"; }
ok()    { echo "${C_OK}[OK]${C_END} $*"; }
warn()  { echo "${C_WARN}[WARN]${C_END} $*"; }
err()   { echo "${C_ERR}[ERR]${C_END} $*" >&2; }
die()   { err "$*"; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

pkg_install() { # 包管理器自适应，避免在缺失依赖时重复 update
  local pkgs=("$@")
  if command_exists dnf; then sudo dnf install -y "${pkgs[@]}"
  elif command_exists yum; then sudo yum install -y "${pkgs[@]}"
  elif command_exists apt-get; then sudo apt-get update -qq && sudo apt-get install -y "${pkgs[@]}"
  else die "未识别的包管理器（仅支持 apt/yum/dnf）"; fi
}

# 按检测到的包管理器安装 Node LTS 20（与 pkg_install 同一份判序）。
# 为什么不能写死 apt：脚本自适应 apt/yum/dnf，node 缺失时若仍 curl deb 的 nodesource
#   源，RHEL/CentOS(yum/dnf) 会因源不匹配而失败。dnf/yum 走 rpm 的 nodesource 源。
install_node() {
  if command_exists apt-get; then
    info "apt 系统：用 nodesource 官方源安装 Node LTS 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash
    sudo apt-get install -y nodejs
  elif command_exists dnf; then
    info "dnf 系统：启用 nodesource RPM 源并安装 Node 20..."
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo dnf install -y nodejs
  elif command_exists yum; then
    info "yum 系统：启用 nodesource RPM 源并安装 Node 20..."
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo yum install -y nodejs
  else
    die "未识别的包管理器，无法自动安装 Node；请手动安装 Node 18+ 后重试"
  fi
}

## ── 1. 安装依赖 ───────────────────────────────────────────
cmd_install() {
  info "安装系统依赖与项目依赖（需要 sudo）..."
  local syspkgs=()
  command_exists curl || syspkgs+=(curl)
  # make/gcc：@yao-pkg/pkg 从源码构建 Node 二进制时的备用编译链（一般用不到）。
  command_exists make || syspkgs+=(make)
  # git：后端以 child_process 调 git 收集 schema/静态页信息，缺失仅使相关功能降级，问答不受影响。
  command_exists git  || { warn "未检测到 git（建议安装，问答不受影响）"; syspkgs+=(git); }
  if [ "${#syspkgs[@]}" -gt 0 ]; then pkg_install "${syspkgs[@]}"; fi

  if command_exists node; then
    local nmj; nmj=$(node -p 'process.versions.node.split(".")[0]')
    [ "$nmj" -lt "$NODE_MIN_MAJOR" ] && die "Node $nmj < $NODE_MIN_MAJOR，请升级 Node 18+"
  else
    install_node
  fi

  # pnpm：本项目用 pnpm workspace；corepack 随 Node 分发，优先用它，避免额外 curl
  command_exists pnpm || { sudo corepack enable 2>/dev/null || sudo npm install -g pnpm@11; }

  # 关键修正：根 package.json 依赖 @wiki/harness 指向 Windows 绝对盘符“file:D:/...”，
  # 在 Linux 上无法 resolve 会导致 pnpm install 失败，改为相对仓库的 ../wiki-harness。
  # 仅改根 package.json；api/package.json 已是相对路径 file:../../wiki-harness，不受影响。
  local root_pkg="$REPO_ROOT/package.json"
  if [ -f "$root_pkg" ] && grep -q 'file:D:' "$root_pkg"; then
    info "修正根 package.json 中 @wiki/harness 的 Windows 绝对路径..."
    sed -i 's#"@wiki/harness"[[:space:]]*:[[:space:]]*"file:D:[^"]*"#"@wiki/harness": "file:../wiki-harness"#' "$root_pkg"
  fi

  info "pnpm install 安装项目依赖..."
  ( cd "$REPO_ROOT" && pnpm install ) || die "pnpm install 失败"
  ok "依赖就绪：node=$(node -v) pnpm=$(pnpm --version 2>/dev/null || echo '?')"
}

## ── 2. 构建 ───────────────────────────────────────────────
cmd_build() {
  info "1/2 构建前端 SPA（vue-tsc 类型检查 + vite build → release/spa/public）..."
  ( cd "$PROJECT_DIR/frontend" && pnpm run build ) || die "前端构建失败"
  # 说明：spa-static.ts 的 resolveSpaRoot 探测顺序会命中 release/spa/public（第 4 位）伺服，
  # 因此无需额外拷贝；frontend/dist 仅作为更靠后的兜底候选。

  info "2/2 esbuild 打包后端 TS → 单文件 CJS（target=node18，与 Windows 发布一致）..."
  mkdir -p "$(dirname "$BUNDLE")"
  # 直接调用 esbuild 的 JS 入口而非 .bin shim：跨平台且不依赖 shell 包装。
  # import.meta.url 处理：源码用它定位 config/prompts 等资源，而 --format=cjs 下 import.meta
  # 不可用，故 banner 注入 CJS 等价式 + --define 替换；检测 __filename 是否存在，
  # 因为 SEA/ELF 中该文件不存在时须以 process.execPath 定位 exe 同级资源。
  # @wiki/harness 是 file: sibling 包，不能 --external，必须打进 bundle。
  node "$PROJECT_DIR/node_modules/esbuild/bin/esbuild" \
    "$PROJECT_DIR/api/src/index.ts" \
    --bundle --platform=node --format=cjs --target=node18 \
    --loader:.node=copy \
    --banner:js="var __import_meta_url=require('url').pathToFileURL(require('fs').existsSync(__filename)?__filename:process.execPath).href" \
    --define:import.meta.url=__import_meta_url \
    --log-level=info \
    --outfile="$BUNDLE"
  [ -f "$BUNDLE" ] || die "esbuild 打包失败，未产出 bundle.cjs"
  ok "构建完成：$BUNDLE + release/spa/public"
}

## ── 3. 可选：打包单个 Linux ELF ───────────────────────────
cmd_pkg() {
  [ -f "$BUNDLE" ] || { warn "先执行 build"; cmd_build; }
  # 能 require 到即证明 @yao-pkg/pkg 已安装；否则提示补装
  if ! node -e "require('$PROJECT_DIR/node_modules/@yao-pkg/pkg')" 2>/dev/null; then
    die "缺少 @yao-pkg/pkg，请先 pnpm install"
  fi
  info "用 @yao-pkg/pkg 打 Linux ELF（--sea 单文件，target=node18-linux-x64）..."
  # 入口用 lib-es5/bin.js 与 Windows build-exe.ps1 保持一致；--sea 会把 Node 运行时打进单个
  # 可执行，但本项目的 config/llm-presets/prompts 仍走外部文件（runtime.ts），无需注入 assets。
  # ARM 服务器把 target 中 -x64 换成 -arm64 即可。
  node "$PROJECT_DIR/node_modules/@yao-pkg/pkg/lib-es5/bin.js" \
    "$BUNDLE" --sea \
    --output "$PROJECT_DIR/.build/karpathy-wiki" \
    --options max-old-space-size=512
  ok "ELF 已生成：$PROJECT_DIR/.build/karpathy-wiki（配合仓库 resources 使用）"
}

## ── 4. systemd 服务 ───────────────────────────────────────
_unit() { [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; }

cmd_install_service() {
  [ -f "$BUNDLE" ] || die "缺少 bundle.cjs，先执行 build"
  # 写系统目录前做权限自检：非 root 时 cat 会静默失败（脚本无 set -e），
  # 导致「看着执行完、单元却未写入、服务没装上」的伪成功。整脚本应 sudo 运行。
  if [ ! -w /etc/systemd/system ]; then
    die "无权限写入 /etc/systemd/system，请用 sudo ./deploy.sh install-service 运行"
  fi
  info "写入 systemd 单元 $SERVICE_NAME.service（用户=$RUN_USER）..."
  cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Karpathy Wiki (Fastify + Vue SPA on Linux)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
# 工作目录固定仓库根：runtime.ts 据此解析 api/ 资源、data/、SDK/SPA 路径。
WorkingDirectory=$PROJECT_DIR
Environment=NODE_ENV=production
Environment="HOME=/home/$RUN_USER"
ExecStart=/usr/bin/env node $BUNDLE
Restart=on-failure
RestartSec=5
# 后端含 SSE 长连接，日志交给 journald 统一轮转，避免直写文件失控。
StandardOutput=journal
StandardError=journal
KillMode=mixed
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE_NAME"
  cmd_status
}

_service() { sudo systemctl "$1" "$SERVICE_NAME"; }
cmd_start()    { _service start; }
cmd_stop()     { _service stop; }
cmd_restart()  { _service restart; }
cmd_status()   { _service status --no-pager; }
cmd_logs()     { local n="${1:-200}"; sudo journalctl -u "$SERVICE_NAME" -n "$n" --no-pager -f; }

cmd_selfcheck() {
  echo "${C_INFO}== 环境自检 ==${C_END}"
  echo -n "  node  : "; command_exists node && node -v || echo "缺失"
  echo -n "  pnpm  : "; command_exists pnpm && pnpm --version || echo "缺失"
  echo -n "  bundle: "; [ -f "$BUNDLE" ] && echo "就绪" || echo "缺失（需 build）"
  echo -n "  systemd: "; _unit && echo "已安装" || echo "未安装"
  echo -n "  端口3000: "; (command_exists ss && ss -ltn | grep -q ':3000 ') && echo "监听" || echo "未监听"
  echo "${C_INFO}== 排障 ==${C_END}"
  echo "  1) 启动失败先看日志：sudo journalctl -u $SERVICE_NAME -n 100 -e"
  echo "  2) POST 401/403：核对 api/config.json 的鉴权与 adminToken"
  echo "  3) '请求参数有误'：多为所选预设的 model/baseUrl 与 llm-presets.json 不匹配，确认后重启"
  echo "  4) SPA 404：release/spa/public 未生成，重跑 ./deploy.sh build"
}

cmd_uninstall() {
  if _unit; then sudo systemctl disable --now "$SERVICE_NAME"; sudo rm -f "/etc/systemd/system/$SERVICE_NAME.service"; sudo systemctl daemon-reload; fi
  read -r -p "删除体系下服务已停止；是否清理仓库数据目录 data/ 与前端产物？(y/N) " ans
  if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
    sudo rm -rf "$PROJECT_DIR/data" "$REPO_ROOT/release/spa/public"
    ok "已清理数据与前端产物"
  else
    ok "保留数据（服务单元已移除）"
  fi
}

## ── 入口 ──────────────────────────────────────────────────
case "${1:-}" in
  install)         cmd_install ;;
  build)           cmd_build ;;
  pkg)             cmd_pkg ;;
  install-service) cmd_install_service ;;
  start)           cmd_start ;;
  stop)            cmd_stop ;;
  restart)         cmd_restart ;;
  status)          cmd_status ;;
  logs)            cmd_logs "${2:-200}" ;;
  selfcheck)       cmd_selfcheck ;;
  uninstall)       cmd_uninstall ;;
  *)
    echo "用法: $0 {install|build|pkg|install-service|start|stop|restart|status|logs|selfcheck|uninstall}"
    exit 1
    ;;
esac