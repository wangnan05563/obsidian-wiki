import type { Message, ToolDefinition, LLMResponse, LLMChunk } from '../types.js';

// LLM 适配器抽象：解耦具体厂商 SDK，便于切换 GLM/Qwen/DeepSeek
export interface LLMAdapter {
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse>;
  chatStream(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<LLMChunk>;
  countTokens(messages: Message[]): number;
}
