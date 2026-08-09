import type { ToolDefinition, HarnessConfig } from '@wiki/harness';
import { Harness } from '@wiki/harness';
import fs from 'node:fs/promises';
import type { VaultService } from '../vault/vault-service.js';
import type { QueryInput, AnswerChunk, ThinkingChunk, WebRef, WebSearchConfig, ToolsConfig, MediaConfig, AppConfig } from '../types.js';
import { searchPages } from '../search-util.js';
import { createWebSearchTool } from '../tools/web-search.js';
import { loadExtendedTools } from '../tools/registry.js';
// FR-09-2 多模态输出：主问答完成后追加生成 mindmap/faq/timeline
// 为什么放在主问答之后：避免结构化输出污染主答案的流式体验；失败不阻塞主问答
import { generateMultimodalOutput, getModeLabel } from './multimodal-output-workflow.js';
// v3 媒体生成：图像/PPT 在 done 前推送 image/ppt 事件
import { generateImage, generatePpt } from './media-generation-workflow.js';

// 加载 query prompt 单点存储。与 compile 共用 prompts/ 目录，保证两阶段等价（M-3）。
// 路径解析统一走 runtime.ts，兼容开发模式与 SEA 打包模式
import { getPromptPath } from '../utils/runtime.js';
async function loadQueryPrompt(): Promise<string> {
  return fs.readFile(getPromptPath('query.md'), 'utf8');
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
  options: { webSearch?: boolean; webSearchConfig?: WebSearchConfig; scopeFilter?: { tags?: string[]; folder?: string } } = {},
): ToolDefinition[] {
  const scopeFilter = options.scopeFilter;
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
        // FR-12 scopeFilter：AI 伙伴预设的范围限定通过 search_pages 的 folder/tags 参数生效
        return searchPages(vault, keywords, 20, scopeFilter ? { folder: scopeFilter.folder, tags: scopeFilter.tags } : undefined);
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

// 从最终答案文本中提取 [[页面名]] 引用，并通过 vault.resolvePageName 解析为实际文件相对路径。
// 为什么解析为路径：RefsList 点击参考资料跳转 Browse 时，前端直接把 ref 当 path 传给 /api/files，
// 若传页面名（如 "llm-wiki"）后端 readFile 找不到文件返回 404。解析为路径（如 "concepts/llm-wiki.md"）
// 后跳转即可正常读取。找不到对应文件时保留原页面名（向后兼容，前端仍可展示）。
async function extractRefs(text: string, vault: VaultService): Promise<string[]> {
  const pageNames = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    pageNames.add(m[1].trim());
  }
  // 并行解析每个页面名为文件路径，避免串行 fs.access 等待
  const resolved = await Promise.all(
    Array.from(pageNames).map(async (name) => {
      const path = await vault.resolvePageName(name);
      return path ?? name;
    }),
  );
  // 去重：不同页面名可能解析到同一文件（理论上不会，但防御性去重）
  return Array.from(new Set(resolved));
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

// 构造 query 任务的完整 prompt 字符串。
// 提取为独立函数降低 queryWithHarness / queryWithHarnessStream 认知复杂度（S3776），
// 两分支共享同一 prompt 构造逻辑，保证等价（M-3）。
async function buildQueryTask(
  input: QueryInput,
  options: { systemPrompt?: string },
): Promise<string> {
  const promptTemplate = await loadQueryPrompt();
  const historyStr = input.history && input.history.length > 0
    ? input.history.map((h) => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`).join('\n')
    : '';
  const historySection = historyStr ? `## 历史对话\n${historyStr}` : '';
  const attachmentHint = buildAttachmentHint(input.attachments);
  const deepHint = buildDeepModeHint(input.mode);
  const skillHint = options.systemPrompt ? `\n## AI 伙伴指令\n${options.systemPrompt}\n` : '';

  return `${promptTemplate}

## 用户问题
${input.question}

${historySection}
${attachmentHint}
${deepHint}
${skillHint}
`;
}

// 基于问题和答案生成追问建议。
// 为什么用规则而非 LLM 二次调用：追问建议是轻量级 UI 辅助，规则方案零延迟零成本。
// 策略：从答案中提取引用页面名构造"详细解释"类问题，从问题关键词构造"对比/扩展"类问题。
function generateFollowups(question: string, answer: string, refs: string[]): string[] {
  const followups: string[] = [];

  // refs 现在是文件相对路径（如 concepts/llm-wiki.md），追问展示用页面名更友好
  // 兼容未解析的页面名（endsWith('.md') 判断区分路径与裸页面名）
  const refNames = refs.map((r) => {
    if (r.endsWith('.md')) {
      const slash = r.lastIndexOf('/');
      return r.slice(slash + 1, -3);
    }
    return r;
  });

  // 策略 1：基于引用页面构造追问
  if (refNames.length > 0) {
    followups.push(`详细解释一下「${refNames[0]}」的概念`);
    if (refNames.length > 1) {
      followups.push(`「${refNames[0]}」和「${refNames[1]}」有什么区别？`);
    }
  }

  // 策略 2：基于问题关键词构造扩展追问
  // 提取问题中的核心词（去掉疑问词后的前 10 个字符）
  const coreQuestion = question
    .replace(/^(什么是|什么是|如何|为什么|怎么|请|能不能|可以|能否)/, '')
    .replaceAll(/[？?]/g, '')
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

// 把答案文本按更细粒度（小段）切分，逐块 yield 模拟流式输出。
// v2 优化：从"按句子切分"改为"按短句/短语切分"：
//   1. 句子切分（句号/问号/感叹号边界）后单块仍可能很长（80-200 字），首屏等待仍久
//   2. 短句切分：句号、问号、感叹号、分号、逗号、冒号、换行都作为自然切分点，
//      单块平均 4-10 字，配合前端逐字渲染可获得接近真实 LLM stream 的"打字机"体验
//   3. 标点保护：切分时把标点保留在前一块末尾，避免"票交所接口。"被切成"票交所接口" + "。"
// 全角/半角标点经 NFKC 归一化后等价，去重保留全角作主分隔符（S5869）；
// 显式分组明确 | 优先级（S5850）
function* yieldAnswerInSentences(answer: string): Iterable<AnswerChunk> {
  // 用非贪婪正则按中文常用标点切分，标点跟随前一块；末尾无标点的尾部单独成块
  // 切分字符：。！？；，：、  + 半角 . ! ? ; , :
  const splitRe = /([。！？；，：、.!?;,:]+)|([^。！？；，：、.!?;,:]+$)/g;
  const parts: string[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = splitRe.exec(answer)) !== null) {
    if (m.index > lastIndex) {
      // 上一个切分点到本次匹配起点之间的剩余文本
      const tail = answer.slice(lastIndex, m.index);
      if (tail) parts.push(tail);
    }
    if (m[1]) {
      // 标点跟随前一块：把标点合并到最后一个非空 part
      const last = parts.pop();
      parts.push((last || '') + m[1]);
    } else if (m[2]) {
      // 末尾无标点的尾部
      parts.push(m[2]);
    }
    lastIndex = splitRe.lastIndex;
  }
  // 处理最后一段（lastIndex 之后的剩余）
  if (lastIndex < answer.length) {
    parts.push(answer.slice(lastIndex));
  }
  // 兜底：空结果
  if (parts.length === 0 && answer) parts.push(answer);
  for (const s of parts) {
    if (s) {
      yield { text: s };
    }
  }
}

// query 进度步骤与进度事件类型（S4323：提取联合类型为别名，多处复用）
type QueryProgressStep = 'searching' | 'fetching' | 'done';
type QueryProgress = { step: QueryProgressStep; count?: number };

// v2: 多输出模式多选类型与默认值
// 与 QueryInput.outputModes 一致；空数组/未配置时全开
type OutputMode = 'thinking' | 'tool_call' | 'answer' | 'multimodal';
const ALL_OUTPUT_MODES: OutputMode[] = ['thinking', 'tool_call', 'answer', 'multimodal'];

// 判断某类事件是否在用户的 outputModes 集合中
// 为什么提取独立函数：yield 处反复调用，避免重复 includes 表达式（S3358）
function shouldEmit(mode: OutputMode, allowed: Set<OutputMode> | null): boolean {
  // null 表示全开（无配置或未设置）
  return allowed === null || allowed.has(mode);
}

// 中间件开关判断：未配置 middlewares（null）时默认开启，配置后按是否包含 key 决定
// 为什么提取独立函数：内层函数（queryWithHarness/queryWithHarnessStream）多处调用，
// 避免重复 Set 构造与 has 判断（S3358）
// 与 queryWorkflow 顶层 useXxx 派生布尔的关系：顶层用于跨函数传递（effectiveInput），
// 此函数用于内层函数内部判断（extended_tools/followups），职责分离
function shouldRunMiddleware(middlewares: string[] | undefined, key: string): boolean {
  // 未配置 middlewares 或空数组 → 走默认行为（开启），保持向后兼容
  if (!middlewares || middlewares.length === 0) return true;
  return middlewares.includes(key);
}

// afterStep hook 收集的可变状态。
// 提取为独立接口便于在辅助函数间传递，降低 queryWithHarness 与 afterStep hook 认知复杂度（S3776）。
interface AfterStepState {
  thinking: ThinkingChunk[];
  webRefs: WebRef[];
  progress: QueryProgress[];
  webSearchDowngradeNotified: boolean;
}

// harness afterStep 回调的 result 参数结构（按需取字段，避免引入 harness 内部类型）。
interface StepResult {
  toolCalls: Array<{ function: { name: string; arguments: string } }>;
  toolResults: unknown[];
}

// 处理单个 toolCall：解析参数并收集 thinking。
// 提取为独立函数降低 afterStep hook 认知复杂度（S3776）。
function appendToolCallThinking(
  tc: StepResult['toolCalls'][number],
  thinking: ThinkingChunk[],
): void {
  let args: Record<string, unknown> | undefined;
  try {
    args = JSON.parse(tc.function.arguments || '{}');
  } catch {
    args = undefined;
  }
  thinking.push({
    phase: 'tool_call',
    message: `正在调用：${tc.function.name}`,
    tool: tc.function.name,
    args,
  });
}

// 处理 web_search 工具调用结果：收集 webRefs 与 progress，记录超时降级提示。
// 提取为独立函数降低 afterStep hook 认知复杂度（S3776）。
// toolResults 与 toolCalls 一一对应，按位置匹配找到 web_search 调用的结果。
function collectWebSearchResults(result: StepResult, state: AfterStepState): void {
  for (let i = 0; i < result.toolCalls.length; i++) {
    const tc = result.toolCalls[i];
    if (tc.function.name !== 'web_search') continue;
    const toolResult = result.toolResults[i] as
      | Array<{ title: string; url: string; snippet: string }>
      | { error: string }
      | undefined;
    if (!toolResult || !Array.isArray(toolResult)) continue;
    // F-3.10 超时降级提示：web_search 被调用但返回空数组，说明搜索超时或失败
    // 为什么放这里：web-search.ts 的 handler 签名只返回数组，无法直接推送 thinking
    // 用 webSearchDowngradeNotified 布尔避免多次 web_search 调用重复提示
    if (toolResult.length === 0 && !state.webSearchDowngradeNotified) {
      state.thinking.push({
        phase: 'thinking',
        message: '联网搜索超时或未返回结果，已降级为仅本地知识库。',
      });
      state.webSearchDowngradeNotified = true;
    }
    // F-3.10 progress 事件：web_search 调用完成，推送 fetching + done
    // 为什么 step='fetching'：searching 状态在调用前无法推送（harness 不支持 beforeToolCall hook）
    const newCount = toolResult.filter((r) => r?.url).length;
    // 单次 push 多个参数保持顺序（S7778）：fetching 与 done 是独立状态事件，按序消费
    state.progress.push({ step: 'fetching', count: newCount }, { step: 'done', count: newCount });
    for (const r of toolResult) {
      if (r?.url) {
        state.webRefs.push({ title: r.title, url: r.url, snippet: r.snippet });
      }
    }
  }
}

// 初始化联网搜索状态：返回是否可用，并推送相应 thinking/progress 到收集器
// 提取为独立函数降低 queryWithHarness 认知复杂度（S3776）
function initWebSearchState(
  input: QueryInput,
  options: { webSearchConfig?: WebSearchConfig },
  collectedThinking: ThinkingChunk[],
  collectedProgress: QueryProgress[],
): boolean {
  if (!input.webSearch) return false;
  if (!options.webSearchConfig) {
    collectedThinking.push({
      phase: 'thinking',
      message: '联网搜索未配置，仅使用本地知识库。',
    });
    return false;
  }
  const wsApiKey = options.webSearchConfig.apiKey || process.env[options.webSearchConfig.apiKeyRef];
  if (!wsApiKey) {
    collectedThinking.push({
      phase: 'thinking',
      message: '联网搜索未配置 API Key，仅使用本地知识库。请在 config.json 中配置 webSearch.apiKey。',
    });
    return false;
  }
  collectedThinking.push({
    phase: 'thinking',
    message: `联网搜索已启用（${options.webSearchConfig.provider}），可获取实时信息...`,
  });
  // F-3.10 progress 事件：联网搜索启动，推送 searching 状态
  // 为什么在 thinking 之前 push：collectedProgress 与 collectedThinking 一起在 run 完成后 yield
  collectedProgress.push({ step: 'searching' });
  return true;
}

// 加载扩展工具并推送加载失败错误到 thinking 收集器
// 提取为独立函数降低 queryWithHarness 认知复杂度（S3776）
async function loadExtendedToolsWithFeedback(
  question: string,
  toolsConfig: ToolsConfig | undefined,
  tools: ToolDefinition[],
  collectedThinking: ThinkingChunk[],
): Promise<void> {
  if (!toolsConfig) return;
  // 需求 4：加载扩展工具（MCP/CLI），根据场景路由动态注入
  // 为什么在 createQueryTools 之后：内置工具优先，扩展工具追加，避免名称冲突时覆盖内置工具
  const extended = await loadExtendedTools(question, toolsConfig);
  tools.push(...extended.tools);
  // 加载失败的错误推送为 thinking，让用户感知哪些工具不可用
  for (const err of extended.errors) {
    collectedThinking.push({
      phase: 'thinking',
      message: `扩展工具加载失败 [${err.source}]: ${err.message}`,
    });
  }
}

// 降级链第 1 级：queryWithHarness
// 走 @wiki/harness ReAct 循环，注入 search_pages/read_page/web_search 工具，由 LLM 自主调用。
// 通过 afterStep hook 收集 thinking 步骤，run 完成后一次性 yield（harness.run 是阻塞 Promise，运行中无法 yield）。
// 失败时（harness.run 抛异常或返回 status='failed'）通过 throw 让上层降级链接管。
// v2: outputModes 透传到内部 yield 过滤（null = 全开）
async function* queryWithHarness(
  harnessConfig: HarnessConfig, // NOSONAR - 参数过多是函数签名要求
  vault: VaultService,
  input: QueryInput,
  options: { webSearchConfig?: WebSearchConfig; toolsConfig?: ToolsConfig; scopeFilter?: { tags?: string[]; folder?: string }; systemPrompt?: string },
  collectedThinking: ThinkingChunk[],
  collectedWebRefs: WebRef[],
  collectedProgress: QueryProgress[],
  outputModes: Set<OutputMode> | null,
): AsyncGenerator<AnswerChunk, void, unknown> {
  // 1. 构造 prompt：复用 buildQueryTask 简化认知复杂度（S3776）
  const task = await buildQueryTask(input, { systemPrompt: options.systemPrompt });

  // 2. 联网搜索可用性检查（委托给 initWebSearchState 降低复杂度 S3776）
  const webSearchAvailable = initWebSearchState(input, options, collectedThinking, collectedProgress);

  // afterStep hook 收集状态：thinking/webRefs/progress 复用入参数组（写后即刷），
  // webSearchDowngradeNotified 为 hook 内部去重标记（harness 多步可能多次调用 web_search）
  const afterStepState: AfterStepState = {
    thinking: collectedThinking,
    webRefs: collectedWebRefs,
    progress: collectedProgress,
    webSearchDowngradeNotified: false,
  };

  // 3. 构造 harness，注入工具与 afterStep hook
  const tools = createQueryTools(vault, {
    webSearch: webSearchAvailable,
    webSearchConfig: options.webSearchConfig,
    // FR-12 scopeFilter：AI 伙伴预设的范围限定通过 search_pages 的 folder/tags 生效
    scopeFilter: options.scopeFilter,
  });

  // 加载扩展工具（委托给 loadExtendedToolsWithFeedback 降低复杂度 S3776）
  // 中间件 'extended_tools' 控制：未配置 middlewares 或含 'extended_tools' 时加载
  // 为什么放这里：toolsConfig 存在 ≠ 用户想启用扩展工具，middlewares 给用户最终控制权
  if (shouldRunMiddleware(input.middlewares, 'extended_tools')) {
    await loadExtendedToolsWithFeedback(input.question, options.toolsConfig, tools, collectedThinking);
  }

  const harness = new Harness({
    ...harnessConfig,
    tools,
    hooks: {
      // afterStep hook 委托给模块级辅助函数，降低本函数认知复杂度（S3776）
      afterStep: async (_ctx, _step, result) => {
        const stepResult = result as unknown as StepResult;
        // 每个工具调用转换为 ThinkingChunk
        for (const tc of stepResult.toolCalls) {
          appendToolCallThinking(tc, afterStepState.thinking);
        }
        // §5.2 收集 web_search 工具结果：toolResults 与 toolCalls 一一对应，
        // 按位置匹配找到 web_search 调用的结果（WebSearchResult[]），转换为 WebRef 累加
        collectWebSearchResults(stepResult, afterStepState);
      },
    },
  });

  // 4. 执行问答。harness.run 抛异常时由上层 queryWorkflow catch 触发降级链，此处无需包裹 try/catch
  const result = await harness.run({ task, context: { question: input.question } });

  if (result.status === 'failed') {
    throw new Error(result.finalContent || 'harness run failed');
  }

  // 5. yield 收集到的 progress 事件（联网搜索进度）
  // 为什么 progress 在 thinking 之前 yield：progress 是更高级别的状态提示，
  // 让前端 searchProgress 立即更新，与 thinking 步骤互补
  // v2: progress 总是发出（不属于可配置 outputModes，是基础设施状态）
  for (const p of collectedProgress) {
    yield { progress: p };
  }

  // 6. yield 收集到的 thinking 步骤（工具调用历史）
  // v2: 每个 thinking chunk 补 ts 字段（前端计算单步耗时）
  // v2: 按 allowed Set 过滤，避免用户在"隐藏思考过程"模式下仍收到所有步骤
  for (const t of collectedThinking) {
    // tool_call 步骤在 outputModes 包含 'tool_call' 时才显示思考细节
    // 但 'thinking' / 'composing' 步骤归入 'thinking' 类别
    const category: OutputMode = t.phase === 'tool_call' ? 'tool_call' : 'thinking';
    if (!shouldEmit(category, outputModes)) continue;
    yield { thinking: { ...t, ts: t.ts || new Date().toISOString() } };
  }

  // 7. 将 finalContent 按句切分，逐块 yield 模拟流式输出
  const answer = result.finalContent || '知识库未覆盖此问题。';
  for (const chunk of yieldAnswerInSentences(answer)) {
    yield chunk;
  }

  // 8. 提取引用并标记完成
  const refs = await extractRefs(answer, vault);
  // §5.2 联网搜索引用：collectedWebRefs 已在 afterStep 中累加。
  // 去重（同 url 多次出现时只保留首次），无数量限制，展示全部参考资料
  const seenUrls = new Set<string>();
  const webRefs = collectedWebRefs.filter((r) => {
    if (seenUrls.has(r.url)) return false;
    seenUrls.add(r.url);
    return true;
  });
  // §5.2 生成追问建议：基于问题和答案提取关键概念，构造 3 个延伸问题
  // 中间件 'followups' 控制：未配置 middlewares 或含 'followups' 时生成
  // 为什么用 shouldRunMiddleware：与 extended_tools 一致的中间件判断模式
  if (shouldRunMiddleware(input.middlewares, 'followups')) {
    const followups = generateFollowups(input.question, answer, refs);
    if (followups.length > 0) {
      yield { followups };
    }
  }
  yield { refs, webRefs, done: true };
}

// §真流式降级链第 1 级：queryWithHarnessStream
//   与 queryWithHarness 平行，差异在调用 harness.runStream 而非 harness.run
//   LLM 逐 delta 即时 yield，工具调用生命周期事件化推送 thinking
//   失败时（harness.runStream 抛异常或 yield error 事件）通过 throw 让上层降级链接管
async function* queryWithHarnessStream(
  harnessConfig: HarnessConfig, // NOSONAR - 参数过多是函数签名要求
  vault: VaultService,
  input: QueryInput,
  options: { webSearchConfig?: WebSearchConfig; toolsConfig?: ToolsConfig; scopeFilter?: { tags?: string[]; folder?: string }; systemPrompt?: string },
  collectedThinking: ThinkingChunk[],
  collectedWebRefs: WebRef[],
  collectedProgress: QueryProgress[],
  outputModes: Set<OutputMode> | null,
): AsyncGenerator<AnswerChunk, void, unknown> {
  // 复用 buildQueryTask 降低认知复杂度（S3776）
  const task = await buildQueryTask(input, { systemPrompt: options.systemPrompt });

  const webSearchAvailable = initWebSearchState(input, options, collectedThinking, collectedProgress);
  const afterStepState: AfterStepState = {
    thinking: collectedThinking,
    webRefs: collectedWebRefs,
    progress: collectedProgress,
    webSearchDowngradeNotified: false,
  };

  const tools = createQueryTools(vault, {
    webSearch: webSearchAvailable,
    webSearchConfig: options.webSearchConfig,
    scopeFilter: options.scopeFilter,
  });
  // 中间件 'extended_tools' 控制：与 queryWithHarness 一致的判断逻辑
  if (shouldRunMiddleware(input.middlewares, 'extended_tools')) {
    await loadExtendedToolsWithFeedback(input.question, options.toolsConfig, tools, collectedThinking);
  }

  const harness = new Harness({
    ...harnessConfig,
    tools,
    hooks: {
      // 流式分支下 afterStep 仍用于收集 webRefs/progress（thinking 由 runLoopStream 内事件即时推送）
      afterStep: async (_ctx, _step, result) => {
        const stepResult = result as unknown as StepResult;
        collectWebSearchResults(stepResult, afterStepState);
      },
    },
  });

  // §消费 runStream 事件流：delta 即时转发，tool_call/tool_result 推送 thinking，done 收尾
  let finalAnswer = '';
  let encounteredError: Error | null = null;

  for await (const evt of harness.runStream({ task, context: { question: input.question } })) {
    const stepEvt = evt;
    switch (stepEvt.type) {
      case 'delta':
        // 真流式核心：LLM token 增量即时推送，前端 streamingAnswer 逐字追加
        if (shouldEmit('answer', outputModes)) {
          yield { text: stepEvt.text };
          finalAnswer += stepEvt.text;
        }
        break;
      case 'tool_call':
        // 工具调用开始：推送 thinking 让前端看到"调用工具 X"
        if (shouldEmit('tool_call', outputModes)) {
          collectedThinking.push({
            phase: 'tool_call',
            message: `调用工具：${stepEvt.toolCall.function.name}`,
            ts: new Date().toISOString(),
          });
          yield { thinking: { ...collectedThinking.at(-1)!, ts: new Date().toISOString() } };
        }
        break;
      case 'tool_result':
        // 工具调用结束：推送 thinking 让前端看到"工具 X 返回"
        if (shouldEmit('tool_call', outputModes)) {
          collectedThinking.push({
            phase: 'tool_call',
            message: `工具 ${stepEvt.toolCall.function.name} 返回结果`,
            ts: new Date().toISOString(),
          });
          yield { thinking: { ...collectedThinking.at(-1)!, ts: new Date().toISOString() } };
        }
        break;
      case 'done':
        // finalContent 与累积的 finalAnswer 应一致；如未累积（outputModes 关闭 answer），用 done.finalContent
        finalAnswer = finalAnswer || stepEvt.finalContent;
        break;
      case 'error':
        encounteredError = new Error(stepEvt.message);
        break;
    }
    if (encounteredError) break;
  }

  if (encounteredError) {
    throw encounteredError;
  }

  // §progress/webRefs 在流式分支也需推送（harness 阶段已收集）
  for (const p of collectedProgress) {
    yield { progress: p };
  }
  // thinking 已在事件中实时推送，但起始模式 thinking（如 deep mode）仍需补发
  for (const t of collectedThinking) {
    const category: OutputMode = t.phase === 'tool_call' ? 'tool_call' : 'thinking';
    if (!shouldEmit(category, outputModes)) continue;
    // 已在事件中推送过的 tool_call thinking 跳过，避免重复
    if (t.phase === 'tool_call') continue;
    yield { thinking: { ...t, ts: t.ts || new Date().toISOString() } };
  }

  const answer = finalAnswer || '知识库未覆盖此问题。';
  const refs = await extractRefs(answer, vault);
  const seenUrls = new Set<string>();
  const webRefs = collectedWebRefs.filter((r) => {
    if (seenUrls.has(r.url)) return false;
    seenUrls.add(r.url);
    return true;
  });
  // 中间件 'followups' 控制：与 queryWithHarness 一致的判断逻辑
  if (shouldRunMiddleware(input.middlewares, 'followups')) {
    const followups = generateFollowups(input.question, answer, refs);
    if (followups.length > 0) {
      yield { followups };
    }
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

  // 2. 读取命中页面完整内容（需求2：去掉单页截断限制，确保回答详尽完整）
  // 为什么用 h.path 而非 h.title 收集 refs：refs 统一为文件相对路径形式，
  // 保证前端跳转 Browse 时 /api/files?path=<ref> 能直接命中文件
  const pageContents: string[] = [];
  const refPaths: string[] = [];
  for (const h of hits) {
    try {
      const content = await vault.readFile(h.path);
      pageContents.push(`## ${h.title}\n${content}`);
      refPaths.push(h.path);
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

  // harness.run 抛异常时由上层 queryWorkflow catch 触发降级链落到兜底，无需此处包裹 try/catch
  const result = await harness.run({ task: fallbackPrompt });

  if (result.status === 'failed') {
    throw new Error(result.finalContent || 'fallback harness run failed');
  }

  // 5. 流式输出
  const answer = result.finalContent || '知识库未覆盖此问题。';
  for (const chunk of yieldAnswerInSentences(answer)) {
    yield chunk;
  }

  // 6. 提取引用（合并 search hits 路径与 [[页面名]] 解析后的路径）
  // 需求2：去掉 refs 数量限制，返回所有相关引用
  const extractedRefs = new Set<string>(refPaths);
  for (const r of await extractRefs(answer, vault)) {
    extractedRefs.add(r);
  }
  const refs = Array.from(extractedRefs);
  yield { refs, done: true };
}

// FR-09-2 多模态输出包装器：在 done 事件之前 yield multimodal
// 为什么放在 done 之前：前端 SSE 处理通常在 done 之后停止监听，multimodal 必须在 done 之前到达
// 为什么先 yield thinking：让前端立即显示"正在生成思维导图..."状态，避免用户以为卡住
// 为什么传 chunk.refs：主问答已通过 search_pages 工具搜到最相关页面，复用这些路径作为
// multimodal 生成上下文，避免 collectContextPages 用整句问题做关键词搜索时命中失败
// 失败策略：catch 错误后 yield thinking 提示失败原因，不阻塞主问答的 done 事件
// v2: outputModes 过滤 multimodal 事件；用户在配置中关闭 multimodal 时跳过生成

// 按 mode 分发 multimodal 生成逻辑，返回对应的 AsyncGenerator。
// 提取为独立函数降低 wrapWithMultimodal 认知复杂度（S3776）。
async function* yieldMultimodalByMode(
  mode: string,
  harnessConfig: HarnessConfig,
  vault: VaultService,
  question: string,
  refs: string[] | undefined,
  mediaConfig?: MediaConfig,
  appConfig?: AppConfig,
): AsyncGenerator<AnswerChunk, void, unknown> {
  if (mode === 'image') {
    yield {
      thinking: {
        phase: 'composing',
        message: '正在生成图像...',
        ts: new Date().toISOString(),
      },
    };
    const imageResult = await generateImage(harnessConfig, vault, question, refs, mediaConfig, appConfig);
    yield {
      image: {
        url: imageResult.url,
        alt: imageResult.alt,
        archivePath: imageResult.archivePath,
      },
    };
  } else if (mode === 'ppt') {
    yield {
      thinking: {
        phase: 'composing',
        message: '正在生成 PPT 幻灯片...',
        ts: new Date().toISOString(),
      },
    };
    const pptResult = await generatePpt(harnessConfig, vault, question, refs);
    yield {
      ppt: {
        markdown: pptResult.markdown,
        title: pptResult.title,
        archivePath: pptResult.archivePath,
      },
    };
  } else {
    const multimodalMode = mode as 'mindmap' | 'faq' | 'timeline';
    yield {
      thinking: {
        phase: 'composing',
        message: `正在生成${getModeLabel(multimodalMode)}...`,
        ts: new Date().toISOString(),
      },
    };
    const multimodal = await generateMultimodalOutput(harnessConfig, vault, question, multimodalMode, refs);
    yield { multimodal };
  }
}

// 获取 mode 对应的中文标签，用于错误提示。
// 提取为独立函数避免嵌套三元表达式（S3358）。
function getModeLabelForError(mode: string): string {
  if (mode === 'image') return '图像';
  if (mode === 'ppt') return 'PPT';
  return getModeLabel(mode as 'mindmap' | 'faq' | 'timeline');
}

async function* wrapWithMultimodal(
  source: AsyncIterable<AnswerChunk>,
  harnessConfig: HarnessConfig,
  vault: VaultService,
  input: QueryInput,
  outputModes: Set<OutputMode> | null,
  // v3 媒体生成：image 模式需要 mediaConfig 调用 Agnes API，appConfig 解析 API key
  mediaConfig?: MediaConfig,
  appConfig?: AppConfig,
): AsyncGenerator<AnswerChunk, void, unknown> {
  // 用户在多输出模式中关闭 multimodal 时跳过整个 multimodal 生成（节省 LLM token）
  // 单独的 'composing' thinking 提示（"正在生成思维导图"）也跟着被前置 filter 处理
  for await (const chunk of source) {
    if (chunk.done && input.outputMode && input.outputMode !== 'normal' && shouldEmit('multimodal', outputModes)) {
      const mode = input.outputMode;
      // 委托 yieldMultimodalByMode 分发各模式生成逻辑，降低本函数认知复杂度（S3776）
      try {
        for await (const multimodalChunk of yieldMultimodalByMode(
          mode, harnessConfig, vault, input.question, chunk.refs, mediaConfig, appConfig,
        )) {
          yield multimodalChunk;
        }
      } catch (err) {
        // multimodal/image/ppt 失败不阻塞主问答，推送 thinking 提示失败原因
        yield {
          thinking: {
            phase: 'composing',
            message: `${getModeLabelForError(mode)} 生成失败：${err instanceof Error ? err.message : String(err)}`,
            ts: new Date().toISOString(),
          },
        };
      }
    }
    yield chunk;
  }
}

// 执行 query，返回 AsyncIterable<AnswerChunk>。

// 创建带 multimodal 包装的 harness generator。
// 提取为独立函数降低 queryWorkflow 认知复杂度（S3776）。
function createHarnessWithMultimodal(
  useStream: boolean, // NOSONAR - 参数过多是函数签名要求
  harnessConfig: HarnessConfig,
  vault: VaultService,
  effectiveInput: QueryInput,
  options: {
    webSearchConfig?: WebSearchConfig;
    toolsConfig?: ToolsConfig;
    scopeFilter?: { tags?: string[]; folder?: string };
    systemPrompt?: string;
    mediaConfig?: MediaConfig;
    appConfig?: AppConfig;
  },
  collectedThinking: ThinkingChunk[],
  collectedWebRefs: WebRef[],
  collectedProgress: QueryProgress[],
  outputModes: Set<OutputMode> | null,
): AsyncIterable<AnswerChunk> {
  const harnessFlow = useStream
    ? queryWithHarnessStream(harnessConfig, vault, effectiveInput, options, collectedThinking, collectedWebRefs, collectedProgress, outputModes)
    : queryWithHarness(harnessConfig, vault, effectiveInput, options, collectedThinking, collectedWebRefs, collectedProgress, outputModes);
  return wrapWithMultimodal(harnessFlow, harnessConfig, vault, effectiveInput, outputModes, options.mediaConfig, options.appConfig);
}

// 创建带 multimodal 包装的 fallback generator。
// 提取为独立函数降低 queryWorkflow 认知复杂度（S3776）。
function createFallbackWithMultimodal(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  input: QueryInput,
  options: { mediaConfig?: MediaConfig; appConfig?: AppConfig },
  outputModes: Set<OutputMode> | null,
): AsyncIterable<AnswerChunk> {
  return wrapWithMultimodal(
    queryWithSearchFallback(harnessConfig, vault, input),
    harnessConfig, vault, input, outputModes, options.mediaConfig, options.appConfig,
  );
}

// 中间件解析与有效输入构造：从 middlewares 数组派生布尔开关与覆盖后的 input。
// 提取为独立函数降低 queryWorkflow 认知复杂度（S3776）。
function buildMiddlewareContext(input: QueryInput): {
  middlewareSet: Set<string> | null;
  useWebSearch: boolean;
  useDeepThinking: boolean;
  useStream: boolean;
  effectiveInput: QueryInput;
} {
  const middlewareSet: Set<string> | null = input.middlewares && input.middlewares.length > 0
    ? new Set(input.middlewares)
    : null;
  const useWebSearch = middlewareSet != null ? middlewareSet.has('web_search') : !!input.webSearch;
  const useDeepThinking = middlewareSet != null ? middlewareSet.has('deep_thinking') : input.mode === 'deep';
  const useStream = middlewareSet != null ? middlewareSet.has('stream') : !!input.stream;
  let effectiveMode = input.mode;
  if (useDeepThinking) {
    effectiveMode = 'deep';
  } else if (input.mode === 'deep') {
    effectiveMode = '';
  }
  const effectiveInput: QueryInput = middlewareSet
    ? { ...input, webSearch: useWebSearch, mode: effectiveMode, stream: useStream }
    : input;
  return { middlewareSet, useWebSearch, useDeepThinking, useStream, effectiveInput };
}

export async function* queryWorkflow(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  input: QueryInput,
  options: {
    webSearchConfig?: WebSearchConfig;
    toolsConfig?: ToolsConfig;
    // FR-12 AI 伙伴预设：scope 限定检索范围，systemPrompt 追加到 query prompt 末尾
    scopeFilter?: { tags?: string[]; folder?: string };
    systemPrompt?: string;
    // v3 媒体生成：image 模式需要 mediaConfig 调用 Agnes API，appConfig 解析 API key
    mediaConfig?: MediaConfig;
    appConfig?: AppConfig;
  } = {},
): AsyncIterable<AnswerChunk> {
  // thinking 收集器：harness 阶段收集，fallback 阶段不再追加
  const collectedThinking: ThinkingChunk[] = [];
  // webRefs 收集器：仅 harness 阶段（联网搜索）收集
  const collectedWebRefs: WebRef[] = [];
  // F-3.10 progress 收集器：harness afterStep 中收集 web_search 进度
  const collectedProgress: QueryProgress[] = [];

  // v2: 解析 outputModes 过滤集合
  // input.outputModes 为空/未设置 → null（表示全开，让所有事件照常发送）
  // 设置了非空数组 → Set 形式（O(1) 查找）
  // 类型断言：QueryInput.outputModes 声明为 string[]（JSON 序列化兼容），此处运行时已确保
  // 元素为 OutputMode 联合成员，断言为 OutputMode[] 以匹配 Set<OutputMode> 类型
  const outputModes: Set<OutputMode> | null = input.outputModes && input.outputModes.length > 0
    ? new Set(input.outputModes as OutputMode[])
    : null;

  // 中间件与有效输入构造：提取为独立函数降低 queryWorkflow 认知复杂度（S3776）
  const { middlewareSet, useWebSearch, useDeepThinking, useStream, effectiveInput } = buildMiddlewareContext(input);

  // 模式提示 thinking：在降级链各分支前 push 一次，harness 阶段 yield 出来
  // 为什么改用 useDeepThinking：middlewares 配置后覆盖 input.mode 判断
  if (useDeepThinking) {
    collectedThinking.push({
      phase: 'thinking',
      message: '深度思考模式已启用，正在深入分析问题...',
      ts: new Date().toISOString(),
    });
  }

  // 起始 thinking 事件（让前端立即看到"正在思考"动画）
  // v2: 起始思考也按 outputModes.thinking 过滤（关闭思考时不发起始）
  if (shouldEmit('thinking', outputModes)) {
    yield { thinking: { phase: 'thinking', message: '正在思考...', ts: new Date().toISOString() } };
  }

  // 降级链第 1 级：queryWithHarness（默认）或 queryWithHarnessStream（真流式）
  // 委托 createHarnessWithMultimodal 处理流式切换与 multimodal 包装，降低认知复杂度（S3776）
  let harnessSucceeded = false;
  try {
    for await (const chunk of createHarnessWithMultimodal(
      useStream, harnessConfig, vault, effectiveInput, options,
      collectedThinking, collectedWebRefs, collectedProgress, outputModes,
    )) {
      yield chunk;
    }
    harnessSucceeded = true;
  } catch {
    // harness 失败（LLM 异常、预算耗尽、工具循环错误），落入降级链
  }

  if (harnessSucceeded) return;

  // 降级链第 2 级：queryWithSearchFallback
  if (shouldEmit('thinking', outputModes)) {
    yield { thinking: { phase: 'composing', message: '降级搜索中...', ts: new Date().toISOString() } };
  }
  let fallbackSucceeded = false;
  try {
    for await (const chunk of createFallbackWithMultimodal(
      harnessConfig, vault, input, options, outputModes,
    )) {
      yield chunk;
    }
    fallbackSucceeded = true;
  } catch {
    // fallback 也失败，落入兜底
  }

  if (fallbackSucceeded) return;

  // 降级链第 3 级：兜底提示
  // 为什么不包装兜底：兜底是无相关结果场景，multimodal 必然失败（无 context pages），直接 yield 节省调用
  // 兜底文本也按 outputModes.answer 过滤（关闭 answer 时不发任何兜底文本）
  if (shouldEmit('answer', outputModes)) {
    yield { text: '知识库未覆盖此问题，或当前问答服务暂不可用。' };
  }
  yield { refs: [], done: true };
}
