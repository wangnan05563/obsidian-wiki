// 将 tsc 编译产物（release/harness）回写到 dist（pnpm file: 依赖需要 package 内 dist/index.js）。
// 注意：不能用 fs.cpSync(src, dest, {recursive:true}) —— Node 24.14.0 在 Windows 上该 API 会原生崩溃
// （退出码 0xC0000409 / 3221226505）。这里改为手写递归复制（readdirSync + copyFileSync），稳定可靠。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..'); // wiki-harness
// tsc 的 outDir 是相对 tsconfig.json 的 "../release/harness"，即仓库根/release/harness
const src = path.resolve(projectRoot, '..', 'release', 'harness');
const dest = path.resolve(projectRoot, 'dist'); // wiki-harness/dist（pnpm file: 依赖需要）

function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, e.name);
    const dp = path.join(d, e.name);
    if (e.isDirectory()) {
      copyDir(sp, dp);
    } else if (e.isFile()) {
      fs.copyFileSync(sp, dp);
    }
    // 跳过符号链接/重解析点，避免潜在循环
  }
}

if (!fs.existsSync(src)) {
  console.error(`[copy-dist] 源目录不存在: ${src}`);
  process.exit(1);
}

// 注意：不直接 rmSync(dest) 清空 —— 本机全局注入了 safe-delete 钩子（NODE_OPTIONS preload），
// 批量删除会被 SAFE_DELETE_BULK_CONFIRM_REQUIRED 拦截。改为「只覆盖复制」：
// copyFileSync 会覆写既有文件；源码中已删除的文件在 dist 留下的极少数旧副本无害
// （EXE 打包只按需 import 实际用到的模块，不影响产物）。
copyDir(src, dest);
console.log(`[copy-dist] 已回写 ${src} -> ${dest}`);
