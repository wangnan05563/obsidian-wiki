import { describe, it, expect } from 'vitest';
import {
  deriveKey,
  encryptString,
  decryptString,
  sealRecord,
  openRecord,
  isSealed,
} from '../src/services/crypto';

const SALT = new Uint8Array(16).fill(7);

describe('crypto (FR-RM-07)', () => {
  it('deriveKey 对相同密码+盐派生相同密钥（确定性）', async () => {
    const k1 = await deriveKey('pw', SALT);
    const k2 = await deriveKey('pw', SALT);
    const a = await encryptString(k1, 'x');
    expect(await decryptString(k2, a.iv, a.ct)).toBe('x');
  });

  it('encrypt/decrypt 往返（含非 ASCII）', async () => {
    const k = await deriveKey('pw', SALT);
    const { iv, ct } = await encryptString(k, 'hello 世界 🌍');
    expect(await decryptString(k, iv, ct)).toBe('hello 世界 🌍');
  });

  it('错误密钥解密失败', async () => {
    const k1 = await deriveKey('pw1', SALT);
    const k2 = await deriveKey('pw2', SALT);
    const { iv, ct } = await encryptString(k1, 'secret');
    await expect(decryptString(k2, iv, ct)).rejects.toBeTruthy();
  });

  it('seal/open 保留明文索引字段并加密其余', async () => {
    const k = await deriveKey('pw', SALT);
    const rec = {
      id: 'a',
      ownerId: 'u1',
      updatedAt: 't',
      isPinned: false,
      title: 'S',
      messages: [{ role: 'user', content: 'c' }],
    };
    const env = await sealRecord(rec, ['id', 'ownerId', 'updatedAt', 'isPinned'], k);
    expect(env._enc).toBe(1);
    expect(env.id).toBe('a');
    expect(env.ownerId).toBe('u1');
    expect(env.updatedAt).toBe('t');
    expect((env as Record<string, unknown>).messages).toBeUndefined();
    const opened = await openRecord<typeof rec>(env, k);
    expect(opened.title).toBe('S');
    expect(opened.messages).toEqual([{ role: 'user', content: 'c' }]);
  });

  it('isSealed 判定', () => {
    expect(isSealed({ _enc: 1, iv: 'x', ct: 'y' })).toBe(true);
    expect(isSealed({ id: 'a' })).toBe(false);
    expect(isSealed(null)).toBe(false);
  });
});
