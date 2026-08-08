import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析 SPA 静态资源根目录。
 *
 * 探测顺序（动态）：
 *   1. api/public_live_<ts>（每次部署全新时间戳目录，safe-delete 钩子放行新建写入）
 *      —— 按时间戳「数值」倒序取最新者，自动置首位
 *   2. api/public_live（旧部署兜底，index.html 已被钩子锁定，几乎不再刷新）
 *   3. api/../frontend/dist（vite 默认构建产物）
 *   4. CWD/public（exe 运行模式）
 *   5. api/public（开发/api/public 或 SEA/exe/public）
 *   6. api/static/spa（兼容旧路径）
 *
 * 只要某个候选目录下存在 index.html 即采用，返回其绝对路径；都不存在返回 null。
 *
 * 健壮性要点：
 * - 单个目录 statSync 失败（如损坏的符号链接 / 无权限）不影响整体，跳过该条目；
 * - 时间戳用数值比较而非字典序，避免 13 位时间戳跨长度时排序错乱；
 * - public_live_quarantine_* 等非数字后缀会被 Number() 解析为 NaN 自动排除；
 * - 选中前做资源完整性校验（index.html 引用的首条 JS/CSS 必须存在），跳过「中断部署」的残缺包，回退上一个完整部署，避免白屏。
 */
/**
 * 判定一个候选部署目录是否为「完整可服务」的包。
 *
 * 仅判断 index.html 存在还不够：若部署脚本被中断（如 _deploy_live.mjs 复制途中被杀），
 * 会留下「index.html 已写入、但 assets/*.js|*.css 残缺」的半成品目录。resolveSpaRoot
 * 按时间戳取最新目录，若直接选中这种残缺包，浏览器会因缺少主 JS 而整页白屏。
 *
 * 故额外校验 index.html 引用的首个 JS/CSS 资源确实存在于磁盘：缺失则视为残缺、跳过，
 * 回退到上一个完整部署（或 legacy public_live），避免白屏。
 *
 * - 读取/解析失败（损坏、无权限）返回 false，不阻塞启动；
 * - index.html 无任何 .js/.css 引用（极简页）视为完整，返回 true；
 * - src/href 可能为 `/wiki/assets/...`（base=/wiki/）或 `/assets/...`，统一剥离路由前缀后按相对路径校验。
 */
function isDeployComplete(dir: string): boolean {
  const indexPath = path.join(dir, 'index.html');
  let html: string;
  try {
    html = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return false;
  }
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  if (refs.length === 0) return true;
  const first = refs[0].replace(/^\/wiki\//, '').replace(/^\/+/, '');
  try {
    return fs.existsSync(path.join(dir, first));
  } catch {
    return false;
  }
}

export function resolveSpaRoot(apiDir: string): string | null {
  const liveDirs = fs
    .readdirSync(apiDir)
    .filter((d) => d.startsWith('public_live_'))
    .map((d) => {
      const full = path.join(apiDir, d);
      try {
        const stat = fs.statSync(full);
        const ts = Number(d.replace('public_live_', ''));
        return { full, isDir: stat.isDirectory(), ts };
      } catch {
        // 损坏的符号链接 / 无权限等：跳过，不阻塞启动
        return null;
      }
    })
    .filter(
      (x): x is { full: string; isDir: boolean; ts: number } =>
        x !== null && x.isDir && Number.isFinite(x.ts),
    )
    .sort((a, b) => b.ts - a.ts) // 数值倒序：最新时间戳在前
    .map((x) => x.full);

  const candidates = [
    ...liveDirs,
    path.resolve(apiDir, 'public_live'),
    path.resolve(apiDir, '..', 'frontend', 'dist'),
    path.resolve(process.cwd(), 'public'),
    path.resolve(apiDir, 'public'),
    path.resolve(apiDir, 'static', 'spa'),
  ];

  for (const p of candidates) {
    // 不仅要求 index.html 存在，还需通过资源完整性校验（见 isDeployComplete），
    // 跳过「中断部署」的残缺包，回退到上一个完整部署。
    if (isDeployComplete(p)) {
      return p;
    }
  }
  return null;
}

/**
 * 把一个 URL 路径安全解析为 SPA 根目录下的相对资源路径。
 *
 * 用于 `/wiki/*` 等手动静态处理分支：攻击者可能传入 `/wiki/../secret.json`、
 * `/wiki/..%2f..%2fetc%2fpasswd` 之类越权路径。本函数做两件事：
 *
 *   1. 用 path.resolve 规范化（消除 `..`、`.`、冗余分隔符）；
 *   2. 校验规范化结果严格落在 spaRoot 之内（fp === spaRoot 或为 spaRoot + path.sep 的子路径）；
 *      越界一律返回 null，绝不 sendFile 根目录外的文件。
 *
 * 仅当「在根内」且「磁盘上存在且为普通文件」时才返回相对路径，否则返回 null
 * （调用方应回退到 index.html 走 SPA 路由，而非尝试 sendFile 越界路径）。
 *
 * @param spaRoot  SPA 资源根目录（绝对路径，来自 resolveSpaRoot）
 * @param urlPath  URL 中资源部分（如 `/wiki/assets/app.js` 处理后的 `assets/app.js`，或含 `../` 的恶意串）
 * @returns 根内相对路径（可直接传给 reply.sendFile），越界/缺失返回 null
 */
export function resolveSpaAsset(spaRoot: string, urlPath: string): string | null {
  const rel = urlPath.replace(/^\/+/, '');
  const fp = path.resolve(spaRoot, rel);
  const withinRoot = fp === spaRoot || fp.startsWith(spaRoot + path.sep);
  if (withinRoot && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    return rel;
  }
  return null;
}
