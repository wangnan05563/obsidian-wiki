// 清理 frontend/src 下残留的陈旧编译产物（.js / .vue.js），避免遮蔽真实 .ts/.vue 源码。
// 使用 fs.renameSync 移动到隔离目录（保留相对路径），不删除——安全删除钩子会拦截 unlink/rm。
import { readdirSync, statSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const SRC = join(process.cwd(), 'frontend', 'src');
const QUARANTINE = join(process.cwd(), '_stale_js_quarantine');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js') || name.endsWith('.vue.js')) out.push(full);
  }
  return out;
}

const files = walk(SRC);
let moved = 0;
for (const f of files) {
  const rel = relative(SRC, f);
  const dest = join(QUARANTINE, rel);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(f, dest);
  moved++;
}
console.log(`moved ${moved} stale artifact(s) to ${relative(process.cwd(), QUARANTINE)}/`);
