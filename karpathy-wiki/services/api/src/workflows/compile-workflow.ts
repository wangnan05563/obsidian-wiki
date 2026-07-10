import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import type { ToolDefinition, HarnessConfig, StepResult } from '@wiki/harness';
import { Harness } from '@wiki/harness';
import type { VaultService } from '../vault/vault-service.js';
import type { CompileInput, ProgressEvent } from '../types.js';
import { RunLogger } from '../run-logger.js';
import { CompileCache } from '../compile-cache.js';

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

// 加载 compile prompt 单点存储。Skill 与 harness 共引用，保证两阶段等价（M-3）。
declare const __dirname: string;
async function loadCompilePrompt(): Promise<string> {
  const here = typeof __dirname !== 'undefined' // NOSONAR: __dirname 为 declare const，ESM 下可能未声明，需 typeof 守卫
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
  const promptPath = path.resolve(here, '..', 'prompts', 'compile.md');
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
      description: '写入 Wiki 页面（含 frontmatter）。仅允许 entities/concepts/comparisons/queries/ 目录。',
      parameters: objSchema(
        {
          path: { type: 'string', description: '页面相对路径，如 concepts/llm-wiki.md' },
          content: { type: 'string', description: '页面完整内容（含 frontmatter）' },
        },
        ['path', 'content'],
      ),
      handler: async (args: unknown) => {
        const { path: p, content } = args as { path: string; content: string };
        await vault.writeFile(p, content);
        return { ok: true, path: p };
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
        await vault.appendIndex(pageName, summary);
        return { ok: true };
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
): AsyncIterable<ProgressEvent> {
  // 1. 存档原始资料到 raw/。file 类型读取本地文件，url/text 直接存档字符串。
  let rawContent: string;
  let rawFilename: string;
  if (input.type === 'file') {
    rawContent = await fs.readFile(input.content, 'utf8');
    rawFilename = path.basename(input.content);
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
  yield* bridgeHarnessToEvents(
    harnessConfig,
    vault,
    (harness) => harness.run({ task, context: { rawPath, schema } }),
    rawPath,
    cache,
    rawContent,
  );
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
      const errMsg = err instanceof Error ? err.message : String(err);
      pushEvent({
        step: 'done',
        status: 'error',
        message: `编译失败: ${errMsg}`,
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
          message: `编译异常: ${errMsg}`,
          error: errMsg,
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
