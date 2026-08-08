// FR-RM-07 透明静态加密：本地密钥可用时，对指定 store 的写入做信封加密（索引字段保留明文），
// 读取时透明解密。索引字段（id/ownerId/updatedAt/isPinned）须明文以便主键、隔离与排序。
// 加密范围仅 conversations（敏感问答文本）；attachments 含 Blob、preferences 为全局 UI 状态（登录前需用），
// 按设计不加密（见 SRS R-3 短期以 ownerId + 登录态兜底）。
import { getKey } from './localVault';
import { sealRecord, openRecord, isSealed } from './crypto';

// 各 store 需保留明文的索引字段
const ENCRYPTED_STORES: Record<string, string[]> = {
  conversations: ['id', 'ownerId', 'updatedAt', 'isPinned'],
};

const DB_NAME = 'karpathy-wiki-chat';
// 版本 3→4：conversations 增加 ownerId 索引，支撑本地多账户隔离（FR-RM-06）。
// 升级仅在已装旧库（v<4）时触发 onupgradeneeded；新装直接以 v4 建库。
const DB_VERSION = 4;

export const CHAT_STORES = {
  conversations: 'conversations',
  attachments: 'attachments',
  // FR-RM-08：个人配置（主题/TTS/模型/侧栏状态/偏好）仅存本地 IndexedDB，不回传服务端。
  preferences: 'preferences',
} as const;

let databasePromise: Promise<IDBDatabase> | null = null;

export function openChatDB(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error instanceof Error ? request.error : new Error('IndexedDB request failed'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      const transaction = request.transaction;
      if (!transaction) return;
      if (!db.objectStoreNames.contains(CHAT_STORES.conversations)) {
        db.createObjectStore(CHAT_STORES.conversations, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CHAT_STORES.attachments)) {
        db.createObjectStore(CHAT_STORES.attachments, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CHAT_STORES.preferences)) {
        db.createObjectStore(CHAT_STORES.preferences, { keyPath: 'key' });
      }
      const conversations = transaction.objectStore(CHAT_STORES.conversations);
      if (!conversations.indexNames.contains('updatedAt')) {
        conversations.createIndex('updatedAt', 'updatedAt');
      }
      if (!conversations.indexNames.contains('isPinned')) {
        conversations.createIndex('isPinned', 'isPinned');
      }
      // v4：ownerId 索引，支持按用户（authStore.user.id）隔离本地会话（FR-RM-06）
      if (!conversations.indexNames.contains('ownerId')) {
        conversations.createIndex('ownerId', 'ownerId');
      }
    };
  });
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error instanceof Error ? request.error : new Error('IndexedDB request failed'));
  });
}

export async function dbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openChatDB();
  const raw = (await requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).getAll())) as unknown[];
  const out = (await Promise.all(raw.map((r) => unwrap<T>(r)))) as (T | undefined)[];
  // 未解锁时无法解密的密文记录被过滤（不阻塞加载，由 localLocked 提示用户解锁）
  return out.filter((x) => x !== undefined) as T[];
}

export async function dbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openChatDB();
  const raw = await requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).get(key));
  return unwrap<T>(raw);
}

export async function dbPut<T>(storeName: string, value: T): Promise<IDBValidKey> {
  const key = getKey();
  const plainFields = ENCRYPTED_STORES[storeName];
  // 仅当本地密钥可用且非密文时加密；否则原样写入（向后兼容明文遗留数据）
  let toStore: unknown = value;
  if (key && plainFields && !isSealed(value)) {
    toStore = await sealRecord(value as Record<string, unknown>, plainFields, key);
  }
  const db = await openChatDB();
  return requestResult(db.transaction(storeName, 'readwrite').objectStore(storeName).put(toStore as never));
}

export async function dbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await openChatDB();
  await requestResult(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key));
}

// 透明解密单条记录：密文且已解锁 → 解密；密文未解锁 → undefined（上层按缺失处理）；明文 → 原样。
// 关键健壮性（FR-RM-06/FR-RM-07）：解密失败（密钥不匹配——多为「另一账户用不同登录密码派生的
// AES 密钥加密」的跨账户记录，或密文损坏）必须捕获并返回 undefined，由上层（dbGetAll 的 filter）
// 视为缺失跳过。否则 openRecord 抛出的 OperationError 会沿 dbGetAll → loadConversations 向上冒泡，
// 导致整个会话列表加载崩溃、侧栏停在陈旧/错误快照，表现为「切换账户后列表错乱/人人可见/历史消失」。
async function unwrap<T>(raw: unknown): Promise<T | undefined> {
  const k = getKey();
  if (isSealed(raw)) {
    if (!k) return undefined;
    try {
      return await openRecord<T>(raw, k);
    } catch {
      // 密钥不匹配或密文损坏：本条记录对当前用户不可解密 → 跳过（天然隔离 + 不阻断加载）
      return undefined;
    }
  }
  return raw as T;
}

// 检测某 store 是否存在已加密记录（用于提示用户解锁本地数据）
export async function dbHasSealed(storeName: string): Promise<boolean> {
  const db = await openChatDB();
  const raw = (await requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).getAll())) as unknown[];
  return raw.some((r) => isSealed(r));
}
