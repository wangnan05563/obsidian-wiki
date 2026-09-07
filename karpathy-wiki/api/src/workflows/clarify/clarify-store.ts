// 澄清会话内存存储。
// 为什么内存而非落盘：澄清状态是「本轮问答的瞬时交互上下文」，随会话结束即失效；
// 与服务端不落盘会话（threadsPersist=false 默认）的产品定位一致，重启后自然失效（TTL 兜底）。
// 防泄漏：TTL 过期懒清理 + 会话总数上限（超出淘汰最旧）。
import type { ClarifySession } from './clarify-types.js';

export class ClarifySessionStore {
  // 会话总数上限：防恶意大量 clarifyId 撑爆内存（每会话仅 KB 级，500 上限足够）
  static readonly MAX_SESSIONS = 500;

  private sessions = new Map<string, ClarifySession>();

  // 懒清理：仅在访问时剔除过期项，避免引入定时器增加服务生命周期管理负担
  private sweep(now: number): void {
    if (this.sessions.size === 0) return;
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= now) this.sessions.delete(id);
    }
  }

  get(id: string): ClarifySession | undefined {
    this.sweep(Date.now());
    return this.sessions.get(id);
  }

  // 写入/更新会话；超出上限时淘汰最早创建的会话
  upsert(session: ClarifySession): void {
    this.sweep(Date.now());
    this.sessions.set(session.id, session);
    if (this.sessions.size > ClarifySessionStore.MAX_SESSIONS) {
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, s] of this.sessions) {
        if (s.createdAt < oldestAt) {
          oldestAt = s.createdAt;
          oldestId = id;
        }
      }
      if (oldestId) this.sessions.delete(oldestId);
    }
  }

  get size(): number {
    this.sweep(Date.now());
    return this.sessions.size;
  }
}
