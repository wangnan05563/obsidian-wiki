import fs from 'node:fs/promises';
import type { HarnessConfig } from '@wiki/harness';
import { Harness } from '@wiki/harness';
import type { VaultService } from '../vault/vault-service.js';
import { searchPages } from '../search-util.js';
import type { MultimodalOutput } from '../types.js';
import { getPromptPath } from '../utils/runtime.js';

// 加载 multimodal output prompt 单点存储（与 query/compile 共用 prompts/ 目录）
// 为什么独立 prompt：三种输出模式有严格的格式约束，混入 query.md 会污染主问答 prompt
// 路径解析统一走 runtime.ts，兼容开发模式与 SEA 打包模式
async function loadMultimodalPrompt(): Promise<string> {
  return fs.readFile(getPromptPath('multimodal-output.md'), 'utf8');
}

// 多模态输出模式列表（as const 确保类型安全）
export const MULTIMODAL_MODES = ['mindmap', 'faq', 'timeline'] as const;
export type MultimodalMode = (typeof MULTIMODAL_MODES)[number];

// 模式 → 中文标签（用于 thinking 提示与日志）
const MODE_LABELS: Record<MultimodalMode, string> = {
  mindmap: '思维导图',
  faq: '问答对',
  timeline: '时间线',
};

// 收集相关页面内容作为 LLM 上下文
// 为什么 Top-5 而非全部：避免上下文过长导致 LLM 输出截断
// 为什么读完整内容而非摘要：LLM 需要 created 字段（timeline）与准确细节才能生成可靠引用
// 为什么优先用 contextPaths：主问答阶段 LLM 已通过 search_pages 工具搜到最相关页面，
// 复用这些页面路径避免二次搜索。直接用问题文本做关键词会被 searchPages 的空格分词 +
// includes 匹配命中失败（如 "什么是 LLM?" 被分成 ["什么是","llm?"]，"llm?" 含问号无法匹配）
export async function collectContextPages(
  vault: VaultService,
  question: string,
  maxPages = 5,
  contextPaths?: string[],
): Promise<{ path: string; title: string; content: string; created: string }[]> {
  const pages: { path: string; title: string; content: string; created: string }[] = [];

  // 优先复用主问答已搜到的页面路径
  if (contextPaths && contextPaths.length > 0) {
    for (const p of contextPaths.slice(0, maxPages)) {
      try {
        const content = await vault.readFile(p);
        const createdMatch = content.match(/^---\s*[\s\S]*?created:\s*([^\s]+)\s*[\s\S]*?---/m);
        const created = createdMatch?.[1] ?? '';
        // 路径形如 concepts/llm.md，标题取文件名去扩展名
        const title = p.slice(p.lastIndexOf('/') + 1, -3);
        pages.push({ path: p, title, content: content.slice(0, 2000), created });
      } catch {
        // 跳过读取失败的页面
      }
    }
    if (pages.length > 0) return pages;
    // contextPaths 全部读取失败时回退到关键词搜索
  }

  // 回退方案：用问题文本做关键词搜索
  // 为什么不直接用整句：searchPages 按空格分词 + includes 匹配，整句含疑问词和标点会命中失败
  // 去除开头常见疑问短语 + 去除中英文标点，让核心词能命中
  const keywords = question
    .replace(/^(什么是|如何|为什么|怎么|请|能不能|可以|能否|请问|介绍下|介绍一下|解释下|解释一下|说明下|说明一下)/, '')
    .replace(/[？?。.!！，,、；;：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  const hits = await searchPages(vault, keywords, maxPages);

  for (const hit of hits) {
    try {
      const content = await vault.readFile(hit.path);
      // 提取 frontmatter.created 字段供 timeline 模式使用
      // 为什么简单正则而非 gray-matter：避免引入额外依赖，且 frontmatter 结构稳定
      const createdMatch = content.match(/^---\s*[\s\S]*?created:\s*([^\s]+)\s*[\s\S]*?---/m);
      const created = createdMatch?.[1] ?? '';
      pages.push({
        path: hit.path,
        title: hit.title,
        content: content.slice(0, 2000), // 截断单页避免上下文过长
        created,
      });
    } catch {
      // 跳过读取失败的页面
    }
  }
  return pages;
}

// 构造 LLM 输入 prompt：模式指令 + 上下文页面 + 用户问题
async function buildMultimodalPrompt(
  mode: MultimodalMode,
  pages: { path: string; title: string; content: string; created: string }[],
  question: string,
): Promise<string> {
  const promptTemplate = await loadMultimodalPrompt();
  const pageContext = pages
    .map((p, i) => `### 页面 ${i + 1}: ${p.title}\n路径: ${p.path}\n创建时间: ${p.created || '未知'}\n内容:\n${p.content}`)
    .join('\n\n---\n\n');

  return `${promptTemplate}

## 用户问题
${question}

## 已检索到的知识库页面（作为生成依据）
${pageContext}

## 任务
请按 **${mode}** 模式生成结构化输出。严格遵守对应模式的格式与约束，输出仅包含目标模式的内容。`;
}

// FR-09-2 多模态输出工作流入口
// 调用时机：queryWorkflow 主问答完成后，若 input.outputMode 非 'normal' 则追加调用
// 失败策略：抛错让上层 queryWorkflow catch，不阻塞主问答（主答案已 yield）
// contextPaths：主问答 done chunk 中的 refs，优先用作上下文页面，避免二次搜索失败
export async function generateMultimodalOutput(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  question: string,
  mode: MultimodalMode,
  contextPaths?: string[],
): Promise<MultimodalOutput> {
  // 1. 收集相关页面作为生成上下文（优先复用主问答 refs）
  const pages = await collectContextPages(vault, question, 5, contextPaths);
  if (pages.length === 0) {
    throw new Error('multimodal output: no relevant pages found for context');
  }

  // 2. 构造 prompt
  const task = await buildMultimodalPrompt(mode, pages, question);

  // 3. 复用 harnessConfig 的 LLM 配置，但禁用工具（单轮生成）
  // 为什么 maxSteps:1：避免 ReAct 循环浪费 token，结构化输出只需单轮 LLM 调用
  // 为什么 tokenBudget 缩小：结构化输出比完整问答短，8000 足够
  const multimodalConfig: HarnessConfig = {
    ...harnessConfig,
    tools: [],
    budget: { maxSteps: 1, tokenBudget: 8000 },
    hooks: {},
  };
  const harness = new Harness(multimodalConfig);

  const result = await harness.run({ task });
  if (result.status === 'failed') {
    throw new Error(result.finalContent || `multimodal ${mode} generation failed`);
  }

  // 4. 清理输出：去除可能的 ```mermaid ``` 代码块包裹（mindmap 模式 LLM 可能添加）
  // 为什么清理：前端 markdown 渲染器会处理 ```mermaid 代码块，但为统一存储格式，统一保留原始语法
  const rawContent = result.finalContent || '';
  const content = rawContent.trim();

  return {
    type: mode,
    content,
  };
}

// 导出模式标签供路由层使用（thinking 提示文案）
export function getModeLabel(mode: MultimodalMode): string {
  return MODE_LABELS[mode] ?? mode;
}
