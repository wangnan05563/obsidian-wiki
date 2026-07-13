import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ChatMessage, ConversationRecord } from '../types';
import { dbDelete, dbGet, dbGetAll, dbPut } from '../services/chatDb';

// IndexedDB 常量
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

export const useConversationsStore = defineStore('conversations', () => {
  const conversations = ref<ConversationRecord[]>([]);
  const currentConversationId = ref<string | null>(null);
  const searchKeyword = ref('');

  // 加载所有历史会话列表（启动时调用）
  async function loadConversations() {
    await migrateV1ToV2();
    conversations.value = await dbGetAll<ConversationRecord>(STORE_CONVERSATIONS);
  }

  // 持久化当前对话到 IndexedDB
  // 为什么需要：每轮问答完成后需落盘，支持侧栏历史列表与会话恢复
  // 为什么用 JSON 深拷贝：store.messages 是 Vue reactive proxy，
  // IndexedDB structured clone 无法克隆 Proxy 对象，会报 "could not be cloned" 错误
  async function persistConversation(messages: ChatMessage[]) {
    if (messages.length === 0) return;

    const id = currentConversationId.value || crypto.randomUUID();
    const existing = conversations.value.find((conversation) => conversation.id === id);

    // 深拷贝：剥离 Vue reactive proxy，转为纯对象供 IndexedDB structured clone
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

    await dbPut(STORE_CONVERSATIONS, record);

    // 同步更新内存列表（深拷贝避免 reactive proxy 污染）
    const idx = conversations.value.findIndex((conversation) => conversation.id === id);
    if (idx >= 0) {
      conversations.value[idx] = JSON.parse(JSON.stringify(record));
    } else {
      conversations.value.push(JSON.parse(JSON.stringify(record)));
    }
    currentConversationId.value = id;
  }

  async function deleteConversation(id: string) {
    await dbDelete(STORE_CONVERSATIONS, id);
    conversations.value = conversations.value.filter(c => c.id !== id);
    if (currentConversationId.value === id) {
      currentConversationId.value = null;
    }
  }

  async function renameConversation(id: string, title: string) {
    const record = await dbGet<ConversationRecord>(STORE_CONVERSATIONS, id);
    if (record) {
      record.title = title;
      await dbPut(STORE_CONVERSATIONS, record);
      const idx = conversations.value.findIndex((conversation) => conversation.id === id);
      if (idx >= 0) conversations.value[idx].title = title;
    }
  }

  async function togglePin(id: string) {
    const record = await dbGet<ConversationRecord>(STORE_CONVERSATIONS, id);
    if (record) {
      record.isPinned = !record.isPinned;
      await dbPut(STORE_CONVERSATIONS, record);
      const idx = conversations.value.findIndex((conversation) => conversation.id === id);
      if (idx >= 0) conversations.value[idx].isPinned = record.isPinned;
    }
  }

  // 切换到某历史会话：设置 currentId 并加载消息到 query store
  async function selectConversation(id: string) {
    currentConversationId.value = id;
    const record = await dbGet<ConversationRecord>(STORE_CONVERSATIONS, id);
    if (record) {
      // 动态 import 避免循环依赖
      const { useQueryStore } = await import('./query');
      useQueryStore().loadMessages(record.messages);
    }
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
