// useTtsStore 按用户维度隔离（store 层集成测试）
// 目标：验证 store 通过 watch(authStore.user?.id) 驱动 loadForUser/persist，
//       在登录/切换账户/登出时自动按当前用户读写各自的 tts-config::<userId> 命名空间，
//       各用户配置互不干扰、互不可见。
// 策略：保留真实 ttsConfig 存储层（fake-indexeddb），仅 mock 会在 Node 下触碰浏览器 API 的 useTTS，
//       使用真实 auth store 并通过赋值 auth.user 模拟账户切换。
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTtsStore } from '../src/stores/tts';
import { useAuthStore } from '../src/stores/auth';
import { loadTtsConfig, DEFAULT_TTS_CONFIG } from '../src/services/ttsConfig';

// useTTS 在 Node 下会触碰 window.speechSynthesis / AudioContext，用轻量 stub 替代。
// 用普通对象（含 .value）即可，store 仅读取 providerName.value 与调用方法，从不写回。
const ttsApi = vi.hoisted(() => ({
  state: { value: 'idle' as const },
  providerName: { value: 'edge' as const },
  rate: { value: 1 },
  setProvider: vi.fn(),
  setRate: vi.fn(),
  speak: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../src/composables/useTTS', () => ({
  useTTS: () => ({
    state: ttsApi.state,
    rate: ttsApi.rate,
    providerName: ttsApi.providerName,
    setProvider: ttsApi.setProvider,
    setRate: ttsApi.setRate,
    speak: ttsApi.speak,
    pause: ttsApi.pause,
    resume: ttsApi.resume,
    stop: ttsApi.stop,
  }),
}));

// 等所有异步落定：watch 回调（microtask）与 fake-indexeddb 的 onsuccess（macrotask）都需要排空。
// 单次 setTimeout(0) 不足以等 IDB 完成，这里多轮等待以覆盖嵌套的 macrotask。
const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
};

function setUser(id: string | null) {
  const auth = useAuthStore();
  auth.user = id
    ? ({ id, username: id, role: 'user', enabled: true, createdAt: '', updatedAt: '', lastLoginAt: '', permissions: [] } as never)
    : null;
}

describe('useTtsStore 按用户隔离（store 层集成）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setUser(null);
    ttsApi.setProvider.mockClear();
    ttsApi.setRate.mockClear();
    ttsApi.speak.mockClear();
  });

  it('切换账户时 store 自动按对应用户读写，各用户互不干扰', async () => {
    const store = useTtsStore();

    // 1) 登录 alpha：watch 触发 loadForUser('alpha')
    setUser('alpha');
    await flush();
    expect(ttsApi.setProvider).toHaveBeenCalledWith('edge');

    // 2) 为 alpha 设置专属音色 + 风格
    store.setVoice('zh-CN-YunxiNeural');
    store.setStyle('cheerful'); // 应用 cheerful prosody 预设（rate1.08/vol3/pitch3）并持久化
    await flush();

    const aCfg = await loadTtsConfig('alpha');
    expect(aCfg).toMatchObject({
      provider: 'edge',
      voice: 'zh-CN-YunxiNeural',
      style: 'cheerful',
      rate: 1.08,
      volume: 3,
      pitch: 3,
    });

    // 3) 切换到 beta：应重置为默认（beta 无记录），且 beta 的后续设置不影响 alpha
    setUser('beta');
    await flush();
    expect(store.currentVoice).toBe(DEFAULT_TTS_CONFIG.voice);
    expect(store.currentStyle).toBe(DEFAULT_TTS_CONFIG.style);

    store.setVoice('zh-CN-XiaoyiNeural');
    store.setStyle('serious');
    await flush();

    const bCfg = await loadTtsConfig('beta');
    expect(bCfg.voice).toBe('zh-CN-XiaoyiNeural');
    expect(bCfg.style).toBe('serious');

    // 关键断言：beta 的写入不能动 alpha 的命名空间
    const aAgain = await loadTtsConfig('alpha');
    expect(aAgain.voice).toBe('zh-CN-YunxiNeural');
    expect(aAgain.style).toBe('cheerful');

    // 4) 切回 alpha：store 应从存储重新加载 alpha 的专属配置，而非 beta 的
    setUser('alpha');
    await flush();
    expect(store.currentVoice).toBe('zh-CN-YunxiNeural');
    expect(store.currentStyle).toBe('cheerful');
    expect(store.rate).toBeCloseTo(1.08);
  });

  it('登出（user=null）回落到 guest 命名空间，与登录用户隔离', async () => {
    const store = useTtsStore();
    setUser('gamma');
    await flush();
    store.setVoice('zh-CN-YunyangNeural');
    await flush();
    expect((await loadTtsConfig('gamma')).voice).toBe('zh-CN-YunyangNeural');

    // 登出 → guest
    setUser(null);
    await flush();
    expect(store.currentVoice).toBe(DEFAULT_TTS_CONFIG.voice);

    // guest 设置不影响 gamma 的命名空间
    store.setVoice('zh-CN-XiaochenNeural');
    await flush();
    expect((await loadTtsConfig('guest')).voice).toBe('zh-CN-XiaochenNeural');
    expect((await loadTtsConfig('gamma')).voice).toBe('zh-CN-YunyangNeural');
  });
});
