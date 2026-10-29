import matter from 'gray-matter';

// T03647：gray-matter 按「内容字符串原样」缓存解析结果，且缓存命中时只做浅拷贝
// （node_modules/gray-matter/index.js:35-47：`file = Object.assign({}, cached)`），
// 所以 parsed.data 以及 data 里的数组/对象仍是缓存本体。就地写它等于写缓存：
// 只要第二次读到的原始字节完全相同，就会拿到被第一次改过的同一个 data，随后
// matter.stringify 把别人的字段落进这个页面的 frontmatter。
// 约定：所有「读→改→写 frontmatter」的入口走本模块，先与缓存脱钩，改的永远是副本。
export type FrontmatterData = Record<string, any>;

export interface PageDoc {
  data: FrontmatterData;
  content: string;
}

// 深拷贝 frontmatter：YAML 值可能是数组/嵌套对象（如 entities），浅拷贝仍会串改缓存内部结构。
// 用 structuredClone 而非 JSON 往返：js-yaml 会把无引号日期解析成 Date，JSON 会把它压成字符串。
function detach<T>(value: T): T {
  return value === undefined || value === null
    ? (value as T)
    : structuredClone(value);
}

export function parsePage(raw: string): PageDoc {
  const parsed = matter(raw);
  return { data: detach(parsed.data) ?? {}, content: parsed.content };
}

// 正文以对象形式传入：避免 matter.stringify 再对正文做一次 YAML 解析
// （双块/非法内联 YAML 的历史页面会在重解析时抛 YAMLException）
export function stringifyPage(content: string, data: FrontmatterData): string {
  return matter.stringify({ content }, data);
}
