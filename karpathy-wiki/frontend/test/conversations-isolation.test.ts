// 多账户会话隔离测试（FR-RM-06 / FR-RM-05）
// 验证：filterByOwner 纯函数隔离、loadConversations 按 owner 过滤 + 老数据一次性盖章、
// selectConversation 跨账户越权拦截。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { ConversationRecord } from '../src/types';

// 用 vi.hoisted 提升 mock 容器，避免 vi.mock 提升导致的 TDZ 问题
const { mockDb, mockQuery } = vi.hoisted(() => ({
  mockDb: {
    dbGetAll: vi.fn(),
    dbPut: vi.fn(),
    dbGet: vi.fn(),
    dbDelete: vi.fn(),
    dbHasSealed: vi.fn(),
  },
  mockQuery: { setThreadId: vi.fn(), loadMessages: vi.fn(), reset: vi.fn(), currentThreadId: null as string | null },
}));

// 模拟本地存储层，保证测试确定性（happy-dom 的 IndexedDB 不可靠）
vi.mock('../src/services/chatDb', () => ({
  dbGetAll: (...a: unknown[]) => mockDb.dbGetAll(...a),
  dbPut: (...a: unknown[]) => mockDb.dbPut(...a),
  dbGet: (...a: unknown[]) => mockDb.dbGet(...a),
  dbDelete: (...a: unknown[]) => mockDb.dbDelete(...a),
  dbHasSealed: (...a: unknown[]) => mockDb.dbHasSealed(...a),
}));

// 本地加密开关：测试中视为已解锁，聚焦隔离逻辑
vi.mock('../src/services/localVault', () => ({
  unlock: vi.fn(),
  isUnlocked: () => true,
  lock: vi.fn(),
  restoreKeyFromSession: vi.fn(),
}));

// query store 仅被调用副作用，用桩替换
vi.mock('../src/stores/query', () => ({
  useQueryStore: () => mockQuery,
}));

import { useConversationsStore, filterByOwner } from '../src/stores/conversations';
import { useAuthStore } from '../src/stores/auth';

function rec(id: string, ownerId: string | undefined, threadId?: string): ConversationRecord {
  return {
    id,
    title: id,
    createdAt: '',
    updatedAt: '',
    messageCount: 0,
    isPinned: false,
    preview: '',
    messages: [],
    threadId,
    ownerId,
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
  mockQuery.reset.mockClear();
});

describe('filterByOwner 纯函数隔离（严格）', () => {
  const data = [rec('a', 'admin'), rec('b', '05563'), rec('c', undefined)];

  it('admin 仅看到 ownerId === admin 的会话（无主老数据不向任何已登录账户放行）', () => {
    const r = filterByOwner(data, 'admin');
    expect(r.map((x) => x.id).sort()).toEqual(['a']);
  });

  it('05563 仅看到 ownerId === 05563 的会话', () => {
    const r = filterByOwner(data, '05563');
    expect(r.map((x) => x.id).sort()).toEqual(['b']);
  });

  it('未登录（owner 为 undefined）返回空，避免误把无主记录当「当前用户」泄漏', () => {
    const r = filterByOwner(data, undefined);
    expect(r.map((x) => x.id)).toEqual([]);
  });

  it('distinct owner 互不可见：admin 看不到 05563 的，也看不到无主的', () => {
    const adminView = filterByOwner(data, 'admin');
    const ids = adminView.map((x) => x.id);
    expect(ids).not.toContain('b');
    expect(ids).not.toContain('c');
  });
});

describe('loadConversations 隔离 + 老数据盖章', () => {
  it('admin 登录后只加载自己的会话，并把无 ownerId 的老数据盖章为 admin 并落盘', async () => {
    setUser('admin');
    const store = useConversationsStore();
    mockDb.dbGetAll.mockResolvedValue([rec('a', 'admin'), rec('b', '05563'), rec('c', undefined)]);

    await store.loadConversations();

    // 列表中不应出现 05563 的会话
    const ids = store.conversations.map((x) => x.id);
    expect(ids).not.toContain('b');
    expect(ids).toContain('a');
    expect(ids).toContain('c'); // 老数据仍对 admin 可见（已盖章为 admin）
    // migrateOwnerless 应为 ownerId 缺失的记录落盘（盖章为 admin）
    expect(mockDb.dbPut).toHaveBeenCalledWith('conversations', expect.objectContaining({ id: 'c', ownerId: 'admin' }));
  });

  it('05563 登录后看不到 admin 的会话（即使 admin 的老数据曾被盖章）', async () => {
    setUser('05563');
    const store = useConversationsStore();
    // 模拟 admin 已把老数据 c 盖章为自己的场景
    mockDb.dbGetAll.mockResolvedValue([rec('a', 'admin'), rec('b', '05563'), rec('c', 'admin')]);

    await store.loadConversations();

    const ids = store.conversations.map((x) => x.id);
    expect(ids).not.toContain('a');
    expect(ids).not.toContain('c');
    expect(ids).toContain('b');
  });

  it('安全失败：老数据盖章落盘失败时，第二个登录用户也看不到无主记录（不泄漏）', async () => {
    setUser('05563');
    const store = useConversationsStore();
    // 老数据 c 仍是 undefined（例如 migrateOwnerless 的 dbPut 落盘未生效）
    mockDb.dbGetAll.mockResolvedValue([rec('a', 'admin'), rec('b', '05563'), rec('c', undefined)]);
    // 模拟盖章落盘失败：dbPut 抛错（migrateOwnerless 吞掉异常，但 c 在库中仍无主）
    mockDb.dbPut.mockRejectedValueOnce(new Error('idb fail'));

    await store.loadConversations();

    const ids = store.conversations.map((x) => x.id);
    // 严格过滤：无主记录对 05563 不可见，即使盖章没落盘也不泄漏
    expect(ids).not.toContain('c');
    expect(ids).not.toContain('a');
    expect(ids).toContain('b');
  });
});

describe('resetSession 同步清空问答窗口（账户切换隔离，FR-RM-06）', () => {
  it('resetSession 必须清空 query store 的 messages 缓冲，避免上一用户问答残留在聊天窗口', () => {
    const store = useConversationsStore();
    store.resetSession();
    // 不清则桌面端切换用户后问答窗口仍显示上一用户内容（本次修复点）
    expect(mockQuery.reset).toHaveBeenCalledTimes(1);
  });

  it('resetSession 必须重置 viewingConversationId，避免上一账户"正在查看"状态跨账户残留', () => {
    const store = useConversationsStore();
    // 模拟已处于"正在查看某会话"状态（来自上一账户）
    store.setViewing('some-old-conversation-id');
    expect(store.viewingConversationId).not.toBeNull();
    store.resetSession();
    // 账户切换/登出隔离钩子须一并作废查看态，否则隔离态不完整（与窗口残留同源）
    expect(store.viewingConversationId).toBeNull();
  });

  it('账户切换典型流程（resetSession -> loadConversations）下，窗口已清空且历史按新 owner 隔离', async () => {
    // 模拟先以 admin 加载，再切换到 05563
    setUser('admin');
    const store = useConversationsStore();
    mockDb.dbGetAll.mockResolvedValue([rec('a', 'admin'), rec('b', '05563')]);
    await store.loadConversations();
    expect(store.conversations.map((x) => x.id)).toContain('a');

    // 切到 05563：消费侧（Query.vue / MobileShell.vue）先调 resetSession
    setUser('05563');
    store.resetSession();
    expect(mockQuery.reset).toHaveBeenCalled();
    await store.loadConversations();

    // 历史隔离：看不到 admin 的会话
    expect(store.conversations.map((x) => x.id)).not.toContain('a');
    expect(store.conversations.map((x) => x.id)).toContain('b');
  });
});

describe('selectConversation 跨账户越权拦截', () => {
  it('尝试打开他人（05563）的会话时被拦截，不加载其消息', async () => {
    setUser('admin');
    const store = useConversationsStore();
    mockDb.dbGet.mockResolvedValueOnce(rec('b', '05563', 'thread-05563'));

    await store.selectConversation('b');

    // 越权保护：setThreadId 收到 null，loadMessages 收到空数组
    expect(mockQuery.setThreadId).toHaveBeenCalledWith(null);
    expect(mockQuery.loadMessages).toHaveBeenCalledWith([]);
  });

  it('打开自己的会话时正常加载消息与线程键', async () => {
    setUser('admin');
    const store = useConversationsStore();
    const mine = rec('a', 'admin', 'thread-admin');
    mine.messages = [{ id: 'm1', role: 'user', content: 'hi', createdAt: '' }] as never;
    mockDb.dbGet.mockResolvedValueOnce(mine);

    await store.selectConversation('a');

    expect(mockQuery.setThreadId).toHaveBeenCalledWith('thread-admin');
    expect(mockQuery.loadMessages).toHaveBeenCalledWith(mine.messages);
  });
});
