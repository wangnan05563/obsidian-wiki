import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ChatMessage, ConversationRecord } from '../types';
import { dbDelete, dbGet, dbGetAll, dbPut } from '../services/chatDb';
import { useQueryStore } from './query';

// IndexedDB 常量（保留作为离线缓存，权威数据源为后端 API）
const STORE_CONVERSATIONS = 'conversations';

// v1 ChatMessage → v2 ChatMessage 字段升级
// v1 refs 是 string[]（页面路径），v2 升级为 Reference[] 以支持联网搜索结果
function migrateV1Message(msg: ChatMessage): ChatMessage {
  const oldRefs = msg.refs as string[] | undefined;
  return {
    id: crypto.randomUUID(),
    role: msg.role,
    content: msg.content,
    refs: oldRefs?.map((path: string, i: number) => ({
      path,
      title: path.split('/').pop() || path,
      snippet: '',
      source: 'vault' as const,
      citeIndex: i + 1,
    })),
    followups: msg.followups,
    sessionId: msg.sessionId,
    messageIndex: msg.messageIndex,
    archived: msg.archived,
    createdAt: msg.createdAt || new Date().toISOString(),
  };
}

// 启动时执行：迁移所有 v1 格式的 ChatMessage 到 v2
// 为什么需要：v1 存储的 messages 没有 id 字段，v2 需要 id 用于反馈/重新生成等功能
async function migrateV1ToV2() {
  const allConversations = await dbGetAll<ConversationRecord>(STORE_CONVERSATIONS);
  for (const conv of allConversations) {
    let needsMigration = false;
    conv.messages = conv.messages.map((msg: ChatMessage) => {
      if (!msg.id) {
        needsMigration = true;
        return migrateV1Message(msg);
      }
      return msg;
    });
    if (needsMigration) {
      await dbPut(STORE_CONVERSATIONS, conv);
    }
  }
}

// 一次性迁移：将 IndexedDB 中的会话上传到后端，避免用户历史数据因 origin 切换而"丢失"
// 为什么需要：用户之前在 IndexedDB 积累的会话需迁移到后端持久化，否则切换访问方式后看不到旧会话
// 幂等设计：上传时后端 PUT 为 upsert，重复调用不会产生重复记录
async function migrateIndexedDbToBackend() {
  const allConversations = await dbGetAll<ConversationRecord>(STORE_CONVERSATIONS);
  if (allConversations.length === 0) return;

  // 并发上传所有会话，失败不阻断（下次启动可重试）
  await Promise.all(allConversations.map(async (conv) => {
    try {
      await fetch(`/api/conversations/${conv.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conv),
      });
    } catch {
      // 后端不可用时静默失败，保留 IndexedDB 数据供下次迁移
    }
  }));
}

export const useConversationsStore = defineStore('conversations', () => {
  const conversations = ref<ConversationRecord[]>([]);
  const currentConversationId = ref<string | null>(null);
  const searchKeyword = ref('');

  // 加载所有历史会话列表（启动时调用）
  // 权威数据源为后端 API；IndexedDB 仅作离线缓存与一次性迁移源
  async function loadConversations() {
    await migrateV1ToV2();
    // 一次性迁移：将 IndexedDB 旧会话上传到后端
    await migrateIndexedDbToBackend();

    try {
      const res = await fetch('/api/conversations');
      if (res.ok) {
        const data = await res.json() as { conversations: ConversationRecord[] };
        conversations.value = data.conversations ?? [];
        return;
      }
    } catch {
      // 后端不可用时降级读 IndexedDB 缓存
    }
    conversations.value = await dbGetAll<ConversationRecord>(STORE_CONVERSATIONS);
  }

  // 持久化当前对话到后端（IndexedDB 同步写入作为离线缓存）
  // 为什么需要：每轮问答完成后需落盘，支持侧栏历史列表与会话恢复
  async function persistConversation(messages: ChatMessage[]) {
    if (messages.length === 0) return;

    const id = currentConversationId.value || crypto.randomUUID();
    const existing = conversations.value.find((conversation) => conversation.id === id);

    // 深拷贝：剥离 Vue reactive proxy，转为纯对象供 fetch JSON 序列化与 IndexedDB structured clone
    // 为什么用 JSON 而非 structuredClone：structuredClone 无法克隆 Vue 3 reactive proxy 数组，
    // 会抛出 "[object Array] could not be cloned"；JSON.stringify 会自动遍历 proxy 属性生成纯对象
    const plainMessages: ChatMessage[] = JSON.parse(JSON.stringify(messages));

    const record: ConversationRecord = {
      id,
      title: existing?.title || plainMessages[0].content.slice(0, 30),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: plainMessages.length,
      isPinned: existing?.isPinned || false,
      preview: plainMessages.at(-1)!.content.slice(0, 60),
      messages: plainMessages,
    };

    // 后端持久化（权威）；IndexedDB 写入仅作缓存兜底，失败不影响主流程
    try {
      await fetch(`/api/conversations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
    } catch {
      // 后端不可用时仅写 IndexedDB 缓存
    }
    try {
      await dbPut(STORE_CONVERSATIONS, record);
    } catch {
      // IndexedDB 失败不阻断（如隐私模式）
    }

    // 同步更新内存列表（深拷贝避免 reactive proxy 污染）
    const idx = conversations.value.findIndex((conversation) => conversation.id === id);
    if (idx >= 0) {
      conversations.value[idx] = structuredClone(record);
    } else {
      conversations.value.push(structuredClone(record));
    }
    currentConversationId.value = id;
  }

  async function deleteConversation(id: string) {
    try {
      await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    } catch {
      // 后端不可用时降级操作 IndexedDB
    }
    try {
      await dbDelete(STORE_CONVERSATIONS, id);
    } catch {
      // IndexedDB 失败不阻断
    }
    conversations.value = conversations.value.filter(c => c.id !== id);
    if (currentConversationId.value === id) {
      currentConversationId.value = null;
    }
  }

  async function renameConversation(id: string, title: string) {
    try {
      await fetch(`/api/conversations/${id}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
    } catch {
      // 后端不可用时降级操作 IndexedDB
      const record = await dbGet<ConversationRecord>(STORE_CONVERSATIONS, id);
      if (record) {
        record.title = title;
        await dbPut(STORE_CONVERSATIONS, record);
      }
    }
    const idx = conversations.value.findIndex((conversation) => conversation.id === id);
    if (idx >= 0) conversations.value[idx].title = title;
  }

  async function togglePin(id: string) {
    try {
      const res = await fetch(`/api/conversations/${id}/pin`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json() as { isPinned: boolean };
        const idx = conversations.value.findIndex((conversation) => conversation.id === id);
        if (idx >= 0) conversations.value[idx].isPinned = data.isPinned;
        return;
      }
    } catch {
      // 后端不可用时降级操作 IndexedDB
    }
    const record = await dbGet<ConversationRecord>(STORE_CONVERSATIONS, id);
    if (record) {
      record.isPinned = !record.isPinned;
      await dbPut(STORE_CONVERSATIONS, record);
      const idx = conversations.value.findIndex((conversation) => conversation.id === id);
      if (idx >= 0) conversations.value[idx].isPinned = record.isPinned;
    }
  }

  // 切换到某历史会话：设置 currentId 并加载消息到 query store
  // 优先从后端读取完整会话（含 messages），后端不可用降级读 IndexedDB
  async function selectConversation(id: string) {
    currentConversationId.value = id;
    let messages: ChatMessage[] | null = null;
    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (res.ok) {
        const data = await res.json() as { conversation: ConversationRecord };
        messages = data.conversation.messages;
      }
    } catch {
      // 后端不可用时降级读 IndexedDB
    }
    if (!messages) {
      const record = await dbGet<ConversationRecord>(STORE_CONVERSATIONS, id);
      messages = record?.messages ?? [];
    }
    useQueryStore().loadMessages(messages);
  }

  function startNewConversation() {
    currentConversationId.value = null;
  }

  return {
    conversations,
    currentConversationId,
    searchKeyword,
    loadConversations,
    persistConversation,
    deleteConversation,
    renameConversation,
    togglePin,
    selectConversation,
    startNewConversation,
  };
});
