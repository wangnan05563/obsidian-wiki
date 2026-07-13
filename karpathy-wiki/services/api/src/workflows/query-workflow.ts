import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition, HarnessConfig } from '@wiki/harness';
import { Harness } from '@wiki/harness';
import type { VaultService } from '../vault/vault-service.js';
import type { QueryInput, AnswerChunk, ThinkingChunk } from '../types.js';
import type { WebSearchConfig } from '../types.js';
import { searchPages } from '../search-util.js';
import { createWebSearchTool } from '../tools/web-search.js';

// 加载 query prompt 单点存储。与 compile 共用 prompts/ 目录，保证两阶段等价（M-3）。
declare const __dirname: string;
async function loadQueryPrompt(): Promise<string> {
  const here = typeof __dirname !== 'undefined' // NOSONAR: __dirname 为 declare const，ESM 下可能未声明，需 typeof 守卫
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
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
// §5.2 当 options.webSearch 为 true 时，追加 web_search 工具。
export function createQueryTools(
  vault: VaultService,
  options: { webSearch?: boolean; webSearchConfig?: WebSearchConfig } = {},
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
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

  // §5.2 联网搜索：当配置了 webSearch 且 apiKey 可用时注入工具
  if (options.webSearch && options.webSearchConfig) {
    const webTool = createWebSearchTool(options.webSearchConfig);
    if (webTool) {
      // 适配 ToolDefinition 签名：web-search.ts 的 handler 是单参，harness 的 handler 是双参
      tools.push({
        name: webTool.name,
        description: webTool.description,
        parameters: webTool.parameters,
        handler: async (args: unknown) => webTool.handler(args),
      });
    }
  }

  return tools;
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

// 构造附件提示文本块。
// 为什么不直接传 base64 给 LLM：harness 的 Message.content 仅支持 string，multimodal 需扩展 harness。
// 当前方案：在 prompt 中告知 LLM 用户上传了附件（文件名 + MIME），LLM 可据此理解用户意图。
// 后续若需真正的 multimodal 支持，需扩展 wiki-harness 的 Message 类型。
function buildAttachmentHint(attachments?: QueryInput['attachments']): string {
  if (!attachments || attachments.length === 0) return '';
  const lines = attachments.map((a, i) =>
    `${i + 1}. 文件名: ${a.filename}, 类型: ${a.mimeType}`,
  );
  return `\n## 用户上传的附件\n用户上传了 ${attachments.length} 个附件，请参考附件信息回答：\n${lines.join('\n')}\n`;
}

// 构造深度思考模式提示。
// §5.2 deep 模式：增加推理深度提示，引导 LLM 展示思考过程
function buildDeepModeHint(mode?: string): string {
  if (mode === 'deep') {
    return '\n## 深度思考模式\n请深入思考用户问题，分步骤推理，确保答案的准确性和完整性。\n';
  }
  return '';
}

// 基于问题和答案生成追问建议。
// 为什么用规则而非 LLM 二次调用：追问建议是轻量级 UI 辅助，规则方案零延迟零成本。
// 策略：从答案中提取引用页面名构造"详细解释"类问题，从问题关键词构造"对比/扩展"类问题。
function generateFollowups(question: string, answer: string, refs: string[]): string[] {
  const followups: string[] = [];

  // 策略 1：基于引用页面构造追问
  if (refs.length > 0) {
    followups.push(`详细解释一下「${refs[0]}」的概念`);
    if (refs.length > 1) {
      followups.push(`「${refs[0]}」和「${refs[1]}」有什么区别？`);
    }
  }

  // 策略 2：基于问题关键词构造扩展追问
  // 提取问题中的核心词（去掉疑问词后的前 10 个字符）
  const coreQuestion = question
    .replace(/^(什么是|什么是|如何|为什么|怎么|请|能不能|可以|能否)/, '')
    .replace(/[？?]/g, '')
    .slice(0, 15);
  if (coreQuestion) {
    followups.push(`${coreQuestion}有哪些实际应用场景？`);
  }

  // 策略 3：通用追问模板
  if (followups.length < 3) {
    followups.push('知识库中还有哪些相关内容？');
  }

  // 去重并限制 3 条
  return [...new Set(followups)].slice(0, 3);
}

// 执行 query，返回 AsyncIterable<AnswerChunk>。
// §5.2 改造点：
//   1. 支持 options.webSearch 注入 web_search 工具
//   2. 支持 options.mode='deep' 调整 prompt
//   3. 支持 options.attachments 附加附件信息到 prompt
//   4. 通过 harness afterStep hook 收集 thinking 步骤，run 完成后 yield
//   5. harness.run 是非流式 Promise，这里把 finalContent 按句切分后逐块 yield
export async function* queryWorkflow(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  input: QueryInput,
  options: {
    webSearchConfig?: WebSearchConfig;
  } = {},
): AsyncIterable<AnswerChunk> {
  // 1. 构造 prompt：问答指令 + 用户问题 + 历史 + 附件提示 + 模式提示
  const promptTemplate = await loadQueryPrompt();
  const historyStr = input.history && input.history.length > 0
    ? input.history.map((h) => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`).join('\n')
    : '';
  const historySection = historyStr ? `## 历史对话\n${historyStr}` : '';
  const attachmentHint = buildAttachmentHint(input.attachments);
  const deepHint = buildDeepModeHint(input.mode);

  const task = `${promptTemplate}

## 用户问题
${input.question}

${historySection}
${attachmentHint}
${deepHint}
`;

  // 2. 收集 thinking 步骤：通过 harness afterStep hook 在工具调用时收集
  // 为什么用数组收集而非实时 yield：harness.run 是阻塞的 Promise，无法在运行中 yield
  // run 完成后一次性 yield 所有 thinking，保证 thinking 在 answer 之前
  const collectedThinking: ThinkingChunk[] = [];

  // §5.2 深度思考模式提示：用户可见的 thinking 事件，确认模式已生效
  if (input.mode === 'deep') {
    collectedThinking.push({
      phase: 'thinking',
      message: '深度思考模式已启用，正在深入分析问题...',
    });
  }

  // §5.2 联网搜索模式提示：检查 API Key 是否配置
  // 为什么需要：用户点击联网搜索但未配置 API Key 时，工具静默不注入，用户困惑
  let webSearchAvailable = false;
  if (input.webSearch) {
    if (options.webSearchConfig) {
      const wsApiKey = options.webSearchConfig.apiKey || process.env[options.webSearchConfig.apiKeyRef];
      if (wsApiKey) {
        webSearchAvailable = true;
        collectedThinking.push({
          phase: 'thinking',
          message: `联网搜索已启用（${options.webSearchConfig.provider}），可获取实时信息...`,
        });
      } else {
        collectedThinking.push({
          phase: 'thinking',
          message: '联网搜索未配置 API Key，仅使用本地知识库。请在 config.json 中配置 webSearch.apiKey。',
        });
      }
    } else {
      collectedThinking.push({
        phase: 'thinking',
        message: '联网搜索未配置，仅使用本地知识库。',
      });
    }
  }

  // 3. 构造 harness，注入工具与 afterStep hook
  const tools = createQueryTools(vault, {
    webSearch: webSearchAvailable,
    webSearchConfig: options.webSearchConfig,
  });

  const harness = new Harness({
    ...harnessConfig,
    tools,
    hooks: {
      afterStep: async (_ctx, _step, result) => {
        // 每个工具调用转换为 ThinkingChunk
        for (const tc of result.toolCalls) {
          let args: Record<string, unknown> | undefined;
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = undefined;
          }
          collectedThinking.push({
            phase: 'tool_call',
            message: `正在调用：${tc.function.name}`,
            tool: tc.function.name,
            args,
          });
        }
      },
    },
  });

  // 4. 先 yield thinking 起始事件
  yield { thinking: { phase: 'thinking', message: '正在思考...' } };

  // 5. 执行问答
  let result;
  try {
    result = await harness.run({ task, context: { question: input.question } });
  } catch (err: unknown) {
    yield { thinking: { phase: 'composing', message: '降级搜索中...' } };
    yield { text: `问答失败: ${err instanceof Error ? err.message : String(err)}` };
    yield { refs: [], done: true };
    return;
  }

  // 6. yield 收集到的 thinking 步骤（工具调用历史）
  for (const t of collectedThinking) {
    yield { thinking: t };
  }

  if (result.status === 'failed') {
    yield { thinking: { phase: 'composing', message: '降级搜索中...' } };
    yield { text: `问答失败: ${result.finalContent || '未知错误'}` };
    yield { refs: [], done: true };
    return;
  }

  // 7. 将 finalContent 按句切分，逐块 yield 模拟流式输出
  const answer = result.finalContent || '知识库未覆盖此问题。';
  // 按中英文句号/问号/感叹号切分，保留分隔符。
  // 全角/半角标点经 NFKC 归一化后等价，去重保留全角作主分隔符（S5869）；显式分组明确 | 优先级（S5850）
  const sentences = answer.match(/(?:[^。！？.!]*[。！？.!]+)|(?:[^。！？.!]+$)/g) ?? [answer];
  for (const s of sentences) {
    if (s.trim()) {
      yield { text: s };
    }
  }

  // 8. 提取引用并标记完成
  const refs = extractRefs(answer);
  // §5.2 生成追问建议：基于问题和答案提取关键概念，构造 3 个延伸问题
  const followups = generateFollowups(input.question, answer, refs);
  if (followups.length > 0) {
    yield { followups };
  }
  yield { refs, done: true };
}
