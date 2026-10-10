import type { Message, ToolDefinition, LLMResponse, LLMChunk } from '../types.js';

// LLM 适配器抽象：解耦具体厂商 SDK，便于切换 GLM/Qwen/DeepSeek
// signal（FR-22）：用户主动停止时立即终止上游 HTTP 连接；可选参数保证既有实现零破坏
export interface LLMAdapter {
  chat(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): Promise<LLMResponse>;
  chatStream(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncIterable<LLMChunk>;
  countTokens(messages: Message[]): number;
}
