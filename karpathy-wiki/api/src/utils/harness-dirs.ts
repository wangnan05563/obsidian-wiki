// `.harness` 产物目录（compile-cache / logs / cleanup-audit / state）的单一口径（T02809）。
//
// 背景：run-state 目录在 T02772 已收成一处（utils/run-state-dirs.ts），但另外几类产物仍在各自拼路径：
//   - 写入侧 workflows/compile-workflow.ts 用 `path.join(vault.getVaultPath(), '..', '.harness', …)`
//     ——相对拼接（config 的 vaultPath 就是 `../data/vault` 这种相对值）；
//   - 清理侧 routes/cleanup.ts 用 `path.resolve(vaultPath, '..', '.harness')`——同一条链路的另一份写法。
// 两者今天对得上，只因为「server 与 compile 同进程同 CWD」，是巧合不是机制：换目录起进程
// （双击 SEA exe、从仓库根跑脚本）时产物会散到别处，清理与统计则对着另一个目录报 0——
// 与 T02772「卡面 0 个、磁盘上攒了 107 个」同一根因形态。
//
// 本模块做两件事：
//   1. 定根规则统一：相对 vaultPath 一律按 api 目录定根（这是 `../data/vault` 被写下来时假定的
//      起进程位置），已是绝对路径则原样使用（临时目录测试、SEA rebase 值都属此类）；
//   2. 给清理侧一份「规范 + 遗留」目录清单（与 getRunStateDirs 同族），使写入位置换过之后
//      历史产物仍然扫得到，而不是像 T02772 之前那样只能靠人工发现。
import path from 'node:path';
import { getApiDir, getDataDir } from './runtime.js';

// 把配置里的 vault 路径定根为绝对路径。opts.apiDir 供测试注入（不依赖真实仓库布局）。
export function toAbsVaultPath(vaultPath: string, opts: { apiDir?: string } = {}): string {
  if (path.isAbsolute(vaultPath)) return vaultPath;
  return path.resolve(opts.apiDir ?? getApiDir(), vaultPath);
}

// 与 vault 同级的 `.harness`：compile-workflow 的写入锚点（缓存与日志一直跟着 vault 走，
// 这里只是把它 absolutize，语义不变）。
export function getHarnessDirFromVault(vaultPath: string, opts: { apiDir?: string } = {}): string {
  return path.join(toAbsVaultPath(vaultPath, opts), '..', '.harness');
}

// 规范锚点：数据目录下的 `.harness`（run-state 在 T02772 就以此为唯一写入目录）。
// 真实部署里它与「与 vault 同级」同值（vault 就在 data/vault），两条口径的同值由
// api/test/run-state-dirs.test.ts 锁住；用户把 vault 配到别处时两者不同值，都得算进清理范围。
export function getCanonicalHarnessDir(dataDir: string = getDataDir()): string {
  return path.resolve(dataDir, '.harness');
}

// 遗留候选：改口径之前，产物位置由进程 CWD 决定（相对 vaultPath 展开），
// 所以除了 api 目录（开发模式的实际起法），还要认「当前 CWD 的上一级 data」这一路。
export function getLegacyHarnessDirs(opts: { apiDir?: string; cwd?: string } = {}): string[] {
  const apiDir = opts.apiDir ?? getApiDir();
  const cwd = opts.cwd ?? process.cwd();
  return [
    path.resolve(apiDir, '..', 'data', '.harness'),
    path.resolve(cwd, '..', 'data', '.harness'),
  ];
}

// 清理侧要扫的全部 `.harness` 目录：opts.primaryDirs 保持原顺序在前，其后追加遗留候选，
// resolve 后按小写去重（Windows 路径大小写不敏感、分隔符可能混用）。
// opts.legacyDirs 用于测试注入；生产不传，取真实候选，避免把用户别的目录算进删除清单。
export function getHarnessDirs(
  opts: {
    primaryDirs?: string[];
    vaultPath?: string;
    dataDir?: string;
    legacyDirs?: string[];
    apiDir?: string;
    cwd?: string;
  } = {},
): string[] {
  const primary =
    opts.primaryDirs ??
    [
      getCanonicalHarnessDir(opts.dataDir),
      ...(opts.vaultPath ? [getHarnessDirFromVault(opts.vaultPath, { apiDir: opts.apiDir })] : []),
    ];
  const legacy = opts.legacyDirs ?? getLegacyHarnessDirs({ apiDir: opts.apiDir, cwd: opts.cwd });
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...primary, ...legacy]) {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(path.resolve(dir));
  }
  return dirs;
}

// 单个 `.harness` 目录里的产物路径（逐目录统计/删除用，避免每处再手写文件名拼接）
export function compileCacheFileIn(harnessDir: string): string {
  return path.join(harnessDir, 'compile-cache.json');
}

export function logsDirIn(harnessDir: string): string {
  return path.join(harnessDir, 'logs');
}

export function stateDirIn(harnessDir: string): string {
  return path.join(harnessDir, 'state');
}

export function auditFileIn(harnessDir: string): string {
  return path.join(harnessDir, 'cleanup-audit.log');
}
