// @vitest-environment node
// 真实集成 + 加密路径：模拟真实 App 流程——登录后 unlockVault（启用加密），
// 两个账户在同一浏览器（共享 IndexedDB）分别写入会话，互相不可见。
// 此前单测未走加密路径，这是「测试通过但运行时泄漏」的核心盲区之一。
import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../src/stores/auth';
import { useConversationsStore } from '../src/stores/conversations';
import { unlock as unlockVault, lock as lockVault } from '../src/services/localVault';
import type { ConversationRecord } from '../src/types';

// node 环境无 localStorage / sessionStorage，提供最小 shim（vault 用其存设备盐 / 会话密钥）
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as any).localStorage = new MemStorage();
(globalThis as any).sessionStorage = new MemStorage();

function msg(content: string): any {
  return { id: crypto.randomUUID(), role: 'user', content, refs: [], createdAt: new Date().toISOString() };
}
function setUser(id: string) {
  const auth = useAuthStore();
  auth.user = { id, username: id, role: 'user', permissions: [] } as any;
}
function freshPinia() {
  setActivePinia(createPinia());
}

describe('真实加密路径下多账户隔离', () => {
  beforeEach(() => {
    indexedDB.deleteDatabase('karpathy-wiki-chat');
    lockVault();
  });

  it('A 加密写入、B 加密写入，互不可见', async () => {
    // A 登录 + 解锁（启用加密）
    freshPinia();
    setUser('admin-id');
    await unlockVault('password-A');
    const a = useConversationsStore();
    await a.persistConversation([msg('A 加密私密问答')]);

    // B 登录 + 解锁（启用加密）
    freshPinia();
    setUser('05563-id');
    await unlockVault('password-B');
    const b = useConversationsStore();
    await b.persistConversation([msg('B 加密私密问答')]);

    // A 重新加载
    freshPinia();
    setUser('admin-id');
    await unlockVault('password-A');
    const aAgain = useConversationsStore();
    await aAgain.loadConversations();
    const aTitles = aAgain.conversations.map((c) => c.title);
    expect(aTitles).toEqual(['A 加密私密问答']);

    // B 重新加载
    freshPinia();
    setUser('05563-id');
    await unlockVault('password-B');
    const bAgain = useConversationsStore();
    await bAgain.loadConversations();
    const bTitles = bAgain.conversations.map((c) => c.title);
    expect(bTitles).toEqual(['B 加密私密问答']);

    expect(aTitles).not.toContain('B 加密私密问答');
    expect(bTitles).not.toContain('A 加密私密问答');
  });

  it('未解锁时（密钥缺失）已加密记录不可见，不泄漏给其他用户', async () => {
    // A 加密写入
    freshPinia();
    setUser('admin-id');
    await unlockVault('password-A');
    const a = useConversationsStore();
    await a.persistConversation([msg('A 加密私密问答')]);
    lockVault(); // 模拟 B 未解锁（无密钥）

    // B 在未解锁状态下加载——密文无法解密，应得到空列表（不泄漏）
    freshPinia();
    setUser('05563-id');
    const b = useConversationsStore();
    await b.loadConversations();
    expect(b.conversations.map((c) => c.title)).not.toContain('A 加密私密问答');
  });
});
