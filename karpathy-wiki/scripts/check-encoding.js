#!/usr/bin/env node
/**
 * 编码体检脚本
 *
 * 扫描两部分：
 *   1) packages/web/src 和 services/api/src 下所有 .vue / .ts 真实源文件
 *   2) 项目根元配置文件（.gitignore / .editorconfig / .vscode/settings.json）+ 根目录 .md
 *
 * 识别因被保存为 GBK 而导致的乱码问题。
 *
 * 默认排除：
 *   - *.vue.js / *.ts.js（vue-tsc 2.x 实时生成的 Volar 预转换副本）
 *   - *.js（手写冗余副本，Vite 不会加载 .ts 之外的源）
 *   - node_modules / dist / .cache 等构建产物目录
 *
 * 用法：
 *   node scripts/check-encoding.js               仅检测，exit code: 0 干净，1 有问题
 *   node scripts/check-encoding.js --json        以 JSON 格式输出报告
 *   node scripts/check-encoding.js --fix         自动转码（GBK -> UTF-8 无 BOM），仅修检测为 GBK 的文件
 *   node scripts/check-encoding.js --meta-only   只扫元配置，不扫源码
 *   node scripts/check-encoding.js --src-only    只扫源码，不扫元配置
 *
 * 修复机制：
 *   检测到 GBK 文件（GBK 解码无 0xFFFD 且含中文）后，spawn PowerShell 调用
 *   [System.Text.Encoding]::GetEncoding('GBK') 读取并以 UTF-8 无 BOM 重写。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'packages', 'web', 'src'),
  path.join(REPO_ROOT, 'services', 'api', 'src'),
];

// 只扫真实源文件；Volar 副本与手写 .js 副本显式排除
const SCAN_EXTS = new Set(['.vue', '.ts']);
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', '.cache', '.scannerwork', '.harness']);
const EXCLUDE_FILE_RE = /\.(vue|ts)\.js$/;  // *.vue.js / *.ts.js

const ARGS = new Set(process.argv.slice(2));
const JSON_MODE = ARGS.has('--json');
const FIX_MODE = ARGS.has('--fix');
const META_ONLY = ARGS.has('--meta-only');
const SRC_ONLY = ARGS.has('--src-only');

/** 扫描项目根元配置文件（.gitignore / .editorconfig / .vscode/* 等）+ 根 .md */
function collectMetaFiles() {
  const out = [];
  const targetNames = ['.gitignore', '.editorconfig', '.npmrc', '.prettierrc', '.prettierrc.json'];
  for (const n of targetNames) {
    const p = path.join(REPO_ROOT, n);
    if (fs.existsSync(p)) out.push(p);
  }
  for (const d of ['.vscode', '.husky']) {
    const dir = path.join(REPO_ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && /\.(json|md|txt|cjs|mjs|yml|yaml|toml|ini|conf|cfg)$/i.test(e.name)) {
        out.push(path.join(dir, e.name));
      }
    }
  }
  for (const e of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.md')) out.push(path.join(REPO_ROOT, e.name));
  }
  return out;
}

/** 递归收集目标文件 */
function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      yield* walk(p);
    } else if (e.isFile()) {
      if (EXCLUDE_FILE_RE.test(e.name)) continue;          // *.vue.js / *.ts.js
      const ext = path.extname(e.name);
      if (!SCAN_EXTS.has(ext)) continue;                    // 只扫 .vue / .ts
      yield p;
    }
  }
}

/** 判定单文件问题，并返回是否疑似 GBK 编码保存 */
function inspect(file) {
  const buf = fs.readFileSync(file);
  const utf8Text = buf.toString('utf8');
  const issues = [];

  if (utf8Text.includes('\uFFFD')) issues.push('U+FFFD');
  if (/锟斤拷|烫烫烫|屯屯屯/.test(utf8Text)) issues.push('classic-garbled');
  if (/\?{4,}/.test(utf8Text)) issues.push('long-?');

  // 启发式判定"GBK 编码保存"：用 GBK 解码后无 0xFFFD 且含中文
  // Node 不内置 GBK 解码，spawn PowerShell 检测
  let isGbk = null;
  if (issues.length > 0) {
    isGbk = detectGbkViaPowerShell(buf);
  }

  return { issues, isGbk };
}

/** 用 PowerShell 判断字节是否按 GBK 解码得到"看起来正常的中文" */
function detectGbkViaPowerShell(buf) {
  // 把字节序列写成临时文件，让 PS 读
  const tmp = path.join(REPO_ROOT, '.tmp-encoding-check.bin');
  try {
    fs.writeFileSync(tmp, buf);
    const ps = `
      $b = [System.IO.File]::ReadAllBytes('${tmp.replace(/'/g, "''")}')
      $gbk = [System.Text.Encoding]::GetEncoding('GBK')
      $t = $gbk.GetString($b)
      $hasFFFD = $t.Contains([char]0xFFFD)
      $hasGarbled = $t.Contains('锟斤拷') -or $t.Contains('烫烫烫')
      $hasChinese = $t -match '[\\u4e00-\\u9fff]'
      if (-not $hasFFFD -and -not $hasGarbled -and $hasChinese) { 'GBK' } else { 'OTHER' }
    `.replace(/\r?\n/g, ' ');
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    const out = (r.stdout || '').trim();
    return out === 'GBK';
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** 用 PowerShell 把 GBK 文件转码为 UTF-8 无 BOM */
function fixGbkViaPowerShell(file) {
  const fp = file.replace(/'/g, "''");
  const ps = `
    $gbk = [System.Text.Encoding]::GetEncoding('GBK')
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $b = [System.IO.File]::ReadAllBytes('${fp}')
    $t = $gbk.GetString($b)
    if ($t.Contains([char]0xFFFD) -or $t.Contains('锟斤拷') -or $t.Contains('烫烫烫')) {
      Write-Output 'SKIP'; exit 0
    }
    if ($t -notmatch '[\\u4e00-\\u9fff]') { Write-Output 'SKIP'; exit 0 }
    [System.IO.File]::WriteAllBytes('${fp}', $utf8.GetBytes($t))
    Write-Output ('OK {0} {1} -> {2}' -f '${path.basename(file)}', $b.Length, $utf8.GetBytes($t).Length)
  `.replace(/\r?\n/g, ' ');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

// === 主流程 ===
const results = [];
let totalSrc = 0;
let totalMeta = 0;

// 1) 扫描源码（.vue / .ts）
const srcFiles = [];
if (!META_ONLY) {
  for (const root of SCAN_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const f of walk(root)) {
      srcFiles.push(f);
    }
  }
  for (const f of srcFiles) {
    totalSrc++;
    const { issues } = inspect(f);
    if (issues.length === 0) continue;
    results.push({ file: path.relative(REPO_ROOT, f), kind: 'src', issues });
  }
}

// 2) 扫描元配置（.gitignore / .editorconfig / .vscode/* / 根 .md）
const metaFiles = [];
if (!SRC_ONLY) {
  for (const f of collectMetaFiles()) metaFiles.push(f);
  for (const f of metaFiles) {
    totalMeta++;
    const { issues } = inspect(f);
    if (issues.length === 0) continue;
    results.push({ file: path.relative(REPO_ROOT, f), kind: 'meta', issues });
  }
}

if (FIX_MODE) {
  // --fix：把所有问题文件交给 PowerShell 一次性处理。
  // 独立 .ps1 脚本避免 PowerShell -Command 模式对长字符串 + 中文路径的转义问题。
  // 元配置和源码合并到一个 fix-encoding-all.ps1 统一处理。
  const psScript = path.join(__dirname, 'fix-encoding-all.ps1');
  console.log('=== 自动修复（GBK -> UTF-8 无 BOM）===');
  const r = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript
  ], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  // 转码后重新扫描
  console.log('');
  console.log('=== 转码后复检 ===');
  const results2 = [];
  for (const f of srcFiles) {
    const { issues } = inspect(f);
    if (issues.length > 0) results2.push({ file: path.relative(REPO_ROOT, f), kind: 'src', issues });
  }
  for (const f of metaFiles) {
    const { issues } = inspect(f);
    if (issues.length > 0) results2.push({ file: path.relative(REPO_ROOT, f), kind: 'meta', issues });
  }
  if (results2.length === 0) {
    const total = totalSrc + totalMeta;
    console.log('复检通过：所有 ' + total + ' 个文件已是 UTF-8。');
    process.exit(0);
  } else {
    console.log('仍有 ' + results2.length + ' 个问题文件（需人工介入）：');
    for (const r of results2) console.log('  [' + r.issues.join(',') + ']  ' + r.file);
    process.exit(1);
  }
}

if (JSON_MODE) {
  console.log(JSON.stringify({ totalSrc, totalMeta, problem: results.length, results }, null, 2));
  process.exit(results.length === 0 ? 0 : 1);
}

console.log('=== 编码体检 ===');
if (!META_ONLY) {
  console.log('源码目录：');
  SCAN_ROOTS.filter(fs.existsSync).forEach(r => console.log('  ' + path.relative(REPO_ROOT, r)));
}
if (!SRC_ONLY) {
  console.log('元配置 / 根 .md：');
  console.log('  .gitignore  .editorconfig  .vscode/*.json  根 *.md');
}
console.log('');

if (results.length === 0) {
  const total = totalSrc + totalMeta;
  console.log('扫描 ' + total + ' 个文件（源码 ' + totalSrc + ' + 元配置 ' + totalMeta + '），未发现 GBK 乱码。');
  process.exit(0);
}

for (const r of results) {
  const tag = r.kind === 'meta' ? '[META]  ' : '[SRC]   ';
  console.log(tag + '[' + r.issues.join(',') + ']  ' + r.file);
}
console.log('');
console.log('扫描 ' + (totalSrc + totalMeta) + ' 个文件，问题 ' + results.length + ' 个');
process.exit(1);
