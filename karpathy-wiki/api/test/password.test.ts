import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateSalt,
  hashPassword,
  verifyPassword,
  generateSessionToken,
  verifySessionToken,
  getSessionSecret,
} from '../src/auth/password.js';

// 密码哈希与 Token 安全测试
// 覆盖点：盐生成、哈希确定性、恒定时间比较、Token HMAC 签名验证、密钥引用

describe('password 模块', () => {
  describe('generateSalt', () => {
    it('应返回 base64 编码的 16 字节盐', () => {
      const salt = generateSalt();
      expect(typeof salt).toBe('string');
      // 16 字节 base64 编码后约 24 字符
      const decoded = Buffer.from(salt, 'base64');
      expect(decoded.length).toBe(16);
    });

    it('每次调用返回不同盐', () => {
      const s1 = generateSalt();
      const s2 = generateSalt();
      expect(s1).not.toBe(s2);
    });
  });

  describe('hashPassword', () => {
    it('相同密码 + 盐 + 迭代次数应产生相同哈希（确定性）', () => {
      const salt = generateSalt();
      const h1 = hashPassword('password123', salt, 100000);
      const h2 = hashPassword('password123', salt, 100000);
      expect(h1).toBe(h2);
    });

    it('不同密码应产生不同哈希', () => {
      const salt = generateSalt();
      const h1 = hashPassword('password123', salt);
      const h2 = hashPassword('password456', salt);
      expect(h1).not.toBe(h2);
    });

    it('不同盐应产生不同哈希', () => {
      const s1 = generateSalt();
      const s2 = generateSalt();
      const h1 = hashPassword('password123', s1);
      const h2 = hashPassword('password123', s2);
      expect(h1).not.toBe(h2);
    });

    it('不同迭代次数应产生不同哈希', () => {
      const salt = generateSalt();
      const h1 = hashPassword('password123', salt, 100000);
      const h2 = hashPassword('password123', salt, 50000);
      expect(h1).not.toBe(h2);
    });

    it('默认迭代次数应为 100000', () => {
      const salt = generateSalt();
      const h1 = hashPassword('test', salt);
      const h2 = hashPassword('test', salt, 100000);
      expect(h1).toBe(h2);
    });

    it('哈希结果应可解码为 64 字节', () => {
      const salt = generateSalt();
      const hash = hashPassword('test', salt);
      const decoded = Buffer.from(hash, 'base64');
      expect(decoded.length).toBe(64);
    });
  });

  describe('verifyPassword', () => {
    it('正确密码应返回 true', () => {
      const salt = generateSalt();
      const hash = hashPassword('correctPassword', salt);
      expect(verifyPassword('correctPassword', salt, hash)).toBe(true);
    });

    it('错误密码应返回 false', () => {
      const salt = generateSalt();
      const hash = hashPassword('correctPassword', salt);
      expect(verifyPassword('wrongPassword', salt, hash)).toBe(false);
    });

    it('错误盐应返回 false', () => {
      const salt = generateSalt();
      const wrongSalt = generateSalt();
      const hash = hashPassword('password', salt);
      expect(verifyPassword('password', wrongSalt, hash)).toBe(false);
    });

    it('长度不同的哈希应返回 false 而非抛错', () => {
      const salt = generateSalt();
      const hash = hashPassword('password', salt);
      // 篡改哈希长度
      const tamperedHash = hash.slice(0, 10);
      expect(verifyPassword('password', salt, tamperedHash)).toBe(false);
    });

    it('迭代次数必须匹配，否则返回 false', () => {
      const salt = generateSalt();
      const hash = hashPassword('password', salt, 100000);
      expect(verifyPassword('password', salt, hash, 50000)).toBe(false);
    });
  });

  describe('generateSessionToken', () => {
    const secret = 'test-secret-key-at-least-16-chars';

    it('应返回 {random}.{hmac} 格式的 token', () => {
      const token = generateSessionToken(secret);
      expect(token).toContain('.');
      const parts = token.split('.');
      expect(parts).toHaveLength(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
    });

    it('每次调用返回不同 token', () => {
      const t1 = generateSessionToken(secret);
      const t2 = generateSessionToken(secret);
      expect(t1).not.toBe(t2);
    });
  });

  describe('verifySessionToken', () => {
    const secret = 'test-secret-key-at-least-16-chars';

    it('由 generateSessionToken 生成的 token 应验证通过', () => {
      const token = generateSessionToken(secret);
      expect(verifySessionToken(token, secret)).toBe(true);
    });

    it('篡改 random 部分应验证失败', () => {
      const token = generateSessionToken(secret);
      const [_, hmac] = token.split('.');
      const tampered = `tamperedRandomPart.${hmac}`;
      expect(verifySessionToken(tampered, secret)).toBe(false);
    });

    it('篡改 hmac 部分应验证失败', () => {
      const token = generateSessionToken(secret);
      const [random] = token.split('.');
      const tampered = `${random}.tamperedHmac`;
      expect(verifySessionToken(tampered, secret)).toBe(false);
    });

    it('不同密钥应验证失败', () => {
      const token = generateSessionToken(secret);
      expect(verifySessionToken(token, 'different-secret-key-16-chars')).toBe(false);
    });

    it('空 token 返回 false', () => {
      expect(verifySessionToken('', secret)).toBe(false);
    });

    it('不含点号的 token 返回 false', () => {
      expect(verifySessionToken('invalidToken', secret)).toBe(false);
    });
  });

  describe('getSessionSecret', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('环境变量存在且长度 ≥ 16 时返回环境变量值', () => {
      const envVar = 'WIKI_TEST_SESSION_SECRET';
      process.env[envVar] = 'a-valid-secret-with-16+chars';
      const secret = getSessionSecret(envVar);
      expect(secret).toBe('a-valid-secret-with-16+chars');
      delete process.env[envVar];
    });

    it('环境变量未设置时回退到随机密钥并发出警告', () => {
      const envVar = 'WIKI_TEST_NOT_SET_SECRET';
      delete process.env[envVar];
      const secret = getSessionSecret(envVar);
      expect(typeof secret).toBe('string');
      expect(secret.length).toBeGreaterThan(0);
      expect(console.warn).toHaveBeenCalled();
    });

    it('环境变量长度不足 16 时回退到随机密钥', () => {
      const envVar = 'WIKI_TEST_SHORT_SECRET';
      process.env[envVar] = 'short';
      const secret = getSessionSecret(envVar);
      expect(secret).not.toBe('short');
      expect(console.warn).toHaveBeenCalled();
      delete process.env[envVar];
    });

    it('每次回退生成的随机密钥应不同', () => {
      delete process.env.WIKI_TEST_RANDOM_SECRET_1;
      const s1 = getSessionSecret('WIKI_TEST_RANDOM_SECRET_1');
      const s2 = getSessionSecret('WIKI_TEST_RANDOM_SECRET_1');
      expect(s1).not.toBe(s2);
    });
  });
});
