// 朗读（TTS）配置的按用户维度隔离存储层。
//
// 设计动机（需求：配置数据需按用户维度隔离存储与读取）：
//   - 不同用户在同一浏览器上登录时，各自的朗读偏好（引擎/音色/风格/语速/音量/音调）
//     必须互不干扰、互不可见。
//   - 复用 chatDb 的 preferences 仓库（keyPath='key'），但键名内嵌 userId，
//     形成 per-user 命名空间：'tts-config::<userId>'。
//   - 应用层只读取"当前登录用户"的命名空间，天然实现隔离：用户 A 永远读不到
//     'tts-config::<用户B>' 的记录。
//   - 该仓库不加密（与 conversations 不同），属于非敏感 UI 偏好，登录前即可用。
//
// 注意：本层是纯客户端存储，不回传服务端（与项目"个人配置仅存本地"约定一致）。

import { dbGet, dbPut, CHAT_STORES } from './chatDb';
import type { TTSProviderType } from '../composables/tts';

export interface TtsUserConfig {
  provider: TTSProviderType;
  voice: string;
  style: string;
  rate: number;
  volume: number;
  pitch: number;
}

export const DEFAULT_TTS_CONFIG: TtsUserConfig = {
  provider: 'edge',
  voice: 'zh-CN-XiaoxiaoNeural',
  style: 'narration-relaxed',
  rate: 1,
  volume: 0,
  pitch: 0,
};

// per-user 键名：不同 userId 映射到不同的 preferences 记录，实现隔离
function ttsConfigKey(userId: string): string {
  return `tts-config::${userId}`;
}

// 读取指定用户的朗读配置；用户无记录或读取失败时回退默认值。
export async function loadTtsConfig(userId: string): Promise<TtsUserConfig> {
  if (!userId) return { ...DEFAULT_TTS_CONFIG };
  try {
    const rec = await dbGet<Record<string, unknown>>(CHAT_STORES.preferences, ttsConfigKey(userId));
    if (!rec) return { ...DEFAULT_TTS_CONFIG };
    return {
      provider: (rec.provider as TtsUserConfig['provider']) ?? DEFAULT_TTS_CONFIG.provider,
      voice: (rec.voice as string) || DEFAULT_TTS_CONFIG.voice,
      style: (rec.style as string) || DEFAULT_TTS_CONFIG.style,
      rate: typeof rec.rate === 'number' ? rec.rate : DEFAULT_TTS_CONFIG.rate,
      volume: typeof rec.volume === 'number' ? rec.volume : DEFAULT_TTS_CONFIG.volume,
      pitch: typeof rec.pitch === 'number' ? rec.pitch : DEFAULT_TTS_CONFIG.pitch,
    };
  } catch {
    // IndexedDB 不可用时静默降级为默认配置，不阻断朗读功能
    return { ...DEFAULT_TTS_CONFIG };
  }
}

// 写入指定用户的朗读配置（覆盖式：key 唯一，dbPut 即更新）。
export async function saveTtsConfig(userId: string, cfg: TtsUserConfig): Promise<void> {
  if (!userId) return;
  try {
    await dbPut(CHAT_STORES.preferences, { key: ttsConfigKey(userId), ...cfg });
  } catch {
    // 写入失败（如隐私模式禁用 IndexedDB）时静默降级，不影响朗读
  }
}
