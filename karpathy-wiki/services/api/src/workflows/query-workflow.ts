import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ToolDefinition, HarnessConfig } from '@wiki/harness';
import { Harness } from '@wiki/harness';
import type { VaultService } from '../vault/vault-service.js';
import type { QueryInput, AnswerChunk } from '../types.js';
import { searchPages } from '../search-util.js';

// 加载 query prompt 单点存储。与 compile 共用 prompts/ 目录，保证两阶段等价（M-3）。
async function loadQueryPrompt(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const promptPath = path.resolve(here, '..', 'prompts', 'query.md');
  return fs.readFile(promptPath, 'utf8');
}

// JSON Schema 简写：所有工具参数均为对象，避免重复样板。
function objSchema(properties: Record<string, unknown>, required: string[]) {
  return {
    type: 'object',
    properties,
    required,
  } as const;
}

// query 工作流的工具集。仅提供只读工具，query 不允许写 Vault（AC-03-2）。
export function createQueryTools(vault: VaultService): ToolDefinition[] {
  return [
    {
      name: 'search_pages',
      description: '按关键词搜索知识库页面。返回匹配的页面路径与摘要片段。',
      parameters: objSchema(
        { keywords: { type: 'string', description: '搜索关键词，多个词用空格分隔' } },
        ['keywords'],
      ),
      handler: async (args: unknown) => {
        const { keywords } = args as { keywords: string };
        return searchPages(vault, keywords);
      },
    },
    {
      name: 'read_page',
      description: '读取知识库中指定页面的完整内容。',
      parameters: objSchema(
        { path: { type: 'string', description: '页面相对路径，如 concepts/llm-wiki.md' } },
        ['path'],
      ),
      handler: async (args: unknown) => {
        const { path: p } = args as { path: string };
        return vault.readFile(p);
      },
    },
  ];
}

// 从最终答案文本中提取 [[页面名]] 引用，去重后作为 refs 返回。
function extractRefs(text: string): string[] {
  const refs = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    refs.add(m[1].trim());
  }
  return Array.from(refs);
}

// 执行 query，返回 AsyncIterable<AnswerChunk>。
// harness.run 是非流式 Promise<RunResult>，这里把 finalContent 按句切分后逐块 yield，
// 模拟流式输出体验。真正的流式需 LLM adapter 的 chatStream，留待后续优化。
export async function* queryWorkflow(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  input: QueryInput,
): AsyncIterable<AnswerChunk> {
  // 1. 构造 prompt：问答指令 + 用户问题 + 历史（如果有）
  const promptTemplate = await loadQueryPrompt();
  const historyStr = input.history && input.history.length > 0
    ? input.history.map((h) => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`).join('\n')
    : '';
  const task = `${promptTemplate}

## 用户问题
${input.question}

${historyStr ? `## 历史对话\n${historyStr}` : ''}
`;

  // 2. 构造 harness，query 不需要 afterStep hook 推送进度（答案本身即最终输出）
  const harness = new Harness({
    ...harnessConfig,
    tools: createQueryTools(vault),
  });

  // 3. 执行问答
  let result;
  try {
    result = await harness.run({ task, context: { question: input.question } });
  } catch (err: unknown) {
    yield { text: `问答失败: ${err instanceof Error ? err.message : String(err)}` };
    yield { refs: [], done: true };
    return;
  }

  if (result.status === 'failed') {
    yield { text: `问答失败: ${result.finalContent || '未知错误'}` };
    yield { refs: [], done: true };
    return;
  }

  // 4. 将 finalContent 按句切分，逐块 yield 模拟流式输出
  const answer = result.finalContent || '知识库未覆盖此问题。';
  // 按中英文句号/问号/感叹号切分，保留分隔符
  const sentences = answer.match(/[^。！？.!?]*[。！？.!?]+|[^。！？.!?]+$/g) ?? [answer];
  for (const s of sentences) {
    if (s.trim()) {
      yield { text: s };
    }
  }

  // 5. 提取引用并标记完成
  const refs = extractRefs(answer);
  yield { refs, done: true };
}
