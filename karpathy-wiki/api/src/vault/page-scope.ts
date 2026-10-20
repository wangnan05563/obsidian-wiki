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
