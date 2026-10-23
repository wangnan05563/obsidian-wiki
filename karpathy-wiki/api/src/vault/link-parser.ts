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

// 目标名解析器：精确匹配优先；未命中回落大小写不敏感匹配。
// 回落候选按路径稳定排序取首个，避免同名候选的不确定行为；
// 不做 toLowerCase 单键合并——不同页面可能仅大小写不同，精确命中必须优先且互不吞并。
export function createLinkResolver(nameToPath: Map<string, string>): LinkResolver {
  const byLower = new Map<string, Array<{ path: string }>>();
  for (const [base, p] of nameToPath) {
    const k = base.toLowerCase();
    const arr = byLower.get(k);
    if (arr) arr.push({ path: p });
    else byLower.set(k, [{ path: p }]);
  }
  for (const arr of byLower.values()) {
    arr.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  return {
    resolve(target: string): string | null {
      const exact = nameToPath.get(target);
      if (exact) return exact;
      const cands = byLower.get(target.toLowerCase());
      return cands && cands.length > 0 ? cands[0].path : null;
    },
  };
}
