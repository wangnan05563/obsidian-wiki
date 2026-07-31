// AI 自动打标签工作流（FR-10-1）
//
// 与 compile-workflow 的关键差异：
// 1. LLM 单轮调用（非 agent loop）—— tag 建议是 JSON 输入 → JSON 输出，无需工具调用循环
// 2. 直接 fetch OpenAI 兼容端点——不依赖 harness，避免引入不必要的 agent 复杂度
// 3. 代码控制写入——LLM 返回 ai_tags 数组，代码解析后写入 frontmatter.ai_tags 字段
//
// 数据流：
//   读取页面内容
//     → 调用 LLM (tag-suggest.md prompt)
//     → 解析 JSON 输出 (容错 ```json 包裹)
//     → 写入 frontmatter.ai_tags（保留已有 tags 不覆盖）
//     → 返回 tag 建议数组
//
// 设计决策（V3.1 FR-10-1 验收 AC-10-1）：
//   "compile 末尾追加 tags 建议（仅建议不覆盖）"
//   - 保留原 tags 字段不变，新增 ai_tags 字段作为"建议但未确认"
//   - 用户在 Browse.vue 审核后通过 PUT /api/tags/confirm 移动到 tags 字段

import fs from 'node:fs/promises';
import matter from 'gray-matter';
import type { VaultService, PendingTagPage } from '../vault/vault-service.js';
import type { AppConfig } from '../types.js';
import { getEffectiveApiKey } from '../config.js';
import { getPromptPath } from '../utils/runtime.js';

// prompt 模板路径：api/src/prompts/tag-suggest.md（开发模式）或 exe/prompts/tag-suggest.md（SEA 模式）
// 路径解析统一走 runtime.ts，与 CWD 解耦，兼容 SEA 打包模式
const PROMPT_PATH = getPromptPath('tag-suggest.md');

// prompt 模板缓存：避免每次调用都读盘
let cachedPrompt: string | null = null;

async function loadTagSuggestPrompt(): Promise<string> {
  if (cachedPrompt !== null) return cachedPrompt;
  cachedPrompt = await fs.readFile(PROMPT_PATH, 'utf8');
  return cachedPrompt;
}

// LLM 抽取输出结构（与 tag-suggest.md 输出 schema 对应）
interface LlmTagOutput {
  ai_tags: string[];
}

// 调用 LLM API 生成 tag 建议
// 为什么独立函数：隔离 fetch 逻辑便于单元测试 mock（与 qq-extract-workflow.callLlmForExtract 同模式）
async function callLlmForTagSuggest(
  prompt: string,
  pageContent: string,
  config: AppConfig,
): Promise<LlmTagOutput> {
  const baseUrl = config.llm.baseUrl.trim();
  const model = config.llm.model;
  const apiKey = getEffectiveApiKey(config);

  if (!apiKey && !baseUrl.includes('localhost')) {
    throw new Error('API Key 未设置，无法调用 tag 建议 LLM');
  }

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  // 60s 超时：与 qq-extract-workflow.callLlmForExtract 一致
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: pageContent },
        ],
        // 禁用流式：tag 建议需完整 JSON，流式反而增加解析复杂度
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`LLM API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) {
      throw new Error('LLM 返回空内容');
    }

    return parseLlmJsonOutput(content);
  } finally {
    clearTimeout(timeout);
  }
}

// 解析 LLM 返回的 JSON，容错处理 ```json 包裹与前后多余文本
// 与 qq-extract-workflow.parseLlmJsonOutput 同模式，统一容错策略
export function parseLlmJsonOutput(text: string): LlmTagOutput {
  let cleaned = text.trim();
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(cleaned);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  if (!cleaned.startsWith('{')) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      cleaned = cleaned.slice(first, last + 1);
    }
  }

  const parsed = JSON.parse(cleaned) as Partial<LlmTagOutput>;
  return {
    ai_tags: Array.isArray(parsed.ai_tags)
      ? parsed.ai_tags.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : [],
  };
}

// 为单页面生成 tag 建议，写入 frontmatter.ai_tags 字段
// 路径校验：调用方负责白名单校验（routes/tags.ts 用 VAULT_PAGE_PATTERN 校验）
// 返回值：生成的 tag 建议数组（即使为空也写入 frontmatter，标记"已生成过建议"）
export async function suggestTagsForPage(
  vault: VaultService,
  pagePath: string,
  config: AppConfig,
): Promise<string[]> {
  const raw = await vault.readFile(pagePath);
  const parsed = matter(raw);

  // 调用 LLM 生成 tag 建议
  const prompt = await loadTagSuggestPrompt();
  const result = await callLlmForTagSuggest(prompt, raw, config);

  // 写入 frontmatter.ai_tags（保留已有 tags 不覆盖，遵循"仅建议不覆盖"原则）
  parsed.data.ai_tags = result.ai_tags;
  // 同时更新 updated 字段，记录本次修改时间
  parsed.data.updated = new Date().toISOString().slice(0, 10);

  const updated = matter.stringify(parsed.content, parsed.data);
  await vault.writeFile(pagePath, updated);

  return result.ai_tags;
}

// 确认 tag：从 ai_tags 移到 tags（合并去重）
// 调用方负责 tagPath/tag 参数校验
export async function confirmTagForPage(
  vault: VaultService,
  pagePath: string,
  tag: string,
): Promise<{ tags: string[]; aiTags: string[] }> {
  const raw = await vault.readFile(pagePath);
  const parsed = matter(raw);

  const existingTags: string[] = Array.isArray(parsed.data.tags) ? (parsed.data.tags as string[]) : [];
  const existingAiTags: string[] = Array.isArray(parsed.data.ai_tags) ? (parsed.data.ai_tags as string[]) : [];

  // 已存在于 tags 则直接返回当前状态（幂等）
  if (existingTags.includes(tag)) {
    return { tags: existingTags, aiTags: existingAiTags };
  }

  // 移动：加入 tags，从 ai_tags 移除
  const newTags = [...existingTags, tag];
  const newAiTags = existingAiTags.filter((t) => t !== tag);

  parsed.data.tags = newTags;
  if (newAiTags.length > 0) {
    parsed.data.ai_tags = newAiTags;
  } else {
    // ai_tags 清空后移除字段，避免 frontmatter 留下空数组
    delete parsed.data.ai_tags;
  }
  parsed.data.updated = new Date().toISOString().slice(0, 10);

  const updated = matter.stringify(parsed.content, parsed.data);
  await vault.writeFile(pagePath, updated);

  return { tags: newTags, aiTags: newAiTags };
}

// 列出所有含 ai_tags 字段的页面（供前端 Browse.vue 展示待审核列表）
// § P3-2：委托给 VaultService.listPendingTagPages()，利用其 30s TTL 结果缓存
//   原实现（全量并行 readFile）已移入 VaultService，加缓存 + 分批并发
export { type PendingTagPage } from '../vault/vault-service.js';

export async function listPendingTagPages(vault: VaultService): Promise<PendingTagPage[]> {
  return vault.listPendingTagPages();
}
