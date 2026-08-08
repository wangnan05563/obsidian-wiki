// @vitest-environment node
// 验证 TTS 朗读配置按用户维度隔离存储与读取（需求：各用户仅能访问自身配置，互不可见/互不干扰）。
// 复用 chatDb 的 preferences store，键名内嵌 userId：'tts-config::<userId>'。
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';

// Node 环境无 localStorage/sessionStorage，localVault 需要，提供内存实现（沿用 chatDb-unwrap 测试）。
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as any).localStorage = new MemStorage();
(globalThis as any).sessionStorage = new MemStorage();

const ttsConfig = await import('../src/services/ttsConfig');

const A = { provider: 'edge' as const, voice: 'zh-CN-YunyangNeural', style: 'newscast', rate: 1.5, volume: 12, pitch: 8 };
const B = { provider: 'edge' as const, voice: 'zh-CN-XiaoyiNeural', style: 'chat', rate: 0.8, volume: -10, pitch: -6 };

describe('TTS 配置按用户隔离', () => {
  beforeEach(() => {
    indexedDB.deleteDatabase('karpathy-wiki-chat');
  });

  it('不同用户写入相互独立、读取互不可见', async () => {
    await ttsConfig.saveTtsConfig('userA', A);
    await ttsConfig.saveTtsConfig('userB', B);

    const la = await ttsConfig.loadTtsConfig('userA');
    const lb = await ttsConfig.loadTtsConfig('userB');

    expect(la).toEqual(A);
    expect(lb).toEqual(B);
    // userA 读不到 userB 的值（反之亦然）
    expect(la.voice).toBe(A.voice);
    expect(la.voice).not.toBe(B.voice);

    // 第三用户未配置 -> 仅见默认，绝不泄漏 A/B
    const lc = await ttsConfig.loadTtsConfig('userC');
    expect(lc).toEqual(ttsConfig.DEFAULT_TTS_CONFIG);
    expect(lc.voice).not.toBe(A.voice);
    expect(lc.voice).not.toBe(B.voice);
  });

  it('更新某用户配置不影响另一用户', async () => {
    await ttsConfig.saveTtsConfig('userA', { ...ttsConfig.DEFAULT_TTS_CONFIG, voice: 'zh-CN-XiaoxiaoNeural' });
    await ttsConfig.saveTtsConfig('userB', { ...ttsConfig.DEFAULT_TTS_CONFIG, voice: 'zh-CN-YunyangNeural' });
    // 仅改 userA
    await ttsConfig.saveTtsConfig('userA', { ...ttsConfig.DEFAULT_TTS_CONFIG, voice: 'zh-CN-XiaomengNeural' });

    const la = await ttsConfig.loadTtsConfig('userA');
    const lb = await ttsConfig.loadTtsConfig('userB');
    expect(la.voice).toBe('zh-CN-XiaomengNeural');
    expect(lb.voice).toBe('zh-CN-YunyangNeural');
  });

  it('游客命名空间隔离：guest 与已登录用户互不干扰', async () => {
    await ttsConfig.saveTtsConfig('guest', { ...ttsConfig.DEFAULT_TTS_CONFIG, style: 'calm' });
    await ttsConfig.saveTtsConfig('userA', A);
    const lg = await ttsConfig.loadTtsConfig('guest');
    const la = await ttsConfig.loadTtsConfig('userA');
    expect(lg.style).toBe('calm');
    expect(la.style).toBe(A.style);
    expect(lg.style).not.toBe(la.style);
  });
});
