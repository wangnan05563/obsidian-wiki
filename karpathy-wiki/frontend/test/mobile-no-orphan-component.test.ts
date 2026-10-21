import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// T02794：移动端组件目录不得存在零引用组件。
//
// 为什么要落成守护用例，而不是「看到孤儿就删一次」：
//  1. 死组件会让每一轮口径普查反复多付一次判断成本——T02720 扫 `components/mobile/*.vue`
//     的 StateBlock 变体时，必须先判断「这条命中是不是死代码」，判断本身无人记账。
//  2. 更危险的是假绿：孤儿件自带面向用户的静态短句（`开发中 · 预计 M2–M5 上线`），
//     它不在任何渲染路径上，术语与三态守护扫不到真实后果；一旦被人重新接线，
//     那些从未走过守护的文案会直接进用户界面。
//  3. 因此删除 `MobilePlaceholder.vue` 只是把账清了一次，本用例负责让这笔账不再欠下：
//     新增一个没接线的 .vue 立刻变红，而不是等到下一次人工走查。
//
// 口径：引用判定扫描 frontend/src 全部 .vue/.ts（含路由与 store），
// 组件名同时匹配 PascalCase（import 与标签写法）与 kebab-case（模板标签写法），
// 两者任一命中即算「已接线」——宁可漏报孤儿，也不误报在用组件。

const SRC_DIR = path.resolve(__dirname, '../src');
const MOBILE_DIR = path.join(SRC_DIR, 'components', 'mobile');

/** 已知并登记的孤儿白名单：条目必须写明「为什么允许」与对应处置单号，否则视为违规。 */
const ALLOWED_ORPHANS: Array<{ name: string; why: string }> = [];

function collect(dir: string, exts: string[], out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/** PascalCase 文件名 → kebab-case 标签名（TtsController → tts-controller，MobileMe → mobile-me） */
function toKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

const CORPUS = collect(SRC_DIR, ['.vue', '.ts']).map((file) => ({
  file,
  text: fs.readFileSync(file, 'utf8'),
}));

const MOBILE_FILES = collect(MOBILE_DIR, ['.vue']).sort();

/** 该组件名在 src 内（排除自身文件）的引用处相对路径清单 */
function referencesOf(componentName: string, selfFile: string): string[] {
  const kebab = toKebab(componentName);
  const hits: string[] = [];
  for (const { file, text } of CORPUS) {
    if (file === selfFile) continue;
    if (text.includes(componentName) || text.includes(kebab)) {
      hits.push(path.relative(SRC_DIR, file).replace(/\\/g, '/'));
    }
  }
  return hits;
}

describe('T02794 移动端组件目录零引用守护', () => {
  it('扫描到足量文件（守护不是空跑）', () => {
    expect(MOBILE_FILES.length).toBeGreaterThanOrEqual(6);
    expect(CORPUS.length).toBeGreaterThan(100);
  });

  it('MobilePlaceholder.vue 已删除且全仓无引用（占位链路不回退）', () => {
    expect(fs.existsSync(path.join(MOBILE_DIR, 'MobilePlaceholder.vue'))).toBe(false);
    for (const { file, text } of CORPUS) {
      if (path.basename(file) === 'MobilePlaceholder.vue') continue;
      expect(text.includes('MobilePlaceholder'), `${path.basename(file)} 残留引用`).toBe(false);
      expect(text.includes('mobile-placeholder'), `${path.basename(file)} 残留引用`).toBe(false);
      expect(text.includes('mph-'), `${path.basename(file)} 残留 mph- 死样式`).toBe(false);
    }
  });

  it('components/mobile 下每个组件都至少被引用一次', () => {
    const orphans: string[] = [];
    for (const file of MOBILE_FILES) {
      const name = path.basename(file).replace(/\.vue$/, '');
      if (ALLOWED_ORPHANS.some((a) => a.name === name)) continue;
      if (referencesOf(name, file).length === 0) {
        orphans.push(`${name}.vue（零引用；如属刻意保留，请登记进 ALLOWED_ORPHANS 并写明处置单号）`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it('白名单条目必须仍在用（防止登记后组件被删而条目长存）', () => {
    for (const allowed of ALLOWED_ORPHANS) {
      const file = path.join(MOBILE_DIR, `${allowed.name}.vue`);
      expect(fs.existsSync(file), `白名单里的 ${allowed.name}.vue 已不存在，条目应删除`).toBe(true);
      expect(allowed.why.length, `${allowed.name} 的豁免必须写明理由`).toBeGreaterThan(0);
      expect(referencesOf(allowed.name, file).length, `${allowed.name} 已接线，应从白名单移除`).toBe(0);
    }
  });

  it('MobileShell 的每个 TabKey 都在主区域渲染（删占位件后不留空白 Tab）', () => {
    const shellFile = path.join(MOBILE_DIR, 'MobileShell.vue');
    const shell = fs.readFileSync(shellFile, 'utf8');
    const template = shell.slice(shell.indexOf('<template>'), shell.lastIndexOf('</template>'));
    const union = shell.match(/type TabKey = ([^;]+);/);
    expect(union, 'MobileShell 里应仍能解析出 TabKey 联合类型').toBeTruthy();
    const keys = [...union![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    const missing: string[] = [];
    for (const key of keys) {
      // 主区域内必须有 activeTab === '<key>' 的渲染分支（v-if / v-else-if / v-show 均可）
      if (!template.includes(`activeTab === '${key}'`)) missing.push(key);
    }
    expect(missing, '这些 Tab 没有任何视图承载，用户点它会得到空白页').toEqual([]);
  });

  it('底部 tabs 数组与 TabKey 取值集合一致（导航与渲染不脱节）', () => {
    const shell = fs.readFileSync(path.join(MOBILE_DIR, 'MobileShell.vue'), 'utf8');
    const union = shell.match(/type TabKey = ([^;]+);/);
    const keys = [...union![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    const tabsBlock = shell.slice(shell.indexOf('const tabs:'), shell.indexOf('const activeTab'));
    const declared = [...tabsBlock.matchAll(/key: '([^']+)'/g)].map((m) => m[1]).sort();
    expect(declared).toEqual(keys);
  });
});
