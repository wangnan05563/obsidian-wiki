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
