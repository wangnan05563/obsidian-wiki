// T02836：把 T02753 的固定时长等待守护扩面到 api 侧。
// ------------------------------------------------------------------
// 前端那份守护只扫 `frontend/test`，于是 api 侧同类反模式（T02687 同口径 grep 出来的 14 处）
// 改完之后没有任何机器口径兜着——下一个用例照样能写 `await new Promise(r => setTimeout(r, 10))`。
// 本用例做四件事：
//  1. 扫 api/test 全部用例文件，禁裸写时长的等待（含前端版抓不到的「块状 setTimeout」）；
//  2. 禁文件内自带等待原语（`const sleep =` / `function waitFor(` 等）——只准从 helpers 导入；
//  3. contractSleep 必须带非空来源说明；
//  4. 与 frontend 版比对**同一条 idle 判据**，锁死两侧口径（防止一份改了另一份悄悄漂）。
// 扫描面包含本文件自身（不留豁免口子），所以反向用例的合成样本一律用拼接构造。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const API_DIR = path.resolve(__dirname, '..');
const TEST_DIR = path.join(API_DIR, 'test');
const HELPER_PATH = path.join(TEST_DIR, 'helpers', 'waitForProgress.ts');
const FRONTEND_HELPER = path.resolve(API_DIR, '..', 'frontend', 'test', 'helpers', 'waitForProgress.ts');

/**
 * 裸写的固定时长等待：`setTimeout(r, 10)` / `setTimeout(resolve, 120)`。
 * 0 不算（让出一个宏任务节拍是合法手法，helpers 内部就这么让步）。
 */
const BARE_SLEEP = /setTimeout\(\s*[A-Za-z_$][\w$]*\s*,\s*([1-9][\d_]*)\s*\)/g;
/**
 * 块状写法：`setTimeout(() => { ...断言... }, 5)`（api 侧实测存在于 session.test.ts / permission-cache.test.ts）。
 * 前端版只抓标识符形态，这一条形态把断言整个包在回调里，是 api 侧的真实漏口。
 */
const BARE_SLEEP_BLOCK = /setTimeout\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{[\s\S]{0,800}?\}\s*,\s*([1-9][\d_]*)\s*\)/g;
/** 文件内自带等待原语：一份实现一个口径，六份 waitFor 漂移正是本单起因 */
const LOCAL_WAIT_PRIMITIVE =
  /(?:async\s+)?function\s+(sleep|tick|delay|pause|waitFor|waitUntil|sleepFor)\s*\(|(?:const|let)\s+(sleep|tick|delay|pause|waitFor|waitUntil|sleepFor)\s*=/;
/** matchAll 要求 g 旗标；判定一律走上面无状态的 test()，避免 lastIndex 串味 */
const LOCAL_WAIT_PRIMITIVE_G = new RegExp(LOCAL_WAIT_PRIMITIVE.source, 'g');
/** contractSleep(reason, ms)：reason 为空串/空模板就是没写来源 */
const EMPTY_CONTRACT_REASON = /contractSleep\(\s*(?:''|""|`\s*`|)\s*,/;
/**
 * 显式豁免口子：`T02836` 拼 `-allow:` 再跟理由（写在被豁免行上或其上一行）。
 * 只留给「根本不是等待」的定时器文本（实测唯一例子：给真子进程 `-e` 脚本里的存活时长）。
 * 标记本身必须拼出来写——直写会让本文件的说明命中自己的规则，被当成一处没豁免到东西的口子。
 * 口子必须登记在案：见「allow 口子必须登记在案」用例，新增豁免一律先红再评审。
 */
const ALLOW_TOKEN = ['T02836', '-allow:'].join('');
const ALLOW_PRAGMA = new RegExp(`${ALLOW_TOKEN}\\s*(\\S.*)$`);

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

interface AllowEntry {
  file: string;
  line: number;
  reason: string;
  used: boolean;
}

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function collectTestFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .flatMap((e) => collectTestFiles(path.join(dir, e.name)))
    .concat(
      entries
        .filter((e) => e.isFile() && e.name.endsWith('.test.ts'))
        .map((e) => path.join(dir, e.name)),
    );
}

/**
 * 去掉注释后的代码文本（保留行号：注释行替换为空行）。
 * 说明旧写法（「原先是 setTimeout(r, 10)」）必须能写出来，口径与前端守护一致；
 * 但块状规则要跨行匹配，逐行跳过注释不够，必须先剥注释再拼。
 */
function stripComments(src: string): string {
  let inBlock = false;
  return src
    .split(/\r?\n/)
    .map((raw) => {
      const t = raw.trim();
      if (inBlock) {
        if (t.endsWith('*/')) inBlock = false;
        return '';
      }
      if (t.startsWith('/*')) {
        if (!t.endsWith('*/')) inBlock = true;
        return '';
      }
      if (t.startsWith('//') || t.startsWith('*')) return '';
      // 行尾注释：按 ` //` 切（避开字符串里的 `://`——URL 前一定有空格或引号，不会误切）
      const cut = raw.search(/\s\/\//);
      return cut === -1 ? raw : raw.slice(0, cut);
    })
    .join('\n');
}

function scan(files: string[]): { violations: Violation[]; allows: AllowEntry[] } {
  const hits: Violation[] = [];
  const allowEntries: AllowEntry[] = [];
  for (const file of files) {
    const rel = path.relative(TEST_DIR, file).replace(/\\/g, '/');
    const src = fs.readFileSync(file, 'utf8');
    const pragmaByLine = new Map<number, AllowEntry>();
    src
      .split(/\r?\n/)
      .forEach((raw, i) => {
        const m = raw.match(ALLOW_PRAGMA);
        if (m) {
          const entry: AllowEntry = { file: rel, line: i + 1, reason: m[1].trim(), used: false };
          pragmaByLine.set(i + 1, entry);
          allowEntries.push(entry);
        }
      });
    const allowedAt = (line: number): boolean => {
      const e = pragmaByLine.get(line) ?? pragmaByLine.get(line - 1);
      if (!e) return false;
      e.used = true;
      return true;
    };
    const stripped = stripComments(src);
    const lines = stripped.split('\n');
    lines.forEach((text, i) => {
      const line = i + 1;
      const push = (rule: string) => {
        if (allowedAt(line)) return;
        hits.push({ file: rel, line, rule, text: text.trim().slice(0, 80) });
      };
      for (const m of text.matchAll(BARE_SLEEP)) push(`裸写 ${m[1]}ms`);
      for (const m of text.matchAll(LOCAL_WAIT_PRIMITIVE_G)) push(`自带等待原语 ${m[1] ?? m[2]}`);
      if (text.includes('contractSleep(') && EMPTY_CONTRACT_REASON.test(text)) push('contractSleep 缺来源');
    });
    // 块状等待跨行，只能在剥完注释的全文上找；行号回查该匹配起始位置所在行
    for (const m of stripped.matchAll(BARE_SLEEP_BLOCK)) {
      const line = stripped.slice(0, m.index).split('\n').length;
      if (allowedAt(line)) continue;
      hits.push({ file: rel, line, rule: `块状裸写 ${m[1]}ms`, text: (lines[line - 1] ?? '').trim().slice(0, 80) });
    }
  }
  return { violations: hits, allows: allowEntries };
}

// 反向用例的合成样本：直写会先命中自己的规则，拼法本身就是「守护覆盖自身」的证据。
const bareSleepLine = (fn: string, ms: number) => ['set', `Timeout(${fn}, ${ms})`].join('');
const bareSleepBlock = (ms: number) =>
  ['set', `Timeout(() => {\n    expect(1).toBe(1);\n  }, ${ms})`].join('');
const emptyReasonCall = ['contractSleep(', "''", ', 50)'].join('');
const localWaitDecl = ['async function', 'waitFor('].join(' ');

/** 本单接入公共工具的文件（= api 侧逐条登记的清单，缺一个就是漏改） */
const CONVERTED = [
  'cleanup-active-guard.test.ts',
  'cleanup-compile-mutex.test.ts',
  'cleanup-cross-process.test.ts',
  'health-check-route.test.ts',
  'integration.test.ts',
  'permission-cache.test.ts',
  'session.test.ts',
  'stream-run-manager.test.ts',
  'user-store.test.ts',
];

describe('T02836 api 侧固定时长等待防退化守护', () => {
  const files = collectTestFiles(TEST_DIR);

  it('公共等待工具存在且导出与前端同一组出口', () => {
    expect(fs.existsSync(HELPER_PATH), '缺少 api/test/helpers/waitForProgress.ts').toBe(true);
    const src = fs.readFileSync(HELPER_PATH, 'utf8');
    for (const exportName of [
      'export async function waitForProgress',
      'export async function pollUntil',
      'export function contractSleep',
      'export function yieldSlice',
      'export const NO_TIMER_CHAIN',
      'export const CLEANUP_CHAIN',
      'export const MARKER_WAIT_BUDGET_MS',
      'export const TEST_SLICE_MS',
    ]) {
      expect(src, `helpers 未导出 ${exportName}`).toContain(exportName);
    }
    // helpers 自身也只能有「让出一个宏任务」的 0ms 定时，不得藏固定预算
    expect(scan([HELPER_PATH]).violations, 'helpers 内出现固定时长等待').toEqual([]);
  });

  it('两侧口径锁：api helper 与 frontend helper 用同一条无进展判据', () => {
    // 复制实现（见 helpers 头注）最怕的是「一份改了另一份没改」——判据本身比字符串，
    // 两侧任何一次调参没同步，这条用例就会红并把两边原文贴出来。
    expect(fs.existsSync(FRONTEND_HELPER), `找不到 frontend 版工具（${FRONTEND_HELPER}），口径锁失效`).toBe(true);
    const apiSrc = fs.readFileSync(HELPER_PATH, 'utf8');
    const feSrc = fs.readFileSync(FRONTEND_HELPER, 'utf8');
    const IDLE_RULE = 'elapsed > floorMs && now - lastProgressAt > idleMs';
    const IDLE_RULE_FE = /elapsed\s*>\s*floorMs\s*&&\s*now\s*-\s*lastProgressAt\s*>\s*idleMs/;
    expect(IDLE_RULE_FE.test(apiSrc), `api helper 的判据不是「${IDLE_RULE}」`).toBe(true);
    expect(IDLE_RULE_FE.test(feSrc), 'frontend helper 的判据已与 api 侧不一致').toBe(true);
    // 同一组出口名（前端版没有 pollUntil 时也不许 api 侧静默分叉）
    for (const name of ['waitForProgress', 'contractSleep', 'ProgressWaitOptions']) {
      expect(feSrc.includes(name), `frontend helper 缺少 ${name}，两侧出口面已分叉`).toBe(true);
    }
  });

  it('扫描面覆盖 api/test（守护不是空跑）', () => {
    expect(files.length).toBeGreaterThan(40);
    const rels = files.map((f) => path.relative(TEST_DIR, f).replace(/\\/g, '/'));
    for (const must of CONVERTED) {
      expect(rels, `未扫描 ${must}`).toContain(must);
    }
  });

  it('api/test 内无裸写时长的等待、无自带等待原语、contractSleep 一律带来源', () => {
    const { violations } = scan(files);
    expect(
      violations,
      `违反 T02836：\n${violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`).join('\n')}\n` +
        '改法：终点可观测 → helpers/waitForProgress 的 waitForProgress / pollUntil；' +
        '确需定时 → contractSleep(来源说明, 由契约常量推导的预算) 或 yieldSlice(用途)',
    ).toEqual([]);
  });

  it('allow 口子必须登记在案、带理由、且确实用上（不养死豁免）', () => {
    const { allows } = scan(files);
    for (const a of allows) {
      expect(a.reason.length, `${a.file}:${a.line} 的 T02836-allow 没写理由`).toBeGreaterThan(0);
      expect(a.used, `${a.file}:${a.line} 的 T02836-allow 没豁免到任何东西，请删掉`).toBe(true);
    }
    // 全库只允许这一处豁免（给真子进程的存活脚本用的时长，不是测试等待）。
    // 按文件登记而非行号：行号会随编辑漂移，登记面必须是「哪些文件有口子」这件事本身。
    expect(
      [...new Set(allows.map((a) => a.file))],
      '新增豁免口子必须先在本用例登记（防「加个 allow 就绿了」）',
    ).toEqual(['cleanup-cross-process.test.ts']);
  });

  it('接入清单逐条登记：清单内文件必须从 helpers 导入', () => {
    const imported = files
      .map((f) => [path.relative(TEST_DIR, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8')] as const)
      .filter(([, src]) => src.includes('helpers/waitForProgress'))
      .map(([rel]) => rel);
    for (const must of CONVERTED) {
      expect(imported, `${must} 未接入 helpers/waitForProgress`).toContain(must);
    }
    expect(imported.length).toBeGreaterThanOrEqual(CONVERTED.length);
  });

  it('反向用例：裸写时长（单行与块状）、空来源、自带 waitFor 必须被抓到', () => {
    const single = [...bareSleepLine('r', 10).matchAll(BARE_SLEEP)].map((m) => m[1]);
    expect(single, '固定 10ms 必须被抓').toEqual(['10']);
    expect([...bareSleepLine('resolve', 120).matchAll(BARE_SLEEP)].map((m) => m[1]), '固定 120ms 必须被抓').toEqual(['120']);
    // setTimeout(r, 0) 是让出一个宏任务节拍（helpers 内部就这么让），不属裸写预算
    expect([...bareSleepLine('r', 0).matchAll(BARE_SLEEP)].map((m) => m[1]), '0ms 不该被抓').toEqual([]);
    // 块状形态（前端版抓不到的那条口子）必须抓：断言整个写在 setTimeout 回调里 + 尾随固定时长
    expect([...bareSleepBlock(5).matchAll(BARE_SLEEP_BLOCK)].map((m) => m[1]), '块状 5ms 必须被抓').toEqual(['5']);
    expect([...bareSleepBlock(0).matchAll(BARE_SLEEP_BLOCK)].map((m) => m[1]), '块状 0ms 不该被抓').toEqual([]);
    expect(EMPTY_CONTRACT_REASON.test(emptyReasonCall), '空来源必须被抓').toBe(true);
    expect(EMPTY_CONTRACT_REASON.test("contractSleep('tip.ts:27 HIDE_GRACE_MS × 4', 320)")).toBe(false);
    expect(LOCAL_WAIT_PRIMITIVE.test(localWaitDecl), '自带 waitFor 必须被抓').toBe(true);
    expect(LOCAL_WAIT_PRIMITIVE.test('const params = { delay: 0 };'), '对象字面量里的 delay 不该被抓').toBe(false);
    // 注释里点名旧写法不抓（修复说明必须写得出来），且守护自身不被自己的规则抓到
    expect(
      scan([path.join(TEST_DIR, 'session.test.ts')]).violations,
      'session.test.ts 的旧写法说明必须留在注释里且不触发规则',
    ).toEqual([]);
    expect(
      scan([path.join(TEST_DIR, 'wait-for-progress-guard.test.ts')]).violations,
      '守护自身被自己的规则抓到（合成样本没拼开）',
    ).toEqual([]);
    // 豁免口子必须带理由：标记后面空的，就不构成豁免（否则口子等于没有规则）
    expect(`${ALLOW_TOKEN}   `.match(ALLOW_PRAGMA), '空理由的 allow 不该成立').toBeNull();
    expect(
      [`// ${ALLOW_TOKEN} `, '子进程存活时长，非测试等待'].join('').match(ALLOW_PRAGMA)?.[1],
      '带理由的 allow 必须登记出理由',
    ).toBe('子进程存活时长，非测试等待');
  });
});
