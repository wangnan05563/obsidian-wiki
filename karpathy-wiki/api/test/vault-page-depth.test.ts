// T02731：页面路径「深度」口径守护（顶层目录之后不得再有子目录）。
// ------------------------------------------------------------------
// 用户报的表现：投递交数正常、日志里 AI 也确实用 write_file 写了页面，但知识库列表/搜索里查无此页。
// 真实原因：写盘白名单只比顶层目录名，`concepts/entity/bill-recourse.md` 的顶层是 concepts，照样放行；
//   而全库枚举页面一律是「对 PAGE_DIRS 逐个 flat readdir + endsWith('.md') 过滤」
//   （listAllPages / 链接图 / 统计 / 混合搜索 / 体检 / 标签），子目录名不以 .md 结尾被直接跳过
//   → 页面落了盘却永远不进任何列表，也解析不出 [[引用]]：静默丢失，比报错更难查。
// 本用例锁三件事：
//   A 深度规则本身（pageDepthError）与它的例外口径
//   B 真实写盘入口（VaultService.writeFile / MCP vault_write_page）确实拒收错位路径，且拒得很干净（不落盘、不建目录）
//   C 「看不见」这条因果链是实测出来的，不是推断的：同一份内容，塞进子目录时 listAllPages 找不到，平铺后找得到
//   D 单一来源：例外清单与公开媒体路由前缀同源；写盘工具的提示词与校验同口径
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NESTED_PAGE_DIRS,
  PAGE_DIRS,
  PAGE_DIR_TO_TYPE,
  TYPE_TO_PAGE_DIR,
  WRITABLE_DIRS,
  pageDepthError,
  flatPagePathHint,
} from '../src/vault/page-scope.js';
import { VaultService } from '../src/vault/vault-service.js';
import { callTool } from '../src/mcp/tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

let tempDir: string;
let vaultDir: string;
let vault: VaultService;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-page-depth-'));
  vaultDir = path.join(tempDir, 'vault');
  vault = new VaultService(vaultDir);
  await vault.init();
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('A · 深度规则本身', () => {
  it('两段（顶层目录/文件名）与一段（index.md/log.md）都合法', () => {
    for (const rel of ['concepts/a.md', 'entities/a.md', 'raw/来源.md', 'drafts/草稿.md', 'index.md', 'log.md']) {
      expect(pageDepthError(rel), `${rel} 应当合法`).toBeNull();
    }
  });

  it('例外只有 NESTED_PAGE_DIRS 里的三段路径，且当前唯一成员是 queries/media', () => {
    expect(NESTED_PAGE_DIRS).toEqual(['queries/media']);
    // 例外必须挂在合法可写目录之下（否则「合法嵌套」会变成绕过白名单的后门）
    for (const nested of NESTED_PAGE_DIRS) {
      expect(WRITABLE_DIRS).toContain(nested.split('/')[0]);
      expect(PAGE_DIRS).toContain(nested.split('/')[0]);
    }
    // 生图/视频/pptx 产物与其 .md 归档同处一层，属刻意设计而非错位
    expect(pageDepthError('queries/media/image-abc.png')).toBeNull();
    expect(pageDepthError('queries/media/image-abc.md')).toBeNull();
    expect(pageDepthError('raw/assets/a.png')).not.toBeNull();
  });

  it('反斜杠同样按深度判定（Windows 侧传路径不带 /）', () => {
    expect(pageDepthError('concepts\\entity\\a.md')).not.toBeNull();
    expect(pageDepthError('concepts\\a.md')).toBeNull();
  });

  it('三段非例外、四段以上都拒：错误文案给出「正确形如」而不是只说非法', () => {
    for (const rel of ['concepts/entity/a.md', 'concepts/comparisons/a.md', 'queries/media/sub/a.md']) {
      const msg = pageDepthError(rel);
      expect(msg, `${rel} 应被拒`).not.toBeNull();
      expect(msg).toContain('不要在目录里再建子目录');
      expect(msg).toContain('<文件名>.md'); // 给出可照抄的正确形态
      expect(msg).toContain(rel.replaceAll('\\', '/'));
    }
  });
});

describe('B · 真实写盘入口拒收错位路径', () => {
  it('VaultService.writeFile 拒绝二层子目录，且不留目录、不落文件', async () => {
    const rel = 'concepts/entity/bill-recourse.md';
    await expect(vault.writeFile(rel, '---\ntitle: 票据追索权\n---\n\n正文\n')).rejects.toThrow(/不要在目录里再建子目录/);
    await expect(fs.stat(path.join(vaultDir, 'concepts', 'entity'))).rejects.toThrow();
    await expect(fs.readFile(path.join(vaultDir, 'concepts', 'entity', 'bill-recourse.md'), 'utf8')).rejects.toThrow();
  });

  it('非例外的嵌套（raw/assets、drafts/子目录）一并拒；平铺与 queries/media 正常写入', async () => {
    await expect(vault.writeFile('raw/assets/pic.png', Buffer.from('x'))).rejects.toThrow(/子目录/);
    await expect(vault.writeFile('drafts/sub/d.md', 'x')).rejects.toThrow(/子目录/);
    await vault.writeFile('concepts/flat-ok.md', '---\ntitle: 平铺\n---\n\n正文\n');
    await vault.writeFile('queries/media/image-ok.md', '---\ntitle: 媒体归档\n---\n\n正文\n');
    await vault.writeFile('queries/media/blob-ok.png', Buffer.from('png-bytes'));
    expect(await vault.readFile('concepts/flat-ok.md')).toContain('正文');
    expect(await vault.readFile('queries/media/image-ok.md')).toContain('正文');
  });

  it('目录白名单先于深度校验：非白名单目录仍报「不在白名单」，不误导成深度问题', async () => {
    await expect(vault.writeFile('nowhere/sub/deep.md', 'x')).rejects.toThrow(/白名单/);
  });

  it('MCP vault_write_page 同样拒收，并把可纠正的文案回给调用方（AI 能改写路径重试）', async () => {
    const calls: string[] = [];
    const stubVault = {
      getVaultPath: () => vaultDir,
      writeFile: async (rel: string) => {
        calls.push(rel);
      },
    };
    const ctx = { vault: stubVault as never, adapter: {} as never, config: {} as never };
    const r = await callTool('vault_write_page', { path: 'concepts/comparisons/a.md', content: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('不要在目录里再建子目录');
    expect(calls, '校验必须在写盘之前，不能先落盘再报错').toEqual([]);

    const ok = await callTool('vault_write_page', { path: 'concepts/a.md', content: 'x' }, ctx);
    expect(ok.isError).toBe(false);
    expect(calls).toEqual(['concepts/a.md']);
  });

  it('MCP vault_create_page 传嵌套 dir（如 concepts/entity）也被拒', async () => {
    const stubVault = { getVaultPath: () => vaultDir, writeFile: async () => undefined };
    const ctx = { vault: stubVault as never, adapter: {} as never, config: {} as never };
    const r = await callTool('vault_create_page', { dir: 'concepts/entity', name: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('子目录');
  });
});

describe('C · 错位即隐身：这条因果链是实测出来的', () => {
  it('同一份内容，被 flat readdir 跳过时既进不了页面列表也解析不出 [[引用]]，归位后两者都恢复', async () => {
    // 用 fs 直接落盘，模拟「写盘校验上线前」已存在的存量错位页面（它们正是本单要迁移的对象）
    const strayDir = path.join(vaultDir, 'concepts', 'legacy');
    await fs.mkdir(strayDir, { recursive: true });
    await fs.writeFile(path.join(strayDir, 'stray.md'), `---\ntitle: 存量错位页\n---\n\n正文\n`, 'utf8');

    const pages = await vault.listAllPages();
    const paths = pages.map((p) => p.path);
    expect(paths, '子目录里的 .md 不该出现在页面列表').not.toContain('concepts/legacy/stray.md');
    // 目录名本身也不会被当成条目：flat 扫描按 .md 过滤，故连 concepts/legacy 都不出现
    expect(paths.some((p) => p.includes('legacy'))).toBe(false);
    // 于是引用它的双链解析不出（前端点参考资料跳转会 404，知识图谱里也没有这个节点）
    expect(await vault.resolvePageName('stray')).toBeNull();
    // 但读侧不拒——存量页必须还能被读出来，才有机会归位
    expect(await vault.readFile('concepts/legacy/stray.md')).toContain('正文');

    // 归位（本单对存量的处置方式）：同内容搬到合法目录后，列表与 [[引用]] 解析同时恢复
    await vault.writeFile('concepts/stray.md', await fs.readFile(path.join(strayDir, 'stray.md'), 'utf8'));
    const after = await vault.listAllPages();
    expect(after.map((p) => p.path)).toContain('concepts/stray.md');
    expect(await vault.resolvePageName('stray')).toBe('concepts/stray.md');
  });
});

describe('D · 单一来源与提示词同口径', () => {
  const read = (rel: string) => fs.readFile(path.join(repoRoot, rel), 'utf8');

  it('公开媒体路由前缀由 NESTED_PAGE_DIRS 派生，两处不再各写一遍字面量', async () => {
    const files = await read('api/src/routes/files.ts');
    expect(files).toContain("import { NESTED_PAGE_DIRS } from '../vault/page-scope.js'");
    expect(files, 'MEDIA_PREFIX 必须派生自例外清单').toContain('const MEDIA_PREFIX = `${NESTED_PAGE_DIRS[0]}/`;');
    expect(files).not.toMatch(/const MEDIA_PREFIX = 'queries\/media\/'/);
    // 例外清单目前只支持一个前缀（路由用 [0]）；扩容时本用例先把假设显式化
    expect(NESTED_PAGE_DIRS.length).toBe(1);
  });

  it('写盘入口与 MCP 工具层都取同一份深度规则，不各自复制判断', async () => {
    const svc = await read('api/src/vault/vault-service.ts');
    const tools = await read('api/src/mcp/tools.ts');
    expect(svc).toMatch(/import \{[^}]*pageDepthError[^}]*\} from '\.\/page-scope\.js'/);
    expect(svc).toContain('const depthError = pageDepthError(relativePath);');
    expect(tools).toContain('const depthError = pageDepthError(norm);');
  });

  it('三个写盘工具的 description 都带上同口径提示（校验会拒写，提示落后就会让 AI 反复撞墙）', async () => {
    const compile = await read('api/src/workflows/compile-workflow.ts');
    const fix = await read('api/src/workflows/health-check-fix-workflow.ts');
    const tools = await read('api/src/mcp/tools.ts');
    // 断言落在 description 那一行本身（只要求「文件里出现过 flatPagePathHint」会被参数说明里的另一处蒙过）
    for (const [name, text] of [
      ['compile-workflow', compile],
      ['health-check-fix-workflow', fix],
    ] as const) {
      expect(text, `${name} 的 write_file description 应带深度提示`).toContain('目录；${flatPagePathHint()}（否则页面不会被知识库索引到）');
    }
    expect(tools, 'MCP vault_write_page description 应带深度提示').toContain('白名单目录；${flatPagePathHint()}');
    expect(flatPagePathHint()).toContain('不要在目录里再建子目录');
    // 例外目录不能出现在给 AI 的提示里（否则等于鼓励它建子目录）
    for (const d of NESTED_PAGE_DIRS) expect(flatPagePathHint()).not.toContain(d);
  });

  it('深度校验只加在写入侧：读侧保持原样（存量错位页要能被读出来才谈得上归位）', async () => {
    const svc = await read('api/src/vault/vault-service.ts');
    // readFile / readFileBuffer 不调用 pageDepthError——全文只在 writeFile 里出现一次
    expect(svc.match(/pageDepthError\(/g), '深度校验应只在写盘入口出现一次').toHaveLength(1);
    // MCP 侧同理：allowWrite 分支才判深度
    const tools = await read('api/src/mcp/tools.ts');
    expect(tools).toMatch(/if \(allowWrite\) \{[\s\S]*?pageDepthError\(norm\)/);
  });

  // T02797：写侧拒收 + 读侧归位是同一套口径的两半，检测/归位不得自带第二份目录清单，
  //   否则 PAGE_DIRS 扩容时又会退回「一侧知道、一侧看不见」。
  it('错位页检测与归位复用同一份目录口径，不自带页面目录字面量', async () => {
    const scanner = await read('api/src/data-clean/misplaced-pages.ts');
    const imported = scanner.match(/import \{([\s\S]*?)\} from '\.\.\/vault\/page-scope\.js'/);
    expect(imported, '必须从 page-scope 取目录口径').toBeTruthy();
    for (const name of ['PAGE_DIRS', 'NESTED_PAGE_DIRS', 'TYPE_TO_PAGE_DIR', 'isPageFile']) {
      expect(imported![1], `检测应引用 ${name}`).toContain(name);
    }
    // 页面目录名只允许出现在注释里（说明成因时用）：不得出现「自带目录数组」的判断
    expect(scanner, '不得自带页面目录清单').not.toMatch(/=\s*\['(?:entities|concepts|comparisons|queries|qa|solutions)'/);
    expect(scanner, '媒体归档例外不得写死字面量').not.toMatch(/['"]queries\/media['"]/);
    // 归位落点由反查表给出，而不是硬编码 entities/... 之类
    expect(scanner).toContain('TYPE_TO_PAGE_DIR[type] ?? topDir');
  });

  it('TYPE_TO_PAGE_DIR 是 PAGE_DIR_TO_TYPE 的双射反量（有重复 type 时反查会静默丢一侧）', async () => {
    const dirs = Object.keys(PAGE_DIR_TO_TYPE);
    const types = Object.values(PAGE_DIR_TO_TYPE);
    expect(new Set(types).size, '两个目录共用一个 type 时，先改映射再动本用例').toBe(types.length);
    expect(new Set(dirs).size).toBe(dirs.length);
    for (const d of dirs) expect(TYPE_TO_PAGE_DIR[PAGE_DIR_TO_TYPE[d]]).toBe(d);
    for (const t of types) expect(PAGE_DIR_TO_TYPE[TYPE_TO_PAGE_DIR[t]]).toBe(t);
    expect(Object.keys(TYPE_TO_PAGE_DIR).sort()).toEqual([...types].sort());
    // 反查值必须仍是合法页面目录（否则归位会把页面搬进白名单外的目录）
    for (const d of Object.values(TYPE_TO_PAGE_DIR)) expect(PAGE_DIRS).toContain(d);
  });
});
