// T02753：固定时长等待的防退化守护。
// ------------------------------------------------------------------
// 本单把 6 个文件里 11 处「凭经验写死的 setTimeout 时长」换成进展感知等待，但**换完不是终点**：
// 只要没有机器口径，下一个用例照样会写 `await new Promise(r => setTimeout(r, 10))`，
// 于是「全套并发跑偶发假失败」重新长回来（T02687 / T02472 都为此付过代价）。
// 本用例做的事：全站测试目录里不允许出现裸写时长的等待；确需定时的只能走 contractSleep，
// 且必须带来源说明。清单为空不代表守护空跑——反向用例用合成文本锁死抓得住。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DIR = __dirname;
const HELPER_PATH = path.join(TEST_DIR, 'helpers', 'waitForProgress.ts');

/** 裸写的固定时长等待：setTimeout(r, 10) / setTimeout(resolve, 120) —— 0 不算（让出一个宏任务节拍是合法手法） */
const BARE_SLEEP = /setTimeout\(\s*[A-Za-z_$][\w$]*\s*,\s*([1-9][\d_]*)\s*\)/g;
/** contractSleep(reason, ms)：reason 为空串就是没写来源 */
const EMPTY_CONTRACT_REASON = /contractSleep\(\s*(?:''|""|`\s*`|)\s*,/;

interface Violation {
  file: string;
  line: number;
  text: string;
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

function findBareSleeps(files: string[]): Violation[] {
  const hits: Violation[] = [];
  for (const file of files) {
    const rel = path.relative(TEST_DIR, file).replace(/\\/g, '/');
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((raw, i) => {
        const text = raw.trim();
        // 整行注释豁免：说明旧写法（如「原来是 setTimeout(r, 10)」）必须能写出来，
        // 口径与术语表守护（T02475/T02705）一致
        if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) return;
        for (const m of text.matchAll(BARE_SLEEP)) {
          hits.push({ file: rel, line: i + 1, text: `固定 ${m[1]}ms —— ${text.slice(0, 70)}` });
        }
      });
  }
  return hits;
}

// 守护的扫描面**包含本文件自身**（不给守护留豁免口子，否则口子会被抄给别人）。
// 于是反向用例里的合成样本必须拼出来——直写会先命中自己，
// 拼法本身就是「守护覆盖自身」的证据；真出现裸写时长时依然会红。
const bareSleepLine = (fn: string, ms: number) => ['set', `Timeout(${fn}, ${ms})`].join('');
const emptyReasonCall = ['contractSleep(', "''", ', 50)'].join('');
const LOCAL_WAITFOR_DECL = ['function', 'waitFor('].join(' ');

describe('T02753 固定时长等待防退化守护', () => {
  const files = collectTestFiles(TEST_DIR);

  it('公共等待工具存在且导出两个出口', () => {
    expect(fs.existsSync(HELPER_PATH), '缺少 frontend/test/helpers/waitForProgress.ts').toBe(true);
    const src = fs.readFileSync(HELPER_PATH, 'utf8');
    expect(src).toContain('export async function waitForProgress');
    expect(src).toContain('export function contractSleep');
    // 只有一份实现：接入文件不该再自带 waitFor（六份实现漂移就是本单起因）
    for (const file of files) {
      const rel = path.relative(TEST_DIR, file).replace(/\\/g, '/');
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes(LOCAL_WAITFOR_DECL)) {
        expect.fail(`${rel} 仍自带本地 waitFor 实现，应改为从 helpers 导入`);
      }
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

  it('test 目录内无裸写时长的等待', () => {
    const violations = findBareSleeps(files);
    expect(
      violations,
      `违反 T02753（固定时长等待）：\n${violations.map((v) => `${v.file}:${v.line} ${v.text}`).join('\n')}\n` +
        `改法：终点可观测 → helpers/waitForProgress 的 waitForProgress；` +
        `确需定时 → contractSleep(来源说明, 由契约常量推导的预算)`,
    ).toEqual([]);
  });

  it('contractSleep 必须带非空来源说明', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(TEST_DIR, file).replace(/\\/g, '/');
      if (file === HELPER_PATH) continue;
      fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((raw, i) => {
          const text = raw.trim();
          if (text.startsWith('//')) return;
          if (text.includes('contractSleep(') && EMPTY_CONTRACT_REASON.test(text)) {
            offenders.push(`${rel}:${i + 1} ${text.slice(0, 70)}`);
          }
        });
    }
    expect(offenders, `contractSleep 缺来源说明：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('反向用例：裸写时长与空来源必须被抓到（守护不是空跑）', () => {
    const scan = (line: string) => [...line.matchAll(BARE_SLEEP)].map((m) => m[1]);
    expect(scan(bareSleepLine('r', 10)), '固定 10ms 必须被抓').toEqual(['10']);
    expect(scan(bareSleepLine('resolve', 120)), '固定 120ms 必须被抓').toEqual(['120']);
    // setTimeout(r, 0) 是让出一个宏任务节拍（waitForProgress 内部就这么让），不属裸写预算
    expect(scan(bareSleepLine('r', 0)), '0ms 不该被抓').toEqual([]);
    // 写在注释里不抓——修复说明必须能点名旧写法
    expect(findBareSleeps([HELPER_PATH]), 'helpers 不在扫描面内').toEqual([]);
    // 守护覆盖自身：本文件里除了拼出来的合成样本，不该有真命中
    expect(findBareSleeps([path.join(TEST_DIR, 'wait-for-progress-guard.test.ts')]), '守护自身被自己的规则抓到').toEqual([]);
    expect(EMPTY_CONTRACT_REASON.test(emptyReasonCall), '空来源必须被抓').toBe(true);
    expect(EMPTY_CONTRACT_REASON.test(`contractSleep('tip.ts:27 HIDE_GRACE_MS × 4', 320)`)).toBe(false);
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
