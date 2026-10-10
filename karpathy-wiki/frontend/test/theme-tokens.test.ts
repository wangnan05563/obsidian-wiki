// FR-24 / T01762：主题 token 完整性校验脚本单测。
// 覆盖三层：真实样式文件全量通过（防回归）、缺失 accent-fg 报错（硬规则）、
// 缺失其他 token 报错（防半迁移主题）。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkThemeTokens, extractThemeBlocks } from '../scripts/check-theme-tokens.mjs';

const stylesDir = join(__dirname, '..', 'src', 'styles');

/** 与 CLI 门禁同源的递归扫描（主题文件在 styles/themes/ 子目录） */
function collectCss(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectCss(p));
    else if (ent.name.endsWith('.css')) out.push(p);
  }
  return out;
}

function loadRealSources() {
  const sources = collectCss(stylesDir).map((p) => ({ file: p, css: readFileSync(p, 'utf-8') }));
  // style.css（:root 兜底主题所在）与构建门禁同源
  const styleCss = join(__dirname, '..', 'src', 'style.css');
  sources.push({ file: styleCss, css: readFileSync(styleCss, 'utf-8') });
  return sources;
}

describe('extractThemeBlocks', () => {
  it('提取主题名与块体', () => {
    const blocks = extractThemeBlocks('[data-theme="a"] { --tk-accent-fg: #fff; }');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].theme).toBe('a');
    expect(blocks[0].body).toContain('--tk-accent-fg: #fff');
  });

  it('单引号选择器同样可解析', () => {
    expect(extractThemeBlocks("[data-theme='x'] { --tk-base: #000; }")[0].theme).toBe('x');
  });
});

describe('checkThemeTokens', () => {
  it('真实样式目录全部主题通过校验', () => {
    expect(checkThemeTokens(loadRealSources())).toEqual([]);
  });

  it('缺失 --tk-accent-fg 报错并提示配对规则', () => {
    const css = `[data-theme="bad"] {
      --tk-base: #fff; --tk-surface: #fff; --tk-surface-2: #eee;
      --tk-accent: #0af; --tk-text: #111; --tk-text-2: #555; --tk-border: #ddd;
    }`;
    const errors = checkThemeTokens([{ file: 'fake.css', css }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('--tk-accent-fg');
    expect(errors[0]).toContain('accent-fg');
  });

  it('缺失其他 token 同样报错（防半迁移）', () => {
    const css = '[data-theme="partial"] { --tk-accent-fg: #fff; }';
    const errors = checkThemeTokens([{ file: 'fake.css', css }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('--tk-base');
  });

  it('注释中提到 token 名不视为声明', () => {
    const css = `[data-theme="comment-only"] {
      /* --tk-accent-fg: #fff; 被注释掉的声明不算数 */
    }`;
    const errors = checkThemeTokens([{ file: 'fake.css', css }]);
    expect(errors).toHaveLength(1);
  });

  it('同主题拆多文件声明可合并判定', () => {
    const a = '[data-theme="split"] { --tk-base: #fff; --tk-accent-fg: #000; }';
    const b = `[data-theme="split"] {
      --tk-surface: #fff; --tk-surface-2: #eee; --tk-accent: #0af;
      --tk-text: #111; --tk-text-2: #555; --tk-border: #ddd;
    }`;
    expect(checkThemeTokens([{ file: 'a.css', css: a }, { file: 'b.css', css: b }])).toEqual([]);
  });

  it('无任何主题块时报错（防扫描范围失效）', () => {
    const errors = checkThemeTokens([{ file: 'empty.css', css: ':root { color: red; }' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('未找到任何');
  });
});
