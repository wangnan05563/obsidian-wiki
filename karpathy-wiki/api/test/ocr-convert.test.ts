import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppConfig } from '../src/types.js';
import {
  resolveOcrConfig,
  ocrImageToMarkdown,
  OCR_SUPPORTED_MIME,
  type OcrConfig,
} from '../src/utils/ocr-convert.js';

// FR-13-2 单元测试：OCR 配置解析 + 图片 OCR 调用
// 为什么 mock fetch：实际调用 LLM 视觉模型消耗 token 且依赖网络，
// 单元测试只验证请求构造与响应解析逻辑

// ===========================================================================
// resolveOcrConfig：OCR 配置解析优先级测试
// ===========================================================================
describe('resolveOcrConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 每个用例前清理环境变量，避免相互干扰
    delete process.env.MOCK_OCR_KEY;
    delete process.env.DEEPSEEK_API_KEY;
  });

  afterEach(() => {
    // 恢复原始环境
    process.env = { ...originalEnv };
  });

  it('优先使用独立 ocr 配置的 apiKey', () => {
    const config = {
      llm: {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKeyRef: 'DEEPSEEK_API_KEY',
        apiKey: 'llm-key',
      },
      ocr: {
        provider: 'agnes',
        baseUrl: 'https://api.agnes.com',
        model: 'agnes-2.1-flash',
        apiKey: 'ocr-key',
      },
    } as unknown as AppConfig;
    const result = resolveOcrConfig(config);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('agnes');
    expect(result!.apiKey).toBe('ocr-key');
    expect(result!.model).toBe('agnes-2.1-flash');
  });

  it('ocr 配置 apiKey 为空时回退到 apiKeyRef 环境变量', () => {
    process.env.MOCK_OCR_KEY = 'env-ocr-key';
    const config = {
      llm: {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKeyRef: 'DEEPSEEK_API_KEY',
        apiKey: 'llm-key',
      },
      ocr: {
        provider: 'agnes',
        baseUrl: 'https://api.agnes.com',
        model: 'agnes-2.1-flash',
        apiKeyRef: 'MOCK_OCR_KEY',
        // apiKey 未设置
      },
    } as unknown as AppConfig;
    const result = resolveOcrConfig(config);
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('env-ocr-key');
  });

  it('未配置 ocr 时回退到主 llm 配置', () => {
    // 为什么需要回退：用户未单独配置 ocr 时，若主 LLM 支持视觉可直接复用
    const config = {
      llm: {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKeyRef: 'DEEPSEEK_API_KEY',
        apiKey: 'llm-key',
      },
      // ocr 未配置
    } as unknown as AppConfig;
    const result = resolveOcrConfig(config);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('deepseek');
    expect(result!.apiKey).toBe('llm-key');
  });

  it('ocr 和 llm.apiKey 都为空时回退到 llm.apiKeyRef 环境变量', () => {
    process.env.DEEPSEEK_API_KEY = 'env-llm-key';
    const config = {
      llm: {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKeyRef: 'DEEPSEEK_API_KEY',
        // apiKey 未设置
      },
    } as unknown as AppConfig;
    const result = resolveOcrConfig(config);
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('env-llm-key');
  });

  it('所有配置都缺失时返回 null', () => {
    // 为什么返回 null：让调用方决定降级策略（如返回提示字符串）
    const config = {
      llm: {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKeyRef: 'DEEPSEEK_API_KEY',
        // apiKey 未设置
      },
    } as unknown as AppConfig;
    const result = resolveOcrConfig(config);
    expect(result).toBeNull();
  });
});

// ===========================================================================
// OCR_SUPPORTED_MIME：图片 MIME 白名单测试
// ===========================================================================
describe('OCR_SUPPORTED_MIME', () => {
  it('包含常见图片格式', () => {
    expect(OCR_SUPPORTED_MIME['jpg']).toBe('image/jpeg');
    expect(OCR_SUPPORTED_MIME['jpeg']).toBe('image/jpeg');
    expect(OCR_SUPPORTED_MIME['png']).toBe('image/png');
    expect(OCR_SUPPORTED_MIME['gif']).toBe('image/gif');
    expect(OCR_SUPPORTED_MIME['webp']).toBe('image/webp');
    expect(OCR_SUPPORTED_MIME['bmp']).toBe('image/bmp');
  });

  it('不包含非图片格式', () => {
    expect(OCR_SUPPORTED_MIME['pdf']).toBeUndefined();
    expect(OCR_SUPPORTED_MIME['docx']).toBeUndefined();
    expect(OCR_SUPPORTED_MIME['mp4']).toBeUndefined();
  });
});

// ===========================================================================
// ocrImageToMarkdown：图片 OCR 调用测试（mock fetch）
// ===========================================================================
describe('ocrImageToMarkdown', () => {
  const mockConfig: OcrConfig = {
    provider: 'agnes',
    baseUrl: 'https://api.agnes.com',
    model: 'agnes-2.1-flash',
    apiKey: 'test-key',
  };

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    // 恢复原始 fetch，避免影响其他测试
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('成功提取文字时返回 Markdown 文本', async () => {
    // 为什么 mock 200 响应：验证正常路径的请求构造与响应解析
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: '# Extracted Title\n\nSome OCR text content.',
            },
          },
        ],
      }),
      text: async () => '',
    };
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const buf = Buffer.from('fake-image-data');
    const result = await ocrImageToMarkdown(buf, 'image/png', mockConfig);

    expect(result).toBe('# Extracted Title\n\nSome OCR text content.');
    // 验证请求 URL 和 method
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.agnes.com/chat/completions');
    expect(options.method).toBe('POST');
    // 验证 Authorization header
    expect(options.headers.Authorization).toBe('Bearer test-key');
    // 验证请求体包含 model 和多模态 content
    const body = JSON.parse(options.body);
    expect(body.model).toBe('agnes-2.1-flash');
    expect(body.messages[0].content).toBeInstanceOf(Array);
    expect(body.messages[0].content[0].type).toBe('text');
    expect(body.messages[0].content[1].type).toBe('image_url');
    // 验证 image_url 是 data URL 格式
    expect(body.messages[0].content[1].image_url.url).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it('API 返回非 200 时返回 [Error] 字符串', async () => {
    // 为什么不抛异常：与 pdf-convert.ts 风格一致，错误返回字符串让调用方决策
    const mockResponse = {
      ok: false,
      status: 400,
      text: async () => 'Model does not support vision input',
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse) as unknown as typeof globalThis.fetch;

    const buf = Buffer.from('fake-image-data');
    const result = await ocrImageToMarkdown(buf, 'image/png', mockConfig);

    expect(result.startsWith('[Error')).toBe(true);
    expect(result).toContain('400');
  });

  it('API 返回空 content 时返回 [Error] 字符串', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '' } }],
      }),
      text: async () => '',
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse) as unknown as typeof globalThis.fetch;

    const buf = Buffer.from('fake-image-data');
    const result = await ocrImageToMarkdown(buf, 'image/png', mockConfig);

    expect(result.startsWith('[Error')).toBe(true);
    expect(result).toContain('empty content');
  });

  it('网络错误时返回 [Error] 字符串而非抛异常', async () => {
    // 为什么捕获异常：网络超时/DNS 失败不应阻断 compile 工作流
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network timeout')) as unknown as typeof globalThis.fetch;

    const buf = Buffer.from('fake-image-data');
    const result = await ocrImageToMarkdown(buf, 'image/png', mockConfig);

    expect(result.startsWith('[Error')).toBe(true);
    expect(result).toContain('Network timeout');
  });
});
