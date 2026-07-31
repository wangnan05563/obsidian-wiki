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
    // 文件夹检测：<DT><H3 ...>Folder Name</H3>
    const folderMatch = line.match(/<DT>\s*<H3[^>]*>([^<]*)<\/H3>/i);
    if (folderMatch) {
      const folderName = folderMatch[1].trim();
      // 栈式管理：遇到 </DL><p> 时出栈（HTML 的 DL 嵌套结构）
      // 当前层级的文件夹名作为子层级的路径前缀
      const currentPath = folderStack.length > 0
        ? folderStack[folderStack.length - 1] + '/' + folderName
        : folderName;
      folderStack.push(currentPath);
      seenFolders.add(currentPath);
      continue;
    }

    // 书签链接检测：<DT><A HREF="url" ...>Title</A>
    const linkMatch = line.match(/<DT>\s*<A\s+[^>]*HREF="([^"]*)"[^>]*>([^<]*)<\/A>/i);
    if (linkMatch) {
      const href = linkMatch[1];
      const title = linkMatch[2].trim() || href;

      // 只收集 http/https 协议的书签（排除 javascript:/place:/chrome: 等内部协议）
      if (!href.startsWith('http://') && !href.startsWith('https://')) continue;

      // 提取 ADD_DATE 属性（Unix 时间戳）
      const dateMatch = line.match(/ADD_DATE="(\d+)"/);
      const addDate = dateMatch ? new Date(Number(dateMatch[1]) * 1000).toISOString() : undefined;

      const folder = folderStack.length > 0
        ? folderStack[folderStack.length - 1]
        : '未分类';

      entries.push({ title, url: href, folder, addDate });
    }

    // 文件夹出栈：</DL><p> 表示当前层级的 DL 列表结束
    if (/<\/DL>/i.test(line) && folderStack.length > 0) {
      folderStack.pop();
    }
  }

  // 生成合并 Markdown：按文件夹分组
  const grouped = new Map<string, BookmarkEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.folder) || [];
    list.push(entry);
    grouped.set(entry.folder, list);
  }

  let combinedMarkdown = '# 浏览器书签\n\n';
  combinedMarkdown += `> 解析时间：${new Date().toISOString()}\n`;
  combinedMarkdown += `> 文件夹数：${seenFolders.size}  |  书签数：${entries.length}\n\n`;
  combinedMarkdown += '---\n\n';

  for (const [folder, folderEntries] of grouped) {
    combinedMarkdown += `## ${folder}\n\n`;
    for (const entry of folderEntries) {
      const dateStr = entry.addDate ? ` (${entry.addDate.slice(0, 10)})` : '';
      combinedMarkdown += `- [${entry.title}](${entry.url})${dateStr}\n`;
    }
    combinedMarkdown += '\n';
  }

  return {
    entries,
    totalFolders: seenFolders.size,
    totalBookmarks: entries.length,
    combinedMarkdown,
  };
}
