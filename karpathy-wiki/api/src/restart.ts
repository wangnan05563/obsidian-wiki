// 受控重启通道（T02622 / PRD §10 C1 的一键重启，A 方案）。
// ------------------------------------------------------------------
// 为什么做、当时为什么不做的历史：REQ-032 原话要求「一键重启入口」，此前只做到了
// 「待重启清单 + 重启指引弹窗」（frontend/src/utils/configPendingRestart.ts），原因是
// 服务端自杀式重启会切断正在跑的任务、且无人保证能再拉起。现在补上受控通道，
// 两个前提都已按实测口径落地：
//
//  1) 空闲判定复用 activity.ts 的进程内计数 + T02817 的跨进程合并。compile 类任务
//     全部收口在 withCompileLock（编译/续传/批量/体检批量修复/qq-ingest/prompts），
//     所以「编译队列、批量修复、QQ 导入」都在计数里；问答流计入 query。
//  2) 拉起方按形态分两条：
//     · 打包（SEA/pkg exe）：spawn(process.execPath) detached 自复制后自行退出。
//       实测父进程 exit(0) 后副本可长期存活；新实例启动自带 cleanupPort() 兜底端口残留。
//     · 开发（tsx watch）：**不能**自杀——实测子进程自行 exit(0) 后 watch 不会重跑
//       （服务就真的起不来了）；但被监听文件的 mtime 变化会触发 watch 换进程重跑
//       （实测 2.5s 内 pid 变化）。因此 dev 只用 utimes 触碰入口文件，不改内容。
//     两侧都由前端轮询 /health 的 bootId 确认「真的换了进程」，而不是假装成功。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { CleanupActiveState } from './types.js';
import { IS_SEA, getApiDir } from './utils/runtime.js';

/** 回响应后再退出，给浏览器留出拿到 202 的时间 */
export const RESTART_EXIT_DELAY_MS = 300;
/** 子实例等旧实例释放端口的上限；超时后仍继续启动（cleanupPort 会兜底） */
export const RESTART_PORT_WAIT_MS = 15_000;
/** 子实例标识：用于「先等端口释放」这一步 */
export const RESTART_CHILD_ENV = 'KW_RESTART_CHILD';
/** dev 模式要触碰的入口文件（tsx watch 监听它） */
export const DEV_WATCH_ENTRY = path.resolve(getApiDir(), 'src', 'index.ts');

export type RestartMode = 'packaged' | 'dev-watch';

export interface RestartRefusal {
  code: 'restart_blocked_by_active_task';
  error: string;
  active: Pick<CleanupActiveState, 'compile' | 'query'> & {
    queuedCompile: number;
    blockedReasons: string[];
  };
}

/**
 * 有活跃/排队任务就不许重启。
 * 活跃口径与清理守卫同源（同一个 activeStateAcrossProcesses 快照），但文案不复用
 * guardErrorMessage——那句是「已拦截真实删除 + 改用仅预览」，用在重启上会指错方向。
 * 排队数单独计：activity.ts 只统计已起跑的任务，重启却会连排队中的请求一起丢掉。
 */
export function restartRefusal(active: CleanupActiveState, queuedCompile = 0): RestartRefusal | null {
  const running = active.compile + active.query;
  if (running + queuedCompile === 0) return null;

  const parts: string[] = [];
  if (active.compile > 0) parts.push(`${active.compile} 个编译`);
  if (active.query > 0) parts.push(`${active.query} 个问答`);
  if (queuedCompile > 0) parts.push(`${queuedCompile} 个编译在排队`);
  // 跨进程拦下时把「是谁」带上，否则本进程一个任务都没有却看到「存在进行中任务」无从排查
  const foreign = [...new Set(active.blockedReasons.map((r) => r.reason))].filter((r) => r.includes('另一服务实例'));
  const note = foreign.length > 0 ? `（${foreign.join('；')}）` : '';

  return {
    code: 'restart_blocked_by_active_task',
    error: `存在进行中或排队任务（${parts.join('、')}）${note}，已拒绝重启：重启会中断这些任务。请等待结束或取消后再试。`,
    active: {
      compile: active.compile,
      query: active.query,
      queuedCompile,
      blockedReasons: active.blockedReasons.map((r) => r.reason),
    },
  };
}

export interface RestartHooks {
  /** 覆盖形态判定（测试用）；默认按 IS_SEA */
  packaged?: boolean;
  /** 覆盖自复制实现（测试用，避免真的拉起进程） */
  spawnSelf?: () => void;
  /** 覆盖 dev 触盘实现（测试用，避免动真实源码） */
  touchEntry?: () => void;
}

/** 执行拉起动作，返回本次走的通道。调用方负责先回 202、再延迟关闭旧实例。 */
export function performRestart(hooks: RestartHooks = {}): RestartMode {
  const packaged = hooks.packaged ?? IS_SEA;
  if (packaged) {
    (hooks.spawnSelf ?? spawnDetachedSelf)();
    return 'packaged';
  }
  (hooks.touchEntry ?? touchDevEntry)();
  return 'dev-watch';
}

function spawnDetachedSelf(): void {
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // 为什么固定 cwd：相对路径的落点跟进程 CWD 走（T02886），重启不该悄悄换一个工作目录
    cwd: process.cwd(),
    env: { ...process.env, [RESTART_CHILD_ENV]: '1' },
  });
  child.unref();
}

function touchDevEntry(): void {
  const now = new Date();
  // 只改 mtime，不碰内容：tsx watch 的判据是文件变化事件，不是内容 diff
  fs.utimesSync(DEV_WATCH_ENTRY, now, now);
}

/** 供子实例启动时调用：等旧实例释放端口，避免 EADDRINUSE 让重启失败。 */
export async function waitPortFree(
  port: number,
  timeoutMs: number = RESTART_PORT_WAIT_MS,
  intervalMs = 150,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(500, () => settle(false));
  });
}

/** 新实例启动时的固定动作：先等端口空出来，再走原有的清理与监听。 */
export async function awaitPortReleaseForRestart(port: number): Promise<void> {
  if (process.env[RESTART_CHILD_ENV] !== '1') return;
  const free = await waitPortFree(port);
  if (!free) {
    console.warn(`[启动] 等待旧实例释放端口 ${port} 超时，继续启动（将由 cleanupPort 兜底）`);
  }
}
