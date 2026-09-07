// 媒体生成（生图/视频）用户 BYOK 配置存储层：复用 userConfig 的 per-user IndexedDB 命名空间。
//
// 设计动机（与 userConfig.ts 的 AI/搜索/工具配置一致）：
//   - 每用户独立持有自己的生图/视频 API Key 与参数（模型/分辨率/比例/秒数等），
//     密钥仅存自己浏览器的 IndexedDB，不落服务端磁盘，规避"全员共用同一额度"或互相限流。
//   - 软件升级/重装不影响用户本地媒体配置（存客户端）。
//
// 使用方式：
//   - 配置页 / 生成弹窗读取 loadMediaUserConfig(userId) 得到 { image, video } 两组配置；
//   - 发起生成时把对应组（imageConfig / mediaConfig.video）随请求体透传给后端，
//     后端 generateImage / generateVideo 优先生效该用户配置，缺失字段才回退服务端 media.agnes。
//   - 预设（GET /api/media/presets）为只读模板，一键应用 = 把预设的生成参数合并进本组配置，
//     用户在表单手动微调后再保存（saveMediaUserConfig），实现"预设 + 微调 + 自定义"。

import { loadUserConfig, saveUserConfig } from './userConfig';
import { API_BASE } from '../utils/apiBase';
import type {
  MediaImageUserConfig,
  MediaVideoUserConfig,
  MediaImagePreset,
  MediaVideoPreset,
  MediaPresetsFile,
} from '../types/media';

// 用户媒体配置整包：生图 + 视频两组（BYOK，均存本地）
export interface MediaUserConfig {
  image: MediaImageUserConfig;
  video: MediaVideoUserConfig;
}

// 首次进入配置页/未配置时的占位：baseUrl 用 Agnes 常见默认，key/model/size 留空待填。
export const DEFAULT_MEDIA_USER_CONFIG: MediaUserConfig = {
  image: {
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKey: '',
    model: 'agnes-image-2.1-flash',
    size: '1024x768',
    ratio: '16:9',
  },
  video: {
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKey: '',
    videoModel: 'agnes-video-v2.0',
    size: '1280x720',
    seconds: 5,
  },
};

// 读取当前登录用户的媒体配置（未配置回退默认值）。
export async function loadMediaUserConfig(userId: string): Promise<MediaUserConfig> {
  return loadUserConfig<MediaUserConfig>(userId, 'media', DEFAULT_MEDIA_USER_CONFIG);
}

// 保存当前登录用户的媒体配置（覆盖式）。
export async function saveMediaUserConfig(userId: string, cfg: MediaUserConfig): Promise<void> {
  await saveUserConfig(userId, 'media', cfg);
}

// 拉取后端媒体预设（生图 imagePresets / 视频 videoPresets）。失败返回空预设（UI 降级为纯手动配置）。
// 为什么入参 authFetch：/api/media/presets 已挂 requireAuth，需用带凭证的请求（authStore.authFetch）；
//   未传时回退 window.fetch（后端若要求登录会 401，由调用方负责传 authFill 版本）。
export async function fetchMediaPresets(
  authFetch: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
): Promise<MediaPresetsFile> {
  try {
    const resp = await authFetch(`${API_BASE}/media/presets`, { method: 'GET' });
    if (!resp.ok) return { imagePresets: [], videoPresets: [] };
    const data = (await resp.json()) as MediaPresetsFile;
    return {
      imagePresets: Array.isArray(data.imagePresets) ? data.imagePresets : [],
      videoPresets: Array.isArray(data.videoPresets) ? data.videoPresets : [],
    };
  } catch {
    return { imagePresets: [], videoPresets: [] };
  }
}

// 把生图预设模板的"生成参数"合并进某组用户配置，得到可直接应用/保存的新对象。
// 为什么只覆盖 model/size/比例/扩展参数、保留 baseUrl/apiKey：预设是场景模板，不含用户密钥
//   （与 LLM 预设一致），避免应用预设时把用户已填的 baseUrl/key 冲掉。
export function mergeImagePreset(
  current: MediaImageUserConfig,
  p: MediaImagePreset,
): MediaImageUserConfig {
  return {
    ...current,
    model: p.model,
    size: p.size,
    ...(p.ratio ? { ratio: p.ratio } : {}),
    ...(p.steps !== undefined ? { steps: p.steps } : {}),
    ...(p.cfgScale !== undefined ? { cfgScale: p.cfgScale } : {}),
    ...(p.sampler ? { sampler: p.sampler } : {}),
    ...(p.seed !== undefined ? { seed: p.seed } : {}),
    ...(p.negativePrompt ? { negativePrompt: p.negativePrompt } : {}),
  };
}

// 把视频预设模板的"生成参数"合并进视频组配置。
export function mergeVideoPreset(
  current: MediaVideoUserConfig,
  p: MediaVideoPreset,
): MediaVideoUserConfig {
  return {
    ...current,
    videoModel: p.model,
    size: p.size,
    seconds: p.seconds,
    ...(p.fps !== undefined ? { fps: p.fps } : {}),
    ...(p.motion !== undefined ? { motion: p.motion } : {}),
    ...(p.seed !== undefined ? { seed: p.seed } : {}),
    ...(p.negativePrompt ? { negativePrompt: p.negativePrompt } : {}),
  };
}