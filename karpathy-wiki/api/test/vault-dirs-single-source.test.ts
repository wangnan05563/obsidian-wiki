// T02686：知识库目录清单「单一来源」守护。
// ------------------------------------------------------------------
// 背景（同源缺陷已复现两次）：同一份 vault 目录清单在库内被写了 6~9 遍——
//   api/src（vault-service 写白名单、mcp/tools、discover-workflow、search-util、hybrid-search、
//   harness-adapter 断链扫描、routes/tags、routes/discover 路径正则、quality-scanner 的 dir→type 映射）、
//   scripts/install.ps1 / setup-env.ps1 / build-exe.ps1（初始化目录）、前端 dirMap。
//   T02472 修的是「216 vs 245 两个总数」，T02478 又因旧实例复现——每次都是「改了一处、漏了另一处」。
// 本用例把这三类漂移一次性锁死：
//   A 集合语义自洽（页面集合 ≠ 可写集合 ≠ 初始化集合，差异是刻意的）
//   B PowerShell 镜像 scripts/vault-dirs.mjs 与 TS 单一来源逐集合相等，CLI 行为正确
//   C 全库不再有第二份「带引号的目录清单」字面量（除单一来源与本镜像）
//   D 真实行为：VaultService.init() 建齐 8 个目录；写白名单覆盖 qa/solutions/drafts
//   E 真实行为：体检断链扫描覆盖 6 个页面目录（原写死 4 个 → qa/solutions 的断链永远报不出来）
//   F 真实行为：补元信息的 dir→type 推断覆盖 6 个页面目录（原缺 qa/solutions → qa 页被写成 concept）
//   G 前端 dirMap / PAGE_SCOPE_DIRS 与后端同集合（跨端只比源码文本，改动即失败）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

import {
  PAGE_DIRS,
  NON_PAGE_DIRS,
  WRITABLE_DIRS,
  READABLE_DIRS,
  INIT_DIRS,
  TITLE_DEDUPE_DIRS,
  PAGE_DIR_TO_TYPE,
  PAGE_DIRS_ALT,
  VAULT_DIR_SETS,
} from '../src/vault/page-scope.js';
import { VaultService } from '../src/vault/vault-service.js';
import { HarnessAdapter } from '../src/engine/harness-adapter.js';
import { fixFrontmatter, scanVault } from '../src/data-clean/quality-scanner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const mirrorFile = path.join(repoRoot, 'scripts', 'vault-dirs.mjs');

/** 从 TS 源码文本里抽出「带引号的目录字面量数组」的正则：两个目录名以逗号相邻即视为一份自带清单 */
const QUOTED_DIR_PAIR = /['"](?:entities|concepts|comparisons|queries|qa|solutions|raw|drafts)['"]\s*,\s*['"](?:entities|concepts|comparisons|queries|qa|solutions|raw|drafts)['"]/;

/** 逐行剥掉注释后再比对，避免「注释里提到目录清单」被误判为硬编码 */
function stripComments(ts: string): string {
  return ts
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

async function collectFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(full, out);
    else if (/\.(ts|mjs|ps1)$/.test(entry.name)) out.push(full);
  }
  return out;
}

let tempDir: string;
let vaultDir: string;
let vault: VaultService;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-dirs-single-'));
  vaultDir = path.join(tempDir, 'vault');
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('A · 集合语义自洽', () => {
  it('页面集合固定 6 个目录，raw/drafts 只进可写集合', () => {
    expect(PAGE_DIRS).toEqual(['entities', 'concepts', 'comparisons', 'queries', 'qa', 'solutions']);
    expect(NON_PAGE_DIRS).toEqual(['raw', 'drafts']);
    // 刻意差异：draft 是中间态、raw 是外部输入，都不参与链接图（page-scope 注释已说明）
    for (const d of NON_PAGE_DIRS) expect(PAGE_DIRS).not.toContain(d);
    expect(WRITABLE_DIRS).toEqual([...PAGE_DIRS, ...NON_PAGE_DIRS]);
    expect(READABLE_DIRS).toEqual(WRITABLE_DIRS);
    expect(INIT_DIRS).toEqual(WRITABLE_DIRS);
    expect(TITLE_DEDUPE_DIRS).toEqual(['entities', 'concepts']);
  });

  it('VAULT_DIR_SETS 暴露的键即外部消费者可用的集合名', () => {
    expect(Object.keys(VAULT_DIR_SETS).sort()).toEqual(['init', 'pages', 'readable', 'titleDedupe', 'writable']);
    expect(PAGE_DIRS_ALT).toBe(PAGE_DIRS.join('|'));
  });

  it('dir→type 映射覆盖全部页面目录，且值都是 SCHEMA 合法 type', () => {
    expect(Object.keys(PAGE_DIR_TO_TYPE).sort()).toEqual([...PAGE_DIRS].sort());
    const validTypes = ['entity', 'concept', 'comparison', 'query', 'qa', 'solution'];
    for (const t of Object.values(PAGE_DIR_TO_TYPE)) expect(validTypes).toContain(t);
  });
});

describe('B · PowerShell 镜像与 CLI', () => {
  it('vault-dirs.mjs 每个集合与 page-scope 完全一致', async () => {
    const mirror = (await import(mirrorFile)) as { VAULT_DIR_SETS: Record<string, string[]> };
    for (const key of Object.keys(VAULT_DIR_SETS)) {
      expect(mirror.VAULT_DIR_SETS[key], `镜像集合 ${key}`).toEqual(VAULT_DIR_SETS[key]);
    }
  });

  it('node scripts/vault-dirs.mjs init 输出 INIT_DIRS（安装脚本据此建目录）', () => {
    const stdout = execFileSync('node', [mirrorFile, 'init'], { encoding: 'utf8' });
    // 契约：**每行一个目录**。PowerShell 侧 `@(& node vault-dirs.mjs init)` 直接得到字符串数组。
    // 这里刻意不用 JSON：Windows PowerShell 5.1 的 ConvertFrom-Json 会把 JSON 数组当**单个对象**返回，
    // `@(... | ConvertFrom-Json)` 的 Count 恒为 1（实测 first="entities concepts ..."），
    // 安装脚本会拿整份清单当一个目录名去建目录。
    expect(stdout.split(/\r?\n/)).toEqual(INIT_DIRS);
  });

  it('集合名写错时非零退出（安装脚本必须中止，不得回退到写死清单）', () => {
    expect(() => execFileSync('node', [mirrorFile, 'no-such-set'], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});

describe('C · 库内不得有第二份目录清单', () => {
  it('api/src + scripts 里不存在带引号的相邻目录字面量（除单一来源与镜像）', async () => {
    const allowed = new Set([
      path.join(repoRoot, 'api', 'src', 'vault', 'page-scope.ts'),
      mirrorFile,
    ]);
    const files = [
      ...(await collectFiles(path.join(repoRoot, 'api', 'src'))),
      ...(await collectFiles(path.join(repoRoot, 'scripts'))),
    ];
    const offenders: string[] = [];
    for (const f of files) {
      if (allowed.has(f)) continue;
      const text = stripComments(await fs.readFile(f, 'utf8'));
      const hit = text.match(QUOTED_DIR_PAIR);
      if (hit) offenders.push(`${path.relative(repoRoot, f)} → ${hit[0]}`);
    }
    expect(offenders, '新目录并入 PAGE_DIRS 时，任何自带清单都会重新造成「两处数对不上」').toEqual([]);
  });

  it('三个 PowerShell 脚本改为消费 vault-dirs.mjs，不再自带 $PageDirs 字面量', async () => {
    for (const name of ['install.ps1', 'setup-env.ps1', 'build-exe.ps1']) {
      const text = await fs.readFile(path.join(repoRoot, 'scripts', name), 'utf8');
      expect(text, `${name} 应通过 vault-dirs.mjs 取清单`).toContain('vault-dirs.mjs');
      expect(/\$PageDirs\s*=\s*@\(\s*'/.test(text), `${name} 仍有硬编码 $PageDirs 清单`).toBe(false);
      // 取不到清单必须显式失败，不能静默按空目录继续装
      expect(text, `${name} 缺少清单为空时的中止分支`).toContain('无法从单一来源读取 Vault 目录清单');
    }
  });
});

describe('D · VaultService.init() 的真实落盘口径', () => {
  it('新建 vault 时把 8 个可写目录全部建出来（原只建 5 个 → 仪表盘「静默的 0」）', async () => {
    vault = new VaultService(vaultDir);
    await vault.init();
    for (const d of INIT_DIRS) {
      const st = await fs.stat(path.join(vaultDir, d));
      expect(st.isDirectory(), `init 后应存在目录 ${d}`).toBe(true);
    }
  });

  it('写白名单覆盖 qa/solutions/drafts，且仍拒绝非白名单目录', async () => {
    for (const rel of ['qa/ok.md', 'solutions/ok.md', 'drafts/ok.md', 'raw/ok.md']) {
      await vault.writeFile(rel, '---\ntitle: ok\n---\n\n正文\n');
      expect(await vault.readFile(rel)).toContain('正文');
    }
    await expect(vault.writeFile('nowhere/ok.md', 'x')).rejects.toThrow(/白名单/);
  });
});

describe('E · 体检断链扫描覆盖 6 个页面目录（本单修掉的真缺陷）', () => {
  it('qa/ 与 solutions/ 页面里的断链会被报出，联调遗留 test-*.md 不产断链', async () => {
    const broken = '不存在的页面' + process.pid;
    const page = (title: string) => matter.stringify(`# ${title}\n\n引用 [[${broken}]]。\n`, { title });
    await vault.writeFile('qa/broken-link-sample.md', page('问答断链样本'));
    await vault.writeFile('solutions/broken-link-sample.md', page('方案断链样本'));
    await vault.writeFile('qa/test-noise.md', page('联调遗留'));

    const adapter = new HarnessAdapter({} as never, vault);
    adapter.invalidateHealthCheckCache();
    const report = await adapter.healthCheck();
    const froms = report.brokenLinks.map((b) => b.from);

    expect(froms).toContain('qa/broken-link-sample.md');
    expect(froms).toContain('solutions/broken-link-sample.md');
    // isPageFile 同口径：test-*.md 不是页面，不该进断链结果
    expect(froms).not.toContain('qa/test-noise.md');
  });
});

describe('F · 补元信息的 dir→type 推断覆盖 6 个页面目录', () => {
  it('qa/ 与 solutions/ 页面补元信息后 type 不再兜底成 concept', async () => {
    await vault.writeFile('qa/meta-sample.md', '# 问答元信息样本\n\n正文内容。\n');
    await vault.writeFile('solutions/meta-sample.md', '# 方案元信息样本\n\n正文内容。\n');

    const res = await fixFrontmatter(vault, ['qa/meta-sample.md', 'solutions/meta-sample.md'], false);
    expect(res.errors).toEqual([]);

    const qaFm = matter(await vault.readFile('qa/meta-sample.md')).data;
    const solFm = matter(await vault.readFile('solutions/meta-sample.md')).data;
    expect(qaFm.type).toBe('qa');
    expect(solFm.type).toBe('solution');
  });
});

describe('H · 双 frontmatter 块合并（T02933）', () => {
  // 真实故障形态：第一块只有 type/ai_tags/updated，第二块才带 title/created/source
  const DUP = [
    '---',
    'type: concept',
    'ai_tags: [a]',
    "updated: '2026-10-09'",
    '---',
    '---',
    'title: 双块样本',
    'type: concept',
    'created: 2026-07-21',
    'source: concepts/dup.md',
    '---',
    '',
    '正文第一行。',
    '',
  ].join('\n');

  it('fixFrontmatter 后只剩一块，created 保留第二块真实值，正文不再以 --- 开头', async () => {
    await vault.writeFile('concepts/dup-fm.md', DUP);
    const res = await fixFrontmatter(vault, ['concepts/dup-fm.md'], false);
    expect(res.errors).toEqual([]);
    expect(res.fixed.map((f) => f.path)).toContain('concepts/dup-fm.md');

    const raw = await vault.readFile('concepts/dup-fm.md');
    // 只保留一对 --- 分隔符（一个 frontmatter 块）
    expect(raw.match(/^---$/gm)?.length).toBe(2);
    const parsed = matter(raw);
    expect(parsed.data.title).toBe('双块样本');
    expect(new Date(parsed.data.created as string).toISOString().slice(0, 10)).toBe('2026-07-21');
    expect(parsed.content.trimStart().startsWith('---')).toBe(false);
    expect(parsed.content).toContain('正文第一行');
  });

  it('扫描口径：双块页面合并后判定为有元信息，不再落进「缺元信息」', async () => {
    await vault.writeFile('concepts/dup-scan.md', DUP);
    const pages = await scanVault(vault);
    const page = pages.find((p) => p.path === 'concepts/dup-scan.md');
    expect(page).toBeTruthy();
    expect(page!.metadata.hasFrontmatter).toBe(true);
    expect(page!.title).toBe('双块样本');
  });
});

describe('G · 前端副本与后端同集合', () => {
  it('dataCleanPresentation.PAGE_SCOPE_DIRS 与 Browse.vue dirMap 跟后端一致', async () => {
    const pres = await fs.readFile(
      path.join(repoRoot, 'frontend', 'src', 'utils', 'dataCleanPresentation.ts'),
      'utf8',
    );
    const m = pres.match(/export const PAGE_SCOPE_DIRS\s*=\s*\[([^\]]*)\]/);
    expect(m, '前端页面口径常量存在性').not.toBeNull();
    const frontDirs = (m as RegExpMatchArray)[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(frontDirs).toEqual(PAGE_DIRS);

    const browse = await fs.readFile(
      path.join(repoRoot, 'frontend', 'src', 'views', 'Browse.vue'),
      'utf8',
    );
    for (const [dir, type] of Object.entries(PAGE_DIR_TO_TYPE)) {
      expect(new RegExp(`${dir}:\\s*'${type}'`).test(browse), `前端 dirMap 缺 ${dir}→${type}`).toBe(true);
    }
  });
});
