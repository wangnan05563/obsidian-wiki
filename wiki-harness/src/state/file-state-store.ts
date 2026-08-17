import type { StateStore, RunState, Message } from '../types.js';
import { messagesToEvents } from '../session/session-log.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// 文件系统状态存储：每个 run 一个 JSON 文件，便于断点恢复与调试
// 零依赖，仅用 Node.js 内置 fs 模块
export class FileStateStore implements StateStore {
  constructor(private dir: string = '.harness/state') {}

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
