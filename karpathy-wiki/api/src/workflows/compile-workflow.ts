import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { ToolDefinition, HarnessConfig, StepResult } from '@wiki/harness';
import { Harness } from '@wiki/harness';
import type { VaultService } from '../vault/vault-service.js';
import type { CompileInput, ProgressEvent, AppConfig } from '../types.js';
import { RunLogger } from '../run-logger.js';
import { CompileCache } from '../compile-cache.js';
import { convertOfficeFile } from '../utils/office-convert.js';
import { convertPdfToMarkdown } from '../utils/pdf-convert.js';
import { ocrImageToMarkdown, resolveOcrConfig, OCR_SUPPORTED_MIME } from '../utils/ocr-convert.js';
import { audioToText, resolveAudioConfig, AUDIO_SUPPORTED_MIME } from '../utils/audio-convert.js';
import { friendlyLlmError } from '../utils/llm-error.js';
import { suggestTagsForPage } from './tag-suggest-workflow.js';

// §12.3-6：compile 中途失败时，给已生成的页面标记 status: draft。
// 决策不回滚——LLM 编译成本高（token 已消耗），半成品保留供用户决策。
async function markPagesAsDraft(vault: VaultService, pagePaths: string[]): Promise<void> {
  for (const rel of pagePaths) {
    try {
      const raw = await vault.readFile(rel);
      const parsed = matter(raw);
      // 已有 status 字段则不覆盖，仅补充缺失的
      if (!parsed.data.status) {
        parsed.data.status = 'draft';
        const updated = matter.stringify(parsed.content, parsed.data);
        await vault.writeFile(rel, updated);
      }
    } catch {
      // 页面可能写入失败就不存在，跳过
    }
  }
}

// FR-15-4：合法的页面 type 枚举，与 SCHEMA.md 对齐
const VALID_PAGE_TYPES = ['entity', 'concept', 'comparison', 'query', 'qa', 'solution'] as const;
type PageType = (typeof VALID_PAGE_TYPES)[number];

// 去掉编译路由写入临时文件时附加的内部前缀（wiki-batch-<ts>-<i>- 与 wiki-compile-<ts>-），
// 避免批次/单文件上传的内部命名泄漏到 raw/ 存档文件名。用户的原始文件名应被保留。
function stripInternalPrefix(name: string): string {
  return name
    .replace(/^wiki-batch-\d+-\d+-/, '')
    .replace(/^wiki-compile-\d+-/, '');
}

// FR-15-4：目录名 → type 推断映射
// 为什么需要兜底：LLM 可能漏写或写错 type 字段，按写入路径的顶层目录推断是最可靠的回退策略
// 与前端 Browse.vue KANBAN_COLUMNS 的 dirMap 保持一致，避免前后端推断分歧
const DIR_TO_TYPE: Record<string, PageType> = {
  entities: 'entity',
  concepts: 'concept',
  comparisons: 'comparison',
  queries: 'query',
  qa: 'qa',
  solutions: 'solution',
};

// FR-15-4：校验并补全页面 frontmatter 的 type 字段
// - type 合法：原样返回（fast path，零开销）
// - type 缺失或非法：按目录路径推断后回写 frontmatter
// - frontmatter 解析失败：原样返回（不阻断写入，由后续 health-check 兜底）
function ensurePageTypeField(pagePath: string, content: string): string {
  let parsed;
  try {
    parsed = matter(content);
  } catch {
    // frontmatter 格式错误时不阻断写入，交给 health-check 兜底
    return content;
  }
  const currentType = parsed.data.type;
  const isValid = typeof currentType === 'string'
    && (VALID_PAGE_TYPES as readonly string[]).includes(currentType.toLowerCase());
  if (isValid) {
    return content; // fast path：LLM 已正确写入
  }
  // 按顶层目录推断 type
  const topDir = pagePath.split('/')[0]?.toLowerCase() ?? '';
  const inferredType = DIR_TO_TYPE[topDir] ?? 'concept'; // 兜底到 concept
  parsed.data.type = inferredType;
  return matter.stringify(parsed.content, parsed.data);
}

// FR-15-6：校验 frontmatter entities 字段格式与拓扑一致性
// 设计原则（与 ensurePageTypeField 不同）：
// - 不自动补全 entities：AC-15-6 要求"由 LLM 抽取"，从 [[双链]] 反向抽取会违反"不编造"原则
// - 仅做格式校验与清理：保证数据质量，不阻断写入
// 清理规则：
// 1. entities 不存在或为空数组：原样返回（fast path）
// 2. entities 非数组或项非对象：移除整个字段（格式严重错误）
// 3. 项缺 name 字段或 name 不在正文 [[双链]] 中：移除该项（保证图谱拓扑一致）
// 4. 清理后 entities 为空：移除 frontmatter.entities 字段（避免空数组污染）
function ensureEntitiesField(content: string): string {
  let parsed;
  try {
    parsed = matter(content);
  } catch {
    return content; // frontmatter 格式错误时不阻断写入
  }
  const rawEntities = parsed.data.entities;
  // fast path 1：entities 字段不存在
  if (rawEntities === undefined || rawEntities === null) {
    return content;
  }
  // 格式校验：必须是数组
  if (!Array.isArray(rawEntities)) {
    delete parsed.data.entities;
    return matter.stringify(parsed.content, parsed.data);
  }
  // 空数组：删除字段避免污染
  if (rawEntities.length === 0) {
    delete parsed.data.entities;
    return matter.stringify(parsed.content, parsed.data);
  }
  // 收集正文 [[页面名]] 用于校验 entities.name 拓扑一致性
  const wikilinkNames = new Set<string>();
  const wikilinkRe = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikilinkRe.exec(parsed.content)) !== null) {
    wikilinkNames.add(m[1]);
  }
  // 过滤无效项：必须有 name 字段且 name 在正文双链中出现
  // 为什么要求 name 必须在双链中出现：AC-15-6 明确规定保证图谱拓扑一致
  const validEntities = rawEntities.filter((item: unknown): item is { name: string; relation?: string } => {
    if (typeof item !== 'object' || item === null) return false;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== 'string' || obj.name.trim() === '') return false;
    return wikilinkNames.has(obj.name);
  });
  // 清理后为空：移除字段
  if (validEntities.length === 0) {
    delete parsed.data.entities;
    return matter.stringify(parsed.content, parsed.data);
  }
  // 写回清理后的 entities（过滤掉无效项）
  parsed.data.entities = validEntities;
  return matter.stringify(parsed.content, parsed.data);
}

// 加载 compile prompt 单点存储。Skill 与 harness 共引用，保证两阶段等价（M-3）。
// 路径解析统一走 runtime.ts，兼容开发模式与 SEA 打包模式
import { getPromptPath } from '../utils/runtime.js';
async function loadCompilePrompt(): Promise<string> {
  return fs.readFile(getPromptPath('compile.md'), 'utf8');
}

// JSON Schema 简写：所有工具参数均为对象，避免重复样板。
function objSchema(properties: Record<string, unknown>, required: string[]) {
  return {
    type: 'object',
    properties,
    required,
  } as const;
}

// compile 工作流的工具集。这些工具是 LLM 唯一可用的读写出口，
// 通过白名单校验在 VaultService 内部保证 AI 写入边界（10.4 写入约束）。
export function createCompileTools(vault: VaultService): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: '读取 Vault 中的文件（相对路径，如 SCHEMA.md、raw/xxx.md）',
      parameters: objSchema(
        { path: { type: 'string', description: 'Vault 内相对路径' } },
        ['path'],
      ),
      handler: async (args: unknown) => {
        const { path: p } = args as { path: string };
        return vault.readFile(p);
      },
    },
    {
      name: 'write_file',
      description: '写入 Wiki 页面（含 frontmatter）。仅允许 entities/concepts/comparisons/queries/qa/solutions/ 目录。',
      parameters: objSchema(
        {
          path: { type: 'string', description: '页面相对路径，如 concepts/llm-wiki.md' },
          content: { type: 'string', description: '页面完整内容（含 frontmatter）' },
        },
        ['path', 'content'],
      ),
      handler: async (args: unknown) => {
        const { path: p, content } = args as { path: string; content: string };
        // P2 去重：按 frontmatter title 查找已有页面，命中则重定向到已有路径（覆盖更新而非新建重复）
        // 仅对 entities/concepts 目录生效（这两个目录重复最严重；qa/solutions 按 rawId 命名天然不重复）
        const topDir = p.split('/')[0]?.toLowerCase() ?? '';
        let targetPath = p;
        if (topDir === 'entities' || topDir === 'concepts') {
          try {
            const parsed = matter(content);
            const title = typeof parsed.data.title === 'string' ? parsed.data.title : '';
            if (title) {
              const existing = await vault.findPageByTitle(title, topDir);
              // 命中且非当前路径本身：重定向（避免 LLM 用不同 slug 新建同实体重复页）
              if (existing && existing !== p) {
                targetPath = existing;
              }
            }
          } catch {
            // frontmatter 解析失败时跳过去重，按原路径写入（不阻断）
          }
        }
        // FR-15-4 兜底：LLM 漏写或写错 type 字段时，按目录路径自动推断回写
        // FR-15-6 兜底：校验 entities 字段格式与拓扑一致性，清理无效项
        // 为什么放在写入前：避免脏数据落盘后还要回扫修复，与 markPagesAsDraft 同样采用"读→改→写"模式
        const withType = ensurePageTypeField(targetPath, content);
        const finalContent = ensureEntitiesField(withType);
        await vault.writeFile(targetPath, finalContent);
        return { ok: true, path: targetPath, redirected: targetPath !== p ? p : undefined };
      },
    },
    {
      name: 'append_index',
      description: '向 index.md 追加一行摘要：- [[页面名]] — 摘要',
      parameters: objSchema(
        {
          pageName: { type: 'string' },
          summary: { type: 'string' },
        },
        ['pageName', 'summary'],
      ),
      handler: async (args: unknown) => {
        const { pageName, summary } = args as { pageName: string; summary: string };
        // P2 查重：appendIndex 追加前检查 [[pageName]] 是否已存在，skipped=true 时跳过
        const result = await vault.appendIndex(pageName, summary);
        return { ok: result.ok, skipped: result.skipped };
      },
    },
    {
      name: 'append_log',
      description: '向 log.md 追加编译操作记录',
      parameters: objSchema(
        {
          files: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        ['files'],
      ),
      handler: async (args: unknown) => {
        const { files, note } = args as { files: string[]; note?: string };
        await vault.appendLog('compile', files, note);
        return { ok: true };
      },
    },
  ];
}

// 工具调用名 → 前端可读步骤名映射。
// 这是阶段2控制权收回的体现——进度语义由业务层定义，不依赖 LLM 输出（A-5）。
const TOOL_STEP_MAP: Record<string, string> = {
  read_file: 'extract',
  write_file: 'generate_page',
  append_index: 'update_index',
  append_log: 'update_log',
};

// 执行 compile，返回 AsyncIterable<ProgressEvent>。
// harness.run 是非流式 Promise<RunResult>，用 afterStep Hook 把每步事件推入队列，
// AsyncGenerator 从队列 yield 出去，实现"非流式引擎 → 流式接口"的桥接（M-1）。
//
// 这里接受 harnessConfig 而非已构造的 harness 实例，是因为 hooks 在 harness 构造时绑定，
// 必须在本工作流内部构造 harness 才能注入 afterStep hook 推送进度事件。
export async function* compileWorkflow(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  input: CompileInput,
  // FR-10-1: 可选 config 用于编译末尾追加 AI tag 建议生成
  // 为什么可选：保持向后兼容，未传 config 时跳过 tag 建议（如 resume 场景）
  appConfig?: AppConfig,
): AsyncIterable<ProgressEvent> {
  // 1. 存档原始资料到 raw/。file 类型读取本地文件，url/text 直接存档字符串。
  let rawContent: string;
  let rawFilename: string;
  if (input.type === 'file') {
    const buf = await fs.readFile(input.content);
    // 优先使用上传时的原始文件名（已去内部前缀），否则回退到临时文件 basename。
    // 临时文件形如 wiki-batch-<ts>-<i>-<orig> 或 wiki-compile-<ts>-<orig>，
    // 直接取 basename 会把内部批次前缀泄漏进 raw/ 存档名，导致用户无法识别。
    const baseName = stripInternalPrefix(input.originalName ?? path.basename(input.content));
    const ext = path.extname(baseName).toLowerCase().slice(1);
    // FR-13-1：PDF 先通过 pdf-parse 提取文本为 Markdown，再走 compile 工作流
    // 为什么单独分支：PDF 不是 Office 格式，与 Office ZIP+XML 解析路径无关
    if (ext === 'pdf') {
      rawContent = await convertPdfToMarkdown(buf);
      rawFilename = baseName.replace(/\.[^.]+$/, '') + '.md';
    } else if (OCR_SUPPORTED_MIME[ext]) {
      // FR-13-2: Image OCR via LLM vision model
      // Why separate branch: images have no text layer, must go through OCR
      const ocrConfig = appConfig ? resolveOcrConfig(appConfig) : null;
      if (ocrConfig) {
        const mimeType = OCR_SUPPORTED_MIME[ext];
        rawContent = await ocrImageToMarkdown(buf, mimeType, ocrConfig);
      } else {
        rawContent = '[Warning: Image OCR is not configured. Please configure the ocr field in config.json with a vision-capable model.]';
      }
      rawFilename = baseName.replace(/\.[^.]+$/, '') + '.md';
    } else if (AUDIO_SUPPORTED_MIME[ext]) {
      // FR-13-3: Audio transcription via LLM voice model (OpenAI-compatible /v1/audio/transcriptions)
      // Why separate branch: audio files have no text layer, must go through STT
      const audioConfig = appConfig ? resolveAudioConfig(appConfig) : null;
      if (audioConfig) {
        const mimeType = AUDIO_SUPPORTED_MIME[ext];
        rawContent = await audioToText(buf, mimeType, baseName, audioConfig);
      } else {
        rawContent = '[Warning: Audio transcription is not configured. Please configure the audio field in config.json with a speech-to-text endpoint (e.g., OpenAI Whisper API).]';
      }
      rawFilename = baseName.replace(/\.[^.]+$/, '') + '.md';
    } else if (['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'].includes(ext)) {
      const convResult = await convertOfficeFile(baseName, buf);
      rawContent = convResult.markdown;
      rawFilename = baseName.replace(/\.[^.]+$/, '') + '.md';
    } else {
      rawContent = buf.toString('utf8');
      rawFilename = baseName;
    }
  } else {
    rawContent = input.content;
    rawFilename = input.rawPath ? path.basename(input.rawPath) : `input-${Date.now()}.md`;
  }
  const rawPath = await vault.archiveRaw(rawFilename, rawContent);
  yield { step: 'archive', status: 'done', message: `原始资料已存档: ${rawPath}`, data: { path: rawPath } };

  // §11.2 增量编译：内容哈希命中缓存时跳过编译，避免重复消耗 token。
  const cacheFile = path.join(vault.getVaultPath(), '..', '.harness', 'compile-cache.json');
  const cache = new CompileCache(cacheFile);
  const cached = await cache.lookup(rawContent);
  if (cached) {
    yield {
      step: 'done',
      status: 'done',
      message: `内容已编译过（缓存命中），跳过。对应原始资料: ${cached}`,
      data: { path: rawPath, cached: true },
    };
    return;
  }

  // 2. 读取 SCHEMA.md（强制，不交 LLM 决策，作为 beforeLoop 等价兜底）
  const schema = await vault.readFile('SCHEMA.md');
  yield { step: 'read_schema', status: 'done', message: '已读取 SCHEMA.md' };

  // 3. 构造 prompt：编译指令 + SCHEMA + 原始资料位置
  const promptTemplate = await loadCompilePrompt();
  const task = `${promptTemplate}

## SCHEMA.md 内容
${schema}

## 原始资料
资料已存档于 Vault 内 ${rawPath}，请使用 read_file 工具读取其内容后编译。
原始资料类型: ${input.type}
`;

  // 5. 桥接 harness 到事件流：compile 和 resume 共用此逻辑（§11.2）
  // FR-10-1: generatedPagesRef 由 bridgeHarnessToEvents 填充，编译完成后用于追加 AI tag 建议
  const generatedPagesRef: string[] = [];
  yield* bridgeHarnessToEvents(
    harnessConfig,
    vault,
    (harness) => harness.run({ task, context: { rawPath, schema } }),
    rawPath,
    cache,
    rawContent,
    generatedPagesRef,
  );

  // FR-10-1: 编译成功完成后，对每个生成的页面追加 AI tag 建议
  // 为什么在 bridgeHarnessToEvents 之后：generator 完成意味着 runPromise 已结束，generatedPagesRef 已填充
  // 为什么 try/catch 包裹：tag 建议失败不阻塞 compile 主流程（与 markPagesAsDraft 同决策：保留半成品）
  if (appConfig && generatedPagesRef.length > 0) {
    yield {
      step: 'generate_tags',
      status: 'running',
      message: `正在为 ${generatedPagesRef.length} 个页面生成 AI tag 建议`,
    };
    for (const pagePath of generatedPagesRef) {
      try {
        const aiTags = await suggestTagsForPage(vault, pagePath, appConfig);
        yield {
          step: 'generate_tags',
          status: 'done',
          message: `页面 ${pagePath} 生成 ${aiTags.length} 个 tag 建议`,
          data: { path: pagePath },
        };
      } catch (err) {
        // 单页面 tag 生成失败不阻塞其他页面，记录错误继续
        yield {
          step: 'generate_tags',
          status: 'error',
          message: `页面 ${pagePath} tag 生成失败: ${err instanceof Error ? err.message : String(err)}`,
          data: { path: pagePath },
        };
      }
    }
  }
}

// 通用 harness 事件桥接：构造 afterStep hook → 事件队列 → AsyncGenerator yield。
// compileWorkflow 传入 harness.run，resumeCompileWorkflow 传入 harness.resume，
// 两者共享相同的事件推送、draft 标记、日志双写逻辑，避免闭包重建代码重复。
async function* bridgeHarnessToEvents(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  runFn: (harness: Harness) => Promise<import('@wiki/harness').RunResult>,
  rawPath: string,
  cache: CompileCache | null,
  rawContent: string | null,
  // FR-10-1: 传出本次生成的页面路径，供调用方追加 AI tag 建议
  // 为什么用 ref 参数：避免重构 generatedPages 内部逻辑，最小侵入式扩展
  generatedPagesRef?: string[],
): AsyncIterable<ProgressEvent> {
  // 事件队列：afterStep hook 推入，AsyncGenerator yield 出去。
  // finished 标志避免 generator 提前退出时 harness 仍在写队列导致事件丢失。
  const queue: ProgressEvent[] = [];
  let resolveWaiter: (() => void) | null = null;
  let finished = false;
  // §12.3-8：harness 运行日志双写。logger 实例随每次编译创建，日志目录与 vault 同级。
  const logger = new RunLogger(path.join(vault.getVaultPath(), '..', '.harness', 'logs'));
  let currentRunId = '';
  // §12.3-6：跟踪本次生成的页面路径，失败时标记 draft
  const generatedPages: string[] = [];

  const pushEvent = (ev: ProgressEvent) => {
    queue.push(ev);
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  };

  // 构造 harness，注入 afterStep hook。
  // hook 根据工具调用名映射为前端可读步骤，推入事件队列，同时写入运行日志。
  const harness = new Harness({
    ...harnessConfig,
    tools: createCompileTools(vault),
    hooks: {
      afterStep: async (ctx, step, result: StepResult) => {
        currentRunId = ctx.runId;
        // result.toolCalls 是 LLM 在本步请求的工具调用列表
        for (const call of result.toolCalls) {
          const toolName = call.function.name;
          const stepName = TOOL_STEP_MAP[toolName] ?? toolName;
          let parsedArgs: { path?: string; pageName?: string } = {};
          try {
            parsedArgs = JSON.parse(call.function.arguments) as { path?: string; pageName?: string };
          } catch {
            // LLM 偶发返回非合法 JSON，忽略解析错误仍推送事件
          }
          pushEvent({
            step: stepName,
            status: 'done',
            message: `步骤 ${step}: ${toolName}`,
            data: {
              path: parsedArgs.path,
              title: parsedArgs.pageName,
            },
          });
          // §12.3-6：收集 write_file 生成的页面路径，用于失败时标记 draft
          if (toolName === 'write_file' && parsedArgs.path) {
            generatedPages.push(parsedArgs.path);
            // FR-10-1: 同步推送到调用方 ref，用于编译末尾追加 AI tag 建议
            if (generatedPagesRef) {
              generatedPagesRef.push(parsedArgs.path);
            }
          }
          // §12.3-8：记录技术日志（含 token 消耗，供事后性能分析）
          await logger.log({
            ts: new Date().toISOString(),
            runId: ctx.runId,
            step,
            event: 'step',
            tool: toolName,
            tokenUsed: result.tokenUsed,
            message: `${stepName}: ${parsedArgs.path ?? parsedArgs.pageName ?? ''}`,
          });
        }
      },
    },
  });

  // 启动 harness（run 或 resume），完成后 push done 事件 + 记录终态日志
  const runPromise = runFn(harness)
    .then(async (result) => {
      const isError = result.status === 'failed';
      pushEvent({
        step: 'done',
        status: isError ? 'error' : 'done',
        message: isError
          ? `编译失败: ${result.finalContent || '未知错误'}`
          : `编译完成，共 ${result.step} 步`,
        data: { path: rawPath || undefined },
      });
      // §12.3-6：失败时给已生成页面标记 draft，保留半成品供用户决策
      if (isError && generatedPages.length > 0) {
        await markPagesAsDraft(vault, generatedPages);
      }
      // §11.2：编译成功后记录缓存，下次相同内容跳过（resume 时不记录，避免覆盖）
      if (!isError && cache && rawContent) {
        await cache.record(rawContent, rawPath);
      }
      await logger.log({
        ts: new Date().toISOString(),
        runId: result.runId,
        step: result.step,
        event: isError ? 'error' : 'done',
        tokenUsed: result.tokenUsed,
        message: isError ? `编译失败: ${result.finalContent || '未知错误'}` : `编译完成，共 ${result.step} 步`,
        error: isError ? result.finalContent : undefined,
      });
    })
    .catch(async (err: unknown) => {
      // 为什么用 friendlyLlmError：wiki-harness 抛出的原始错误可能含完整 HTML（Cloudflare 520 页面几十 KB），
      // 直接透传会让前端显示长串 HTML。这里友好化后只返回简短可读提示
      const { friendly: friendlyMsg, category } = friendlyLlmError(err);
      // 原始错误信息仍写入日志（便于排查），但 SSE 推送用友好提示
      const rawErrMsg = err instanceof Error ? err.message : String(err);
      pushEvent({
        step: 'done',
        status: 'error',
        message: `编译失败: ${friendlyMsg}`,
        // 注意：ProgressEvent 无 error 字段，错误详情已含于 message
        // 完整 rawErrMsg 写入 RunLogger 供事后排查
      });
      // §12.3-6：异常分支同样标记 draft
      if (generatedPages.length > 0) {
        await markPagesAsDraft(vault, generatedPages);
      }
      // catch 分支无 result.runId，用 currentRunId 兜底（afterStep 可能已设置）
      if (currentRunId) {
        await logger.log({
          ts: new Date().toISOString(),
          runId: currentRunId,
          step: -1,
          event: 'error',
          message: `编译异常 [${category}]: ${rawErrMsg}`,
          error: rawErrMsg,
        });
      }
    })
    .finally(() => {
      finished = true;
      if (resolveWaiter) {
        const r = resolveWaiter;
        resolveWaiter = null;
        r();
      }
    });

  // yield 队列中的事件，直到 finished 且队列空
  while (!finished || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
      });
    }
    while (queue.length > 0) {
      const ev = queue.shift()!;
      yield ev;
    }
  }

  await runPromise;
}

// §11.2 断点续传：从中断点恢复编译。
// harness.resume 从 FileStateStore 加载 messages/step/tokenUsed，继续未完成的循环。
// afterStep hook 重新绑定——generatedPages 从空开始（之前的页面已在 vault 中），
// 事件队列重新创建，logger 以 append 模式继续写入同一个 {runId}.log 文件。
// 不记录缓存（rawContent 无法从 state 恢复），不重新存档原始资料。
export async function* resumeCompileWorkflow(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  runId: string,
): AsyncIterable<ProgressEvent> {
  yield { step: 'archive', status: 'done', message: `正在恢复编译任务: ${runId.slice(0, 8)}` };

  yield* bridgeHarnessToEvents(
    harnessConfig,
    vault,
    (harness) => harness.resume(runId),
    '',
    null,
    null,
  );
}
