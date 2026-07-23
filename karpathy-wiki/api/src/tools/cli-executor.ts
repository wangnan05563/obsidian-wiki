// CLI 工具安全执行器。
// 为什么需要：让 LLM 能调用本地 CLI 命令（如 ping/nslookup），扩展知识库问答能力边界。
// 安全策略：
// 1. 命令白名单：只允许预定义的安全只读命令，防止 rm/del/format 等破坏性命令
// 2. 无 shell 调用：spawn(command, args) 直接调用，不经 shell 解析，避免管道/重定向注入
// 3. 超时控制：每个命令有最大执行时长，防止恶意长时占用
// 4. 参数校验：argsTemplate 中的 {input} 占位符由 LLM 提供，需校验不含命令分隔符

import { spawn } from 'node:child_process';
import type { CliToolEntry } from '../types.js';

// 安全命令白名单：仅允许无副作用的只读/查询类系统命令。
// 为什么常量化而非配置化：白名单是安全边界，放配置文件会被用户误放宽，故硬编码收敛。
// 扩展新命令需代码审查，确保无写入/删除/网络执行能力。
const ALLOWED_COMMANDS = new Set([
  'ping',
  'nslookup',
  'whoami',
  'hostname',
  'date',
  'time',
  'systeminfo',
  'tasklist',
  'ipconfig',
  'netstat',
  'echo',
  'type',
  'dir',
  'where',
  'findstr',
]);

// 默认超时：30 秒。为什么 30s：覆盖 ping 等网络命令的正常往返，同时防止死循环占用。
const DEFAULT_TIMEOUT_MS = 30000;

// 输入校验：禁止命令分隔符与危险字符，防止 argsTemplate 注入。
// 为什么校验 & | ; > < ` $：这些是 shell 元字符，虽不使用 shell 但防御性校验仍有意义
//   （防止参数被拼到其他工具的 shell 调用中）。
const DANGEROUS_INPUT_PATTERN = /[&|;<>`$]/;

// 将 argsTemplate 字符串拆分为参数数组，支持双引号包裹含空格的参数。
// 为什么需要：默认 split(/\s+/) 会把含空格的路径（如 "C:\Program Files\app"）拆成多个参数，
//   导致 spawn 找不到文件。引号包裹让用户能正确传递含空格的参数。
// 规则：
// - 双引号内的内容作为单个参数（含空格）
// - 双引号外的空格作为分隔符
// - 连续空格被压缩（与原 split(/\s+/) 行为一致）
function splitArgs(template: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  for (const ch of template) {
    if (ch === '"') {
      inQuote = !inQuote;
      // 引号本身不加入参数内容
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      // 连续空格跳过（压缩）
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

export interface CliExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

// 执行 CLI 工具。
// entry: 来自 config.json 的 CLI 工具配置
// input: LLM 提供的 {input} 参数值（已由 JSON Schema 校验为 string）
export async function executeCliTool(entry: CliToolEntry, input: string): Promise<CliExecResult> {
  // 1. 白名单校验
  if (!ALLOWED_COMMANDS.has(entry.command)) {
    return {
      ok: false,
      stdout: '',
      stderr: `Command "${entry.command}" is not in the whitelist. Allowed: ${Array.from(ALLOWED_COMMANDS).join(', ')}`,
      exitCode: null,
      timedOut: false,
    };
  }

  // 2. 输入校验：防止危险字符
  if (input && DANGEROUS_INPUT_PATTERN.test(input)) {
    return {
      ok: false,
      stdout: '',
      stderr: 'Input contains forbidden characters (& | ; < > ` $).',
      exitCode: null,
      timedOut: false,
    };
  }

  // 3. 构造参数：替换 {input} 占位符
  const template = entry.argsTemplate ?? '{input}';
  // 为什么 split + join 而非 replace：input 可能含 $ 符号，replace 会误解为正则反向引用
  // 为什么用 splitArgs 而非 split(/\s+/)：支持双引号包裹含空格的参数（如文件路径）
  const args = splitArgs(template.split('{input}').join(input));

  // 4. 超时控制
  const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    // 为什么 spawn 不用 shell:true：shell:true 会经 cmd.exe 解析，存在管道/重定向注入风险
    const child = spawn(entry.command, args, {
      shell: false,
      timeout: timeoutMs,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('error', (err) => {
      resolve({
        ok: false,
        stdout,
        stderr: stderr + err.message,
        exitCode: null,
        timedOut,
      });
    });
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        stdout: stdout.slice(0, 10000), // 限制输出长度，避免超长结果撑爆 LLM 上下文
        stderr: stderr.slice(0, 5000),
        exitCode: code,
        timedOut,
      });
    });
    // spawn timeout 事件：Node 在 timeout 触发后发送 SIGTERM
    child.on('timeout', () => {
      timedOut = true;
      child.kill('SIGKILL');
    });
  });
}

// 将 CLI 工具配置转为 ToolDefinition 供 harness 使用。
// 为什么需要适配函数：harness 的 ToolDefinition 要求 handler 签名 (args, ctx)，CLI 工具的 input 参数需从中提取。
// handler 接受可选 ctx 参数（与 ToolDefinition.handler 签名对齐），当前未使用但保留扩展点。
export function buildCliToolDefinition(entry: CliToolEntry) {
  return {
    name: entry.name,
    description: entry.description,
    parameters: {
      type: 'object' as const,
      properties: {
        input: { type: 'string', description: '输入参数，将填充到命令模板的 {input} 位置' },
      },
      required: ['input'],
    },
    handler: async (args: unknown, _ctx?: unknown) => {
      const { input } = args as { input: string };
      const result = await executeCliTool(entry, input ?? '');
      if (result.timedOut) {
        return { error: `Command timed out after ${entry.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, stdout: result.stdout };
      }
      if (!result.ok) {
        return { error: result.stderr || `Command exited with code ${result.exitCode}`, stdout: result.stdout };
      }
      return { output: result.stdout };
    },
  };
}
