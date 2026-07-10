import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition, HarnessConfig, StepResult } from '@wiki/harness';
import { Harness } from '@wiki/harness';
import type { VaultService } from '../vault/vault-service.js';
import type { FixInput, FixProgressEvent } from '../types.js';

// 加载 fix prompt 单点存储（M-3 prompt 等价性）
declare const __dirname: string;
async function loadFixPrompt(): Promise<string> {
  const here = typeof __dirname !== 'undefined' // NOSONAR: __dirname 为 declare const，ESM 下可能未声明，需 typeof 守卫
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
  const promptPath = path.resolve(here, '..', 'prompts', 'health-check-fix.md');
  return fs.readFile(promptPath, 'utf8');
}

// JSON Schema 简写
function objSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: 'object', properties, required } as const;
}

// fix 工作流工具集。允许 read_file/write_file/append_log，禁止改 SCHEMA/index（10.4 写入约束）。
// VaultService.writeFile 已内置白名单校验，工具层无需重复校验。
export function createFixTools(vault: VaultService): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: '读取 Vault 中的页面内容（相对路径，如 concepts/llm-wiki.md）',
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
      description: '写入页面（含 frontmatter）。仅允许 entities/concepts/comparisons/queries/ 目录。',
      parameters: objSchema(
        {
          path: { type: 'string', description: '页面相对路径' },
          content: { type: 'string', description: '页面完整内容' },
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
      name: 'append_log',
      description: '向 log.md 追加修复操作记录',
      parameters: objSchema(
        {
          files: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        ['files'],
      ),
      handler: async (args: unknown) => {
        const { files, note } = args as { files: string[]; note?: string };
        await vault.appendLog('health-check', files, note);
        return { ok: true };
      },
    },
  ];
}

// 工具调用名 → 前端可读步骤名映射（与 compile 工作流一致的设计）
const TOOL_STEP_MAP: Record<string, string> = {
  read_file: 'scan',
  write_file: 'fixing',
  append_log: 'update_log',
};

// 执行修复工作流，返回 AsyncIterable<FixProgressEvent>。
// 与 compile-workflow 相同的事件桥接模式：afterStep hook 推送进度，AsyncGenerator yield。
export async function* healthCheckFixWorkflow(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  input: FixInput,
): AsyncIterable<FixProgressEvent> {
  // 1. 构造 prompt
  const promptTemplate = await loadFixPrompt();
  // broken_link 时 target 是对象，orphan 时是字符串。TS 无法在三元中收窄联合类型，故显式断言。
  const targetDesc = input.issueType === 'broken_link'
    ? `来源页面: ${(input.target as { from: string; to: string }).from}，断链指向: [[${(input.target as { from: string; to: string }).to}]]`
    : `孤立页面: ${input.target as string}`;

  const task = `${promptTemplate}

## 问题类型
${input.issueType === 'broken_link' ? '断链修复' : '孤立页面修复'}

## 问题描述
${targetDesc}

请使用工具修复此问题。
`;

  // 2. 事件队列桥接（与 compile-workflow 相同模式）
  const queue: FixProgressEvent[] = [];
  let resolveWaiter: (() => void) | null = null;
  let finished = false;

  const pushEvent = (ev: FixProgressEvent) => {
    queue.push(ev);
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  };

  // 3. 构造 harness，注入 afterStep hook 推送进度
  const harness = new Harness({
    ...harnessConfig,
    tools: createFixTools(vault),
    hooks: {
      afterStep: async (_ctx, step, result: StepResult) => {
        for (const call of result.toolCalls) {
          const toolName = call.function.name;
          const stepName = TOOL_STEP_MAP[toolName] ?? toolName;
          let parsedArgs: { path?: string } = {};
          try {
            parsedArgs = JSON.parse(call.function.arguments) as { path?: string };
          } catch {
            // LLM 偶发非 JSON 参数，忽略
          }
          pushEvent({
            step: stepName,
            status: 'done',
            message: `步骤 ${step}: ${toolName}`,
            tool: toolName,
            data: { path: parsedArgs.path },
          });
        }
      },
    },
  });

  // 4. 启动 harness，完成后推送 done/fixed 事件
  const runPromise = harness
    .run({ task, context: { issueType: input.issueType, target: input.target } })
    .then((result) => {
      const isError = result.status === 'failed';
      pushEvent({
        step: isError ? 'done' : 'fixed',
        status: isError ? 'error' : 'done',
        message: isError
          ? `修复失败: ${result.finalContent || '未知错误'}`
          : `修复完成，共 ${result.step} 步`,
      });
      if (!isError) {
        pushEvent({ step: 'done', status: 'done', message: '修复流程结束' });
      }
    })
    .catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      pushEvent({ step: 'done', status: 'error', message: `修复异常: ${errMsg}` });
    })
    .finally(() => {
      finished = true;
      if (resolveWaiter) {
        const r = resolveWaiter;
        resolveWaiter = null;
        r();
      }
    });

  // 5. yield 队列事件
  while (!finished || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
      });
    }
    while (queue.length > 0) {
      yield queue.shift()!;
    }
  }

  await runPromise;
}
