// T02686：PowerShell 侧的 Vault 目录清单入口（install.ps1 / setup-env.ps1 / build-exe.ps1 共用）。
//
// 为什么需要一个 .mjs 而不是让 .ps1 直接 import TS：安装脚本在依赖安装之前就要跑，
// 且 PowerShell 无法加载 api/src 的 TypeScript。这里的清单是
// api/src/vault/page-scope.ts 的**镜像**，两者的一致性由
// api/test/vault-dirs-single-source.test.ts 在 CI/本地 vitest 里逐集合断言——
// 只改一处就会有用例失败，不需要人工记得同步。
//
// 用法：
//   node scripts/vault-dirs.mjs init      → 每行一个目录（entities\nconcepts\n...），
//     PowerShell 侧 `@(& node vault-dirs.mjs init)` 直接得到字符串数组。
//     **刻意不输出 JSON**：Windows PowerShell 5.1 的 ConvertFrom-Json 把 JSON 数组当**单个对象**
//     返回，`@(... | ConvertFrom-Json)` 只会得到 Count=1 的元素是整份数组——安装脚本会拿它当
//     一个目录名去建目录（实测 count=1，first="entities concepts ... "）。
//   集合名：pages / writable / readable / init / titleDedupe
// 集合名写错或清单为空时**非零退出**：安装脚本据此中止，绝不回退到脚本内写死的清单
// （回退就等于把本单修掉的「静默缺目录」再种回去）。

export const PAGE_DIRS = ['entities', 'concepts', 'comparisons', 'queries', 'qa', 'solutions'];
export const NON_PAGE_DIRS = ['raw', 'drafts'];
export const WRITABLE_DIRS = [...PAGE_DIRS, ...NON_PAGE_DIRS];
export const READABLE_DIRS = [...PAGE_DIRS, ...NON_PAGE_DIRS];
export const INIT_DIRS = [...WRITABLE_DIRS];
export const TITLE_DEDUPE_DIRS = ['entities', 'concepts'];

export const VAULT_DIR_SETS = {
  pages: PAGE_DIRS,
  writable: WRITABLE_DIRS,
  readable: READABLE_DIRS,
  init: INIT_DIRS,
  titleDedupe: TITLE_DEDUPE_DIRS,
};

const isMain =
  process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (isMain) {
  const name = process.argv[2];
  const list = VAULT_DIR_SETS[name];
  if (!Array.isArray(list) || list.length === 0) {
    process.stderr.write(`vault-dirs.mjs: 未知或空目录集合「${name}」，可选：${Object.keys(VAULT_DIR_SETS).join('/')}\n`);
    process.exit(1);
  }
  process.stdout.write(list.join('\n'));
}
