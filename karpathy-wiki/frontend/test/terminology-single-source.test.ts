import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MOBILE_TABS } from '../src/config/mobileTabs';

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
const API_SRC_DIR = path.resolve(__dirname, '../../api/src');
const DOC_PATH = path.resolve(__dirname, '../../docs/术语表.md');
const BANS_PATH = path.resolve(__dirname, '../../docs/terminology-bans.json');
// 豁免登记里的路径相对各自 src，两侧守护都要能解析对方那一侧的登记（写错一侧就是死豁免）
const SIDE_ROOTS: Record<string, string> = { frontend: SRC_DIR, api: API_SRC_DIR };

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
  // 豁免按扫描侧分组（键只能是 frontend / api）；两级粒度见 docs/terminology-bans.json 的 _rules.豁免
  exempt?: Record<string, SideExempt>;
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

// T02790：豁免有两级粒度。行级（lines）是默认选择——整文件放行会让该文件
// 其余用户可见文案一起失去守护，与 T02705 要消灭的「静默分叉」同类，只是粒度更细。
// 两侧守护用例必须用同一套判定口径，故本函数在 api/test/terminology-bans.test.ts 里有逐字一致的副本，
// 由下方「两侧扫描实现不漂移」用例做一致性断言。
export function isExempted(ban: Ban, side: 'frontend' | 'api', rel: string, text: string): boolean {
  const exempt = ban.exempt?.[side];
  if (!exempt) return false;
  if (exempt.files?.some((e) => e.file === rel)) return true;
  return (exempt.lines ?? []).some((e) => e.file === rel && text.includes(e.contains));
}

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

// 整行注释豁免口径：修复说明必须能点名旧词，所以注释不参与扫描。
// 与 isExempted 一样，两侧守护各留一份但由「实现逐字一致」用例锁死。
export function isCommentLine(text: string): boolean {
  return text.startsWith('//') || text.startsWith('/*') || text.startsWith('*') || text.startsWith('<!--');
}

// 单行扫描口径：注释行豁免（见上），其余原样比对。抽出来是为了能被反向用例复用。
function scanLine(rel: string, raw: string, line: number): Hit[] {
  const text = raw.trim();
  if (isCommentLine(text)) return [];
  const hits: Hit[] = [];
  for (const ban of BANS) {
    if (isExempted(ban, 'frontend', rel, text)) continue;
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

  it('行级豁免必须唯一命中，且命中的那行真的含禁用词（防豁免宽化成整文件放行）', () => {
    for (const ban of BANS) {
      for (const [side, exempt] of Object.entries(ban.exempt ?? {})) {
        for (const entry of exempt.lines ?? []) {
          const lines = fs
            .readFileSync(path.join(SIDE_ROOTS[side], entry.file), 'utf8')
            .split(/\r?\n/)
            .map((raw) => raw.trim());
          const matched = lines.filter((text) => text.includes(entry.contains));
          expect(
            matched.length,
            `「${ban.term}」在 ${side}/${entry.file} 的定位片段命中 ${matched.length} 行，要求恰好 1 行（多行命中等于变相整文件放行）`,
          ).toBe(1);
          expect(matched[0], `「${ban.term}」的行级豁免指向的行并不含该禁用词：${side}/${entry.file}`).toContain(ban.term);
          // 命中行必须是生效代码行：写在注释里本来就被豁免，登记它只会掩盖真实漏网
          expect(isCommentLine(matched[0]), `「${ban.term}」的行级豁免指向注释行（本来就是豁免行）：${side}/${entry.file}`).toBe(
            false,
          );
        }
      }
    }
  });

  it('「笔记」的豁免粒度已收窄：整文件通道不得再放行 Help.vue（T02790 回退锁）', () => {
    const notes = BANS.find((b) => b.term === '笔记');
    expect(notes?.exempt?.frontend?.files ?? [], '整文件豁免被重新启用——该文件其余用户可见文案会一起失去守护').toEqual([]);
    expect(notes?.exempt?.frontend?.lines?.length, '行级豁免登记缺失').toBeGreaterThan(0);
    // 后端没有任何「笔记」的正当外部语境：api 侧两级通道都必须为空
    expect(notes?.exempt?.api?.files ?? [], '后端不应有整文件豁免').toEqual([]);
    expect(notes?.exempt?.api?.lines ?? [], '后端不应有行级豁免').toEqual([]);
  });

  it('反向用例：行级豁免只放过声明的那一行，同文件下一行写旧词仍然红', () => {
    const entry = BANS.find((b) => b.term === '笔记')?.exempt?.frontend?.lines?.[0];
    expect(entry, '缺少行级豁免登记，本用例无从验证').toBeTruthy();
    // 声明的那一行：绿
    expect(scanLine(entry!.file, `content: '${entry!.contains}，建立可问答的知识图谱。',`, 189)).toEqual([]);
    // 同文件相邻行写旧词：仍然红。把豁免改回整文件生效时，这一条必红
    const extra = scanLine(entry!.file, `content: '这是本地笔记，先导入进来';`, 190);
    expect(extra.map((h) => h.term)).toContain('笔记');
  });

  it('两侧豁免判定与注释口径的实现逐字一致（扫描口径不许各写一份）', () => {
    const sides: Array<[string, string]> = [
      ['frontend/test/terminology-single-source.test.ts', __dirname],
      ['api/test/terminology-bans.test.ts', path.resolve(__dirname, '../../api/test')],
    ];
    const bodies = sides.map(([rel, dir]) => {
      const src = fs.readFileSync(path.resolve(dir, path.basename(rel)), 'utf8');
      const out: string[] = [];
      for (const name of ['isExempted', 'isCommentLine']) {
        const m = src.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n}`));
        expect(m, `${rel} 缺少可比的 ${name} 实现`).not.toBeNull();
        out.push(m![0].replace(/\s+/g, ' ').trim());
      }
      return out.join('\n');
    });
    expect(bodies[1], 'api 侧的豁免/注释判定口径已与前端漂移（共享的是清单，判定也必须同源）').toBe(bodies[0]);
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

  it('移动端主控件名 ∈ 术语表（T02706）', () => {
    // 移动端 Tab 短名是用户每天点的主控件，必须能在 §3.1 查到它对应哪个桌面功能
    // （或明确标注为移动端专属），否则「问答/浏览/投递」这类短标签会变成术语表外的黑话。
    const md = fs.readFileSync(DOC_PATH, 'utf8');
    const start = md.indexOf('### 3.1');
    const end = md.indexOf('## 4.');
    expect(start, '术语表缺少 §3.1 移动端 Tab 章节').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = md.slice(start, end);

    const menuSrc = fs.readFileSync(path.join(SRC_DIR, 'config/menu.ts'), 'utf8');
    const menuNames = [...menuSrc.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
    // 名单与实现同源：MobileShell 必须引用 MOBILE_TABS，而不是再写一份数组
    const shellSrc = fs.readFileSync(path.join(SRC_DIR, 'components/mobile/MobileShell.vue'), 'utf8');
    expect(shellSrc).toContain('MOBILE_TABS');
    expect(new Set(MOBILE_TABS.map((t) => t.label)).size, '移动端 Tab 短名重复').toBe(MOBILE_TABS.length);

    for (const tab of MOBILE_TABS) {
      const row = section.split('\n').find((line) => line.startsWith(`| ${tab.label} |`));
      expect(row, `移动端 Tab「${tab.label}」未登记到术语表 §3.1`).toBeTruthy();
      if (tab.desktopMenu) {
        expect(menuNames, `移动端 Tab「${tab.label}」映射的「${tab.desktopMenu}」不是桌面菜单实名`).toContain(tab.desktopMenu);
        expect(row).toContain(`| ${tab.desktopMenu} |`);
      } else {
        expect(row, `移动端专属 Tab「${tab.label}」未标注「移动端专属」`).toContain('移动端专属');
      }
    }
  });
});
