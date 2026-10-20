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

interface Ban {
  term: string;
  why: string;
  exempt?: Record<string, string[]>;
}

const BANS: Ban[] = JSON.parse(fs.readFileSync(BANS_PATH, 'utf8')).bans;

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

interface Hit {
  file: string;
  line: number;
  term: string;
  why: string;
  text: string;
}

/** 与前端守护同一套单行口径：整行注释豁免，其余原样比对（注释要能点名旧词） */
export function scanLine(rel: string, raw: string, line: number): Hit[] {
  const text = raw.trim();
  if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('*') || text.startsWith('<!--')) return [];
  const hits: Hit[] = [];
  for (const ban of BANS) {
    if (ban.exempt?.api?.includes(rel)) continue;
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
    expect(notes?.exempt?.frontend, '前端豁免 views/Help.vue 仍在').toContain('views/Help.vue');
    // 后端没有任何「笔记」的正当外部语境：exempt 未给 api 开口，命中即红
    expect(notes?.exempt?.api ?? [], '后端不应有文件级豁免').toEqual([]);
    expect(scanLine('services/y.ts', `return 'Obsidian 笔记'`, 1).map((h) => h.term)).toContain('笔记');
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
