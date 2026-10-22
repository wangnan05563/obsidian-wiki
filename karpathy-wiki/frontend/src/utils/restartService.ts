// 受控重启通道的前端口子（T02622 / PRD §10 C1，A 方案）
// ------------------------------------------------------------------
// 服务端 POST /api/restart 校验确认与空闲后回 202，再延迟优雅退出：
//   装机版 -> detached 拉起新实例（先等旧实例释放端口）；
//   开发模式 -> touch 入口文件触发 tsx watch 重跑。
// 前端只做三件事：发请求、把 400/409 翻成可操作文案、按 /health 的 bootId 变化确认结果。
// 为什么不用「端口重新可连」当成功：旧实例退出前端口照样能连，那会把没重启说成重启成功。
import { API_BASE, apiFetch } from './apiBase';

export const RESTART_URL = `${API_BASE}/restart`;
// /health 是根级路由（不在 /api 下），但同样跟随 Vite/Tailscale 的 base 前缀
export const HEALTH_URL = `${import.meta.env.BASE_URL}health`;

export type RestartMode = 'packaged' | 'dev-watch';

export interface RestartActiveState {
  compile: number;
  query: number;
  /** 已入队但还没起跑的编译：重启同样会把它们丢掉 */
  queuedCompile: number;
  blockedReasons: string[];
}

export type RestartTrigger =
  | { kind: 'accepted'; mode: RestartMode; bootId: string; delayMs: number; note: string }
  | { kind: 'blocked'; message: string; active: RestartActiveState }
  | { kind: 'error'; message: string };

export type BootWaitResult =
  | { kind: 'changed'; bootId: string }
  | { kind: 'timeout'; lastSeen: string | null };

/** 可注入的 fetch（单测用来替代网络，签名与 fetch 兼容） */
export type Send = (input: string, init?: RequestInit) => Promise<Response>;

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function asReasons(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * 请求重启。成功即表示服务端已接受（202），此时旧进程还没退——
 * 真正的成功要再用 waitForBootChange 比较 bootId。
 */
export async function requestRestart(send: Send = apiFetch): Promise<RestartTrigger> {
  let res: Response;
  try {
    res = await send(RESTART_URL, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
  } catch (err) {
    return { kind: 'error', message: `重启请求发不出去：${(err as Error).message}` };
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const serverMessage = typeof data.error === 'string' ? data.error : '';

  // 409 = 有编译/问答在跑：把后端列出的任务原样交给界面，不替它总结
  if (res.status === 409) {
    const active = (data.active ?? {}) as Record<string, unknown>;
    return {
      kind: 'blocked',
      message: serverMessage || '有正在进行的编译或问答，重启被拒绝',
      active: {
        compile: asCount(active.compile),
        query: asCount(active.query),
        queuedCompile: asCount(active.queuedCompile),
        blockedReasons: asReasons(active.blockedReasons),
      },
    };
  }
  if (!res.ok) {
    return { kind: 'error', message: serverMessage || `重启失败（HTTP ${res.status}）` };
  }

  const bootId = typeof data.bootId === 'string' ? data.bootId : '';
  if (!bootId) {
    return { kind: 'error', message: '服务端接受了重启但没回 bootId，无法确认是否真的重启' };
  }
  const mode: RestartMode = data.mode === 'dev-watch' ? 'dev-watch' : 'packaged';
  return {
    kind: 'accepted',
    mode,
    bootId,
    delayMs: typeof data.delayMs === 'number' ? data.delayMs : 0,
    note: typeof data.note === 'string' ? data.note : '',
  };
}

export interface BootWaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** 注入的 sleep/时钟，便于单测不真等待 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** 轮询 /health，直到 bootId 与 beforeBootId 不同；超时返回 timeout（调用方必须如实说「没重启」） */
export async function waitForBootChange(
  beforeBootId: string,
  send: Send = apiFetch,
  opts: BootWaitOptions = {},
): Promise<BootWaitResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let lastSeen: string | null = null;

  for (;;) {
    try {
      const res = await send(HEALTH_URL, { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { bootId?: unknown };
        if (typeof data.bootId === 'string') {
          lastSeen = data.bootId;
          if (data.bootId !== beforeBootId) return { kind: 'changed', bootId: data.bootId };
        }
      }
    } catch {
      // 旧进程已退、新进程未起的窗口里连接必然失败：这是重启的正常中间态
    }
    if (now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  return { kind: 'timeout', lastSeen };
}

/** 把阻塞原因拼成一行可读文案（弹窗顶部提示用） */
export function blockedSummary(active: RestartActiveState): string {
  const parts: string[] = [];
  if (active.compile > 0) parts.push(`${active.compile} 个编译任务`);
  if (active.query > 0) parts.push(`${active.query} 个问答`);
  if (active.queuedCompile > 0) parts.push(`${active.queuedCompile} 个编译排队`);
  return parts.length > 0 ? parts.join('、') : '未知任务';
}
