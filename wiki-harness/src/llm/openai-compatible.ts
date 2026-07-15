import type { Message, ToolDefinition, LLMResponse, LLMChunk, LLMConfig, ToolCall } from '../types.js';
import type { LLMAdapter } from './llm-adapter.js';

// OpenAI 兼容 API 响应结构（仅取关心的字段，避免 any）
interface OpenAIChatResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta: {
      content?: string;
      tool_calls?: ToolCall[];
    };
  }>;
}

// 转换为 OpenAI tools 格式：剥离 handler，只保留 schema 描述
function toOpenAITools(tools: ToolDefinition[]) {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// OpenAI 兼容适配器：通过 baseUrl + apiKey + model 切换 GLM/Qwen/DeepSeek
// 国产模型普遍兼容 OpenAI API 协议，零依赖原生 fetch 实现
export class OpenAICompatibleAdapter implements LLMAdapter {
  constructor(private config: LLMConfig) {}

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
    };
    if (tools && tools.length > 0) {
      body.tools = toOpenAITools(tools);
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      // 60s 超时：防止网络挂起导致整个 agent loop 卡死无响应
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const message = data.choices[0]?.message;
    if (!message) {
      throw new Error('LLM API returned no choices');
    }

    return {
      content: message.content ?? '',
      tool_calls: message.tool_calls,
      usage: data.usage,
    };
  }

  async *chatStream(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<LLMChunk> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) {
      body.tools = toOpenAITools(tools);
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      // 60s 超时：防止网络挂起导致整个 agent loop 卡死无响应
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response body is not readable');

    const decoder = new TextDecoder();
    let buffer = '';

    // SSE 解析：按行分割，data: 前缀为有效载荷，[DONE] 结束
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      // 最后一段可能不完整，留待下次拼接
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data) as OpenAIStreamChunk;
          const delta = parsed.choices?.[0]?.delta;
          if (delta) {
            yield {
              delta: delta.content ?? '',
              tool_calls: delta.tool_calls,
            };
          }
        } catch {
          // 跳过无法解析的 SSE 行，保持流不中断
        }
      }
    }
  }

  countTokens(messages: Message[]): number {
    // 国产模型 tokenizer 不公开且不准，用字符数/3 粗略估算
    // 中英文混合场景下 3 字符约等于 1 token 是经验值
    let chars = 0;
    for (const msg of messages) {
      chars += msg.content.length;
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          chars += tc.function.arguments.length;
        }
      }
    }
    return Math.ceil(chars / 3);
  }
}
