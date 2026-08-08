// @vitest-environment node
// 回归测试：FR-RM-06 跨账户会话覆盖泄漏。
// 根因：currentConversationId 是 Pinia 模块级共享状态，登出/切换账户后若未重置，
// 下一账户复用同一 id 调 persistConversation 会把上一账户的会话「覆盖 + 改属自己」，
// 表现为「admin 历史消失 / 人人可见」。本测试用真实 chatDb（fake-indexeddb）复现并验证修复：
//   1) 切换账户时 resetSession 使 currentConversationId 作废；
//   2) persistConversation 复用他人归属的 id 时改生成新 id，绝不覆盖/改属。
import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../src/stores/auth';
import { useConversationsStore } from '../src/stores/conversations';
import type { ConversationRecord } from '../src/types';

const STORE = 'conversations';

function msg(content: string): any {
  return { id: crypto.randomUUID(), role: 'user', content, refs: [], createdAt: new Date().toISOString() };
}
function setUser(id: string | null) {
  const auth = useAuthStore();
  auth.user = id ? ({ id, username: id, role: 'user', permissions: [] } as any) : null;
}
function seedExisting(id: string, ownerId: string, title: string): ConversationRecord {
  return {
    id, title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messageCount: 1, isPinned: false, preview: title, messages: [msg(title)],
    threadId: null, ownerId,
  };
}

describe('FR-RM-06 回归：跨账户会话覆盖/改属泄漏', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    indexedDB.deleteDatabase('karpathy-wiki-chat');
  });

  it('账户 A 的会话不会被账户 B 复用同一 id 覆盖/改属', async () => {
    // A 创建一条会话（使用固定 id 模拟切换前残留的 currentConversationId）
    setActivePinia(createPinia());
    setUser('admin-id');
    const aStore = useConversationsStore();
    aStore.currentConversationId = 'shared-id-1';
    await aStore.persistConversation([msg('admin 的会话')]);

    // 验证落盘归属 A
    await aStore.loadConversations();
    expect(aStore.conversations.map((c) => c.title)).toContain('admin 的会话');
    expect(aStore.conversations.every((c) => c.ownerId === 'admin-id')).toBe(true);

    // B 登录（触发 auth watch → resetSession，或手动 resetSession）
    setActivePinia(createPinia());
    setUser('user-id');
    const bStore = useConversationsStore();
    bStore.resetSession(); // 模拟 Query.vue 的 auth watch
    await bStore.loadConversations();
    // B 不应看到 A 的任何会话
    expect(bStore.conversations.length).toBe(0);

    // B 复用「残留的 shared-id-1」写自己的会话 —— 必须生成新 id，不得覆盖 A 的
    bStore.currentConversationId = 'shared-id-1';
    await bStore.persistConversation([msg('user 的会话')]);

    // A 重新加载，必须仍只看到自己的、且内容未被 B 覆盖
    setActivePinia(createPinia());
    setUser('admin-id');
    const aAgain = useConversationsStore();
    await aAgain.loadConversations();
    const titles = aAgain.conversations.map((c) => c.title).sort();
    expect(titles).toEqual(['admin 的会话']);
    // 关键：A 的记录 id 未被 B 占用（B 用了新 id）
    const aRec = aAgain.conversations.find((c) => c.title === 'admin 的会话')!;
    expect(aRec.id).toBe('shared-id-1');
    expect(aRec.ownerId).toBe('admin-id');

    // B 的记录是独立新 id，归属 B
    setActivePinia(createPinia());
    setUser('user-id');
    const bAgain = useConversationsStore();
    await bAgain.loadConversations();
    expect(bAgain.conversations.map((c) => c.title)).toEqual(['user 的会话']);
    expect(bAgain.conversations[0].id).not.toBe('shared-id-1');
    expect(bAgain.conversations[0].ownerId).toBe('user-id');
  });

  it('resetSession 清空会话作用域，防止切换账户后残留 currentConversationId 被复用', () => {
    setActivePinia(createPinia());
    setUser('admin-id');
    const store = useConversationsStore();
    store.currentConversationId = 'some-id';
    store.conversations = [{ id: 'some-id', title: 'x', createdAt: '', updatedAt: '', messageCount: 0, isPinned: false, preview: '', messages: [], threadId: null, ownerId: 'admin-id' }];
    store.scopedOwnerId = 'admin-id';

    store.resetSession();

    expect(store.currentConversationId).toBeNull();
    expect(store.scopedOwnerId).toBeNull();
    expect(store.conversations).toEqual([]);
  });
});
