// @vitest-environment node
// 真实集成测试：用真正的 chatDb（IndexedDB）串联 conversations store，
// 模拟「同一浏览器共享 per-origin IndexedDB」下两个账户，验证严格隔离。
// 不 mock chatDb —— 这是此前单测的盲区，正是「测试通过但运行时泄漏」的来源。
import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../src/stores/auth';
import { useConversationsStore } from '../src/stores/conversations';
import { dbPut, dbGetAll } from '../src/services/chatDb';
import type { ConversationRecord } from '../src/types';

const STORE = 'conversations';

function msg(content: string): any {
  return { id: crypto.randomUUID(), role: 'user', content, refs: [], createdAt: new Date().toISOString() };
}

function setUser(id: string | null) {
  const auth = useAuthStore();
  auth.user = id ? ({ id, username: id, role: 'user', permissions: [] } as any) : null;
}

function seedRecord(id: string, ownerId: string | undefined, title: string): ConversationRecord {
  return {
    id,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 1,
    isPinned: false,
    preview: title,
    messages: [msg(title)],
    threadId: null,
    ownerId,
  };
}

describe('真实 IndexedDB 多账户隔离（共享 per-origin）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // 清空共享数据库，模拟全新浏览器
    indexedDB.deleteDatabase('karpathy-wiki-chat');
  });

  it('账户 A 写的会话，账户 B 完全看不到（严格隔离）', async () => {
    // 0. 重启 pinia 以确保 store 状态干净
    setActivePinia(createPinia());
    setUser('admin-id');
    const adminStore = useConversationsStore();
    await adminStore.persistConversation([msg('admin 的私密问答')]);

    // B 登录，写入自己的会话
    setActivePinia(createPinia());
    setUser('05563-id');
    const u05563 = useConversationsStore();
    await u05563.persistConversation([msg('05563 的私密问答')]);

    // A 重新加载会话 —— 必须只能看到自己的
    setActivePinia(createPinia());
    setUser('admin-id');
    const adminAgain = useConversationsStore();
    await adminAgain.loadConversations();
    const adminIds = adminAgain.conversations.map((c) => c.title).sort();
    expect(adminIds).toEqual(['admin 的私密问答']);

    // B 重新加载会话 —— 必须只能看到自己的
    setActivePinia(createPinia());
    setUser('05563-id');
    const u05563Again = useConversationsStore();
    await u05563Again.loadConversations();
    const u05563Ids = u05563Again.conversations.map((c) => c.title).sort();
    expect(u05563Ids).toEqual(['05563 的私密问答']);

    // 交叉验证：A 看不到 B 的，B 看不到 A 的
    expect(adminIds).not.toContain('05563 的私密问答');
    expect(u05563Ids).not.toContain('admin 的私密问答');
  });

  it('升级前的无主老数据：首个登录者认领，第二者绝不可见', async () => {
    // 模拟修复前写入的无主记录（ownerId === undefined）
    await dbPut(STORE, seedRecord('legacy-1', undefined, '老的无主会话'));

    // A 登录并加载 —— migrateOwnerless 应把老数据盖章归属 A 并落盘
    setActivePinia(createPinia());
    setUser('admin-id');
    const adminStore = useConversationsStore();
    await adminStore.loadConversations();
    expect(adminStore.conversations.map((c) => c.title)).toContain('老的无主会话');

    // 验证已落盘归属 A（真实读库，不再经过内存）
    const all = await dbGetAll<ConversationRecord>(STORE);
    const legacy = all.find((c) => c.id === 'legacy-1')!;
    expect(legacy.ownerId).toBe('admin-id');

    // B（第二个登录者）加载 —— 老数据已归属 A，B 绝不能看到
    setActivePinia(createPinia());
    setUser('05563-id');
    const u05563 = useConversationsStore();
    await u05563.loadConversations();
    expect(u05563.conversations.map((c) => c.title)).not.toContain('老的无主会话');
  });

  it('若认领未落盘（dbPut 抛错），无主数据对任何人都不泄漏', async () => {
    // 该安全失败路径由单元测（conversations-isolation.test.ts，mock dbPut 拒绝）覆盖；
    // 此处用真实 chatDb 验证「严格过滤」基线：即便老数据无主，已登录用户也只能看到自己 ownerId 的记录。
    await dbPut(STORE, seedRecord('legacy-fail', 'someone-else', '属于他人的老数据'));

    setActivePinia(createPinia());
    setUser('05563-id');
    const store = useConversationsStore();
    await store.loadConversations();

    // 05563 绝看不到他人 ownerId 的会话（严格过滤基线，无论落盘成功与否）
    expect(store.conversations.map((c) => c.title)).not.toContain('属于他人的老数据');
  });
});
