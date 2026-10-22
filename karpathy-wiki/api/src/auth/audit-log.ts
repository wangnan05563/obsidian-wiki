import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { AuditLogEntry, AuditAction } from './types.js';

// 审计日志模块
// 追加写入文件，记录所有权限相关操作（登录/登出/越权/用户管理）
// 为什么用文件追加而非数据库：本地优先应用，避免引入 DB 依赖
// 文件路径由 AuthConfig.auditLogPath 配置，默认 data/audit.log

// 日志文件句柄缓存：避免每次追加都重新打开文件
// 为什么单例：减少 fd 占用，追加写入天然串行
let logFilePath: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();

// T02782 保留窗口：审计日志只追加，但不是无界——写入侧按行数上限轮转，
// 超限保留最近 AUDIT_RETENTION_LINES 条（登录限流被触发时 429 也会写审计，
// 无上界会随时间无界增长，与「所有可增长产物都要有明确口径」的治理方向冲突）。
// 为什么写入侧轮转而非纳入 POST /api/cleanup：审计留痕不应依赖用户记得去清，
// 自动窗口让 data/audit.log 体积有可验证的上界；「整段清空」反而削弱审计价值。
export const AUDIT_RETENTION_LINES = 10_000;
// 字节快速闸（≈1 万条 × 300B 的余量）：未超闸不做读全文件的重活
const AUDIT_ROTATION_BYTES = 4 * 1024 * 1024;
// 检查按写入次数摊销：每次写入只递增计数，满 ROTATION_CHECK_EVERY 次才 stat 一次
const ROTATION_CHECK_EVERY = 200;
let writesSinceCheck = 0;

// 执行一次保留窗口检查（写入路径按计数摊销调用；测试可直接调）。
// 返回是否实际发生了轮转。
export async function enforceAuditRetention(maxLines: number = AUDIT_RETENTION_LINES): Promise<boolean> {
  if (!logFilePath) return false;
  try {
    const stat = await fs.stat(logFilePath);
    if (stat.size < AUDIT_ROTATION_BYTES) return false;
    const content = await fs.readFile(logFilePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length <= maxLines) return false;
    const kept = lines.slice(-maxLines).join('\n') + '\n';
    await fs.writeFile(logFilePath, kept, 'utf8');
    return true;
  } catch (err) {
    // 轮转失败不阻断写入主流程（下轮写入计数归零后还会再查）
    console.error('[audit] 保留窗口轮转失败:', err);
    return false;
  }
}

// 初始化审计日志文件路径（确保目录存在）
export async function initAuditLog(filePath: string): Promise<void> {
  logFilePath = filePath;
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // 目录已存在或无权限，忽略
  }
  // 触摸文件确保存在（首次启动时创建空文件）
  if (!fsSync.existsSync(filePath)) {
    await fs.writeFile(filePath, '', 'utf8');
  }
}

// 写入审计日志条目
// 为什么用队列：避免并发追加导致日志行交错
// 为什么 JSON 行：每行一个 JSON 对象（JSONL 格式），便于后续解析
export function writeAuditLog(entry: AuditLogEntry): void {
  if (!logFilePath) {
    // 未初始化时降级到 console（不阻断主流程）
    console.warn('[audit] 未初始化日志文件，降级到 console:', JSON.stringify(entry));
    return;
  }
  // 串行化追加：每个写入操作等待前一个完成
  writeQueue = writeQueue.then(async () => {
    try {
      const line = JSON.stringify(entry) + '\n';
      await fs.appendFile(logFilePath!, line, 'utf8');
      // T02782：摊销式保留窗口检查
      if (++writesSinceCheck >= ROTATION_CHECK_EVERY) {
        writesSinceCheck = 0;
        await enforceAuditRetention();
      }
    } catch (err) {
      console.error('[audit] 写入审计日志失败:', err);
    }
  });
}

// 构建审计日志条目（统一字段格式）
export function createAuditEntry(params: {
  userId: string | null;
  username: string | null;
  action: AuditAction;
  resource: string;
  ip: string;
  result: 'success' | 'fail';
  message?: string;
}): AuditLogEntry {
  return {
    ts: new Date().toISOString(),
    userId: params.userId,
    username: params.username,
    action: params.action,
    resource: params.resource,
    ip: params.ip,
    result: params.result,
    message: params.message,
  };
}

// 读取审计日志（管理员查看）
// 为什么限制行数：避免大日志文件导致内存溢出
export async function readAuditLog(filePath: string, maxLines: number = 1000): Promise<AuditLogEntry[]> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    // 取最后 maxLines 行（最新的记录）
    const recentLines = lines.slice(-maxLines);
    const entries: AuditLogEntry[] = [];
    for (const line of recentLines) {
      try {
        entries.push(JSON.parse(line) as AuditLogEntry);
      } catch {
        // 跳过解析失败的行（可能是写入中断导致的不完整行）
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// 等待所有挂起的写入完成（测试用）
export async function flushAuditLog(): Promise<void> {
  await writeQueue;
}

// 重置模块状态（测试用）
export function resetAuditLog(): void {
  logFilePath = null;
  writeQueue = Promise.resolve();
  writesSinceCheck = 0;
}
