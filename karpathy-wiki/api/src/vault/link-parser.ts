// T02921：[[wikilink]] 解析与目标名解析的唯一实现。
// 此前该正则至少六处各自重写（harness-adapter / vault-service / discover-workflow /
// compile-workflow / podcast-workflow / query-workflow），
// 均只取 [[ ]] 整串且按大小写精确匹配：
// - `[[huipiao-chengdui|汇票承兑]]` 被整串当目标名 → 假断链；
// - `[[Cpp014002]]` 对 `cpp014002.md` 判不上 → 假断链 + 假孤立页；
// 隔离副本实测：397 条断链里 83 条（20.9%）是这两类假阳性。
// Obsidian 语义：`[[目标|别名]]`、`[[目标#锚点]]`、`[[目标#^块引用]]` 的链接目标都是「目标」，
// 文件名匹配大小写不敏感——本模块把这两个口径收敛为单一来源。

export interface ParsedWikilink {
  target: string; // 链接目标（页面名，别名/锚点已拆掉）
  alias: string | null; // `[[目标|别名]]` 的别名
  anchor: string | null; // `[[目标#锚点]]` / `[[目标#^块引用]]` 的锚点（保留 ^ 前缀）
}

export const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

export function parseWikilink(raw: string): ParsedWikilink {
  let rest = raw.trim();
  let alias: string | null = null;
  const pipe = rest.indexOf('|');
  if (pipe >= 0) {
    alias = rest.slice(pipe + 1).trim();
    rest = rest.slice(0, pipe).trim();
  }
  let anchor: string | null = null;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    anchor = rest.slice(hash + 1);
    rest = rest.slice(0, hash).trim();
  }
  return { target: rest, alias, anchor };
}

// 扫描正文，按出现顺序返回去重后的链接目标名（别名/锚点已拆掉）。
// 页内去重：同一页指向同一目标的多个别名链接在断链/边口径里只计一条。
export function extractWikilinkTargets(content: string): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  WIKILINK_RE.lastIndex = 0; // 复用正则需重置 lastIndex
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    const t = parseWikilink(m[1]).target;
    if (t && !seen.has(t)) {
      seen.add(t);
      targets.push(t);
    }
  }
  return targets;
}

export interface LinkResolver {
  /** 目标名 → 页面相对路径；解析不到返回 null */
  resolve(target: string): string | null;
}

// 页面名索引：一个名字可对应多个页面路径（跨目录同名页），候选按路径稳定排序。
// T02951：此前 vault-service/harness-adapter 用 Map<string, string> 建索引，
// 同名页后者覆盖前者——被覆盖页永远不进 nameToPath.values()，出边全部丢失。
export type PageNameIndex = Map<string, string[]>;

const comparePath = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

function sortedUnique(paths: string[]): string[] {
  return [...new Set(paths)].sort(comparePath);
}

export function addPageName(index: PageNameIndex, name: string, rel: string): void {
  const arr = index.get(name);
  if (arr) {
    if (!arr.includes(rel)) arr.push(rel);
  } else {
    index.set(name, [rel]);
  }
}

// 登记页面：短名（basename）与「目录/短名」两种键都进索引。
// 同名页只能靠 `[[entities/hundsun]]` 这类路径限定链接精确指向，否则按稳定排序落到首个候选。
export function addPageToNameIndex(index: PageNameIndex, rel: string): void {
  const noExt = rel.replace(/\.md$/i, '');
  const slash = noExt.lastIndexOf('/');
  addPageName(index, noExt.slice(slash + 1), rel);
  if (slash >= 0) addPageName(index, noExt, rel);
}

// 目标名解析器：精确匹配优先；未命中回落大小写不敏感匹配。
// 候选按路径稳定排序取首个，避免同名/同大小写候选的不确定行为；
// 不做 toLowerCase 单键合并——不同页面可能仅大小写不同，精确命中必须优先且互不吞并。
// 兼容旧调用：值可以是单路径或路径数组。
export function createLinkResolver(nameToPath: Map<string, string | string[]>): LinkResolver {
  const byKey = new Map<string, string[]>();
  const byLower = new Map<string, string[]>();
  for (const [name, value] of nameToPath) {
    const cands = sortedUnique(Array.isArray(value) ? value : [value]);
    if (cands.length === 0) continue;
    byKey.set(name, cands);
    const lower = name.toLowerCase();
    const prev = byLower.get(lower);
    byLower.set(lower, prev ? sortedUnique(prev.concat(cands)) : cands);
  }
  return {
    resolve(target: string): string | null {
      const exact = byKey.get(target);
      if (exact && exact.length > 0) return exact[0];
      const cands = byLower.get(target.toLowerCase());
      return cands && cands.length > 0 ? cands[0] : null;
    },
  };
}
