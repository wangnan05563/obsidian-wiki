import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// T02475（PRD X1 / N5 / I6 / Q8 / G3 / H6 / D2x）：术语表落地后的守护用例。
// docs/术语表.md 是单一可信源，本用例把「禁用别名」变成可执行规则——
// 任何新文案把「页面」写回「笔记/文档」、把「共享 AI」写成「共享AI」、
// 或把内部枚举/英文 loading 词直接端给用户，都在这里失败，而不是等下一轮 UX 评审重新发现。
//
// T02705：禁用词清单不再硬编码在本文件里，改为与后端守护用例共用
// docs/terminology-bans.json。原因是清单一旦在两处各写一份，前后端就会出现
// 「前端改了后端不守」的静默分叉——后端 toast 直接端给用户，同样在术语表管辖范围内。
// 两侧扫描根目录与文件类型不同（前端 src 含 .vue，后端只有 .ts），所以扫描器各自留在本地，
// 共享的是「哪些词禁用、为什么禁、谁可以豁免」这部分真正会分叉的数据。

const SRC_DIR = path.resolve(__dirname, '../src');
const DOC_PATH = path.resolve(__dirname, '../../docs/术语表.md');
const BANS_PATH = path.resolve(__dirname, '../../docs/terminology-bans.json');

interface Ban {
  term: string;
  why: string;
  // 允许出现的文件（相对各自 src，正斜杠）——外部语境豁免，见术语表 §2；按扫描侧分组
  exempt?: Record<string, string[]>;
}

interface BansFile {
  bans: Ban[];
}

function loadSharedBans(): Ban[] {
  expect(fs.existsSync(BANS_PATH), `共享禁用词清单缺失：${BANS_PATH}`).toBe(true);
  const parsed = JSON.parse(fs.readFileSync(BANS_PATH, 'utf8')) as BansFile;
  expect(Array.isArray(parsed.bans) && parsed.bans.length > 0, '共享清单 bans 为空').toBe(true);
  return parsed.bans;
}

const BANS: Ban[] = loadSharedBans();

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith('.vue') || entry.name.endsWith('.ts')) {
      out.push(full);
    }
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

// 单行扫描口径：注释行豁免（见下），其余原样比对。抽出来是为了能被反向用例复用。
function scanLine(rel: string, raw: string, line: number): Hit[] {
  const text = raw.trim();
  if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('*') || text.startsWith('<!--')) return [];
  const hits: Hit[] = [];
  for (const ban of BANS) {
    if (ban.exempt?.frontend?.includes(rel)) continue;
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

describe('T02475 术语表守护（PRD X1）', () => {
  const files = collectSourceFiles(SRC_DIR);

  it('术语表文档存在且含锁定词分组', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
    const md = fs.readFileSync(DOC_PATH, 'utf8');
    for (const section of ['页面', '体检中心', '配置中心 → ', '共享 AI', '抽取', 'URL']) {
      expect(md).toContain(section);
    }
  });

  it('扫描到前端源码文件（守护不是空跑）', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('src 内无禁用别名残留', () => {
    const violations = findViolations(files);
    expect(
      violations,
      `违反术语表：\n${violations.map((v) => `${v.file}:${v.line} [${v.term}] ${v.text} —— ${v.why}`).join('\n')}`,
    ).toEqual([]);
  });

  it('反向用例：禁用词写在文案里必须被抓到（守护不是空跑）', () => {
    expect(scanLine('views/Demo.vue', `ElMessage('请查看知识库文档');`, 1).map((h) => h.term)).toContain('知识库文档');
    expect(scanLine('views/Demo.vue', `label="共享AI"`, 1).map((h) => h.term)).toContain('共享AI');
    // 同一句写在注释里则豁免——修复说明要点名旧词
    expect(scanLine('views/Demo.vue', `// 已把「知识库文档」改为「知识库页面」`, 1)).toEqual([]);
  });

  it('清单来自共享 JSON，两个守护用例都不再本地硬编码禁用词（T02705 防分叉）', () => {
    const shared = (JSON.parse(fs.readFileSync(BANS_PATH, 'utf8')) as BansFile).bans;
    expect(BANS.length, '本用例加载的条数必须等于共享清单条数').toBe(shared.length);
    expect(shared.length).toBeGreaterThanOrEqual(20);

    const sides: Array<[string, string]> = [
      ['frontend/test/terminology-single-source.test.ts', __dirname],
      ['api/test/terminology-bans.test.ts', path.resolve(__dirname, '../../api/test')],
    ];
    for (const [rel, dir] of sides) {
      const file = path.resolve(dir, path.basename(rel));
      expect(fs.existsSync(file), `缺少守护用例：${rel}`).toBe(true);
      const src = fs.readFileSync(file, 'utf8');
      expect(src, `${rel} 必须从 docs/terminology-bans.json 取清单`).toContain('terminology-bans.json');
      // 守护口径与扫描源码时一致：整行注释豁免，只看真正生效的代码行——
      // 否则本条会被「说明分叉长什么样」的注释自己触发
      const codeLines = src
        .split(/\r?\n/)
        .filter((line) => {
          const t = line.trim();
          return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
      // 本地再写一份禁用词数组就是分叉的开始
      expect(/const BANS[^=]*=\s*\[/.test(codeLines), `${rel} 不应再本地硬编码禁用词数组`).toBe(false);
    }
  });

  it('菜单实名与帮助条目名同词（§3 一致性）', () => {
    // menu.ts 是菜单名单一来源；帮助页若另起一套词，本用例即失败
    const menuSrc = fs.readFileSync(path.join(SRC_DIR, 'config/menu.ts'), 'utf8');
    const helpSrc = fs.readFileSync(path.join(SRC_DIR, 'views/Help.vue'), 'utf8');
    const menuNames = [...menuSrc.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(menuNames.length).toBeGreaterThanOrEqual(15);
    for (const name of ['体检中心', '配置中心', '投递资料', '页面质量清洗', '缓存与日志清理']) {
      expect(menuNames).toContain(name);
      expect(helpSrc).toContain(name);
    }
  });

  it('配置 tab 提示语路径不含不存在的 tab 名', () => {
    // 提示语里「配置中心 → X」的 X 必须是 configTabs.ts 的实名，否则用户按指引找不到标签页
    const tabsSrc = fs.readFileSync(path.join(SRC_DIR, 'utils/configTabs.ts'), 'utf8');
    const tabLabels = [...tabsSrc.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
    // 只取 tab 名形状的片段（汉字/字母/数字/内部空格），遇到 」 ' ` < （ 。 即截断——
    // 用「到下一个定界符」的贪婪写法会把 HTML 标签和后半句一起吃进来
    const tabPattern = /配置中心 → ([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 ]{0,14})/g;
    const paths = files.flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(tabPattern)].map((m) => m[1].trim()));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(tabLabels, `${p} 不是 configTabs 里的标签页实名`).toContain(p);
    }
  });
});
