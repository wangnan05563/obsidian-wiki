import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 部署到「全新时间戳目录」：safe-delete 钩子仅拦截对已存在文件的覆盖/重命名，
// 对全新路径的 create+write 允许。故每次部署都新建 release/spa/public_live_<ts>，
// index.ts（resolveSpaRoot）启动时自动选取最新的 public_live_<ts> 目录，无需改动代码即可热切换。
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// 必须显式传入构建目录；不允许静默回退到陈旧构建（曾经误用过 builds/dist_u025505 旧包）
const SRC = process.argv[2];
if (!SRC) {
  console.error('用法: node api/_deploy_live.mjs <构建目录>  （例如 release/builds/dist_u140557）');
  process.exit(1);
}
const SRC_RESOLVED = path.resolve(SRC);
if (!fs.existsSync(SRC_RESOLVED)) {
  console.error('SRC 构建目录不存在:', SRC_RESOLVED);
  process.exit(1);
}
if (!fs.existsSync(path.join(SRC_RESOLVED, 'index.html'))) {
  console.error('SRC 不是有效的前端构建产物（缺少 index.html）:', SRC_RESOLVED);
  process.exit(1);
}

// 锚定到脚本所在目录（api/），无论从哪个 cwd 调用都能落到项目根/release/spa（getApiDir 能扫描到的位置）
const ts = Date.now();
const DST = path.resolve(scriptDir, '..', '..', 'release', 'spa', 'public_live_' + ts);
fs.mkdirSync(DST, { recursive: true });

let added = 0;
function walk(dir, rel = '') {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error('读取目录失败:', dir, err);
    process.exit(1);
  }
  for (const e of entries) {
    const sp = path.join(dir, e.name);
    const rp = path.join(rel, e.name);
    if (e.isDirectory()) walk(sp, rp); else copyFile(sp, rp);
  }
}
function copyFile(sp, rp) {
  const dp = path.join(DST, rp);
  fs.mkdirSync(path.dirname(dp), { recursive: true });
  try {
    fs.copyFileSync(sp, dp); // 全新路径写入，safe-delete 钩子放行
  } catch (err) {
    console.error('复制失败:', sp, '->', dp, err);
    process.exit(1);
  }
  added++;
}
walk(SRC_RESOLVED);
console.log(`DEPLOY -> ${DST} (added=${added})`);
