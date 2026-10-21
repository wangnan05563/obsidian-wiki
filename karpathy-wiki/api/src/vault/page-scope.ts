// T02472 L1：知识库「页面」口径的单一可信源。
// 背景：仪表盘总页数取自链接图（6 个页面目录），数据清洗页取自 scanVault（自带 3 目录白名单 +
//   测试文件过滤），同一 vault 在两处分别显示 245 与 216，用户读作「数据矛盾」。
// 约定：任何统计/扫描知识库页面的地方必须复用 PAGE_DIRS 与 isPageFile，不得再自带目录白名单。
// qa/solutions 加入：QQ 导入子系统编译产物需参与双向链接图（SRS §3.2 建立双向链接）
// drafts 不加入：draft 是中间状态，不应参与正式页面
export const PAGE_DIRS: string[] = ['entities', 'concepts', 'comparisons', 'queries', 'qa', 'solutions'];

// 联调遗留的测试文件（test-*.md / proxy-test*.md）不是正式页面
const TEST_PATTERNS = [/^test-.*\.md$/, /proxy-test.*\.md$/];

export function isPageFile(name: string): boolean {
  return name.endsWith('.md') && !TEST_PATTERNS.some((p) => p.test(name));
}

// ============================================================
// T02686：与「页面口径」相邻的三类目录集合也收在同一个文件里。
// 为什么放这儿而不是各自定义：历史上同一份清单在库内写了 4~6 遍（三个 .ps1、VaultService.init、
// mcp/tools、discover、search、hybrid-search 各一份），加一个目录要改多处，漏一处就是
// 「两个总数对不上」的同源缺陷（T02472 已修过一次，T02478 又因旧实例复现）。
// 三个集合语义不同，**不是同一份清单的副本**，差异原因逐条写清：
// ============================================================

/** 原始资料与中间态目录：不是页面，但合法可写 */
export const NON_PAGE_DIRS: string[] = ['raw', 'drafts'];

/**
 * 可写白名单 = 页面目录 + raw/drafts。
 * 与 PAGE_DIRS 的差异是刻意的：raw 存外部输入、drafts 存未发布草稿，二者可写但不参与链接图。
 */
export const WRITABLE_DIRS: string[] = [...PAGE_DIRS, ...NON_PAGE_DIRS];

/**
 * MCP / 只读侧可枚举目录 = 页面目录 + raw/drafts（与 WRITABLE_DIRS 同集合，
 * 单列一个名字是为了让「读侧」在代码里读得出来，不是第二份定义）。
 */
export const READABLE_DIRS: string[] = WRITABLE_DIRS;

/**
 * 初始化目录 = WRITABLE_DIRS。
 * 变化点：此前 install.ps1 / setup-env.ps1 / build-exe.ps1 / VaultService.init() 只建
 * `raw/entities/concepts/comparisons/queries` 5 个，缺 qa/solutions/drafts——新库首次使用前
 * 这三个目录不存在，routes/stats.ts 对缺目录是 `catch → 0`，仪表盘上表现为「静默的 0」，
 * 看不出是没内容还是没建目录。
 */
export const INIT_DIRS: string[] = WRITABLE_DIRS;

/**
 * 按 frontmatter title 去重的目录（编译 P2 去重仅对这两个目录生效）。
 * 保留独立定义的理由（T02686 要求逐处判定）：qa/solutions 按 rawId 命名天然不重复，
 * comparisons/queries 是聚合产物，按 title 重定向会把不同主题并成一页。
 */
export const TITLE_DEDUPE_DIRS: string[] = ['entities', 'concepts'];

/**
 * 目录 → frontmatter type 的推断映射（单一来源）。
 * 为什么收在这儿（T02686）：同一份映射原本有 3 份副本——compile-workflow.DIR_TO_TYPE 有 6 个目录、
 * 数据清洗 quality-scanner 的 typeMap 只有 4 个（缺 qa/solutions）、前端 Browse.vue dirMap 有 6 个。
 * 副本不一致的实际后果不是编译而是**补元信息写错 type**：给 qa/ 下的页面补 frontmatter 时，
 * 缺项映射会走 `|| 'concept'` 兜底，把 qa 页标成 concept，前端按 type 分组/看板随之分错。
 */
export const PAGE_DIR_TO_TYPE: Record<string, string> = {
  entities: 'entity',
  concepts: 'concept',
  comparisons: 'comparison',
  queries: 'query',
  qa: 'qa',
  solutions: 'solution',
};

/**
 * type → 页面目录 的反向映射（由 PAGE_DIR_TO_TYPE 派生，不另写一遍）。
 * 为什么单列（T02797）：存量错位页的归位要把「页面自己声明的 type」翻译成「正确落点」——
 *   T02731 实测的错位正是 `type: entity` 被写进了 `concepts/entity/`，按目录名猜只会回到错的那个目录，
 *   按 type 反查才指得出 `entities/`。反向量若手写第二份，PAGE_DIR_TO_TYPE 扩容时它就会落后，
 *   归位随之把新目录的页面搬到别处去。
 * 口径前提：PAGE_DIR_TO_TYPE 的 value 当前互不相同，反查是一对一；
 *   若将来两个目录共用一个 type，这里会静默保留后者——由 vault-page-depth.test.ts 的双射守护拦住。
 */
export const TYPE_TO_PAGE_DIR: Record<string, string> = Object.fromEntries(
  Object.entries(PAGE_DIR_TO_TYPE).map(([dir, type]) => [type, dir]),
);

/**
 * 页面目录的正则交替串（`entities|concepts|...`）。
 * discover.ts 与 tags.ts 各写过一遍同样的 6 目录白名单正则，新目录加入 PAGE_DIRS 时
 * 忘记同步的那一侧会把合法页面判成「Invalid path」→ 400。
 */
export const PAGE_DIRS_ALT: string = PAGE_DIRS.join('|');

/** 面向用户/LLM 的目录清单文案（`entities/concepts/.../solutions`）；工具 description 用它，避免文案落后于白名单 */
export function pageDirsSlash(): string {
  return PAGE_DIRS.join('/');
}

/** 给外部消费者（PowerShell 安装/打包脚本）的机器可读视图，键名即集合名 */
export const VAULT_DIR_SETS: Record<string, string[]> = {
  pages: PAGE_DIRS,
  writable: WRITABLE_DIRS,
  readable: READABLE_DIRS,
  init: INIT_DIRS,
  titleDedupe: TITLE_DEDUPE_DIRS,
};

// ============================================================
// T02731：页面路径「深度」口径（顶层目录之后不得再有子目录）。
// 为什么与目录清单放在一起：可写白名单只看顶层目录（`concepts/entity/x.md` 的顶层是
//   concepts，照样通过），于是一条 AI 写入把页面塞进了二层子目录。而全库枚举页面都是
//   对 PAGE_DIRS 逐个 flat readdir + `endsWith('.md')` 过滤（listPages / 链接图 / 统计 /
//   搜索 / 体检 / 标签），子目录名不以 .md 结尾被直接跳过 —— 页面落了盘却永远不会出现在
//   任何列表里，也解析不出 [[引用]]，表现为「投递交数正常但知识库查无此页」的静默丢失。
// 因此深度规则必须和白名单同源，写盘入口（VaultService.writeFile）只判一次即可覆盖
//   编译 / 体检修复 / QQ 导入 / MCP / 前端编辑全部写入方（工具层注释即写明「工具层无需重复校验」）。
// ============================================================

/**
 * 顶层目录之后允许再多一层的「嵌套目录」白名单。
 * 唯一成员 queries/media 的由来：生图/视频/pptx 产物统一归档在此，
 * routes/files.ts 的公开媒体路由只服务该前缀（MEDIA_PREFIX 由本集合派生，不另写一遍），
 * 二进制文件与 .md 归档同处一层，属刻意设计而非错位。
 */
export const NESTED_PAGE_DIRS: string[] = ['queries/media'];

/**
 * 校验页面路径深度，返回 null 表示合法，否则返回可直接回给 AI/用户的报错文案。
 * 规则：`<可写顶层目录>/<文件名>` 两段；NESTED_PAGE_DIRS 下的 `<目录>/<子目录>/<文件名>` 三段。
 * 为什么返回文案而不是抛异常：写盘入口与 MCP 工具层都要用同一句话，异常只在调用方各自包装。
 */
export function pageDepthError(relativePath: string): string | null {
  const norm = relativePath.replaceAll('\\', '/');
  const segments = norm.split('/').filter((s) => s.length > 0);
  // 一段（vault 根下的 index.md/log.md 等白名单文件）与两段（常规页面）都合法
  if (segments.length <= 2) return null;
  if (segments.length === 3 && NESTED_PAGE_DIRS.includes(`${segments[0]}/${segments[1]}`)) return null;
  return (
    `写入被拒绝：知识库页面必须直接放在顶层目录下，不要在目录里再建子目录。` +
    `正确形如 ${pageDirsSlash()}/<文件名>.md（当前路径：${norm}）`
  );
}

/**
 * 面向 LLM 的路径写法提示：写盘工具的 description 用它，与 pageDepthError 同口径。
 * 为什么单列：校验会拒写，但提示词落后于校验时 LLM 会反复撞同一堵墙（T02686 的「qa 写不进去」即同类）。
 */
export function flatPagePathHint(): string {
  return '路径必须是「顶层目录/文件名.md」两段，不要在目录里再建子目录';
}
