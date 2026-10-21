// 运行状态（run-state）目录的单一口径（T02772）。
//
// 背景：harness 默认 FileStateStore 的落盘目录是**相对进程 CWD** 的 `.harness/state`
// （wiki-harness/src/state/file-state-store.ts 构造参数默认值）。而 api 里「规范目录」
// 是按数据目录算的 `getDataDir()/.harness/state`（index.ts 注册 /api/compile/runs 用的就是它）。
// 两者在开发模式下不同值（进程 CWD 是 api/，实际状态文件落到 api/.harness/state，
// 本机实测 107 个），打包（SEA）模式下更是取决于用户从哪个目录起进程——
// 结果就是「清理运行状态」只扫规范目录，遗留目录里的文件永远清不到，
// 且 SEA 下可能写进只读安装目录。
//
// 本模块把「哪些目录算 run-state」收成一处，供三个消费方共用同一份清单：
//   - 写入侧：engine/run-state-store.ts 一律写规范目录（不再随 CWD 漂移）；
//   - 清理侧：routes/cleanup.ts 的计数与删除覆盖「规范 + 遗留」，升级前已有的文件也能删掉；
//   - 读取侧：routes/runs.ts 的续传列表与步骤追踪跨目录合并，遗留文件不会因为换了目录就「消失」。
//
// 为什么遗留目录要同时给 apiDir 与 cwd 两个候选：改写入规范目录之前，实际位置由进程 CWD 决定；
// 开发模式 CWD==api 目录（历史文件就在 api/.harness/state），而从其它目录起进程（SEA 双击 exe
// 属此类）时历史文件在 <cwd>/.harness/state。两个候选都留，清完即自然收敛为空。
import path from 'node:path';
import { getApiDir, getDataDir } from './runtime.js';
import { toAbsVaultPath } from './harness-dirs.js';

// 规范目录：数据目录下的 .harness/state（开发模式 karpathy-wiki/data/，
// SEA 模式 %LOCALAPPDATA%\KarpathyWiki\data\，两者都在用户可写区）。
// 为什么参数可传 dataDir：测试用临时目录时不能碰用户真实数据目录。
export function getCanonicalRunStateDir(dataDir: string = getDataDir()): string {
  return path.resolve(dataDir, '.harness', 'state');
}

// 清理侧的规范目录：历史上 routes/cleanup.ts 是按「与 vault 同级」推导的
// （resolve(vaultPath, '..', '.harness', 'state')）。真实部署里 vault 就在 data/vault，
// 两条口径必须同值——否则清理清的就是一个不存在的目录（本单的原始症状）。
// 同值由 api/test/run-state-dirs.test.ts 断言锁死，改任一侧都会红。
// T02809：改走 toAbsVaultPath 定根。原先相对 vaultPath（config 里的 `../data/vault`）
// 由 path.resolve 按进程 CWD 展开，换目录起进程时它会变成一个既非规范、也不在遗留清单里的
// 第三方目录，混进 primaryDirs 后被当作「规范优先」项参与写入与标注。
export function getCanonicalRunStateDirFromVault(vaultPath: string): string {
  return path.join(toAbsVaultPath(vaultPath), '..', '.harness', 'state');
}

// 遗留目录候选（不含规范目录；去重在 getRunStateDirs 里做）
export function getLegacyRunStateDirs(opts: { apiDir?: string; cwd?: string } = {}): string[] {
  const apiDir = opts.apiDir ?? getApiDir();
  const cwd = opts.cwd ?? process.cwd();
  return [
    path.resolve(apiDir, '.harness', 'state'),
    path.resolve(cwd, '.harness', 'state'),
  ];
}

// 全部 run-state 目录，primaryDirs 保持原顺序在前（读取时同名 runId 以先出现者为准），
// 其后是遗留目录。调用方保证 primaryDirs[0] 是写入侧规范目录——清理结果的目录标注依赖这一点。
// opts.legacyDirs 用于测试注入（传 [] 即「只认 primary 目录」）；生产调用不传，取真实候选，
// 这样测试不会把用户真实的遗留目录算进删除清单。
export function getRunStateDirs(
  opts: { primaryDirs?: string[]; dataDir?: string; legacyDirs?: string[]; apiDir?: string; cwd?: string } = {},
): string[] {
  const primary = opts.primaryDirs ?? [getCanonicalRunStateDir(opts.dataDir)];
  const legacy = opts.legacyDirs ?? getLegacyRunStateDirs({ apiDir: opts.apiDir, cwd: opts.cwd });
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...primary, ...legacy]) {
    // Windows 路径大小写不敏感、分隔符可能混用：用 resolve 后转小写作去重键
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(path.resolve(dir));
  }
  return dirs;
}
