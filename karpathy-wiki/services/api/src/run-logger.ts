import fs from 'node:fs/promises';
import path from 'node:path';

// §12.3-8 决策：harness 运行日志双写——控制台供 dev 实时查看，.harness/logs/ 供事后排查。
// log.md 是业务日志（用户视角），harness 日志是技术日志（开发者视角），分离避免语义混淆。
//
// 日志格式：JSONL（每行一个 JSON 对象），便于 grep 与程序化分析。
// 文件命名：{runId}.log，与 .harness/state/{runId}.json 对应。

export interface RunLogEntry {
  ts: string;          // ISO 时间戳
  runId: string;
  step: number;
  event: 'step' | 'done' | 'error';
  tool?: string;       // step 事件时填充
  tokenUsed?: number;
  message: string;
  error?: string;      // error 事件时填充
}

export class RunLogger {
  private readonly logDir: string;

  constructor(logDir: string) {
    this.logDir = logDir;
  }

  // 确保 .harness/logs/ 目录存在，幂等
  async ensureDir(): Promise<void> {
    await fs.mkdir(this.logDir, { recursive: true });
  }

  // 写入单条日志。控制台同时输出摘要，文件写入完整 JSONL。
  // 写文件失败不抛异常——日志不应阻断业务流程。
  async log(entry: RunLogEntry): Promise<void> {
    // 控制台摘要：[runId 短前缀] step N tool: msg
    const shortId = entry.runId.slice(0, 8);
    // 提取嵌套模板到变量，降低模板复杂度（S4624）
    const toolPart = entry.tool ? ` ${entry.tool}` : '';
    const consoleMsg = `[harness ${shortId}] step ${entry.step} ${entry.event}${toolPart}: ${entry.message}`;
    if (entry.event === 'error') {
      console.error(consoleMsg);
    } else {
      console.log(consoleMsg);
    }

    // 文件写入：JSONL 格式，append 模式
    try {
      await this.ensureDir();
      const filePath = path.join(this.logDir, `${entry.runId}.log`);
      await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // 日志写入失败不影响业务，仅控制台告警
      console.warn(`[harness] 日志文件写入失败，runId=${entry.runId}`);
    }
  }
}
