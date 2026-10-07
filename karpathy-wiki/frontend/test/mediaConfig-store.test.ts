// 媒体生成 BYOK 配置存储层（src/services/mediaConfig.ts）单元测试。
// userConfig 依赖以 vi.mock 替换为 spy（本文件只验证 mediaConfig 自身的委托与合并语义，
// IndexedDB 行为已由 userConfig-isolation 等既有测试覆盖）；
// fetchMediaPresets 用注入的 authFetch / stubGlobal fetch 完全离线确定性执行。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_MEDIA_USER_CONFIG,
  loadMediaUserConfig,
  saveMediaUserConfig,
  fetchMediaPresets,
  mergeImagePreset,
  mergeVideoPreset,
} from '../src/services/mediaConfig';
import { loadUserConfig, saveUserConfig } from '../src/services/userConfig';
import { API_BASE } from '../src/utils/apiBase';
import type { MediaImageUserConfig, MediaVideoUserConfig } from '../src/types/media';

vi.mock('../src/services/userConfig', () => ({
  loadUserConfig: vi.fn(),
  saveUserConfig: vi.fn(),
}));

// ===== load / save 委托 =====

describe('loadMediaUserConfig / saveMediaUserConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('读取走 per-user "media" 命名空间，且默认值为导出常量整包（image+video 两组）', async () => {
    const stored = { image: { ...DEFAULT_MEDIA_USER_CONFIG.image, apiKey: 'k' }, video: DEFAULT_MEDIA_USER_CONFIG.video };
    (loadUserConfig as ReturnType<typeof vi.fn>).mockResolvedValue(stored);
    await expect(loadMediaUserConfig('u1')).resolves.toBe(stored);
    expect(loadUserConfig).toHaveBeenCalledWith('u1', 'media', DEFAULT_MEDIA_USER_CONFIG);
  });

  it('保存覆盖式委托 saveUserConfig（同 kind、同 userId、原样配置对象）', async () => {
    (saveUserConfig as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const cfg = { image: DEFAULT_MEDIA_USER_CONFIG.image, video: DEFAULT_MEDIA_USER_CONFIG.video };
    await saveMediaUserConfig('u2', cfg);
    expect(saveUserConfig).toHaveBeenCalledWith('u2', 'media', cfg);
  });

  it('默认配置常量的实际字段值（配置页首屏占位依据）', () => {
    expect(DEFAULT_MEDIA_USER_CONFIG.image).toEqual({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      apiKey: '',
      model: 'agnes-image-2.5-flash',
      size: '1024x768',
      ratio: '16:9',
    });
    expect(DEFAULT_MEDIA_USER_CONFIG.video).toEqual({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      apiKey: '',
      videoModel: 'agnes-video-2.5-flash',
      size: '1280x720',
      seconds: 5,
    });
  });
});

// ===== fetchMediaPresets =====

describe('fetchMediaPresets', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }

  it('正常返回：两组预设数组原样透传，且请求为 GET {API_BASE}/media/presets', async () => {
    const img = [{ key: 'i1', label: 'L', model: 'm', size: '1024x1024' }];
    const vid = [{ key: 'v1', label: 'V', model: 'vm', size: '1280x720', seconds: 5 }];
    const authFetch = vi.fn().mockResolvedValue(okResponse({ imagePresets: img, videoPresets: vid }));
    const res = await fetchMediaPresets(authFetch as any);
    expect(res).toEqual({ imagePresets: img, videoPresets: vid });
    expect(authFetch).toHaveBeenCalledWith(`${API_BASE}/media/presets`, { method: 'GET' });
  });

  it('响应字段非数组（后端字段缺失/类型漂移）时逐项回退空数组', async () => {
    const authFetch = vi
      .fn()
      .mockResolvedValue(okResponse({ imagePresets: null, videoPresets: 'oops' }));
    const res = await fetchMediaPresets(authFetch as any);
    expect(res).toEqual({ imagePresets: [], videoPresets: [] });
  });

  it('HTTP 非 2xx（如 401 未登录）降级为空预设，不读 body', async () => {
    const jsonSpy = vi.fn();
    const authFetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: jsonSpy });
    const res = await fetchMediaPresets(authFetch as any);
    expect(res).toEqual({ imagePresets: [], videoPresets: [] });
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('请求 reject / body 解析炸都静默降级为空预设（UI 转纯手动配置）', async () => {
    const failFetch = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(fetchMediaPresets(failFetch as any)).resolves.toEqual({ imagePresets: [], videoPresets: [] });

    const badJson = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('x'); } });
    await expect(fetchMediaPresets(badJson as any)).resolves.toEqual({ imagePresets: [], videoPresets: [] });
  });

  it('默认参数回退全局 fetch（未注入 authFetch 的调用方）', async () => {
    const spy = vi.fn().mockResolvedValue(okResponse({ imagePresets: [], videoPresets: [] }));
    vi.stubGlobal('fetch', spy);
    await fetchMediaPresets();
    expect(spy).toHaveBeenCalledWith(`${API_BASE}/media/presets`, { method: 'GET' });
  });
});

// ===== mergeImagePreset =====

const baseImage: MediaImageUserConfig = {
  baseUrl: 'https://mine.example/v1',
  apiKey: 'sk-user',
  model: 'old-model',
  size: '512x512',
  ratio: '4:3',
  steps: 9,
  sampler: 'euler_a',
};

describe('mergeImagePreset：预设只覆盖生成参数，保留用户密钥与 baseUrl', () => {
  it('最小预设：model/size 覆盖，ratio/steps 等未提供字段保留现值，baseUrl/apiKey 不动', () => {
    const r = mergeImagePreset(baseImage, { key: 'p', label: 'P', model: 'new-m', size: '1024x1024' });
    expect(r).toEqual({
      baseUrl: 'https://mine.example/v1', // 用户自有配置不被预设冲掉
      apiKey: 'sk-user',
      model: 'new-m',
      size: '1024x1024',
      ratio: '4:3', // 预设无 ratio → 保留
      steps: 9, // 预设 steps undefined → 保留（!== undefined 守卫）
      sampler: 'euler_a', // 预设 sampler 缺失 → 保留
    });
    // 预设模板的展示字段不泄漏进用户配置
    expect((r as Record<string, unknown>).key).toBeUndefined();
    expect((r as Record<string, unknown>).label).toBeUndefined();
  });

  it('全量预设：可选字段齐备时逐项写入', () => {
    const r = mergeImagePreset(baseImage, {
      key: 'p', label: 'P', model: 'm2', size: '768x768', ratio: '1:1',
      steps: 20, cfgScale: 7.5, sampler: 'dpm++', seed: 42, negativePrompt: 'blurry',
    });
    expect(r).toEqual({
      baseUrl: 'https://mine.example/v1', apiKey: 'sk-user',
      model: 'm2', size: '768x768', ratio: '1:1', steps: 20, cfgScale: 7.5,
      sampler: 'dpm++', seed: 42, negativePrompt: 'blurry',
    });
  });

  it('数值 0 不被当成缺失：steps=0 / seed=0 仍然写入（=== undefined 守卫而非 falsy）', () => {
    const r = mergeImagePreset(baseImage, { key: 'p', label: 'P', model: 'm', size: 's', steps: 0, seed: 0 });
    expect(r.steps).toBe(0);
    expect(r.seed).toBe(0);
  });

  it('字符串字段按 truthy 判定：preset.ratio/sampler/negativePrompt 为空串时不覆盖现值', () => {
    const r = mergeImagePreset(baseImage, {
      key: 'p', label: 'P', model: 'm', size: 's', ratio: '', sampler: '', negativePrompt: '',
    });
    expect(r.ratio).toBe('4:3');
    expect(r.sampler).toBe('euler_a');
    expect(r.negativePrompt).toBeUndefined();
  });
});

// ===== mergeVideoPreset =====

const baseVideo: MediaVideoUserConfig = {
  baseUrl: 'https://mine.example/v1',
  apiKey: 'sk-video',
  videoModel: 'old-video',
  size: '640x480',
  seconds: 8,
  fps: 24,
  seed: 7,
};

describe('mergeVideoPreset', () => {
  it('model→videoModel 映射、seconds 必覆盖（预设 5 顶掉现值 8）、未提供字段保留', () => {
    const r = mergeVideoPreset(baseVideo, { key: 'v', label: 'V', model: 'vm2', size: '1280x720', seconds: 5 });
    expect(r).toEqual({
      baseUrl: 'https://mine.example/v1',
      apiKey: 'sk-video',
      videoModel: 'vm2',
      size: '1280x720',
      seconds: 5,
      fps: 24, // 预设 fps undefined → 保留
      seed: 7, // 预设 seed undefined → 保留
    });
    expect((r as Record<string, unknown>).key).toBeUndefined();
    expect((r as Record<string, unknown>).model).toBeUndefined(); // 只以 videoModel 落地
  });

  it('fps=0 / motion=0 / seed=0 等数值 0 均写入；negativePrompt 空串不写入', () => {
    const r = mergeVideoPreset(baseVideo, {
      key: 'v', label: 'V', model: 'vm', size: 'x', seconds: 3, fps: 0, motion: 0, seed: 0, negativePrompt: '',
    });
    expect(r.seconds).toBe(3);
    expect(r.fps).toBe(0);
    expect(r.motion).toBe(0);
    expect(r.seed).toBe(0);
    expect(r.negativePrompt).toBeUndefined();
  });

  it('全量预设覆盖所有可选位', () => {
    const r = mergeVideoPreset(baseVideo, {
      key: 'v', label: 'V', model: 'vm', size: '1920x1080', seconds: 10, fps: 30, motion: 5, seed: 1, negativePrompt: 'nsfw',
    });
    expect(r).toEqual({
      baseUrl: 'https://mine.example/v1', apiKey: 'sk-video', videoModel: 'vm',
      size: '1920x1080', seconds: 10, fps: 30, motion: 5, seed: 1, negativePrompt: 'nsfw',
    });
  });

  it('合并结果为新对象：不原地修改当前配置（响应式安全）', () => {
    const snapshot = { ...baseVideo };
    mergeVideoPreset(baseVideo, { key: 'v', label: 'V', model: 'changed', size: 's', seconds: 1 });
    expect(baseVideo).toEqual(snapshot);
  });
});
