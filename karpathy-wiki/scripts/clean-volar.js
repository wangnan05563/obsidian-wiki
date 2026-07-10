// 用法：node scripts/clean-volar.js
//
// 清理 packages/web/src 下所有 Volar 预转换副本：
//   - *.vue.js
//   - *.ts.js
//   - 根目录的 types.js（vue-tsc 2.x 也会生成这个）
//
// 背景：vue-tsc 2.x 在 IDE 打开 .vue / .ts 时会实时生成同名 .js 副本
// （用于 IDE 内部类型检查的虚拟代码），它们已被 .gitignore 排除入库，
// 但留在磁盘上会污染编码扫描器。
//
// 工作区根 .vscode/settings.json 已改为 utf8（见 .editorconfig 注释），
// 新副本会按 utf8 生成，不会再是 GBK。本脚本用于一次性清理历史脏副本。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'packages', 'web', 'src');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

let removed = 0;
let kept = 0;
const files = walk(ROOT, []);
for (const f of files) {
  const base = path.basename(f);
  const isVolar = base.endsWith('.vue.js') || base.endsWith('.ts.js');
  const isTypesJs = base === 'types.js' && path.dirname(f) === ROOT;
  if (!isVolar && !isTypesJs) { kept++; continue; }
  try {
    fs.unlinkSync(f);
    console.log('DEL  ' + path.relative(path.join(__dirname, '..'), f));
    removed++;
  } catch (e) {
    console.log('FAIL ' + path.relative(path.join(__dirname, '..'), f) + '  ' + e.message);
  }
}
console.log('done: removed=' + removed + ' kept=' + kept);
