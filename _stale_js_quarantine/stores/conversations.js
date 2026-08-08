import { defineStore } from 'pinia';
import { ref } from 'vue';
import { dbDelete, dbGet, dbGetAll, dbPut, dbHasSealed } from '../services/chatDb';
import { unlock as unlockVault, isUnlocked } from '../services/localVault';
import { useQueryStore } from './query';
import { useAuthStore } from './auth';
// IndexedDB 常量。会话数据现以 IndexedDB 为唯一权威源（本地优先，FR-RM-05/FR-RM-06）：
// 会话内容仅存于客户端，不再上传/双写后端 /api/conversations，按 ownerId 隔离多账户。
const STORE_CONVERSATIONS = 'conversations';
// 当前用户 id（用于 ownerId 隔离）。未登录时为 undefined，老数据（无 ownerId）按「归属当前用户」兼容。
function currentOwnerId() {
    return useAuthStore().user?.id;
}
// 本地多账户隔离过滤（FR-RM-06）：仅返回当前用户的会话；
// 老数据（升级前无 ownerId）缺失即视为归属当前用户，避免历史会话在升级后丢失。
function filterByOwner(conversations) {
    const owner = currentOwnerId();
    return conversations.filter((c) => c.ownerId === undefined || c.ownerId === owner);
}
// v1 ChatMessage → v2 ChatMessage 字段升级
// v1 refs 是 string[]（页面路径），v2 升级为 Reference[] 以支持联网搜索结果
function migrateV1Message(msg) {
    const oldRefs = msg.refs;
    return {
        id: crypto.randomUUID(),
        role: msg.role,
        content: msg.content,
        refs: oldRefs?.map((path, i) => ({
            path,
            title: path.split('/').pop() || path,
            snippet: '',
            source: 'vault',
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
    const allConversations = await dbGetAll(STORE_CONVERSATIONS);
    for (const conv of allConversations) {
        let needsMigration = false;
        conv.messages = conv.messages.map((msg) => {
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
    const conversations = ref([]);
    const currentConversationId = ref(null);
    const searchKeyword = ref('');
    // 本地数据锁定状态（FR-RM-07）：存在已加密记录但未解锁时为真，供 UI 提示用户输入密码解锁
    const localLocked = ref(false);
    // 加载所有历史会话列表（启动时调用）
    // 本地优先（FR-RM-05/FR-RM-06）：会话数据唯一权威源为 IndexedDB，按 ownerId 隔离多账户；
    // 不再调用后端 /api/conversations（避免会话内容落盘服务端）。
    async function loadConversations() {
        await migrateV1ToV2();
        // 读取全部本地会话，按当前用户隔离（老数据无 ownerId 视为当前用户，见 filterByOwner）
        const all = await dbGetAll(STORE_CONVERSATIONS);
        conversations.value = filterByOwner(all);
        // 未解锁且存在加密记录 → 提示用户解锁（FR-RM-07）
        localLocked.value = !isUnlocked() && (await dbHasSealed(STORE_CONVERSATIONS));
    }
    // 用登录密码解锁本地加密数据（FR-RM-07）：Help 页「解锁」按钮调用
    async function unlockLocalData(password) {
        await unlockVault(password);
        localLocked.value = false;
        await loadConversations();
    }
    // 持久化当前对话到 IndexedDB（本地优先，FR-RM-05）
    // 为什么只写 IndexedDB、不再 PUT 后端：会话内容仅存客户端，避免落盘服务端（D-1/FR-RM-05）。
    // 每次问答完成后落盘，支持侧栏历史列表与会话恢复；按 ownerId 归属当前用户实现多账户隔离（FR-RM-06）。
    async function persistConversation(messages) {
        if (messages.length === 0)
            return;
        const id = currentConversationId.value || crypto.randomUUID();
        const existing = conversations.value.find((conversation) => conversation.id === id);
        // 深拷贝：剥离 Vue reactive proxy，转为纯对象供 IndexedDB structured clone
        // 为什么用 JSON 而非 structuredClone：structuredClone 无法克隆 Vue 3 reactive proxy 数组，
        // 会抛出 "[object Array] could not be cloned"；JSON.stringify 会自动遍历 proxy 属性生成纯对象
        const plainMessages = JSON.parse(JSON.stringify(messages)); // NOSONAR: S7784 - structuredClone 无法克隆 Vue 3 reactive proxy 数组
        const record = {
            id,
            title: existing?.title || plainMessages[0].content.slice(0, 30),
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: plainMessages.length,
            isPinned: existing?.isPinned || false,
            preview: plainMessages.at(-1).content.slice(0, 60),
            messages: plainMessages,
            // 线程隔离键落盘：重开会话时可恢复本地记忆归属，续接上下文
            threadId: useQueryStore().currentThreadId ?? existing?.threadId,
            // 本地多账户隔离键（FR-RM-06）：归属当前用户；未登录时留空（升级前老数据兼容）
            ownerId: currentOwnerId(),
        };
        // 仅写入 IndexedDB（客户端本地权威源），不再双写后端
        try {
            await dbPut(STORE_CONVERSATIONS, record);
        }
        catch {
            // IndexedDB 失败不阻断（如隐私模式）
        }
        // 同步更新内存列表（深拷贝避免 reactive proxy 污染）
        const idx = conversations.value.findIndex((conversation) => conversation.id === id);
        if (idx >= 0) {
            conversations.value[idx] = structuredClone(record);
        }
        else {
            conversations.value.push(structuredClone(record));
        }
        currentConversationId.value = id;
    }
    async function deleteConversation(id) {
        // 本地优先：仅从 IndexedDB 删除（会话不落盘服务端，FR-RM-05）
        try {
            await dbDelete(STORE_CONVERSATIONS, id);
        }
        catch {
            // IndexedDB 失败不阻断
        }
        conversations.value = conversations.value.filter(c => c.id !== id);
        if (currentConversationId.value === id) {
            currentConversationId.value = null;
        }
    }
    async function renameConversation(id, title) {
        // 本地优先：仅更新 IndexedDB 中的标题
        const record = await dbGet(STORE_CONVERSATIONS, id);
        if (record) {
            record.title = title;
            await dbPut(STORE_CONVERSATIONS, record);
        }
        const idx = conversations.value.findIndex((conversation) => conversation.id === id);
        if (idx >= 0)
            conversations.value[idx].title = title;
    }
    async function togglePin(id) {
        // 本地优先：仅翻转并更新 IndexedDB 中的置顶状态
        const record = await dbGet(STORE_CONVERSATIONS, id);
        if (record) {
            record.isPinned = !record.isPinned;
            await dbPut(STORE_CONVERSATIONS, record);
            const idx = conversations.value.findIndex((conversation) => conversation.id === id);
            if (idx >= 0)
                conversations.value[idx].isPinned = record.isPinned;
        }
    }
    // 切换到某历史会话：设置 currentId 并从 IndexedDB 加载消息到 query store
    // 本地优先（FR-RM-05）：会话内容仅存客户端，不再从后端读取
    async function selectConversation(id) {
        currentConversationId.value = id;
        const record = (await dbGet(STORE_CONVERSATIONS, id)) ?? null;
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
    }
    return {
        conversations,
        currentConversationId,
        searchKeyword,
        localLocked,
        loadConversations,
        unlockLocalData,
        persistConversation,
        deleteConversation,
        renameConversation,
        togglePin,
        selectConversation,
        startNewConversation,
    };
});
