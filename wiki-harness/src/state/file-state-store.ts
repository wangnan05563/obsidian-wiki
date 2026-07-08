import type { StateStore, RunState } from '../types.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// 文件系统状态存储：每个 run 一个 JSON 文件，便于断点恢复与调试
// 零依赖，仅用 Node.js 内置 fs 模块
export class FileStateStore implements StateStore {
  constructor(private dir: string = '.harness/state') {}

  async save(runId: string, state: RunState): Promise<void> {
    // 确保目录存在，recursive 模式幂等
    await fs.mkdir(this.dir, { recursive: true });
    const filePath = path.join(this.dir, `${runId}.json`);
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  async load(runId: string): Promise<RunState | null> {
    const filePath = path.join(this.dir, `${runId}.json`);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as RunState;
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
