const DB_NAME = 'karpathy-wiki-chat';
const DB_VERSION = 3;
export const CHAT_STORES = {
    conversations: 'conversations',
    attachments: 'attachments',
    preferences: 'preferences',
};
let databasePromise = null;
export function openChatDB() {
    if (databasePromise)
        return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error instanceof Error ? request.error : new Error('IndexedDB request failed'));
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            const transaction = request.transaction;
            if (!transaction)
                return;
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
        };
    });
    return databasePromise;
}
function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error instanceof Error ? request.error : new Error('IndexedDB request failed'));
    });
}
export async function dbGetAll(storeName) {
    const db = await openChatDB();
    return requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
}
export async function dbGet(storeName, key) {
    const db = await openChatDB();
    return requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).get(key));
}
export async function dbPut(storeName, value) {
    const db = await openChatDB();
    return requestResult(db.transaction(storeName, 'readwrite').objectStore(storeName).put(value));
}
export async function dbDelete(storeName, key) {
    const db = await openChatDB();
    await requestResult(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key));
}
