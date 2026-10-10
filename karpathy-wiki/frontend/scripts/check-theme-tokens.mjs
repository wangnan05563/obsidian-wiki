// FR-24 主题 token 完整性校验（T01762）
// ------------------------------------------------------------------
// 硬规则（SRS FR-24 规格 3 / NFR-2）：任何主题的激活背景都必须同步声明
// --tk-accent-fg。为什么用脚本而非人工 review：T01630 的「浅色激活背景上
// 白图标不可见」事故根源就是新主题容易漏配前景色，构建期静态校验可以
// 把这类回归拦在合入之前，而不是靠视觉巡检兜底。
//
// 校验规则：扫描 src/styles/**/*.css 与 src/style.css，对每个
// [data-theme="X"] 主题块要求 8 个 --tk-* token 全部显式声明
// （accent-fg 为核心，其余 7 项一并校验防止「半迁移」主题混入）。
//
// 接入：frontend build 前置门禁（package.json build 脚本）；
// 核心逻辑导出供 vitest 单测（test/theme-tokens.test.ts）。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_TOKENS = [
  '--tk-base',
  '--tk-surface',
  '--tk-surface-2',
  '--tk-accent',
  '--tk-accent-fg',
  '--tk-text',
  '--tk-text-2',
  '--tk-border',
];

/** 从 CSS 文本提取所有 [data-theme="X"] 块的内容（大括号计数器防嵌套误切） */
export function extractThemeBlocks(css) {
  const blocks = [];
  const re = /\[data-theme=["']([\w-]+)["']\]\s*\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push({ theme: m[1], body: css.slice(m.index + m[0].length, i - 1) });
  }
  return blocks;
}

/**
 * 校验一组 CSS 源码：返回错误数组（空数组 = 通过）。
 * @param {Array<{file: string, css: string}>} sources
 */
export function checkThemeTokens(sources) {
  const errors = [];
  // 主题 → 声明的 token 集合；同一主题可拆多文件（如 creative.css 与未来拆分），合并后判定
  const declared = new Map();
  for (const { file, css } of sources) {
    for (const { theme, body } of extractThemeBlocks(css)) {
      if (!declared.has(theme)) declared.set(theme, new Set());
      const set = declared.get(theme);
      // 修剪注释行后匹配声明，避免「注释里提到 token 名」造成误判
      const bodyNoComments = body.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const token of REQUIRED_TOKENS) {
        // 不锚定行首：同一行多声明（压缩/手写风格）也要命中；
        // 负向后视防止 --my--tk-base 之类的长变量名误匹配
        if (new RegExp(`(?<![\\w-])${token}\\s*:`).test(bodyNoComments)) set.add(token);
      }
    }
  }
  for (const [theme, set] of [...declared.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const missing = REQUIRED_TOKENS.filter((t) => !set.has(t));
    if (missing.length > 0) {
      errors.push(
        `主题 [data-theme="${theme}"] 缺少 token 声明: ${missing.join(', ')}` +
          (missing.includes('--tk-accent-fg')
            ? '（激活背景必须配对 accent-fg，防白图标不可见回归）'
            : ''),
      );
    }
  }
  if (declared.size === 0) {
    errors.push('未找到任何 [data-theme] 主题块——样式文件被移动或命名变更，请检查校验脚本扫描范围');
  }
  return errors;
}

function collectCssFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    // 递归子目录：主题文件位于 styles/themes/ 下，漏扫会误报主题缺失
    if (name.isDirectory()) out.push(...collectCssFiles(p));
    else if (name.name.endsWith('.css')) out.push(p);
  }
  return out;
}

function main() {
  const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const styleDirs = [join(frontendRoot, 'src', 'styles'), join(frontendRoot, 'src')];
  const sources = [];
  for (const dir of styleDirs) {
    for (const p of collectCssFiles(dir)) {
      // src 根目录只取 style.css（:root 兜底主题所在），避免误扫其他层级
      if (dir.endsWith('src') && !p.endsWith('style.css')) continue;
      sources.push({ file: p, css: readFileSync(p, 'utf-8') });
    }
  }
  const errors = checkThemeTokens(sources);
  if (errors.length > 0) {
    console.error('[check-theme-tokens] 主题 token 校验失败：');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('[check-theme-tokens] 主题 token 校验通过');
}

// 被 vitest import 时不执行 CLI 入口
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
