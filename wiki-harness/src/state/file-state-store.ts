import type { StateStore, RunState, Message } from '../types.js';
import { messagesToEvents } from '../session/session-log.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// 文件系统状态存储：每个 run 一个 JSON 文件，便于断点恢复与调试
// 零依赖，仅用 Node.js 内置 fs 模块

// 状态目录的环境变量兜底通道（T02811）：宿主不给构造实参时用它，值同样必须是绝对路径。
export const STATE_DIR_ENV = 'WIKI_HARNESS_STATE_DIR';

// 目录解析口径（T02811）。
// 历史缺陷：构造参数默认值曾是相对路径 '.harness/state'，落点由**进程 CWD** 决定——
// 同一次运行从哪个目录起进程，状态就写进哪。主仓为此被咬过三次（api/.harness/state 攒了
// 107 个清理页报 0 的文件、验证脚本每跑一次在起脚本的目录留状态、包内测试在仓库根留状态），
// 每次都靠调用方逐个注入绕开，而「不注入就静默往 CWD 写」这条路一直留在包里，下一个使用者照踩。
// 现在的契约：目录只能由「显式实参 → 环境变量」给出，且必须是绝对路径；两者都没有即在构造期抛错。
// 宁可宿主启动即失败，也不要「写成功了但没人能读、没人能清」。
export function resolveStateDir(dir?: string): string {
  const raw = dir ?? process.env[STATE_DIR_ENV];
  if (!raw) {
    throw new Error(
      `FileStateStore 需要显式状态目录：构造时传入绝对路径，或设置环境变量 ${STATE_DIR_ENV}。` +
        '已取消「相对进程 CWD 的 .harness/state」隐式默认——那种落点随启动目录漂移，清理与续传都找不到它。',
    );
  }
  if (!path.isAbsolute(raw)) {
    throw new Error(
      `FileStateStore 状态目录必须是绝对路径，收到相对路径 "${raw}"（它按进程 CWD 展开，换目录起进程就换地方）。`,
    );
  }
  return raw;
}

export class FileStateStore implements StateStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = resolveStateDir(dir);
  }

  // 防 path traversal：runId 直接拼接到文件路径，非 UUID 值可能越权访问目录外文件
  private validateRunId(runId: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
      throw new Error(`Invalid runId format: ${runId}`);
    }
  }

  async save(runId: string, state: RunState): Promise<void> {
    this.validateRunId(runId);
    // 确保目录存在，recursive 模式幂等
    await fs.mkdir(this.dir, { recursive: true });
    const filePath = path.join(this.dir, `${runId}.json`);
    // 原子写入：先写临时文件再 rename，避免并发或写入中断产生半截 JSON 文件
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  async load(runId: string): Promise<RunState | null> {
    this.validateRunId(runId);
    const filePath = path.join(this.dir, `${runId}.json`);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as RunState & { messages?: Message[] };
      // §兼容性迁移：旧版图腾仅含 messages 无 events 时，按事件溯源重建事件序列，
      // 保证历史持久化状态在升级后仍可被 resume / 重放。
      if (!parsed.events && parsed.messages) {
        parsed.events = messagesToEvents(parsed.messages);
      }
      return parsed as RunState;
    } catch {
      // 文件不存在或解析失败均返回 null，调用方按无状态处理
      return null;
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.dir);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''));
    } catch {
      // 目录不存在时返回空数组
      return [];
    }
  }
}
