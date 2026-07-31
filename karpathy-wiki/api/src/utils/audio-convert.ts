// FR-13-3：音频转写为 Markdown（LLM 语音模型方案）
// 设计哲学与 ocr-convert.ts 一致：零原生依赖、错误返回字符串而非抛异常
//
// 为什么用 LLM 语音模型而非本地 whisper.cpp：
// 1. 复用现有 fetch 基础设施，零新增依赖
// 2. 与 ocr-convert.ts 的"零原生依赖"原则一致
// 3. OpenAI-compatible /v1/audio/transcriptions 端点被广泛支持
// 4. 本地 whisper.cpp 方案需下载模型文件（75MB-2.9GB）和管理 C++ 编译环境
//
// 视频转写：当前仅支持音频文件，视频需要 ffmpeg 提取音频轨（系统未安装）
// 视频支持留待后续迭代（FR-13-3 第二阶段）

import type { AppConfig } from '../types.js';

// 音频转写配置：从 config.json 的 audio 字段读取，未配置时回退到 llm 字段
// 为什么独立配置：主 LLM（如 deepseek-chat）可能不支持音频输入，
// 用户需配置支持语音转文字的模型端点（如 OpenAI Whisper API）
export interface AudioTranscribeConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

// 从 AppConfig 提取音频转写配置：优先用 audio 字段，回退到 llm 字段
// 为什么回退：用户未单独配置 audio 时，若主 LLM provider 恰好支持语音转写，可直接复用
export function resolveAudioConfig(config: AppConfig): AudioTranscribeConfig | null {
  // 优先读取独立 audio 配置
  if (config.audio?.apiKey) {
    return {
      provider: config.audio.provider,
      baseUrl: config.audio.baseUrl,
      model: config.audio.model,
      apiKey: config.audio.apiKey,
    };
  }
  // 回退 1：audio 配置存在但 apiKey 为空，尝试从环境变量读取
  if (config.audio?.apiKeyRef) {
    const envKey = process.env[config.audio.apiKeyRef] ?? '';
    if (envKey) {
      return {
        provider: config.audio.provider,
        baseUrl: config.audio.baseUrl,
        model: config.audio.model,
        apiKey: envKey,
      };
    }
  }
  // 回退 2：audio 配置不存在，尝试复用主 llm 配置
  // 风险：主 LLM 可能不支持音频，调用会返回 4xx 错误，由调用方捕获并降级
  if (config.llm.apiKey) {
    return {
      provider: config.llm.provider,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      apiKey: config.llm.apiKey,
    };
  }
  // 回退 3：主 llm apiKey 为空，尝试环境变量
  const llmEnvKey = process.env[config.llm.apiKeyRef] ?? '';
  if (llmEnvKey) {
    return {
      provider: config.llm.provider,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      apiKey: llmEnvKey,
    };
  }
  return null;
}

// 支持的音频 MIME 类型白名单
// 为什么不含 video/*：视频转写需 ffmpeg 提取音频轨，当前环境不支持
export const AUDIO_SUPPORTED_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'audio/webm',
  wma: 'audio/x-ms-wma',
  opus: 'audio/opus',
};

/**
 * 将音频 buffer 通过 LLM 语音模型转写为文本
 *
 * OpenAI-compatible 端点：POST {baseUrl}/v1/audio/transcriptions
 * 请求格式：multipart/form-data（含 file + model 字段）
 *
 * @param buffer 音频二进制数据
 * @param mimeType 音频 MIME 类型（如 audio/mpeg）
 * @param filename 原始文件名（用于 Content-Disposition header）
 * @param config 音频转写配置
 * @returns 转写文本；失败返回 [Error: ...] 字符串
 */
export async function audioToText(
  buffer: Buffer,
  mimeType: string,
  filename: string,
  config: AudioTranscribeConfig,
): Promise<string> {
  // 构造 multipart/form-data：OpenAI Whisper API 兼容格式
  // 为什么用 Uint8Array 而非直接传 Buffer：Node.js 22+ 类型定义中 Buffer 的 buffer 属性
  // 为 SharedArrayBuffer，Blob 构造函数要求 ArrayBuffer 或 TypedArray
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  formData.append('file', blob, filename);
  formData.append('model', config.model);
  // 默认语言：auto（自动检测），用户可通过 config 覆盖
  // response_format 默认 json（返回 { text: "..." }）

  try {
    const response = await fetch(`${config.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: formData,
      // 120s 超时：音频转写比 OCR 慢（文件更大 + 推理时间长）
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      // 常见错误：API key 无效（401）、额度不足（402/429）、文件格式不支持（400）
      return `[Error: Transcription API returned ${response.status} — ${errText.slice(0, 200)}]`;
    }

    const data = (await response.json()) as { text?: string };
    const text = data.text?.trim();
    if (!text || text.length === 0) {
      return '[Error: Transcription API returned empty text]';
    }

    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Error: Transcription request failed — ${msg}]`;
  }
}

// 估算音频时长（秒）：基于文件大小和 MIME 类型粗略估算
// 为什么估算：在 API 调用前判断文件是否过大，给出友好提示
// 为什么不用 ffprobe：避免原生依赖
export function estimateAudioDuration(buffer: Buffer, mimeType: string): number {
  // 常见音频比特率估算（kbps）：mp3 128kbps, wav 1411kbps, ogg 192kbps, flac 900kbps
  const bitrates: Record<string, number> = {
    'audio/mpeg': 128,
    'audio/wav': 1411,
    'audio/ogg': 192,
    'audio/flac': 900,
    'audio/mp4': 128,
    'audio/aac': 128,
    'audio/webm': 192,
    'audio/opus': 96,
    'audio/x-ms-wma': 128,
  };
  const kbps = bitrates[mimeType] ?? 128;
  // 时长 = 文件大小（字节）* 8 / 比特率（bps）
  return Math.ceil((buffer.length * 8) / (kbps * 1000));
}
