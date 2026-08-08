// 复制会话功能测试（F-3.3 增强：duplicateConversation）
// 验证：生成新 id / 深拷贝消息 / 标题加 (副本) / 不继承置顶 / 新 threadId / ownerId 归属 /
// 落盘 dbPut / 加入内存列表 / 不存在返回 null / 跨账户越权返回 null。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { ConversationRecord, ChatMessage } from '../src/types';

const { mockDb, mockQuery } = vi.hoisted(() => ({
  mockDb: {
    dbGetAll: vi.fn(),
    dbPut: vi.fn(),
    dbGet: vi.fn(),
    dbDelete: vi.fn(),
    dbHasSealed: vi.fn(),
  },
  mockQuery: { setThreadId: vi.fn(), loadMessages: vi.fn(), currentThreadId: null as string | null },
}));

vi.mock('../src/services/chatDb', () => ({
  dbGetAll: (...a: unknown[]) => mockDb.dbGetAll(...a),
  dbPut: (...a: unknown[]) => mockDb.dbPut(...a),
  dbGet: (...a: unknown[]) => mockDb.dbGet(...a),
  dbDelete: (...a: unknown[]) => mockDb.dbDelete(...a),
  dbHasSealed: (...a: unknown[]) => mockDb.dbHasSealed(...a),
}));

vi.mock('../src/services/localVault', () => ({
  unlock: vi.fn(),
  isUnlocked: () => true,
  lock: vi.fn(),
  restoreKeyFromSession: vi.fn(),
}));

vi.mock('../src/stores/query', () => ({
  useQueryStore: () => mockQuery,
}));

import { useConversationsStore } from '../src/stores/conversations';
import { useAuthStore } from '../src/stores/auth';

function msg(role: 'user' | 'assistant', content: string): ChatMessage {
  return { id: `m-${content}`, role, content, createdAt: '' } as ChatMessage;
}

function rec(
  id: string,
  ownerId: string | undefined,
  opts: Partial<ConversationRecord> = {}
): ConversationRecord {
  return {
    id,
    title: `会话${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 2,
    isPinned: false,
    preview: 'preview',
    messages: [msg('user', '你好'), msg('assistant', '你好，有什么可以帮你？')],
    threadId: `thread-${id}`,
    ownerId,
    ...opts,
  } as ConversationRecord;
}

function setUser(id: string | undefined) {
  const auth = useAuthStore();
  auth.user = id
    ? ({ id, username: id, role: 'user', enabled: true, createdAt: '', updatedAt: '', lastLoginAt: '', permissions: [] } as never)
    : null;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mockDb.dbGetAll.mockResolvedValue([]);
  mockDb.dbPut.mockResolvedValue('ok');
  mockDb.dbGet.mockResolvedValue(undefined);
  mockDb.dbDelete.mockResolvedValue(undefined);
  mockDb.dbHasSealed.mockResolvedValue(false);
  mockQuery.setThreadId.mockClear();
  mockQuery.loadMessages.mockClear();
});

describe('duplicateConversation 复制会话', () => {
  it('生成新 id（不同于源），标题追加 (副本)，并落盘 + 加入内存列表', async () => {
    setUser('admin');
    const store = useConversationsStore();
    const src = rec('a', 'admin');
    store.conversations = [src];

    const newId = await store.duplicateConversation('a');

    expect(newId).toBeTruthy();
    expect(newId).not.toBe('a');
    expect(mockDb.dbPut).toHaveBeenCalledTimes(1);
    const saved = mockDb.dbPut.mock.calls[0][1] as ConversationRecord;
    expect(saved.id).toBe(newId);
    expect(saved.title).toBe('会话a (副本)');
    expect(saved.ownerId).toBe('admin');
    // 加入内存列表（原 1 条 + 新副本 = 2 条）
    expect(store.conversations.map((c) => c.id)).toEqual(['a', newId]);
  });

  it('深拷贝消息：副本与源内容一致，但修改源不影响副本', async () => {
    setUser('admin');
    const store = useConversationsStore();
    const src = rec('a', 'admin');
    store.conversations = [src];

    const newId = await store.duplicateConversation('a');
    const copy = store.conversations.find((c) => c.id === newId)!;

    expect(copy.messages).toEqual(src.messages);
    expect(copy.messages).not.toBe(src.messages); // 不同引用
    // 修改源消息不应污染副本
    src.messages[0].content = '被篡改';
    expect(copy.messages[0].content).toBe('你好');
  });

  it('不继承置顶态，并赋予全新 threadId（隔离本地记忆线程）', async () => {
    setUser('admin');
    const store = useConversationsStore();
    const src = rec('a', 'admin', { isPinned: true });
    store.conversations = [src];

    const newId = await store.duplicateConversation('a');
    const saved = mockDb.dbPut.mock.calls[0][1] as ConversationRecord;
    const copy = store.conversations.find((c) => c.id === newId)!;

    expect(copy.isPinned).toBe(false);
    expect(saved.isPinned).toBe(false);
    expect(saved.threadId).toBeTruthy();
    expect(saved.threadId).not.toBe('thread-a');
    expect(copy.messageCount).toBe(2);
  });

  it('源会话不存在时返回 null，且不落盘', async () => {
    setUser('admin');
    const store = useConversationsStore();
    store.conversations = [];
    const r = await store.duplicateConversation('nope');
    expect(r).toBeNull();
    expect(mockDb.dbPut).not.toHaveBeenCalled();
  });

  it('跨账户越权：只复制归属当前用户的会话，他人会话返回 null', async () => {
    setUser('admin');
    const store = useConversationsStore();
    // 会话归属 05563，当前用户是 admin
    store.conversations = [rec('b', '05563')];
    const r = await store.duplicateConversation('b');
    expect(r).toBeNull();
    expect(mockDb.dbPut).not.toHaveBeenCalled();
  });
});
