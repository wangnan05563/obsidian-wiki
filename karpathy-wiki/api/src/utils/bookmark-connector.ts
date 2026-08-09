// FR-16-2 浏览器书签 Connector：解析书签 HTML 导出文件为 Markdown
// 为什么选书签作为首个 Connector：Netscape Bookmark HTML 格式是浏览器通用导出格式，
// 解析逻辑纯文本正则匹配，零外部依赖，实现难度最低
//
// 为什么独立于 url-crawl.ts：url-crawl 是 BFS 活页爬虫，书签是静态文件解析，
// 输入格式完全不同（HTML 文件 vs URL 入口），共用会破坏单一职责

// 书签条目
export interface BookmarkEntry {
  title: string;
  url: string;
  folder: string; // 所属文件夹层级路径，如 "技术/AI"
  addDate?: string; // 添加时间戳（HTML ADD_DATE 属性）
}

// 书签解析结果
export interface BookmarkResult {
  entries: BookmarkEntry[];
  totalFolders: number;
  totalBookmarks: number;
  combinedMarkdown: string;
}

// 尝试匹配文件夹行，返回文件夹路径或 null
function tryMatchFolder(line: string, folderStack: string[], seenFolders: Set<string>): boolean {
  const folderMatch = line.match(/<DT>\s*<H3[^>]*>(?<folderName>[^<]*)<\/H3>/i);
  if (!folderMatch) return false;
  const folderName = folderMatch.groups!.folderName.trim();
  const currentPath = folderStack.length > 0
    ? folderStack.at(-1) + '/' + folderName
    : folderName;
  folderStack.push(currentPath);
  seenFolders.add(currentPath);
  return true;
}

// 尝试匹配书签链接行，返回解析的书签条目或 null
function tryMatchBookmark(line: string, folderStack: string[]): BookmarkEntry | null {
  const linkMatch = line.match(/<DT>\s*<A\s+[^>]*HREF="(?<href>[^"]*)"[^>]*>(?<title>[^<]*)<\/A>/i);
  if (!linkMatch) return null;
  const href = linkMatch.groups!.href;
  if (!href.startsWith('http://') && !href.startsWith('https://')) return null;
  const title = linkMatch.groups!.title.trim() || href;
  const dateMatch = line.match(/ADD_DATE="(?<timestamp>\d+)"/);
  const addDate = dateMatch ? new Date(Number(dateMatch.groups!.timestamp) * 1000).toISOString() : undefined;
  const folder = folderStack.length > 0 ? folderStack.at(-1)! : '未分类';
  return { title, url: href, folder, ...(addDate ? { addDate } : {}) };
}

// 生成合并 Markdown：按文件夹分组
function buildBookmarkMarkdown(entries: BookmarkEntry[], seenFolders: Set<string>): string {
  const grouped = new Map<string, BookmarkEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.folder) || [];
    list.push(entry);
    grouped.set(entry.folder, list);
  }

  let md = '# 浏览器书签\n\n';
  md += `> 解析时间：${new Date().toISOString()}\n`;
  md += `> 文件夹数：${seenFolders.size}  |  书签数：${entries.length}\n\n`;
  md += '---\n\n';

  for (const [folder, folderEntries] of grouped) {
    md += `## ${folder}\n\n`;
    for (const entry of folderEntries) {
      const dateStr = entry.addDate ? ` (${entry.addDate.slice(0, 10)})` : '';
      md += `- [${entry.title}](${entry.url})${dateStr}\n`;
    }
    md += '\n';
  }
  return md;
}

/**
 * 解析 Netscape Bookmark HTML 格式文件
 *
 * 为什么不用 DOM 解析库（cheerio/jsdom）：书签 HTML 结构简单，
 * 正则匹配即可提取 <A HREF> 标签，避免引入额外依赖
 *
 * @param html 书签文件的完整 HTML 内容
 * @returns 解析后的书签结果
 */
export function parseBookmarksHtml(html: string): BookmarkResult {
  const entries: BookmarkEntry[] = [];
  const folderStack: string[] = [];
  const seenFolders = new Set<string>();

  // 逐行解析：DT 标签 + H3 标签 = 文件夹，A 标签 = 书签链接
  const lines = html.split(/\r?\n/);

  for (const line of lines) {
    if (tryMatchFolder(line, folderStack, seenFolders)) continue;
    const bookmark = tryMatchBookmark(line, folderStack);
    if (bookmark) {
      entries.push(bookmark);
    }
    // 文件夹出栈：</DL><p> 表示当前层级的 DL 列表结束
    if (/<\/DL>/i.test(line) && folderStack.length > 0) {
      folderStack.pop();
    }
  }

  return {
    entries,
    totalFolders: seenFolders.size,
    totalBookmarks: entries.length,
    combinedMarkdown: buildBookmarkMarkdown(entries, seenFolders),
  };
}
