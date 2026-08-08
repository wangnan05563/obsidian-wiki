#!/usr/bin/env node
/**
 * 迁移脚本：将 vault/raw/ 下带内部临时前缀的存档文件名清洗为可识别名称，
 * 并同步更新所有编译页面 frontmatter 里的 `source:` 引用。
 *
 * 背景：
 *   旧实现把上传临时文件名（wiki-batch-<ts>-<i>-<orig> / wiki-compile-<ts>-<orig>）
 *   直接作为 raw 存档名，导致用户看到 "wiki-batch-1785896202865-0-00____...20240822.md"
 *   这类无法识别的文件（见 compile-workflow / cleanup 修复）。本脚本处理存量数据。
 *
 * 行为：
 *   - 默认 dry-run：只打印将要执行的重命名与引用改写，不改动任何文件。
 *   - --apply：真正执行重命名 + 改写。
 *   - 默认启用 --recover-title：若某 raw 仅被一个编译页引用且该页有“干净”的 title，
 *     则用该 title 作为新文件名（可恢复中文原标题）；否则仅剥掉内部前缀。
 *   - --vault <path>：指定 vault 根目录（默认脚本上级的 ../data/vault）。
 *
 * 安全性：
 *   - 绝不删除文件，仅重命名 + 文本替换。
 *   - 重名冲突自动追加 -2 / -3 后缀。
 *   - 仅匹配内部前缀（wiki-batch-<digits>-<digits>- / wiki-compile-<digits>-），
 *     不会动用户自己命名的中文源文件。
 *
 * 用法：
 *   node scripts/migrate-raw-filenames.mjs                 # 预览
 *   node scripts/migrate-raw-filenames.mjs --apply         # 执行
 *   node scripts/migrate-raw-filenames.mjs --vault /path/to/vault --apply
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};

const apply = has('--apply');
const recoverTitle = !has('--no-recover-title');
const vault = opt('--vault')
  ?? path.resolve(process.cwd(), '..', 'data', 'vault');
const rawDir = path.join(vault, 'raw');

const INTERNAL_PREFIX = /^(wiki-batch-\d+-\d+-|wiki-compile-\d+-)/;

function stripPrefix(name) {
  return name.replace(INTERNAL_PREFIX, '');
}

// 仅保留文件系统安全字符（保留中文/字母/数字/._-），用于 title 推导的新名
function sanitizeFsName(name) {
  let n = name.trim().replace(/[/\\?%*:|"<>]/g, '_');
  // 去掉首尾空白与点（避免以 . 结尾的非法名）
  n = n.replace(/^[.\s]+|[.\s]+$/g, '');
  return n || 'untitled';
}

function isCleanTitle(t) {
  if (!t || typeof t !== 'string') return false;
  if (t.length < 1 || t.length > 120) return false;
  // 至少含一个字母/数字/中文，排除纯符号或纯数字时间戳
  return /[\p{L}\p{N}]/u.test(t) && !/^[\d_-]+$/.test(t);
}

async function listRawFiles() {
  const entries = await fs.readdir(rawDir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

async function walkMd(dir, acc = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'raw') continue; // raw 内部文件不视为“编译页”
      await walkMd(p, acc);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      acc.push(p);
    }
  }
  return acc;
}

function extractTitle(content) {
  const m = content.match(/^title:\s*(.+)$/m);
  if (!m) return null;
  let t = m[1].trim();
  // 去引号
  t = t.replace(/^['"]|['"]$/g, '');
  return t;
}

function extractSourceTargets(content) {
  // 收集本页 source: 引用的 raw 文件名（raw/<name> 形式）
  const out = [];
  const re = /^source:\s*['"]?raw\/([^'"\s]+)['"]?/gm;
  let m;
  while ((m = re.exec(content)) !== null) out.push(m[1]);
  return out;
}

async function main() {
  console.log(`vault: ${vault}`);
  console.log(`mode : ${apply ? 'APPLY' : 'DRY-RUN'}  recover-title: ${recoverTitle}`);
  console.log('---');

  let rawFiles;
  try {
    rawFiles = await listRawFiles();
  } catch (e) {
    console.error(`无法读取 raw 目录: ${rawDir}\n${e.message}`);
    process.exit(1);
  }

  const toMigrate = rawFiles.filter((f) => INTERNAL_PREFIX.test(f));
  if (toMigrate.length === 0) {
    console.log('未发现需要迁移的内部前缀文件。');
    return;
  }
  console.log(`发现 ${toMigrate.length} 个待迁移 raw 文件（共 ${rawFiles.length} 个 raw 文件）。`);

  // 收集所有编译页，并一次性预读内容到缓存（避免同一页面被多次 readFile：refs 收集、文件名推导、source 改写）
  const pages = await walkMd(vault);
  console.log(`扫描 ${pages.length} 个编译页面以定位 source: 引用。`);

  const pageCache = new Map(); // pagePath -> content
  for (const page of pages) {
    pageCache.set(page, await fs.readFile(page, 'utf8'));
  }

  // 建立 oldName -> 引用它的页面列表
  const refs = new Map(); // oldName -> [pagePath]
  for (const page of pages) {
    const content = pageCache.get(page);
    const targets = extractSourceTargets(content);
    for (const t of targets) {
      if (INTERNAL_PREFIX.test(t)) {
        if (!refs.has(t)) refs.set(t, []);
        refs.get(t).push(page);
      }
    }
  }

  // 计算新文件名（处理重名）
  const renameMap = new Map(); // oldName -> newName
  const used = new Set(rawFiles); // 当前已占用的名字
  for (const oldName of toMigrate) {
    let newName;
    if (recoverTitle) {
      const pagesRef = refs.get(oldName) ?? [];
      // 收集引用页里“干净”的 title，若唯一（单引用或所有引用页 title 一致）则采用
      const cleanTitles = new Set();
      for (const p of pagesRef) {
        const title = extractTitle(pageCache.get(p));
        if (isCleanTitle(title)) cleanTitles.add(title);
      }
      if (cleanTitles.size === 1) {
        const ext = path.extname(oldName) || '.md';
        newName = sanitizeFsName([...cleanTitles][0]) + ext;
      }
    }
    if (!newName) newName = stripPrefix(oldName);

    // 冲突处理
    if (used.has(newName)) {
      const ext = path.extname(newName);
      const base = newName.slice(0, newName.length - ext.length);
      let i = 2;
      while (used.has(`${base}-${i}${ext}`)) i++;
      newName = `${base}-${i}${ext}`;
    }
    used.add(newName);
    renameMap.set(oldName, newName);
  }

  // 执行
  let renamed = 0;
  let patchedPages = 0;
  const errors = [];

  for (const [oldName, newName] of renameMap) {
    const refPages = refs.get(oldName) ?? [];
    console.log(
      `${apply ? 'RENAME' : 'would rename'}: ${oldName}\n` +
        `               -> ${newName}  (refs: ${refPages.length})`
    );
    if (apply) {
      try {
        await fs.rename(path.join(rawDir, oldName), path.join(rawDir, newName));
        renamed++;
      } catch (e) {
        errors.push(`rename ${oldName} -> ${newName} 失败: ${e.message}`);
        continue;
      }
    }
  }

  if (apply) {
    // 改写所有编译页里的 source: 引用（复用 pageCache，避免重复 IO）
    for (const page of pages) {
      let content = pageCache.get(page);
      let changed = false;
      for (const [oldName, newName] of renameMap) {
        const re = new RegExp(`(raw/)(${escapeRe(oldName)})(?=["'\\s]|$)`, 'g');
        if (re.test(content)) {
          // 函数式替换：避免 newName 中含 '$' 被 String.replace 误当作捕获组引用
          content = content.replace(re, (_, g1) => `${g1}${newName}`);
          changed = true;
        }
      }
      if (changed) {
        await fs.writeFile(page, content, 'utf8');
        pageCache.set(page, content);
        patchedPages++;
      }
    }
  } else {
    // dry-run：统计会影响多少页
    const affected = new Set();
    for (const [oldName] of renameMap) {
      for (const p of refs.get(oldName) ?? []) affected.add(p);
    }
    patchedPages = affected.size;
  }

  console.log('---');
  console.log(
    apply
      ? `执行完成：重命名 ${renamed}/${renameMap.size} 个文件，改写 ${patchedPages} 个页面的 source: 引用。`
      : `预览完成：将重命名 ${renameMap.size} 个文件，影响 ${patchedPages} 个页面的 source: 引用。`
  );
  if (errors.length) {
    console.log('错误:');
    for (const e of errors) console.log('  - ' + e);
  }
  if (!apply) {
    console.log('\n这是预览，未做任何改动。确认无误后加 --apply 执行。');
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
