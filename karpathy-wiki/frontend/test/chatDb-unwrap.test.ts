// @vitest-environment node
// 验证 chatDb.unwrap 在「密钥不匹配（跨账户记录）」时返回 undefined 而非抛错，
// 这是 loadConversations 不崩溃、且跨账户记录被天然隔离的关键。
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach, vi } from 'vitest';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as any).localStorage = new MemStorage();
(globalThis as any).sessionStorage = new MemStorage();

const cryptoMod = await import('../src/services/crypto');
const chatDb = await import('../src/services/chatDb');
const localVault = await import('../src/services/localVault');

const STORE = 'conversations';

function rec(id: string, ownerId: string) {
  return { id, title: id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 1, isPinned: false, preview: id, messages: [], threadId: null, ownerId };
}

describe('chatDb.unwrap 跨账户密钥不匹配', () => {
  beforeEach(() => {
    indexedDB.deleteDatabase('karpathy-wiki-chat');
    localVault.lock();
  });

  it('A 加密的记录，B 解锁后 loadConversations 不崩溃且看不到 A 的记录', async () => {
    // A 解锁并写入（加密）
    await localVault.unlock('pw-A');
    const sealedA = await cryptoMod.sealRecord(rec('a1', 'A'), ['id', 'ownerId', 'updatedAt', 'isPinned'], localVault.getKey()!);
    await chatDb.dbPut(STORE, sealedA);

    // B 解锁（不同密码 → 不同密钥）
    localVault.lock();
    await localVault.unlock('pw-B');
    const all = await chatDb.dbGetAll<any>(STORE);
    // B 无法解密 A 的记录 → 被 unwrap 跳过 → 结果为空（天然隔离，不抛错）
    expect(all).toEqual([]);
  });

  it('未解锁时密文记录也被跳过（不抛错）', async () => {
    await localVault.unlock('pw-A');
    const sealedA = await cryptoMod.sealRecord(rec('a1', 'A'), ['id', 'ownerId', 'updatedAt', 'isPinned'], localVault.getKey()!);
    await chatDb.dbPut(STORE, sealedA);
    localVault.lock(); // 无密钥
    const all = await chatDb.dbGetAll<any>(STORE);
    expect(all).toEqual([]);
  });
});
