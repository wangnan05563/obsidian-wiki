import { describe, it, expect, vi, beforeEach } from 'vitest';

// 用内存假数据替换 chatDb，避免依赖 IndexedDB（happy-dom 不含 IDB）
vi.mock('../src/services/chatDb', () => ({
  dbGetAll: vi.fn(async (store: string) =>
    store === 'conversations' ? [{ id: 'c1', ownerId: 'u1', title: 'T', messages: [] }] : [{ id: 'a1' }],
  ),
  dbPut: vi.fn(async () => 'ok'),
}));

import { createBackup, restoreBackup, readBackupFile } from '../src/services/backup';
import { dbPut } from '../src/services/chatDb';

describe('backup (风险 R-2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createBackup 生成自包含加密文件', async () => {
    const f = await createBackup('pwd');
    expect(f.format).toBe('karpathy-wiki-backup');
    expect(f.version).toBe(1);
    expect(f.salt).toBeTruthy();
    expect(f.iv).toBeTruthy();
    expect(f.ct).toBeTruthy();
  });

  it('restoreBackup 用正确口令还原并写回两条记录', async () => {
    const f = await createBackup('pwd');
    const res = await restoreBackup(f, 'pwd');
    expect(res.conversations).toBe(1);
    expect(res.attachments).toBe(1);
    expect((dbPut as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });

  it('错误口令还原失败', async () => {
    const f = await createBackup('pwd');
    await expect(restoreBackup(f, 'wrong')).rejects.toThrow(/口令|损坏/);
  });

  it('readBackupFile 校验格式并拒绝无效文件', async () => {
    const f = await createBackup('pwd');
    const ok = await readBackupFile(new File([JSON.stringify(f)], 'b.json', { type: 'application/json' }));
    expect(ok.format).toBe('karpathy-wiki-backup');
    await expect(
      readBackupFile(new File(['{"format":"x"}'], 'bad.json', { type: 'application/json' })),
    ).rejects.toThrow(/有效/);
  });
});
