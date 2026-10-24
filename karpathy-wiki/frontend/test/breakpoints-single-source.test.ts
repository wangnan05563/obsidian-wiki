import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  BREAKPOINTS,
  CANONICAL_MAX_WIDTHS,
  maxWidthQuery,
} from '../src/config/breakpoints';

// wiki四期 T02916：断点单一来源守护。
// 曾经全仓并存 480/500/600/640/700/760/768/900/1100 九档接近值，新增页面时无从判断该用哪一档，
// 且「内容列降列」类规则按视口宽定档，在侧栏壳（901-1100）下恰好失效。
// 本用例把三件事钉住：① 字面量只能是四个档位之一；② 不留空 media 块；③ 定档口径不被改回视口宽。

const SRC = resolve(__dirname, '../src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(vue|css)$/.test(name)) out.push(p);
  }
  return out;
}

const readSrc = (p: string) => readFileSync(resolve(SRC, p), 'utf8');
// 捕获组只取块体（不含收尾大括号），否则空块判据永远不成立
const MEDIA_RE = /@media[^{]*\(\s*max-width:\s*(\d+)px\s*\)\s*\{([\s\S]*?)\r?\n\}/g;

describe('config/breakpoints 档位表', () => {
  it('四档语义值固定，且 max-width 白名单由表推导', () => {
    expect(BREAKPOINTS).toEqual({ xs: 480, portable: 768, compact: 900, laptop: 1100 });
    expect([...CANONICAL_MAX_WIDTHS].sort((a, b) => a - b)).toEqual([480, 768, 900, 1100]);
    expect(maxWidthQuery('portable')).toBe('(max-width: 768px)');
  });
});

describe('全仓 @media 字面量收敛（T02916）', () => {
  const files = walk(SRC);

  it('文件确实被扫到（防目录结构变化导致用例空转）', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('所有 max-width 字面量必须是四个档位之一', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/@media[^{]*\(\s*max-width:\s*(\d+)px/g)) {
        if (!CANONICAL_MAX_WIDTHS.includes(Number(m[1]))) {
          offenders.push(`${f.replace(SRC, 'src')}: max-width ${m[1]}px`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('不得留下空的 @media 块（Config.vue 曾有 760px 空块）', () => {
    const empties: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(MEDIA_RE)) {
        if (!m[2].trim()) empties.push(`${f.replace(SRC, 'src')}: max-width ${m[1]}px`);
      }
    }
    expect(empties).toEqual([]);
  });
});

describe('平板 768-1100 定档口径', () => {
  it('MobileShell 阈值引用档位表而非字面量', () => {
    const src = readSrc('composables/useIsMobile.ts');
    expect(src).toContain("maxWidthQuery('portable')");
    expect(src).not.toContain("'(max-width: 768px)'");
  });

  it('壳层收窄（侧栏→顶部横条）留在 compact 档', () => {
    const src = readSrc('App.vue');
    const block = /@media \(max-width: 900px\) \{([\s\S]*?)\n\}/.exec(src);
    expect(block).not.toBeNull();
    // 单行横滚：菜单不换行、分组标题与纵向溢出提示条让位
    expect(block![1]).toContain('flex-wrap: nowrap');
    expect(block![1]).toMatch(/\.nav-group-label,[\s\S]*?\.nav-scroll-hint \{\s*display: none;/);
    expect(block![1]).toContain('overflow-x: auto');
  });

  it('内容列降列按 laptop 档（侧栏壳下 901-1100 的内容列比 ≤900 更窄）', () => {
    const laptopUsers: Record<string, string> = {
      'views/Dashboard.vue': '.stats-row',
      'views/Cleanup.vue': '.status-grid',
      'views/Help.vue': '.help-sidebar',
      'views/Config.vue': '.config-layout',
      'components/ConfigSideNav.vue': '.config-nav',
    };
    for (const [file, selector] of Object.entries(laptopUsers)) {
      const src = readSrc(file);
      const block = /@media \(max-width: 1100px\) \{([\s\S]*?)\n\}/.exec(src);
      expect(block, `${file} 应有 laptop 档规则`).not.toBeNull();
      expect(block![1], `${file} 的 ${selector} 应在 laptop 档内`).toContain(selector);
      // 倒挂防线：这些规则不得再退回按视口 900 定档
      expect(src, `${file} 不应残留 900 档内容列规则`).not.toContain('@media (max-width: 900px)');
    }
  });
});
