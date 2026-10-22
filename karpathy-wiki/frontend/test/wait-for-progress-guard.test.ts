// T02753：固定时长等待的防退化守护；T02904 起与 api 侧（T02836）同规则面。
// ------------------------------------------------------------------
// 本单把 6 个文件里 11 处「凭经验写死的 setTimeout 时长」换成进展感知等待，但**换完不是终点**：
// 只要没有机器口径，下一个用例照样会写 `await new Promise(r => setTimeout(r, 10))`，
// 于是「全套并发跑偶发假失败」重新长回来（T02687 / T02472 都为此付过代价）。
// T02904 实测：api 侧扩面时发现前端版抓不到两类写法——
//   1) 块状 `setTimeout(() => { 断言... }, 5)`（BARE_SLEEP 只认单行标识符形态）；
//   2) 参数化包装 `const sleep = (ms) => setTimeout(r, ms)`（时长藏进变量后 BARE_SLEEP 完全不红）。
// 本用例做四件事：
//   1. 扫 frontend/test 全部用例文件，禁裸写时长的等待（含块状）；
//   2. 禁文件内自带等待原语（`const sleep =` / `function waitFor(` 等）——只准从 helpers 导入；
//   3. contractSleep 必须带非空来源说明；
//   4. 与 api 版比对同一串规则判据，锁死两侧口径（防止一份改了另一份悄悄漂）。
// 扫描面包含本文件自身（不留豁免口子），所以反向用例的合成样本一律用拼接构造。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const FRONTEND_DIR = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;
const HELPER_PATH = path.join(TEST_DIR, 'helpers', 'waitForProgress.ts');
const API_GUARD_PATH = path.resolve(FRONTEND_DIR, '..', 'api', 'test', 'wait-for-progress-guard.test.ts');

/** 裸写的固定时长等待：setTimeout(r, 10) / setTimeout(resolve, 120) —— 0 不算（让出一个宏任务节拍是合法手法） */
const BARE_SLEEP = /setTimeout\(\s*[A-Za-z_$][\w$]*\s*,\s*([1-9][\d_]*)\s*\)/g;
/**
 * 块状写法：`setTimeout(() => { ...断言... }, 5)`。T02753 版只抓标识符形态，
 * 这一条形态把断言整个包在回调里（api 侧 session/permission-cache 就这么躲过清点的）。
 */
const BARE_SLEEP_BLOCK = /setTimeout\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{[\s\S]{0,800}?\}\s*,\s*([1-9][\d_]*)\s*\)/g;
/** 文件内自带等待原语：一份实现一个口径，六份 waitFor 漂移正是本单起因 */
const LOCAL_WAIT_PRIMITIVE =
  /(?:async\s+)?function\s+(sleep|tick|delay|pause|waitFor|waitUntil|sleepFor)\s*\(|(?:const|let)\s+(sleep|tick|delay|pause|waitFor|waitUntil|sleepFor)\s*=/;
/** matchAll 要求 g 旗标；判定一律走无状态的 test()/matchAll，避免 lastIndex 串味 */
const LOCAL_WAIT_PRIMITIVE_G = new RegExp(LOCAL_WAIT_PRIMITIVE.source, 'g');
/** contractSleep(reason, ms)：reason 为空串/空模板就是没写来源 */
const EMPTY_CONTRACT_REASON = /contractSleep\(\s*(?:''|""|`\s*`|)\s*,/;
/**
 * 显式豁免口子：任务号拼 `-allow:` 再跟理由（写在被豁免行上或其上一行）。
 * 只留给「不是第二套等待实现」的形态（实测唯一例子：query-edit-resend-flow 里给契约
 * 常量做默认值的薄适配层，内部直接转发 helpers/waitForProgress，见 T02753 说明）。
 * 标记本身必须拼出来写——直写会让本文件的说明命中自己的规则。口子必须登记在案：
 * 见「allow 口子必须登记在案」用例，新增豁免一律先红再评审。
 */
const ALLOW_TOKEN = ['T02904', '-allow:'].join('');
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

function collectTestFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'helpers' && !e.name.startsWith('.'))
    .flatMap((e) => collectTestFiles(path.join(dir, e.name)))
    .concat(
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.test.ts'))
        .map((e) => path.join(dir, e.name)),
    );
}

/**
 * 去掉注释后的代码文本（保留行号：注释行替换为空行）。
 * 说明旧写法（「原先是 setTimeout(r, 10)」）必须能写出来；但块状规则要跨行匹配，
 * 逐行跳过注释不够，必须先剥注释再拼。
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
      for (const m of text.matchAll(BARE_SLEEP)) push(`固定 ${m[1]}ms`);
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
const localWaitDecl = ['const', 'sleep ='].join(' ');

describe('T02753 固定时长等待防退化守护', () => {
  const files = collectTestFiles(TEST_DIR);

  it('公共等待工具存在且导出两个出口', () => {
    expect(fs.existsSync(HELPER_PATH), '缺少 frontend/test/helpers/waitForProgress.ts').toBe(true);
    const src = fs.readFileSync(HELPER_PATH, 'utf8');
    expect(src).toContain('export async function waitForProgress');
    expect(src).toContain('export function contractSleep');
  });

  it('两侧口径锁：api 版守护与前端版用同一串规则判据（T02904）', () => {
    // 规则分叉就是本单的起因：前端缺两条规则全绿了半年。判据本身比字符串，
    // 任何一侧改判据没同步，这条用例就会红并把两侧原文贴出来。
    expect(fs.existsSync(API_GUARD_PATH), `找不到 api 版守护（${API_GUARD_PATH}），口径锁失效`).toBe(true);
    const apiSrc = fs.readFileSync(API_GUARD_PATH, 'utf8');
    for (const rule of [BARE_SLEEP, BARE_SLEEP_BLOCK, LOCAL_WAIT_PRIMITIVE, EMPTY_CONTRACT_REASON]) {
      expect(apiSrc.includes(rule.source), `api 版守护缺少同串判据：${rule.source}`).toBe(true);
    }
  });

  it('扫描到测试文件（守护不是空跑）', () => {
    expect(files.length).toBeGreaterThan(40);
    const rels = files.map((f) => path.relative(TEST_DIR, f).replace(/\\/g, '/'));
    // 本单收敛的六个文件必须都在扫描面内
    for (const must of [
      'dataclean-ai-analysis.test.ts',
      'dataclean-interaction-loading.test.ts',
      'floating-chat-llmconfig.test.ts',
      'global-tooltip.test.ts',
      'inputBoxSettings-isolation.test.ts',
      'useFormDraft.test.ts',
    ]) {
      expect(rels, `未扫描 ${must}`).toContain(must);
    }
  });

  it('test 目录内无裸写时长的等待、无自带等待原语、contractSleep 一律带来源', () => {
    const { violations } = scan(files);
    expect(
      violations,
      `违反 T02753/T02904：\n${violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`).join('\n')}\n` +
        `改法：终点可观测 → helpers/waitForProgress 的 waitForProgress；` +
        `确需定时 → contractSleep(来源说明, 由契约常量推导的预算)`,
    ).toEqual([]);
  });

  it('allow 口子必须登记在案、带理由、且确实用上（不养死豁免）', () => {
    const { allows } = scan(files);
    for (const a of allows) {
      expect(a.reason.length, `${a.file}:${a.line} 的 allow 没写理由`).toBeGreaterThan(0);
      expect(a.used, `${a.file}:${a.line} 的 allow 没豁免到任何东西，请删掉`).toBe(true);
    }
    // 全库只允许这一处豁免（给契约常量做默认值的薄适配层，转发 helpers/waitForProgress，
    // 不是第二套等待实现）。按文件登记而非行号：行号会随编辑漂移。
    expect(
      [...new Set(allows.map((a) => a.file))],
      '新增豁免口子必须先在本用例登记（防「加个 allow 就绿了」）',
    ).toEqual(['query-edit-resend-flow.test.ts']);
  });

  it('反向用例：裸写时长（单行与块状）、空来源、自带原语必须被抓到（守护不是空跑）', () => {
    const scanOne = (line: string) => [...line.matchAll(BARE_SLEEP)].map((m) => m[1]);
    expect(scanOne(bareSleepLine('r', 10)), '固定 10ms 必须被抓').toEqual(['10']);
    expect(scanOne(bareSleepLine('resolve', 120)), '固定 120ms 必须被抓').toEqual(['120']);
    // setTimeout(r, 0) 是让出一个宏任务节拍（waitForProgress 内部就这么让），不属裸写预算
    expect(scanOne(bareSleepLine('r', 0)), '0ms 不该被抓').toEqual([]);
    // 块状形态（T02753 版抓不到的那条口子）必须抓：断言整个写在 setTimeout 回调里 + 尾随固定时长
    expect([...bareSleepBlock(5).matchAll(BARE_SLEEP_BLOCK)].map((m) => m[1]), '块状 5ms 必须被抓').toEqual(['5']);
    expect([...bareSleepBlock(0).matchAll(BARE_SLEEP_BLOCK)].map((m) => m[1]), '块状 0ms 不该被抓').toEqual([]);
    expect(EMPTY_CONTRACT_REASON.test(emptyReasonCall), '空来源必须被抓').toBe(true);
    expect(EMPTY_CONTRACT_REASON.test(`contractSleep('tip.ts:27 HIDE_GRACE_MS × 4', 320)`)).toBe(false);
    expect(LOCAL_WAIT_PRIMITIVE.test(localWaitDecl), '参数化 sleep 声明必须被抓').toBe(true);
    expect(LOCAL_WAIT_PRIMITIVE.test('const params = { delay: 0 };'), '对象字面量里的 delay 不该被抓').toBe(false);
    // 守护覆盖自身：本文件里除了拼出来的合成样本，不该有真命中
    expect(
      scan([path.join(TEST_DIR, 'wait-for-progress-guard.test.ts')]).violations,
      '守护自身被自己的规则抓到（合成样本没拼开）',
    ).toEqual([]);
    // 豁免口子必须带理由：标记后面空的，就不构成豁免
    expect(`${ALLOW_TOKEN}   `.match(ALLOW_PRAGMA), '空理由的 allow 不该成立').toBeNull();
  });

  it('本单收敛的 11 处等待已接入公共工具', () => {
    const imported = files
      .map((f) => [path.relative(TEST_DIR, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8')] as const)
      .filter(([, src]) => src.includes('helpers/waitForProgress'))
      .map(([rel]) => rel);
    // 六个待改文件 + T02687 的原文件（抽公共工具后它也必须从 helpers 导入）
    expect(imported.length).toBeGreaterThanOrEqual(7);
    for (const must of [
      'query-edit-resend-flow.test.ts',
      'dataclean-ai-analysis.test.ts',
      'dataclean-interaction-loading.test.ts',
      'floating-chat-llmconfig.test.ts',
      'global-tooltip.test.ts',
      'inputBoxSettings-isolation.test.ts',
      'useFormDraft.test.ts',
    ]) {
      expect(imported, `${must} 未接入 helpers/waitForProgress`).toContain(must);
    }
  });
});
