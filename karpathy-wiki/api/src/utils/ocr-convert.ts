// FR-13-2：图片 OCR 提取为 Markdown（LLM 视觉模型方案）
// 设计哲学与 pdf-convert.ts / office-convert.ts 一致：零原生依赖、错误返回字符串而非抛异常
//
// 为什么用 LLM 视觉模型而非 PaddleOCR/云 OCR：
// 1. 复用现有 LLM 配置（OpenAI-compatible 接口），零新增依赖
// 2. 与 office-convert.ts 的"零原生依赖"原则一致
// 3. AC-13-4 修订后允许"PaddleOCR 或云 OCR"，LLM 视觉模型属于云 OCR 的一种形态
// 4. 现代多模态 LLM（GPT-4o / Claude 3.5 / 豆包视觉）OCR 准确率已接近专业 OCR 服务
//
// 为什么不通过 harness 调用：wiki-harness 的 Message.content 是 string 类型，
// 不支持 OpenAI 多模态 content 数组（[{type:'text'}, {type:'image_url'}]）。
// 直接用 fetch 调用 /chat/completions 是最简路径，避免改造 harness 类型定义。

import type { AppConfig } from '../types.js';

// OCR 专用配置：从 config.json 的 ocr 字段读取，未配置时回退到 llm 字段
// 为什么独立配置：主 LLM（如 deepseek-chat）可能不支持视觉输入，
// 用户需配置支持视觉的模型（如 agnes-2.1-flash、doubao-vision）做 OCR
export interface OcrConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

// 从 AppConfig 提取 OCR 配置：优先用 ocr 字段，回退到 llm 字段
// 为什么回退：用户未单独配置 ocr 时，若主 LLM 恰好支持视觉（如 GPT-4o），可直接复用
export function resolveOcrConfig(config: AppConfig): OcrConfig | null {
  // 优先读取独立 ocr 配置
  if (config.ocr?.apiKey) {
    return {
      provider: config.ocr.provider,
      baseUrl: config.ocr.baseUrl,
      model: config.ocr.model,
      apiKey: config.ocr.apiKey,
    };
  }
  // 回退 1：ocr 配置存在但 apiKey 为空，尝试从环境变量读取
  if (config.ocr?.apiKeyRef) {
    const envKey = process.env[config.ocr.apiKeyRef] ?? '';
    if (envKey) {
      return {
        provider: config.ocr.provider,
        baseUrl: config.ocr.baseUrl,
        model: config.ocr.model,
        apiKey: envKey,
      };
    }
  }
  // 回退 2：ocr 配置不存在，尝试复用主 llm 配置
  // 风险：主 LLM 可能不支持视觉，调用会返回 4xx 错误，由调用方捕获并降级
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

// 支持的图片 MIME 类型白名单（防注入 + 调用方校验）
export const OCR_SUPPORTED_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

// OCR 提示词：引导 LLM 提取图片中的文字并结构化为 Markdown
// 为什么不写在 prompts/ 目录：OCR 是工具函数级调用，非工作流级，
// 单轮 LLM 调用无需独立 prompt 文件管理
const OCR_PROMPT = `You are an OCR engine. Extract all text from the provided image and return it as clean Markdown.

Rules:
1. Preserve the visual structure: headings, lists, tables, paragraphs.
2. Convert tables to Markdown table syntax.
3. Ignore non-text elements (logos, decorations) unless they contain text.
4. If the image contains no readable text, return exactly: [Warning: No text detected in image]
5. Output ONLY the extracted Markdown, no explanations or wrapping.`;

/**
 * 将图片 buffer 通过 LLM 视觉模型 OCR 提取为 Markdown 文本
 *
 * @param buffer 图片二进制数据
 * @param mimeType 图片 MIME 类型（如 image/png）
 * @param config OCR 配置（含 baseUrl/model/apiKey）
 * @returns Markdown 文本；失败返回 [Error: ...] 字符串
 */
export async function ocrImageToMarkdown(
  buffer: Buffer,
  mimeType: string,
  config: OcrConfig,
): Promise<string> {
  // base64 编码图片：OpenAI-compatible 视觉接口要求 data URL 格式
  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const body = {
    model: config.model,
    // 多模态 content 数组：文本指令 + 图片
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: OCR_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    // OCR 是单轮任务，无需流式
    stream: false,
  };

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      // 90s 超时：图片 OCR 比纯文本慢，但不应超过 90s
      signal: AbortSignal.timeout(90000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      // 常见错误：模型不支持视觉（400）、API key 无效（401）、额度不足（402/429）
      return `[Error: OCR API returned ${response.status} — ${errText.slice(0, 200)}]`;
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content || content.trim().length === 0) {
      return '[Error: OCR API returned empty content]';
    }

    return content.trim();
  } catch (err) {
    // 常见错误：网络超时、DNS 解析失败、模型不支持视觉
    const msg = err instanceof Error ? err.message : String(err);
    return `[Error: OCR request failed — ${msg}]`;
  }
}
