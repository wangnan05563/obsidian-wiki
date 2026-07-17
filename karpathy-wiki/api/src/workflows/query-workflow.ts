import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, HarnessConfig } from '@wiki/harness';
import { Harness } from '@wiki/harness';
import type { VaultService } from '../vault/vault-service.js';
import type { QueryInput, AnswerChunk, ThinkingChunk, WebRef } from '../types.js';
import type { WebSearchConfig } from '../types.js';
import { searchPages } from '../search-util.js';
import { createWebSearchTool } from '../tools/web-search.js';

// 加载 query prompt 单点存储。与 compile 共用 prompts/ 目录，保证两阶段等价（M-3）。
// esbuild 打包时通过 --define 替换 import.meta.url 为 CJS 等价表达式
import { fileURLToPath } from 'node:url';
const __dirname_resolved = path.dirname(fileURLToPath(import.meta.url));
async function loadQueryPrompt(): Promise<string> {
  const promptPath = path.resolve(__dirname_resolved, '..', 'prompts', 'query.md');
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

// 把答案文本按中英文句号/问号/感叹号切分，逐块 yield 模拟流式输出。
// 全角/半角标点经 NFKC 归一化后等价，去重保留全角作主分隔符（S5869）；
// 显式分组明确 | 优先级（S5850）
function* yieldAnswerInSentences(answer: string): Iterable<AnswerChunk> {
  const sentences = answer.match(/(?:[^。！？.!]*[。！？.!]+)|(?:[^。！？.!]+$)/g) ?? [answer];
  for (const s of sentences) {
    if (s.trim()) {
      yield { text: s };
    }
  }
}

// 降级链第 1 级：queryWithHarness
// 走 @wiki/harness ReAct 循环，注入 search_pages/read_page/web_search 工具，由 LLM 自主调用。
// 通过 afterStep hook 收集 thinking 步骤，run 完成后一次性 yield（harness.run 是阻塞 Promise，运行中无法 yield）。
// 失败时（harness.run 抛异常或返回 status='failed'）通过 throw 让上层降级链接管。
async function* queryWithHarness(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  input: QueryInput,
  options: { webSearchConfig?: WebSearchConfig },
  collectedThinking: ThinkingChunk[],
  collectedWebRefs: WebRef[],
): AsyncGenerator<AnswerChunk, void, unknown> {
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

  // 2. 联网搜索可用性检查：用户点联网搜索但未配置 API Key 时提示
  let webSearchAvailable = false;
  if (input.webSearch && options.webSearchConfig) {
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
  } else if (input.webSearch) {
    collectedThinking.push({
      phase: 'thinking',
      message: '联网搜索未配置，仅使用本地知识库。',
    });
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
        // §5.2 收集 web_search 工具结果：toolResults 与 toolCalls 一一对应，
        // 按位置匹配找到 web_search 调用的结果（WebSearchResult[]），转换为 WebRef 累加
        for (let i = 0; i < result.toolCalls.length; i++) {
          const tc = result.toolCalls[i];
          if (tc.function.name !== 'web_search') continue;
          const toolResult = result.toolResults[i] as
            | Array<{ title: string; url: string; snippet: string }>
            | { error: string }
            | undefined;
          if (!toolResult || !Array.isArray(toolResult)) continue;
          for (const r of toolResult) {
            if (r && r.url) {
              collectedWebRefs.push({ title: r.title, url: r.url, snippet: r.snippet });
            }
          }
        }
      },
    },
  });

  // 4. 执行问答。harness.run 抛异常或返回 failed status 时让上层降级链接管。
  let result;
  try {
    result = await harness.run({ task, context: { question: input.question } });
  } catch (err) {
    // 让上层 queryWorkflow catch 触发降级链
    throw err;
  }

  if (result.status === 'failed') {
    throw new Error(result.finalContent || 'harness run failed');
  }

  // 5. yield 收集到的 thinking 步骤（工具调用历史）
  for (const t of collectedThinking) {
    yield { thinking: t };
  }

  // 6. 将 finalContent 按句切分，逐块 yield 模拟流式输出
  const answer = result.finalContent || '知识库未覆盖此问题。';
  for (const chunk of yieldAnswerInSentences(answer)) {
    yield chunk;
  }

  // 7. 提取引用并标记完成
  const refs = extractRefs(answer);
  // §5.2 联网搜索引用：collectedWebRefs 已在 afterStep 中累加。
  // 去重（同 url 多次出现时只保留首次），限制最多 8 条避免 UI 过长
  const seenUrls = new Set<string>();
  const webRefs = collectedWebRefs.filter((r) => {
    if (seenUrls.has(r.url)) return false;
    seenUrls.add(r.url);
    return true;
  }).slice(0, 8);
  // §5.2 生成追问建议：基于问题和答案提取关键概念，构造 3 个延伸问题
  const followups = generateFollowups(input.question, answer, refs);
  if (followups.length > 0) {
    yield { followups };
  }
  yield { refs, webRefs, done: true };
}

// 降级链第 2 级：queryWithSearchFallback
// 决策理由：harness.run 失败（LLM 限流、工具循环异常、预算耗尽）时，绕过 ReAct 循环，
// 直接调 searchPages 拿到 Top-K 相关页面，拼到 prompt 里让 LLM 单轮回答。
// 无工具循环、无 ReAct，故障面小，给用户一个降级但可用的回答。
// 实现关键：复用 harnessConfig 的 llm 配置，但 tools=[] + maxSteps=1 强制单轮。
async function* queryWithSearchFallback(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  input: QueryInput,
): AsyncGenerator<AnswerChunk, void, unknown> {
  // 1. 直接调 searchPages 拿到 Top-K 相关页面
  // 截断避免长问题拖慢搜索（searchPages 按 includes 匹配，长字符串扫描慢）
  const keywords = input.question.slice(0, 100);
  const hits = await searchPages(vault, keywords, 5);

  if (hits.length === 0) {
    // 无命中：让上层降级链落到兜底
    throw new Error('search fallback: no hits');
  }

  // 2. 读取命中页面内容（截断到 2000 字符避免 prompt 过长）
  const pageContents: string[] = [];
  const refTitles: string[] = [];
  for (const h of hits) {
    try {
      const content = await vault.readFile(h.path);
      // 单页 2000 字符上限，5 页合计约 10K token，可控
      pageContents.push(`## ${h.title}\n${content.slice(0, 2000)}`);
      refTitles.push(h.title);
    } catch {
      // 跳过读取失败的页面
    }
  }

  if (pageContents.length === 0) {
    throw new Error('search fallback: all page reads failed');
  }

  // 3. 构造单轮 prompt：检索结果 + 用户问题
  const fallbackPrompt = `你是知识库助手。以下是检索到的相关页面：

${pageContents.join('\n\n---\n\n')}

## 用户问题
${input.question}

请基于上述页面内容回答，并在合适位置使用 [[页面名]] 引用对应页面。`;

  // 4. 复用 harnessConfig 的 LLM 配置，但禁用工具（强制单轮）
  // 为什么 maxSteps:1：单轮 LLM 调用即可，不需要 ReAct 循环
  // 为什么 tokenBudget 缩小：避免 fallback 也耗光预算
  const fallbackConfig: HarnessConfig = {
    ...harnessConfig,
    tools: [],
    budget: { maxSteps: 1, tokenBudget: 8000 },
    hooks: {},
  };
  const harness = new Harness(fallbackConfig);

  let result;
  try {
    result = await harness.run({ task: fallbackPrompt });
  } catch (err) {
    // LLM 调用也失败：让上层降级链落到兜底
    throw err;
  }

  if (result.status === 'failed') {
    throw new Error(result.finalContent || 'fallback harness run failed');
  }

  // 5. 流式输出
  const answer = result.finalContent || '知识库未覆盖此问题。';
  for (const chunk of yieldAnswerInSentences(answer)) {
    yield chunk;
  }

  // 6. 提取引用（合并 search hits 与 [[页面名]]）
  const extractedRefs = new Set<string>(refTitles);
  for (const r of extractRefs(answer)) {
    extractedRefs.add(r);
  }
  const refs = Array.from(extractedRefs).slice(0, 8);
  yield { refs, done: true };
}

// 执行 query，返回 AsyncIterable<AnswerChunk>。
// §6.0.1 降级链编排：queryWithHarness → queryWithSearchFallback → 兜底提示
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
  // thinking 收集器：harness 阶段收集，fallback 阶段不再追加
  const collectedThinking: ThinkingChunk[] = [];
  // webRefs 收集器：仅 harness 阶段（联网搜索）收集
  const collectedWebRefs: WebRef[] = [];

  // 模式提示 thinking：在降级链各分支前 push 一次，harness 阶段 yield 出来
  if (input.mode === 'deep') {
    collectedThinking.push({
      phase: 'thinking',
      message: '深度思考模式已启用，正在深入分析问题...',
    });
  }

  // 起始 thinking 事件（让前端立即看到"正在思考"动画）
  yield { thinking: { phase: 'thinking', message: '正在思考...' } };

  // 降级链第 1 级：queryWithHarness
  let harnessSucceeded = false;
  try {
    for await (const chunk of queryWithHarness(
      harnessConfig,
      vault,
      input,
      options,
      collectedThinking,
      collectedWebRefs,
    )) {
      yield chunk;
    }
    harnessSucceeded = true;
  } catch {
    // harness 失败（LLM 异常、预算耗尽、工具循环错误），落入降级链
  }

  if (harnessSucceeded) return;

  // 降级链第 2 级：queryWithSearchFallback
  yield { thinking: { phase: 'composing', message: '降级搜索中...' } };
  let fallbackSucceeded = false;
  try {
    for await (const chunk of queryWithSearchFallback(
      harnessConfig,
      vault,
      input,
    )) {
      yield chunk;
    }
    fallbackSucceeded = true;
  } catch {
    // fallback 也失败，落入兜底
  }

  if (fallbackSucceeded) return;

  // 降级链第 3 级：兜底提示
  yield { text: '知识库未覆盖此问题，或当前问答服务暂不可用。' };
  yield { refs: [], done: true };
}
