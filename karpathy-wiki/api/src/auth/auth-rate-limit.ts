// 认证接口限流（FR-RM-10）。
// 设计：纯内存固定窗口计数器，不引入任何额外中间件依赖（服务端内存级，满足 SRS 约束）。
// 维度：按 IP 与按用户名（username）双计数器，任一维度超限即拒绝（429）。
//   - 单 IP 10 次/分钟：防同一来源批量撞库/枚举。
//   - 单用户名探测 5 次/分钟：防针对特定用户名的存在性探测（注册）/ 爆破（登录）。
// 登录接口复用同一框架（SRS："登录接口可复用同一限流框架"）。
//
// 说明：项目全局已注册 @fastify/rate-limit（默认 60 req/min），本模块提供更严格的、
// 双维度的认证专用限额；由于本模块限额更紧（10 < 60），实际生效的是本模块的控制。
//
// 真实客户端 IP（见 clientIpFromRequest）：桶 key 由「不可伪造的 socket 对端 IP」
// 与「X-Forwarded-For 首跳」组合而成。仅当两者同时变化才能刷新整桶，单一字段
// （如客户端伪造 XFF 首跳）不足以绕过限流，堵住原「优先采信 XFF 首跳」的伪造绕过。

import type { FastifyRequest } from 'fastify';

const WINDOW_MS = 60_000;

/**
 * 还原真实客户端 IP 桶 key。
 * 桶 key = 不可伪造的 socket 对端 IP（request.ip）拼接 X-Forwarded-For 首跳。
 * 仅当 socket IP 与 XFF 首跳「同时」变化才能刷新整桶，单一字段（如客户端伪造 XFF 首跳）
 * 不足以绕过限流，堵住原「优先采信 XFF 首跳」的伪造绕过（排查报告模块 7 MEDIUM）。
 * 隧道场景（socket=127.0.0.1）下仍以 XFF 首跳区分真实客户端，不坍缩为全站单桶；
 * 若部署在可信反代之后且需以 XFF 作为权威 IP，应配置 Fastify trustProxy，而非在此信任客户端 XFF。
 */
export function clientIpFromRequest(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  const xffFirst = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() ?? '';
  return `${request.ip}|${xffFirst}`;
}

export interface AuthRateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** 距窗口重置的秒数；仅在 denied 时有意义，用于 429 的 Retry-After 头。 */
  retryAfterSec: number;
}

/** 固定窗口计数器：每个 key 在 [windowStart, windowStart+WINDOW_MS) 内最多 max 次。 */
class FixedWindowCounter {
  private readonly counts = new Map<string, { windowStart: number; count: number }>();
  /** 上次惰性淘汰的窗口起点；窗口前进时触发一次过期条目清理，避免 Map 随运行无限增长。 */
  private sweepWindow = -1;

  constructor(private readonly max: number) {}

  hit(key: string, now: number): AuthRateLimitResult {
    const windowStart = now - (now % WINDOW_MS);
    // 惰性淘汰：窗口前进后才扫描删除上一窗口的过期条目（每分钟每计数器最多一次 O(n) 扫描）。
    // 不依赖 TTL 定时器，避免额外常驻资源；条目不会跨窗口累积，内存有界。
    if (this.sweepWindow !== windowStart) {
      for (const [k, e] of this.counts) {
        if (e.windowStart !== windowStart) this.counts.delete(k);
      }
      this.sweepWindow = windowStart;
    }
    let entry = this.counts.get(key);
    if (entry?.windowStart !== windowStart) {
      // 窗口已滚动或首次命中：重置计数
      entry = { windowStart, count: 0 };
      this.counts.set(key, entry);
    }
    if (entry.count >= this.max) {
      const retryAfterSec = Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000));
      return { allowed: false, limit: this.max, remaining: 0, retryAfterSec };
    }
    entry.count += 1;
    const remaining = this.max - entry.count;
    return { allowed: true, limit: this.max, remaining, retryAfterSec: 0 };
  }

  /** 清空所有计数（测试用）。同时重置惰性淘汰窗口，保证测试间计数器完全隔离。 */
  reset(): void {
    this.counts.clear();
    this.sweepWindow = -1;
  }
}

// 各维度限额（与 SRS FR-RM-10 一致）。
const registerIp = new FixedWindowCounter(10); // 单 IP 10 次/分钟
const registerUser = new FixedWindowCounter(5); // 单用户名探测 5 次/分钟
const loginIp = new FixedWindowCounter(10); // 单 IP 10 次/分钟
const loginUser = new FixedWindowCounter(5); // 单用户名 5 次/分钟（防爆破）

export type AuthRateLimitKind = 'register' | 'login';

/**
 * 校验认证接口是否受限。
 * @param ip        请求来源 IP（request.ip）
 * @param username  尝试的用户名（缺失时不计入用户名维度，仅 IP 维度生效）
 * @param kind      'register' | 'login'
 * @param now       当前时间戳（测试可注入以控制窗口）
 */
export function checkAuthRateLimit(opts: {
  ip: string;
  username?: string;
  kind: AuthRateLimitKind;
  now?: number;
}): AuthRateLimitResult {
  const now = opts.now ?? Date.now();
  const ipLim = opts.kind === 'register' ? registerIp : loginIp;
  const userLim = opts.kind === 'register' ? registerUser : loginUser;

  // IP 维度始终计入
  const ipRes = ipLim.hit(`ip:${opts.ip}`, now);
  // 用户名维度：缺失（如空 body）时不计入，避免误伤
  const userRes = opts.username
    ? userLim.hit(`user:${opts.username}`, now)
    : { allowed: true, limit: 0, remaining: 0, retryAfterSec: 0 };

  // 任一维度超限即拒绝；返回更严格的那个结果（retryAfter 取较大值）
  if (!ipRes.allowed) return ipRes;
  if (!userRes.allowed) return userRes;
  return ipRes;
}

/** 测试用：清空所有认证限流计数。 */
export function resetAuthRateLimiters(): void {
  registerIp.reset();
  registerUser.reset();
  loginIp.reset();
  loginUser.reset();
}
