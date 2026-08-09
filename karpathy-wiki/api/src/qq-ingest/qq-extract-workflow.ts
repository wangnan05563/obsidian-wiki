// QQ 聊天记录价值抽取工作流（SRS §5.2 环节2）
//
// 与 compile-workflow 的关键差异：
// 1. LLM 单轮调用（非 agent loop）——抽取任务是 JSON 输入 → JSON 输出，无需工具调用循环
// 2. 直接 fetch OpenAI 兼容端点——不依赖 harness，避免引入不必要的 agent 复杂度
// 3. 代码控制写入——LLM 返回 JSON，代码解析后写 draft 文件（M2 决策：代码控制写入）
//
// 数据流：
//   raw/qq-xxx.json (chunks)
//     → 逐 chunk 调用 LLM (qq-extract.md prompt)
//     → 解析 JSON 输出 (容错 ```json 包裹)
//     → 二次脱敏 (redactExtractOutput)
//     → 写入 drafts/qa-<uuid>.md 或 drafts/solution-<uuid>.md
//     → 跨 chunk 合并去重
//     → yield ProgressEvent (chunk_start/draft_written/done)

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import type { VaultService } from '../vault/vault-service.js';
import type { AppConfig, QaPair, QqSolution, ProgressEvent } from '../types.js';
import { getEffectiveApiKey } from '../config.js';
import { redactExtractOutput } from './preprocess/qq-preprocess.js';
import { getPromptPath } from '../utils/runtime.js';

// prompt 模板路径：api/src/prompts/qq-extract.md（开发模式）或 exe/prompts/qq-extract.md（SEA 模式）
// 路径解析统一走 runtime.ts，与 CWD 解耦，兼容 SEA 打包模式
const PROMPT_PATH = getPromptPath('qq-extract.md');

// prompt 模板缓存：避免每个 chunk 都读盘
// 为什么是模块级缓存：prompt 在进程生命周期内不变，重复读盘是浪费
let cachedPrompt: string | null = null;

async function loadExtractPrompt(): Promise<string> {
  if (cachedPrompt !== null) return cachedPrompt;
  cachedPrompt = await fs.readFile(PROMPT_PATH, 'utf8');
  return cachedPrompt;
}

// LLM 抽取输出结构（与 qq-extract.md 输出 schema 对应）
interface LlmExtractOutput {
  qa_pairs: QaPair[];
  solutions: QqSolution[];
}

// 输入参数
export interface ExtractWorkflowInput {
  rawId: string;
  vault: VaultService;
  config: AppConfig;
  // logger.error 用于 SSE catch 分支后端日志双写（硬约束：SSE catch 必须 request.log.error）
  logger?: { error: (obj: unknown, msg?: string) => void };
}

// 调用 LLM API 抽取单个 chunk 的价值信息
// 为什么独立函数：隔离 fetch 逻辑便于单元测试 mock（测试时替换为 fake fetch）
async function callLlmForExtract(
  prompt: string,
  chunkMessages: unknown[],
  config: AppConfig,
): Promise<LlmExtractOutput> {
  const qqConfig = config.qq!;
  // baseUrl 优先级：extract_base_url 非空 > llm.baseUrl（SRS §6.2 extract_model 独立调用决策）
  // 为什么不直接复用 llm.baseUrl：extract_model 可能是不同 provider（如 glm-4-plus vs agnes-2.0-flash），
  // 需独立 baseUrl 避免请求发错端点
  const baseUrl = (qqConfig.extract_base_url || config.llm.baseUrl).trim();
  const model = qqConfig.extract_model;
  const apiKey = getEffectiveApiKey(config);

  if (!apiKey && !baseUrl.includes('localhost')) {
    throw new Error('API Key 未设置，无法调用抽取 LLM');
  }

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  // 60s 超时：与 openai-compatible.ts 一致，防止网络挂起导致 SSE 流永久阻塞
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
          { role: 'user', content: JSON.stringify(chunkMessages) },
        ],
        // 禁用流式：抽取任务需完整 JSON，流式反而增加解析复杂度
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
// 为什么需要容错：尽管 prompt 明确禁止包裹 markdown 代码块，LLM 仍可能违反约束
export function parseLlmJsonOutput(text: string): LlmExtractOutput {
  let cleaned = text.trim();
  // 剥离 ```json ... ``` 或 ``` ... ``` 包裹
  // 用 RegExp.exec 替代 String.match：语义更明确（S6594）
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(cleaned);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  // 兜底：尝试找到首个 { 到末尾 } 的子串（LLM 可能在 JSON 前后加解释文字）
  if (!cleaned.startsWith('{')) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      cleaned = cleaned.slice(first, last + 1);
    }
  }

  const parsed = JSON.parse(cleaned) as Partial<LlmExtractOutput>;
  return {
    qa_pairs: Array.isArray(parsed.qa_pairs) ? parsed.qa_pairs : [],
    solutions: Array.isArray(parsed.solutions) ? parsed.solutions : [],
  };
}

// 生成 draft 文件 slug：type-<uuid 前 8 位>
// 为什么用 uuid 而非 title slug：title 可能含中文/特殊字符，slug 化会引入编码问题；
// uuid 保证唯一性，compile 阶段 LLM 会重命名为正式 slug
function generateSlug(type: 'qa' | 'solution'): string {
  const uuid = crypto.randomUUID().slice(0, 8);
  return `${type}-${uuid}`;
}

// 写入单个 qa draft 文件，返回相对路径
// 路径：drafts/qa-<uuid>.md（M2 实现决策：抽取写入 drafts/ 集中存放，compile 后由 LLM 迁移到 qa/）
export async function writeQaDraft(
  vault: VaultService,
  rawId: string,
  qa: QaPair,
  qqConfig: NonNullable<AppConfig['qq']>,
): Promise<string> {
  const slug = generateSlug('qa');
  const relPath = `drafts/${slug}.md`;
  const today = new Date().toISOString().slice(0, 10);
  // 二次脱敏：对 question/answer/answerer/context/original_refs 应用 redactExtractOutput
  // 为什么必须：LLM 可能从记忆中还原脱敏前的 PII，输出前再次扫描（SRS §5.1.3 双向脱敏）
  const redacted = (s: string) => redactExtractOutput(s, qqConfig);

  const frontmatter = {
    title: qa.question.slice(0, 50) + (qa.question.length > 50 ? '...' : ''),
    type: 'qa',
    created: today,
    updated: today,
    source: `qq-chat:${rawId}`,
    tags: qa.tags,
    status: 'draft',
    confidence: 'medium', // SRS §5.2.3：QQ 来源默认 medium（借鉴 Hermes）
    answerer: redacted(qa.answerer),
    ts: qa.ts,
    original_refs: qa.original_refs.map(redacted),
  };

  const body = [
    '## 问题',
    '',
    redacted(qa.question),
    '',
    '## 答案',
    '',
    redacted(qa.answer),
    '',
    '## 上下文',
    '',
    redacted(qa.context),
    '',
    '## 原文引用',
    '',
    ...qa.original_refs.map((r) => `- > ${redacted(r)}`),
    '',
  ].join('\n');

  const content = matter.stringify(body, frontmatter);
  await vault.writeFile(relPath, content);
  return relPath;
}

// 写入单个 solution draft 文件，返回相对路径
// 路径：drafts/solution-<uuid>.md（M2 实现决策：与 qa draft 同目录，便于人工审核）
export async function writeSolutionDraft(
  vault: VaultService,
  rawId: string,
  sol: QqSolution,
  qqConfig: NonNullable<AppConfig['qq']>,
): Promise<string> {
  const slug = generateSlug('solution');
  const relPath = `drafts/${slug}.md`;
  const today = new Date().toISOString().slice(0, 10);
  const redacted = (s: string) => redactExtractOutput(s, qqConfig);

  const frontmatter = {
    title: sol.title,
    type: 'solution',
    created: today,
    updated: today,
    source: `qq-chat:${rawId}`,
    tags: ['solution'],
    status: 'draft',
    confidence: 'medium',
    ts: sol.ts,
    original_refs: sol.original_refs.map(redacted),
  };

  const body = [
    '## 背景',
    '',
    redacted(sol.background),
    '',
    '## 步骤',
    '',
    ...sol.steps.map((s, i) => `${i + 1}. ${redacted(s)}`),
    '',
    '## 注意事项',
    '',
    redacted(sol.caveats),
    '',
    '## 原文引用',
    '',
    ...sol.original_refs.map((r) => `- > ${redacted(r)}`),
    '',
  ].join('\n');

  const content = matter.stringify(body, frontmatter);
  await vault.writeFile(relPath, content);
  return relPath;
}

// 问题文本标准化：去空格 + 转小写，用于跨 chunk 去重 key
// 为什么不直接用 question 原文：LLM 可能轻度改写，相同问题的不同表述需归并
function normalizeQuestion(q: string): string {
  return q.replaceAll(/\s+/g, '').toLowerCase();
}

// 跨 chunk 合并去重：相同 question 保留首条（最早出现的）
// SRS §5.2.1a 第3点：相同 question 不同块均抽取时，保留 answerer 最多/最早的一条
// 简化实现：保留首条（最早出现的 chunk 索引最小）
export function deduplicateQaPairs(qaPairs: QaPair[]): QaPair[] {
  const seen = new Map<string, QaPair>();
  for (const qa of qaPairs) {
    const key = normalizeQuestion(qa.question);
    if (!seen.has(key)) {
      seen.set(key, qa);
    }
  }
  return Array.from(seen.values());
}

// 跨 chunk 合并 solution：按 title 标准化去重
export function deduplicateSolutions(solutions: QqSolution[]): QqSolution[] {
  const seen = new Map<string, QqSolution>();
  for (const sol of solutions) {
    const key = sol.title.replaceAll(/\s+/g, '').toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, sol);
    }
  }
  return Array.from(seen.values());
}

// 错误信息提取：统一处理 Error 与非 Error 类型，避免重复 instanceof 判断（降低认知复杂度 S3776）
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 在 raw/ 中定位文件（与 preview 路由同模式）
// 提取为独立函数降低 extractWorkflow 认知复杂度（S3776）
async function locateRawFile(vault: VaultService, rawId: string): Promise<string | null> {
  const tree = await vault.listTree('raw');
  const matched = tree.find(
    (n) => n.type === 'file' && n.name.endsWith('.json') && n.name.includes(rawId),
  );
  return matched?.path ?? null;
}

// 解析 raw JSON 的 chunks 字段
// 提取为独立函数降低 extractWorkflow 认知复杂度（S3776）
async function parseRawChunks(vault: VaultService, rawPath: string): Promise<unknown[][]> {
  const content = await vault.readFile(rawPath);
  const parsed = JSON.parse(content) as { chunks?: unknown[][] };
  if (!Array.isArray(parsed.chunks)) {
    // 用 TypeError 而非 Error：chunks 字段类型不匹配是类型错误（S7786）
    throw new TypeError('预清洗 JSON 缺少 chunks 数组');
  }
  return parsed.chunks;
}

// 抽取上下文：跨多个 chunk 共享的不可变配置（S107：参数分组为对象，降低参数数量）
interface ExtractContext {
  prompt: string;
  config: AppConfig;
  vault: VaultService;
  rawId: string;
  qqConfig: NonNullable<AppConfig['qq']>;
  logger: { error: (obj: unknown, msg?: string) => void } | undefined;
}

// 抽取结果累加器：跨 chunk 累积的可变集合（S107：参数分组为对象，降低参数数量）
interface ExtractCollectors {
  allQaPairs: QaPair[];
  allSolutions: QqSolution[];
  draftPaths: string[];
}

// 单个 draft 写入信息（供主 generator yield draft_written 事件）
interface DraftWriteInfo {
  path: string;
  title: string;
}

// 处理单个 chunk：调用 LLM 抽取 + 写入 draft 文件
// 提取为独立函数降低 extractWorkflow 认知复杂度（S3776）
// 内层 try/catch 保留：单条 draft 写入失败不阻塞整批
async function processChunkExtraction(
  ctx: ExtractContext,
  chunk: unknown[],
  collectors: ExtractCollectors,
): Promise<{ qaDrafts: DraftWriteInfo[]; solutionDrafts: DraftWriteInfo[]; llmOutput: LlmExtractOutput }> {
  const { prompt, config, vault, rawId, qqConfig, logger } = ctx;
  const { allQaPairs, allSolutions, draftPaths } = collectors;
  const llmOutput = await callLlmForExtract(prompt, chunk, config);
  const qaDrafts: DraftWriteInfo[] = [];
  const solutionDrafts: DraftWriteInfo[] = [];

  for (const qa of llmOutput.qa_pairs) {
    try {
      const draftPath = await writeQaDraft(vault, rawId, qa, qqConfig);
      draftPaths.push(draftPath);
      allQaPairs.push(qa);
      qaDrafts.push({ path: draftPath, title: qa.question.slice(0, 50) });
    } catch (err) {
      // 单条 draft 写入失败不阻塞整批，记录错误继续
      logger?.error({ err, rawId }, 'qq-extract write qa draft error');
    }
  }

  for (const sol of llmOutput.solutions) {
    try {
      const draftPath = await writeSolutionDraft(vault, rawId, sol, qqConfig);
      draftPaths.push(draftPath);
      allSolutions.push(sol);
      solutionDrafts.push({ path: draftPath, title: sol.title });
    } catch (err) {
      logger?.error({ err, rawId }, 'qq-extract write solution draft error');
    }
  }

  return { qaDrafts, solutionDrafts, llmOutput };
}

// 处理单个 chunk 并 yield 相关事件（extract_chunk running → draft_written × M → extract_chunk done/error）
// 提取为独立 generator 降低 extractWorkflow 认知复杂度（S3776）
async function* processChunkEvents(
  ctx: ExtractContext,
  chunkInfo: { chunk: unknown[]; chunkIdx: number; totalChunks: number },
  collectors: ExtractCollectors,
): AsyncGenerator<ProgressEvent> {
  const { chunk, chunkIdx, totalChunks } = chunkInfo;
  yield {
    step: 'extract_chunk',
    status: 'running',
    message: `抽取块 ${chunkIdx}/${totalChunks}（${Array.isArray(chunk) ? chunk.length : 0} 条消息）`,
    data: { fileIndex: chunkIdx - 1, fileCount: totalChunks, fileName: `chunk-${chunkIdx}` },
  };

  try {
    const { qaDrafts, solutionDrafts, llmOutput } = await processChunkExtraction(ctx, chunk, collectors);
    for (const d of qaDrafts) {
      yield {
        step: 'draft_written',
        status: 'done',
        message: `写入 qa draft: ${d.path}`,
        data: { path: d.path, title: d.title },
      };
    }
    for (const d of solutionDrafts) {
      yield {
        step: 'draft_written',
        status: 'done',
        message: `写入 solution draft: ${d.path}`,
        data: { path: d.path, title: d.title },
      };
    }
    yield {
      step: 'extract_chunk',
      status: 'done',
      message: `块 ${chunkIdx} 完成：${llmOutput.qa_pairs.length} qa + ${llmOutput.solutions.length} solution`,
    };
  } catch (err) {
    ctx.logger?.error({ err, rawId: ctx.rawId, chunkIdx }, 'qq-extract chunk error');
    yield {
      step: 'extract_chunk',
      status: 'error',
      message: `块 ${chunkIdx} 抽取失败: ${errMsg(err)}`,
    };
    // 单块失败不阻塞后续块（与 compile-workflow markPagesAsDraft 同决策：保留半成品）
  }
}

// 价值抽取主入口：AsyncGenerator<ProgressEvent>
// 路由层 for await 消费事件，映射为 SSE 事件（done/page/progress）
//
// 事件序列：
//   locate_raw (running → done/error)
//   [batch_limit (running)]        // 仅超限时
//   [load_prompt error]            // 失败时
//   extract_chunk (running → done/error) × N
//     draft_written (done) × M     // 每个 qa/solution 一条
//   done (done/error)
export async function* extractWorkflow(
  input: ExtractWorkflowInput,
): AsyncIterable<ProgressEvent> {
  const { rawId, vault, config, logger } = input;
  const qqConfig = config.qq;
  if (!qqConfig) {
    yield { step: 'error', status: 'error', message: 'QQ 配置缺失' };
    return;
  }

  // 1. 定位 raw 文件
  yield { step: 'locate_raw', status: 'running', message: `定位 rawId=${rawId} 的预清洗结果` };

  let rawPath: string | null;
  try {
    rawPath = await locateRawFile(vault, rawId);
  } catch (err) {
    logger?.error({ err, rawId }, 'qq-extract locate_raw error');
    yield { step: 'locate_raw', status: 'error', message: `读取 raw 目录失败: ${errMsg(err)}` };
    return;
  }

  if (!rawPath) {
    yield { step: 'locate_raw', status: 'error', message: `未找到 rawId=${rawId} 对应的预清洗结果` };
    return;
  }

  yield { step: 'locate_raw', status: 'done', message: `定位成功: ${rawPath}`, data: { path: rawPath } };

  // 2. 解析 chunks
  let chunks: unknown[][];
  try {
    chunks = await parseRawChunks(vault, rawPath);
  } catch (err) {
    logger?.error({ err, rawPath }, 'qq-extract parse raw error');
    yield { step: 'parse_raw', status: 'error', message: `解析预清洗 JSON 失败: ${errMsg(err)}` };
    return;
  }

  if (chunks.length === 0) {
    yield { step: 'done', status: 'done', message: '无消息块可抽取', data: { path: rawPath } };
    return;
  }

  // 3. 限制批次：最多处理 max_batch_size 个块
  // 为什么需要：防 LLM 上下文溢出 + 控制 token 成本
  const maxBatch = qqConfig.max_batch_size;
  const totalChunks = chunks.length;
  const chunksToProcess = chunks.slice(0, maxBatch);
  if (totalChunks > maxBatch) {
    yield {
      step: 'batch_limit',
      status: 'running',
      message: `共 ${totalChunks} 块，超过 max_batch_size=${maxBatch}，仅处理前 ${maxBatch} 块`,
    };
  }

  // 4. 加载 prompt
  let prompt: string;
  try {
    prompt = await loadExtractPrompt();
  } catch (err) {
    logger?.error({ err }, 'qq-extract load prompt error');
    yield { step: 'load_prompt', status: 'error', message: `加载 qq-extract.md 失败: ${errMsg(err)}` };
    return;
  }

  // 5. 逐 chunk 调用 LLM 抽取（事件生成委托给 processChunkEvents，降低本函数认知复杂度）
  const allQaPairs: QaPair[] = [];
  const allSolutions: QqSolution[] = [];
  const draftPaths: string[] = [];
  // 三组参数分组（S107）：ctx 不可变上下文 / collectors 累加器，二者跨 chunk 共享同一引用
  const ctx: ExtractContext = { prompt, config, vault, rawId, qqConfig, logger };
  const collectors: ExtractCollectors = { allQaPairs, allSolutions, draftPaths };

  for (let i = 0; i < chunksToProcess.length; i++) {
    yield* processChunkEvents(
      ctx,
      { chunk: chunksToProcess[i], chunkIdx: i + 1, totalChunks: chunksToProcess.length },
      collectors,
    );
  }

  // 6. 跨 chunk 合并去重（仅用于 done 事件统计，已写入的 draft 文件不回收）
  const dedupQa = deduplicateQaPairs(allQaPairs);
  const dedupSol = deduplicateSolutions(allSolutions);

  yield {
    step: 'done',
    status: 'done',
    message: `抽取完成：${dedupQa.length} qa + ${dedupSol.length} solution（已写入 ${draftPaths.length} 个 draft 文件）`,
    data: { path: rawPath },
  };
}
