// T02705：把术语表守护从「只扫 frontend/src」扩展到后端用户可见文案。
// ------------------------------------------------------------------
// 为什么要扫后端：api/src 的 routes/services 里有直接端给用户的字符串——接口 message /
// detail、启动失败原因、修复日志条目——前端会原样 toast 出去。这些文案此前不在禁用词
// 扫描范围内，等于「前端改名 → 后端 toast 还是旧词」这类回归没人守。
// T02475 落地时实测确认后端当时没有禁用别名残留，所以本用例是**防回归**；
// 实施本单时它立刻抓到一处真实违规（routes/ai.ts 的共享模型未配置提示写成「共享AI」，
// 而 tab 实名带空格），已在同一提交修掉。
//
// 清单口径：禁用词全部来自 docs/terminology-bans.json，与 frontend/test/terminology-single-source.test.ts
// 共用同一份数据——两份清单各写一处必然分叉，那是本单要消灭的问题，不是要复制的问题。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// api 是 ESM 包（package.json type: module），用 import.meta.url 而不是 __dirname 定位仓库根
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const SRC_DIR = path.join(REPO_ROOT, 'api', 'src');
const BANS_PATH = path.join(REPO_ROOT, 'docs', 'terminology-bans.json');
const DOC_PATH = path.join(REPO_ROOT, 'docs', '术语表.md');
const CONFIG_TABS_PATH = path.join(REPO_ROOT, 'frontend', 'src', 'utils', 'configTabs.ts');

interface LineExempt {
  file: string;
  // 行级豁免的定位片段：必须在目标文件里唯一命中一行，且该行确实含该禁用词
  contains: string;
  reason: string;
}

interface FileExempt {
  file: string;
  reason: string;
}

interface SideExempt {
  files?: FileExempt[];
  lines?: LineExempt[];
}

interface Ban {
  term: string;
  why: string;
  // 豁免按扫描侧分组（键只能是 frontend / api），值分整文件/行级两级粒度
  exempt?: Record<string, SideExempt>;
}

const BANS: Ban[] = JSON.parse(fs.readFileSync(BANS_PATH, 'utf8')).bans;
const SIDE_ROOTS: Record<string, string> = {
  frontend: path.join(REPO_ROOT, 'frontend', 'src'),
  api: SRC_DIR,
};

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// T02790：豁免分整文件（files）与行级（lines）两级粒度，行级是默认选择——
// 整文件放行会让该文件其余用户可见文案一起失去守护。
// 本函数与 frontend/test/terminology-single-source.test.ts 里的同名实现必须逐字一致，
// 由前端侧「两侧豁免判定与注释口径的实现逐字一致」用例锁死。
export function isExempted(ban: Ban, side: 'frontend' | 'api', rel: string, text: string): boolean {
  const exempt = ban.exempt?.[side];
  if (!exempt) return false;
  if (exempt.files?.some((e) => e.file === rel)) return true;
  return (exempt.lines ?? []).some((e) => e.file === rel && text.includes(e.contains));
}

interface Hit {
  file: string;
  line: number;
  term: string;
  why: string;
  text: string;
}

// 整行注释豁免口径：修复说明必须能点名旧词，所以注释不参与扫描。
// 与 isExempted 一样，两侧守护各留一份但由「实现逐字一致」用例锁死。
export function isCommentLine(text: string): boolean {
  return text.startsWith('//') || text.startsWith('/*') || text.startsWith('*') || text.startsWith('<!--');
}

/** 与前端守护同一套单行口径：整行注释豁免，其余原样比对（注释要能点名旧词） */
export function scanLine(rel: string, raw: string, line: number): Hit[] {
  const text = raw.trim();
  if (isCommentLine(text)) return [];
  const hits: Hit[] = [];
  for (const ban of BANS) {
    if (isExempted(ban, 'api', rel, text)) continue;
    if (text.includes(ban.term)) {
      hits.push({ file: rel, line, term: ban.term, why: ban.why, text: text.slice(0, 90) });
    }
  }
  return hits;
}

function findViolations(files: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const rel = path.relative(SRC_DIR, file).replace(/\\/g, '/');
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((raw, i) => hits.push(...scanLine(rel, raw, i + 1)));
  }
  return hits;
}

describe('T02705 术语表守护扩到后端用户可见文案', () => {
  const files = collectSourceFiles(SRC_DIR);

  it('共享清单可用且不含本地副本（与前端同一数据源）', () => {
    expect(fs.existsSync(BANS_PATH), `共享禁用词清单缺失：${BANS_PATH}`).toBe(true);
    expect(BANS.length).toBeGreaterThanOrEqual(20);
    // 关键分组必须都在：核心对象词 / tab 实名 / 阶段动词 / 加载态英文 / 提示语路径
    for (const term of ['知识库文档', '笔记', '共享AI', '提取要点', 'LOADING...', '「配置 →']) {
      expect(BANS.map((b) => b.term), `共享清单缺禁用词「${term}」`).toContain(term);
    }
  });

  it('扫描到后端源码文件（守护不是空跑）', () => {
    expect(files.length).toBeGreaterThan(40);
    // 断言真的扫到了会直接吐给用户的路由文件，而不是只落在几个角落模块上
    const rels = files.map((f) => path.relative(SRC_DIR, f).replace(/\\/g, '/'));
    for (const must of ['routes/ai.ts', 'routes/query.ts', 'routes/mcp-route.ts']) {
      expect(rels, `未扫描 ${must}`).toContain(must);
    }
  });

  it('api/src 内无禁用别名残留', () => {
    const violations = findViolations(files);
    expect(
      violations,
      `违反术语表（后端用户可见文案）：\n${violations.map((v) => `${v.file}:${v.line} [${v.term}] ${v.text} —— ${v.why}`).join('\n')}`,
    ).toEqual([]);
  });

  it('反向用例：禁用词写进接口提示语必须被抓到（守护不是空跑）', () => {
    // 这条就是本单实施时抓到的真实形状：后端 detail 文案直接变成前端 toast
    const bad = `? '共享AI 未配置 API Key：请先在「共享AI」页填写并保存'`;
    expect(scanLine('routes/ai.ts', bad, 1).map((h) => h.term)).toContain('共享AI');
    expect(scanLine('services/x.ts', `reply.send({ detail: '请查看知识库文档' })`, 1).map((h) => h.term)).toContain(
      '知识库文档',
    );
    // 同一句写在注释里则豁免——修复说明必须能点名旧词
    expect(scanLine('routes/ai.ts', '// 已把「共享AI」改为「共享 AI」', 1)).toEqual([]);
  });

  it('豁免只用于外部语境，且按侧生效（前端的豁免不能漏到后端）', () => {
    const notes = BANS.find((b) => b.term === '笔记');
    expect(notes?.exempt?.frontend?.lines?.map((e) => e.file), '前端行级豁免登记缺失').toContain('views/Help.vue');
    // 后端没有任何「笔记」的正当外部语境：api 侧两级通道都不得开口，命中即红
    expect(notes?.exempt?.api?.files ?? [], '后端不应有整文件豁免').toEqual([]);
    expect(notes?.exempt?.api?.lines ?? [], '后端不应有行级豁免').toEqual([]);
    expect(scanLine('services/y.ts', `return 'Obsidian 笔记'`, 1).map((h) => h.term)).toContain('笔记');
    // 前端那一行的豁免不会漏给后端：同一 rel 文本在后端侧仍然红
    expect(isExempted(notes as Ban, 'api', 'views/Help.vue', '将外部资料（Obsidian 笔记）导入知识库')).toBe(false);
  });

  it('豁免登记自审：只认 frontend/api 两侧、理由必填、登记的文件真实存在（T02790）', () => {
    for (const ban of BANS) {
      for (const [side, exempt] of Object.entries(ban.exempt ?? {})) {
        expect(SIDE_ROOTS[side], `禁用词「${ban.term}」的豁免键「${side}」不是合法扫描侧（写错侧名 = 豁免永不生效）`).toBeDefined();
        for (const entry of exempt.files ?? []) {
          expect(entry.reason?.trim(), `「${ban.term}」在 ${side} 的整文件豁免 ${entry.file} 未写理由`).not.toBe('');
          expect(
            fs.existsSync(path.join(SIDE_ROOTS[side], entry.file)),
            `「${ban.term}」的整文件豁免指向不存在的文件：${side}/${entry.file}`,
          ).toBe(true);
        }
        for (const entry of exempt.lines ?? []) {
          expect(entry.reason?.trim(), `「${ban.term}」在 ${side}/${entry.file} 的行级豁免未写理由`).not.toBe('');
          expect(entry.contains?.trim(), `「${ban.term}」在 ${side}/${entry.file} 的行级豁免缺定位片段`).not.toBe('');
          expect(
            fs.existsSync(path.join(SIDE_ROOTS[side], entry.file)),
            `「${ban.term}」的行级豁免指向不存在的文件：${side}/${entry.file}`,
          ).toBe(true);
        }
      }
    }
  });

  it('行级豁免只放过声明的那一行：本侧判定口径与前端同形（合成登记验证）', () => {
    // 后端目前没有真实豁免需求（exempt.api 全空），所以用一条合成登记验判定口径本身，
    // 防止「行级通道在后端侧退化成整文件通道」这种只在需要用的那天才暴露的缺陷。
    const synth: Ban = {
      term: '笔记',
      why: '合成用例',
      exempt: { api: { files: [], lines: [{ file: 'routes/x.ts', contains: 'Obsidian 笔记', reason: '外部语境' }] } },
    };
    expect(isExempted(synth, 'api', 'routes/x.ts', "detail: '支持 Obsidian 笔记导入'")).toBe(true);
    // 同一文件的下一行写旧词：仍然不放行
    expect(isExempted(synth, 'api', 'routes/x.ts', "detail: '请先整理本地笔记'")).toBe(false);
    // 换一个文件：仍然不放行（豁免不跨文件）
    expect(isExempted(synth, 'api', 'routes/y.ts', "detail: '支持 Obsidian 笔记导入'")).toBe(false);
    // 整文件通道仍可用，但必须显式登记且带理由
    const whole: Ban = { term: '笔记', why: '合成用例', exempt: { api: { files: [{ file: 'routes/x.ts', reason: '整篇是外部语境' }] } } };
    expect(isExempted(whole, 'api', 'routes/x.ts', "detail: '请先整理本地笔记'")).toBe(true);
    expect(isExempted(whole, 'api', 'routes/y.ts', "detail: '请先整理本地笔记'")).toBe(false);
  });

  it('后端提示语里的「配置中心 → X」必须是真实存在的标签页实名', () => {
    // 后端 toast 也写路径指引（如「请在「配置中心 → AI 服务」填写 API Key」），
    // 而 tab 实名只有前端 configTabs.ts 一份——前端改名而后端没跟上，用户按指引就找不到标签页
    expect(fs.existsSync(CONFIG_TABS_PATH), 'tab 实名来源缺失').toBe(true);
    const tabLabels = [...fs.readFileSync(CONFIG_TABS_PATH, 'utf8').matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
    const tabPattern = /配置中心 → ([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 ]{0,14})/g;
    const paths = files.flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(tabPattern)].map((m) => m[1].trim()));
    // 至少要有现存的三处指引（AI 服务 / MCP 接口），否则说明本用例又变成空跑
    expect(paths.length).toBeGreaterThanOrEqual(3);
    for (const p of paths) {
      expect(tabLabels, `${p} 不是 configTabs 里的标签页实名`).toContain(p);
    }
  });

  it('术语表文档仍是单一可信源且含锁定词分组', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
    const md = fs.readFileSync(DOC_PATH, 'utf8');
    expect(md).toContain('docs/terminology-bans.json');
    for (const section of ['页面', '体检中心', '配置中心 → ', '共享 AI', '抽取', 'URL']) {
      expect(md).toContain(section);
    }
  });
});
