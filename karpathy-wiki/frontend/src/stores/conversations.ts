import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ChatMessage, ConversationRecord } from '../types';
import { dbDelete, dbGet, dbGetAll, dbPut, dbHasSealed } from '../services/chatDb';
import { unlock as unlockVault, isUnlocked } from '../services/localVault';
import { useQueryStore } from './query';
import { useAuthStore } from './auth';
import { STORAGE_KEYS } from '../constants/storageKeys';

// FR-RM-09 断点续答：跨刷新记住「上次活跃会话」，重载后据此自动恢复并续答。
// 读写集中在此处（与写入 currentConversationId 同生命周期），避免键名散落。
function setLastActiveConversationId(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEYS.LAST_ACTIVE_CONVERSATION, id);
    else localStorage.removeItem(STORAGE_KEYS.LAST_ACTIVE_CONVERSATION);
  } catch {
    // 隐私模式/localStorage 不可用：静默降级，续答能力退化为不可用（不影响主流程）
  }
}

// FR-RM-09 读取上次活跃会话 id（供 Query.vue onMounted 判定是否需续答）
export function getLastActiveConversationId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.LAST_ACTIVE_CONVERSATION);
  } catch {
    return null;
  }
}

// IndexedDB 常量。会话数据现以 IndexedDB 为唯一权威源（本地优先，FR-RM-05/FR-RM-06）：
// 会话内容仅存于客户端，不再上传/双写后端 /api/conversations，按 ownerId 隔离多账户。
const STORE_CONVERSATIONS = 'conversations';

// 当前用户 id（用于 ownerId 隔离）。未登录时为 undefined。
function currentOwnerId(): string | undefined {
  return useAuthStore().user?.id;
}

// 本地多账户隔离过滤（FR-RM-06）：严格按 ownerId 返回归属当前用户的会话。
// 抽成纯函数便于单测。
// 关键安全约束：已登录用户（owner 有值）只返回 ownerId === owner 的记录；
// 老数据（ownerId === undefined）绝不向任何已登录账户放行——否则在「共享 per-origin
// IndexedDB」下，无主记录会被每个登录账户当作自己的而跨账户泄漏（正是此前「人人可见」的根因）。
// 无主老数据由 migrateOwnerless 在 loadConversations 时一次性盖章归属首个登录者并落盘，
// 此后按具体 ownerId 隔离；若盖章未落盘（异常），无主记录对所有人都不可见（安全失败，不泄漏）。
// 未登录（owner === undefined，无稳定身份）返回空，避免把无主记录误判为「当前用户」。
export function filterByOwner(conversations: ConversationRecord[], owner: string | undefined): ConversationRecord[] {
  if (owner === undefined) {
    return [];
  }
  return conversations.filter((c) => c.ownerId === owner);
}

// 老数据归属一次性固化（FR-RM-06 加固）：升级前产生的会话无 ownerId，在共享 per-origin IndexedDB 中
// 若不做固化，filterByOwner 的「ownerId 缺失→当前用户」规则会让它在每个登录账户下都可见，造成跨账户泄漏。
// 此处把 ownerId 缺失的记录盖章为当前用户并落盘，使其成为具体归属，后续按 ownerId 严格隔离。
// 仅当已登录（owner 有值）时执行；多账户场景下「首个登录者认领全部老数据」属一次性迁移的取舍，
// 优于老数据永久对所有人可见。
async function migrateOwnerless(all: ConversationRecord[], owner: string | undefined): Promise<void> {
  if (!owner) return;
  for (const c of all) {
    if (c.ownerId === undefined) {
      // 仅当落盘成功后才在内存中归属当前用户：避免「内存盖章但没持久化」导致无主记录
      // 在当前会话被认领可见、却未真正归属，下一次加载又被另一账户认领（即此前「人人可见」的运行时机制）。
      // 落盘失败则保持无主，交由 filterByOwner 严格过滤——对所有人都不可见（安全失败，不泄漏）。
      try {
        await dbPut(STORE_CONVERSATIONS, { ...c, ownerId: owner });
        c.ownerId = owner;
      } catch {
        // IndexedDB 失败：保持无主，严格过滤下不可见
      }
    }
  }
}

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
    threadId: msg.threadId,
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

// 注：历史上曾有 migrateIndexedDbToBackend（把 IndexedDB 会话上传后端 /api/conversations）。
// 自 SRS §2.3 本地优先模型起，会话内容仅存客户端（FR-RM-05），不再上传/双写后端，该函数已移除。

export const useConversationsStore = defineStore('conversations', () => {
  const conversations = ref<ConversationRecord[]>([]);
  const currentConversationId = ref<string | null>(null);
  const searchKeyword = ref('');
  // 当前用户（authStore.user.id）上一次 loadConversations 时的归属，用于在 auth 变化时
  // 判定是否需要重置会话作用域（FR-RM-06 防御）：切换账户后 currentConversationId 必须作废，
  // 否则下一用户复用同一 id 调 persistConversation 会把上一用户的会话覆盖并改属自己，
  // 表现为「admin 历史消失 / 人人可见」的跨账户泄漏。
  const scopedOwnerId = ref<string | null>(null);
  // 本地数据锁定状态（FR-RM-07）：存在已加密记录但未解锁时为真，供 UI 提示用户输入密码解锁
  const localLocked = ref(false);

  // 加载所有历史会话列表（启动时调用）
  // 本地优先（FR-RM-05/FR-RM-06）：会话数据唯一权威源为 IndexedDB，按 ownerId 隔离多账户；
  // 不再调用后端 /api/conversations（避免会话内容落盘服务端）。
  async function loadConversations() {
    await migrateV1ToV2();
    // 读取全部本地会话
    const all = await dbGetAll<ConversationRecord>(STORE_CONVERSATIONS);
    const owner = currentOwnerId();
    // 账户切换防御（FR-RM-06）：若本次加载的归属者与上次不同，当前会话作用域作废，
    // 避免下一用户复用同一 currentConversationId 覆盖上一用户的会话并改属自己。
    if (scopedOwnerId.value !== (owner ?? null)) {
      currentConversationId.value = null;
      scopedOwnerId.value = owner ?? null;
    }
    // 一次性固化老数据归属（ownerId 缺失→当前用户并落盘），避免共享 IndexedDB 下跨账户泄漏
    await migrateOwnerless(all, owner);
    // 按当前用户隔离（老数据无 ownerId 视为当前用户，见 filterByOwner）
    conversations.value = filterByOwner(all, owner);
    // 未解锁且存在加密记录 → 提示用户解锁（FR-RM-07）
    localLocked.value = !isUnlocked() && (await dbHasSealed(STORE_CONVERSATIONS));
  }

  // 账户切换 / 登出时由外层调用：作废当前会话 id 与会话作用域，强制按新账户隔离
  // （FR-RM-06 加固：阻止跨账户会话 id 复用导致的覆盖/改属泄漏）。
  function resetSession() {
    currentConversationId.value = null;
    scopedOwnerId.value = null;
    conversations.value = [];
  }

  // 用登录密码解锁本地加密数据（FR-RM-07）：Help 页「解锁」按钮调用
  async function unlockLocalData(password: string): Promise<void> {
    await unlockVault(password);
    localLocked.value = false;
    await loadConversations();
  }

  // 持久化当前对话到 IndexedDB（本地优先，FR-RM-05）
  // 为什么只写 IndexedDB、不再 PUT 后端：会话内容仅存客户端，避免落盘服务端（D-1/FR-RM-05）。
  // 每次问答完成后落盘，支持侧栏历史列表与会话恢复；按 ownerId 归属当前用户实现多账户隔离（FR-RM-06）。
  async function persistConversation(messages: ChatMessage[]) {
    if (messages.length === 0) return;

    let id = currentConversationId.value || crypto.randomUUID();
    const owner = currentOwnerId();

    // 跨账户覆盖防御（FR-RM-06）：currentConversationId 是模块级共享状态，若复用了一个
    // 「已落盘且归属他人」的 id（如上一用户残留的会话 id），绝不能把它覆盖并改属自己——
    // 这正是此前「admin 历史消失 / 人人可见」的根因。必须以 IndexedDB 实际记录为准
    // （内存列表按 ownerId 过滤后不含他人记录，不能作为判断依据）。
    // 注：未解锁场景下记录以明文落盘，dbGet 可直接读到 ownerId；已加密场景下若解密失败
    // unwrap 返回 undefined（无法判属），此时由 resetSession 在 auth 变化时作废
    // currentConversationId 作为主防御，二者互补。
    const persisted = await dbGet<ConversationRecord>(STORE_CONVERSATIONS, id);
    if (persisted && persisted.ownerId !== undefined && persisted.ownerId !== owner) {
      id = crypto.randomUUID();
    }

    const existing = conversations.value.find((conversation) => conversation.id === id);

    // 深拷贝：剥离 Vue reactive proxy，转为纯对象供 IndexedDB structured clone
    // 为什么用 JSON 而非 structuredClone：structuredClone 无法克隆 Vue 3 reactive proxy 数组，
    // 会抛出 "[object Array] could not be cloned"；JSON.stringify 会自动遍历 proxy 属性生成纯对象
    const plainMessages: ChatMessage[] = JSON.parse(JSON.stringify(messages)); // NOSONAR: S7784 - structuredClone 无法克隆 Vue 3 reactive proxy 数组

    const record: ConversationRecord = {
      id,
      title: existing?.title || plainMessages[0].content.slice(0, 30),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: plainMessages.length,
      isPinned: existing?.isPinned || false,
      preview: plainMessages.at(-1)!.content.slice(0, 60),
      messages: plainMessages,
      // 线程隔离键落盘：重开会话时可恢复本地记忆归属，续接上下文
      threadId: useQueryStore().currentThreadId ?? existing?.threadId,
      // 本地多账户隔离键（FR-RM-06）：归属当前用户；未登录时留空（升级前老数据兼容）
      ownerId: currentOwnerId(),
    };

    // 仅写入 IndexedDB（客户端本地权威源），不再双写后端
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
    // FR-RM-09 续答：每次落盘同步记住活跃会话，重载后据此恢复
    setLastActiveConversationId(id);
  }

  async function deleteConversation(id: string) {
    // 本地优先：仅从 IndexedDB 删除（会话不落盘服务端，FR-RM-05）
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
    // 本地优先：仅更新 IndexedDB 中的标题
    const record = await dbGet<ConversationRecord>(STORE_CONVERSATIONS, id);
    if (record) {
      record.title = title;
      await dbPut(STORE_CONVERSATIONS, record);
    }
    const idx = conversations.value.findIndex((conversation) => conversation.id === id);
    if (idx >= 0) conversations.value[idx].title = title;
  }

  async function togglePin(id: string) {
    // 本地优先：仅翻转并更新 IndexedDB 中的置顶状态
    const record = await dbGet<ConversationRecord>(STORE_CONVERSATIONS, id);
    if (record) {
      record.isPinned = !record.isPinned;
      await dbPut(STORE_CONVERSATIONS, record);
      const idx = conversations.value.findIndex((conversation) => conversation.id === id);
      if (idx >= 0) conversations.value[idx].isPinned = record.isPinned;
    }
  }

  // 复制会话（F-3.3 增强）：复制某会话的全部消息内容，生成一条全新的独立会话。
  // 用途：用户在已有问答基础上开新分支继续追问，而不破坏原会话。
  // 本地优先（FR-RM-05）：新会话同样只落盘 IndexedDB，归属当前用户（ownerId），
  // 并赋新的 threadId 以隔离本地记忆线程；标题追加「(副本)」便于区分；副本不继承置顶态。
  async function duplicateConversation(id: string): Promise<string | null> {
    const src = conversations.value.find((c) => c.id === id);
    if (!src) return null;
    // 跨账户越权保护：只复制归属当前用户的会话（FR-RM-06）
    const owner = currentOwnerId();
    if (src.ownerId !== undefined && src.ownerId !== owner) return null;

    const newId = crypto.randomUUID();
    // 深拷贝消息：剥离 Vue reactive proxy，转为纯对象供 IndexedDB 存储
    const plainMessages: ChatMessage[] = JSON.parse(JSON.stringify(src.messages)); // NOSONAR: S7784 - structuredClone 无法克隆 reactive proxy 数组
    const record: ConversationRecord = {
      id: newId,
      title: `${src.title} (副本)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: plainMessages.length,
      isPinned: false,
      preview: src.preview,
      messages: plainMessages,
      // 新线程隔离键：副本是独立会话，重置 threadId 避免与原会话共享本地记忆
      threadId: crypto.randomUUID(),
      ownerId: owner,
    };

    try {
      await dbPut(STORE_CONVERSATIONS, record);
    } catch {
      // IndexedDB 失败不阻断
    }
    conversations.value.push(structuredClone(record));
    return newId;
  }

  // 切换到某历史会话：设置 currentId 并从 IndexedDB 加载消息到 query store
  // 本地优先（FR-RM-05）：会话内容仅存客户端，不再从后端读取
  async function selectConversation(id: string) {
    currentConversationId.value = id;
    // FR-RM-09 续答：切换会话同步记住活跃会话
    setLastActiveConversationId(id);
    const record = (await dbGet<ConversationRecord>(STORE_CONVERSATIONS, id)) ?? null;
    // 越权保护：非当前用户（ownerId 不匹配）的会话不加载（FR-RM-06）
    if (record && record.ownerId !== undefined && record.ownerId !== currentOwnerId()) {
      useQueryStore().setThreadId(null);
      useQueryStore().loadMessages([]);
      return;
    }
    // 恢复线程隔离键：重开历史会话时一并恢复其本地记忆归属，使后续问答续接上下文
    useQueryStore().setThreadId(record?.threadId ?? null);
    useQueryStore().loadMessages(record?.messages ?? []);
  }

  function startNewConversation() {
    currentConversationId.value = null;
    // FR-RM-09 续答：开新会话清空活跃会话记忆（新会话尚未落盘，重载无需恢复）
    setLastActiveConversationId(null);
  }

  return {
    conversations,
    currentConversationId,
    searchKeyword,
    localLocked,
    scopedOwnerId,
    loadConversations,
    resetSession,
    unlockLocalData,
    persistConversation,
    deleteConversation,
    renameConversation,
    togglePin,
    duplicateConversation,
    selectConversation,
    startNewConversation,
  };
});
