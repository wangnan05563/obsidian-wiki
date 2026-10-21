// T02797：存量错位页面（落在页面目录的**子目录**里的 .md）的检测与归位。
// ------------------------------------------------------------------
// 为什么必须单独做：T02731 只在写盘入口加了深度校验（page-scope.pageDepthError +
//   VaultService.writeFile + MCP validateKbPath），它只挡得住**新增**错位。写盘校验上线前
//   已经存在的错位页仍然彻底隐身——全库枚举页面一律是「对 PAGE_DIRS 逐个 flat readdir +
//   endsWith('.md') 过滤」（listAllPages / 链接图 / routes/stats.ts / hybrid-search /
//   quality-scanner / listPendingTagPages），子目录名不以 .md 结尾被直接跳过。
//   用户看到的现象：投递交数正常、编译日志与 log.md 都写着写成功，但列表/搜索/统计/图谱
//   一处都查无此页，[[引用]] 也解析不出——而且没有任何地方说「你有 N 个页面在子目录里丢了」。
//   T02731 当时靠人工 `find data/vault -mindepth 3 -name '*.md'` 取证后手工搬文件，
//   其它安装/历史 vault 没有这个人工环节，所以本单把「发现」和「归位」都做成产品能力。
//
// 口径全部取自 page-scope，不自带第二份清单：
//   页面目录 = PAGE_DIRS；刻意允许的嵌套归档 = NESTED_PAGE_DIRS（当前唯一成员 queries/media，
//   生图/视频/pptx 产物与 .md 归档同层，属设计而非错位，误报会让用户去搬合法文件）；
//   页面文件过滤 = isPageFile（联调遗留的 test-*.md 不是页面）；
//   目标目录 = TYPE_TO_PAGE_DIR（PAGE_DIR_TO_TYPE 的反向量，按页面自己声明的 type 找正确落点——
//   T02731 实测 `type: entity` 被写进 concepts/entity/，按目录名猜只会回到错的那个目录）。
//
// 归位保持「读侧不拒」前提：读仍走 vault.readFile（深度校验只在写侧，见 T02731 守护用例），
//   否则存量错位页根本读不出来，也就无从归位。
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { VaultService } from '../vault/vault-service.js';
import type { MisplacedPage, MisplacedPromoteResult } from '../types.js';
import {
  NESTED_PAGE_DIRS,
  PAGE_DIRS,
  TYPE_TO_PAGE_DIR,
  isPageFile,
  pageDirsSlash,
} from '../vault/page-scope.js';
import { resolveVaultPath } from './quality-scanner.js';

/** 列出一个顶层页面目录下的**子目录**名（顶层 .md 是常规页面，不在本模块职责内） */
async function listSubDirs(vault: VaultService, dirRel: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(vault.getVaultPath(), dirRel), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // 目录不存在（老库缺 qa/solutions 是已知现象）→ 没有子目录，不算错误
    return [];
  }
}

/** 递归收集 dirRel（已是错位目录）下的全部页面文件，含更深层嵌套 */
async function collectPagesUnder(vault: VaultService, dirRel: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(path.join(vault.getVaultPath(), dirRel), { withFileTypes: true });
  } catch (err) {
    // 列不出来（权限/占用）只留日志：这一类页面本来就没有第二处会报，静默等于回到 T02731 的症状
    console.warn(`[MISPLACED] 无法列出目录 ${dirRel}:`, err instanceof Error ? err.message : String(err));
    return;
  }
  for (const e of entries) {
    const childRel = `${dirRel}/${e.name}`;
    if (e.isDirectory()) await collectPagesUnder(vault, childRel, out);
    else if (e.isFile() && isPageFile(e.name)) out.push(childRel);
  }
}

/** 读 frontmatter 的 title/type；读不出来（权限/编码）时退回文件名，仍把这一页列出来 */
async function readPageMeta(vault: VaultService, rel: string): Promise<{ title: string; type: string }> {
  const fallbackTitle = path.posix.basename(rel, '.md');
  try {
    const data = matter(await vault.readFile(rel)).data as Record<string, unknown>;
    const title = typeof data.title === 'string' && data.title.trim() !== '' ? data.title : fallbackTitle;
    const type = typeof data.type === 'string' ? data.type.trim() : '';
    return { title, type };
  } catch {
    return { title: fallbackTitle, type: '' };
  }
}

/** 目标目录：type 能反查出合法页面目录就用它，否则留在原顶层目录（只补掉多余层级，不改归属） */
function resolveTargetDir(type: string, topDir: string): string {
  return TYPE_TO_PAGE_DIR[type] ?? topDir;
}

/**
 * 冲突判定（只报不动手）：命中任一条就意味着归位会把两页并成一页或覆盖已有内容，
 * 而并页是内容级决策（mergeDuplicatePages 那条链路才做得到），本模块不替用户决定。
 */
async function findConflict(
  vault: VaultService,
  item: { path: string; title: string; suggestedPath: string },
  siblings: MisplacedPage[],
): Promise<string | null> {
  const abs = resolveVaultPath(vault, item.suggestedPath);
  try {
    await fs.access(abs);
    return `目标位置已有同名页面：${item.suggestedPath}`;
  } catch {
    // 目标不存在，继续查下面两种
  }
  const twin = siblings.find((s) => s !== item && s.suggestedPath === item.suggestedPath);
  if (twin) return `与本批另一个页面同名：${twin.path} 也要归位到 ${item.suggestedPath}`;
  const sameTitle = await vault.findPageByTitle(item.title, path.posix.dirname(item.suggestedPath));
  if (sameTitle) return `目标目录已有同标题页面：${sameTitle}（需人工确认后合并，不自动并页）`;
  return null;
}

/**
 * 检测：扫 PAGE_DIRS 下不属于 NESTED_PAGE_DIRS 的子目录，列出其中的 .md。
 * 返回按路径升序，前端第一屏就能看到最该处理的（同一目录里的错位页相邻）。
 */
export async function detectMisplacedPages(vault: VaultService): Promise<MisplacedPage[]> {
  const relPaths: string[] = [];
  for (const dir of PAGE_DIRS) {
    for (const sub of await listSubDirs(vault, dir)) {
      const subRel = `${dir}/${sub}`;
      // 媒体归档目录整棵子树跳过：它合法（见 page-scope.NESTED_PAGE_DIRS 注释），误报等于鼓励用户搬错文件
      if (NESTED_PAGE_DIRS.includes(subRel)) continue;
      await collectPagesUnder(vault, subRel, relPaths);
    }
  }
  const items: MisplacedPage[] = [];
  for (const rel of relPaths.sort()) {
    const { title, type } = await readPageMeta(vault, rel);
    const suggestedPath = `${resolveTargetDir(type, rel.split('/')[0])}/${path.posix.basename(rel)}`;
    items.push({ path: rel, title, type, suggestedPath, conflict: null });
  }
  // 冲突要在整批都算完 target 之后再判：两页各自都不冲突、并到一起才撞车的情况很常见
  for (const item of items) {
    item.conflict = await findConflict(vault, item, items);
  }
  return items;
}

/** 归位后清掉搬空的子目录（从最深一层往上，到顶层页面目录为止——顶层本身永远不动） */
async function pruneEmptyDirs(vault: VaultService, oldRel: string): Promise<void> {
  const segments = oldRel.split('/');
  // segments[0] 是顶层页面目录（合法，不删），最后一段是文件名；从倒数第二段的目录开始
  for (let depth = segments.length - 1; depth >= 2; depth--) {
    const dirRel = segments.slice(0, depth).join('/');
    try {
      await fs.rmdir(resolveVaultPath(vault, dirRel));
    } catch {
      // 目录非空 / 并发占用：留在原地即可，父目录此时必然也不空
      return;
    }
  }
}

/**
 * 归位：读→写→删，逐条独立执行（单条失败不影响其余）。
 * 为什么不相信前端传来的目标路径：只接受「当前仍被检测为错位」的路径，落点由服务端重算——
 *   这样调用方无法借归位接口把任意路径写进 vault（路径合法性由 writeFile 的白名单 + 深度校验兜底）。
 * 冲突项一律跳过并说明原因；需要并页请走「页面质量清洗」的重复检测与合并动作。
 */
export async function promoteMisplacedPages(
  vault: VaultService,
  paths: string[],
  dryRun = true,
): Promise<MisplacedPromoteResult> {
  const result: MisplacedPromoteResult = { promoted: [], skipped: [], errors: [], dryRun };
  const detected = await detectMisplacedPages(vault);
  const byPath = new Map(detected.map((d) => [d.path, d]));

  for (const raw of paths) {
    const rel = String(raw ?? '').trim().replaceAll('\\', '/');
    if (!rel) continue;
    const item = byPath.get(rel);
    if (!item) {
      result.skipped.push({ path: rel, reason: `这个位置当前没有子目录中的页面（可能已归位或删除）；可归位的页面形如 ${pageDirsSlash()}/<子目录>/<文件名>.md` });
      continue;
    }
    if (item.conflict) {
      result.skipped.push({ path: rel, reason: item.conflict });
      continue;
    }
    if (dryRun) {
      result.promoted.push({ from: rel, to: item.suggestedPath });
      continue;
    }
    try {
      // 读侧不拒（存量页必须读得出才谈得上归位）；写侧仍走 writeFile，白名单与深度校验一道不少
      const content = await vault.readFile(rel);
      await vault.writeFile(item.suggestedPath, content);
      await fs.unlink(resolveVaultPath(vault, rel));
      result.promoted.push({ from: rel, to: item.suggestedPath });
      await pruneEmptyDirs(vault, rel);
    } catch (err) {
      result.errors.push(`归位失败 ${rel} → ${item.suggestedPath}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
