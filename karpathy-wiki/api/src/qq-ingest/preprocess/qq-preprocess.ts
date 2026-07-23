// QQ 聊天记录预清洗模块（SRS §5.1 环节1）。
// 物理位置调整说明：SRS §3.3 设计为项目根 qq-ingest/preprocess/，通过 tsconfig paths 映射。
// 实际放置在 api/src/qq-ingest/preprocess/ 以避免 tsx 运行时 paths 解析不可靠的问题，
// 同时保持与 routes/vault/auth 等模块平级的源码结构。SRS §3.3 的 qq-ingest/ 目录仍保留
// 用于存放规格文档（SRS.md/REVIEW.md）与 prompt 模板（qq-extract.md）。

import crypto from 'node:crypto';
import type { QqConfig, QqPreprocessResult } from '../../types.js';
// ============================================================================
// 常量定义
// ============================================================================

// PII 脱敏替换标记（强制不可关闭，SRS §5.1.3）
// 为什么用 [REDACTED-XXX] 而非 ***：保留类型信息便于审核与调试，同时 LLM 无法逆向还原
const PII_REPLACEMENTS: Record<string, string> = {
  phone: '[REDACTED-PHONE]',
  id_card: '[REDACTED-ID]',
  email: '[REDACTED-EMAIL]',
  card: '[REDACTED-CARD]',
  qq: '[REDACTED-QQ]',
};

// 噪声规则关键词（与 config.qq.noise_rules 配合使用）
// NR-1: 纯表情/图片占位符——QQ 客户端渲染图片/表情时的占位文本
const NR1_PLACEHOLDER_PATTERNS = /^\[(图片|表情|动画表情|语音|视频|文件|红包|转账)\]$/;
// NR-2: 短回应——<5 字且不含 ? ! （避免过滤掉"什么是 X?"这类有价值疑问句）
const NR2_SHORT_THRESHOLD = 5;
// NR-3: 系统消息关键词——QQ 群事件通知
const NR3_SYSTEM_KEYWORDS = ['撤回了', '加入了', '退出了', '修改了群名', '被禁言', '被踢出', '成为了管理员', '取消了管理员'];
// NR-4: 纯链接消息——整条匹配 http(s)://
const NR4_LINK_PATTERN = /^https?:\/\/\S+$/;
// NR-5: 纯数字/纯标点——无信息量
const NR5_PURE_NUMBER_OR_PUNCT = /^[\d\s\p{P}]+$/u;
// NR-6: 重复刷屏——同一发言人连续相同内容阈值
const NR6_REPEAT_THRESHOLD = 5;

// ============================================================================
// 内部类型定义
// ============================================================================

// 归一化后的消息结构（无论 JSON 还是 TXT 输入，统一为此格式后再过滤/脱敏）
interface NormalizedMessage {
  // ISO8601 时间戳（原始 "2026-07-20 14:30:15" 转换为 "2026-07-20T14:30:15Z"）
  ts: string;
  // 发言人昵称（脱敏前保留原值，脱敏阶段处理 PII）
  speaker: string;
  // 消息正文
  content: string;
  // 消息类型：text 保留，image/file/system 通常被 NR-1/NR-3 过滤
  type: string;
}

// 预清洗中间格式（SRS §5.1.4，落盘到 vault/raw/）
interface PreprocessOutput {
  meta: {
    source: 'qq-chat';
    chatName: string;
    dateRange: string;
    originalCount: number;
    filteredCount: number;
    redactedCount: number;
  };
  // 分块后的消息数组（每块独立供 LLM 抽取，SRS §5.2.1a）
  chunks: NormalizedMessage[][];
}

// ============================================================================
// 输入格式解析
// ============================================================================

// 解析 QQ 自带消息管理器导出的 TXT 格式（SRS §5.1.1）
// 格式：每条消息由"时间戳行"+"正文行"组成，时间戳行格式：
//   2026-07-20 14:30:15 张三<xxx@qq.com>
// 为什么用正则而非 split：时间戳格式固定，正则一次性提取 ts/speaker/email 更可靠
const TXT_LINE_PATTERN = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+([^<]+)(?:<([^>]+)>)?$/;

function parseTxtFormat(rawText: string): { chatName: string; messages: NormalizedMessage[] } {
  const lines = rawText.split(/\r?\n/);
  const messages: NormalizedMessage[] = [];
  let chatName = 'unknown-chat';
  let currentMsg: NormalizedMessage | null = null;
  let hasParsedHeader = false;

  // 闭包封装"开始新消息"逻辑，降低 parseTxtFormat 认知复杂度（S3776）
  // 为什么用闭包而非独立函数：需修改多个外层 let 变量（currentMsg/chatName/hasParsedHeader），
  //   独立函数需传 state 对象，闭包更简洁
  const startNewMessage = (match: RegExpExecArray, i: number) => {
    // 新消息开始：先保存上一条
    if (currentMsg) {
      messages.push(currentMsg);
    }
    currentMsg = createMessageFromMatch(match);
    // 尝试从首条消息前的注释行解析群名（仅一次）
    if (!hasParsedHeader && i > 0) {
      const name = tryParseChatName(lines[i - 1]);
      if (name) chatName = name;
      hasParsedHeader = true;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 用 RegExp.exec 替代 String.match：语义更明确，且 exec 返回 RegExpExecArray | null（S6594）
    const match = TXT_LINE_PATTERN.exec(line);
    if (match) {
      startNewMessage(match, i);
    } else if (currentMsg) {
      // 正文行：追加到当前消息（多条正文行用 \n 连接）
      appendContentLine(currentMsg, line);
    }
  }
  // 保存最后一条
  if (currentMsg) {
    messages.push(currentMsg);
  }

  return { chatName, messages };
}

// 从正则匹配结果构造新消息（时间戳重组为 ISO8601）
// 提取为独立函数降低 parseTxtFormat 认知复杂度（S3776）
function createMessageFromMatch(match: RegExpExecArray): NormalizedMessage {
  // 重新组装 ISO8601 时间戳（原始 "2026-07-20 14:30:15" → "2026-07-20T14:30:15Z"）
  // 为什么加 Z：QQ 导出时间默认本地时区，统一标记 Z 便于后续按日切分；
  //   实际时区偏差不影响分块正确性（同一天的消息仍在同一块）
  const ts = match[1].replace(/\s+/, 'T') + 'Z';
  return {
    ts,
    speaker: match[2].trim(),
    content: '',
    type: 'text',
  };
}

// 从 headerLine 解析群名（QQ 导出文件首行格式："xxx 聊天记录"）
// 提取为独立函数降低 parseTxtFormat 认知复杂度（S3776）
function tryParseChatName(headerLine: string): string | null {
  const chatMatch = /^(.+?)\s+(?:聊天记录|消息记录)/.exec(headerLine);
  return chatMatch ? chatMatch[1].trim() : null;
}

// 追加正文行到当前消息：已有内容用 \n 连接
// 提取为独立函数降低 parseTxtFormat 认知复杂度（S3776）
function appendContentLine(msg: NormalizedMessage, line: string): void {
  if (msg.content) {
    msg.content += '\n' + line;
  } else {
    msg.content = line;
  }
}

// 解析 qq-chat-exporter 等工具产出的 JSON 格式（SRS §5.1.1）
function parseJsonFormat(rawText: string): { chatName: string; messages: NormalizedMessage[] } {
  const parsed = JSON.parse(rawText) as {
    meta?: { chatName?: string };
    messages?: Array<{
      timestamp: string;
      speaker: string;
      type?: string;
      content: string;
    }>;
  };

  if (!parsed.messages || !Array.isArray(parsed.messages)) {
    throw new Error('QQ JSON 输入缺少 messages 数组');
  }

  const chatName = parsed.meta?.chatName ?? 'unknown-chat';
  const messages: NormalizedMessage[] = parsed.messages.map((m) => ({
    // JSON 格式时间戳可能是 "2026-07-20 14:30:15" 或 ISO8601，统一处理
    ts: normalizeTimestamp(m.timestamp),
    speaker: m.speaker,
    content: m.content,
    type: m.type ?? 'text',
  }));

  return { chatName, messages };
}

// 时间戳归一化：将 "2026-07-20 14:30:15" 转为 ISO8601 "2026-07-20T14:30:15Z"
// 已是 ISO8601 的直接返回（假设含 T 标记）
function normalizeTimestamp(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('T')) {
    return trimmed;
  }
  // "2026-07-20 14:30:15" → "2026-07-20T14:30:15Z"
  return trimmed.replace(/\s+/, 'T') + 'Z';
}

// ============================================================================
// 噪声过滤（SRS §5.1.2）
// ============================================================================

// NR-6 重复刷屏检测：同一发言人连续 NR6_REPEAT_THRESHOLD 条相同内容
// 提取为独立函数降低 isNoise 认知复杂度（S3776）
function isRepeatSpam(
  content: string,
  recentSpeakerMsgs: Map<string, string[]>,
  speaker: string,
): boolean {
  const recent = recentSpeakerMsgs.get(speaker) ?? [];
  // 最近一条与本条不同，不构成连续刷屏
  if (recent.at(-1) !== content) return false;
  // 连续计数：从末尾向前数连续相同内容的条数
  let consecutiveCount = 1;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i] !== content) break;
    consecutiveCount++;
    if (consecutiveCount >= NR6_REPEAT_THRESHOLD) return true;
  }
  return false;
}

// 判断单条消息是否应被过滤（返回 true 表示是噪声）
function isNoise(msg: NormalizedMessage, config: QqConfig, recentSpeakerMsgs: Map<string, string[]>): boolean {
  const rules = config.noise_rules;
  const content = msg.content.trim();

  // 空内容直接过滤（不属于 NR 规则，但无价值）
  if (!content) return true;

  // NR-1: 纯表情/图片占位符
  if (rules['NR-1'] && NR1_PLACEHOLDER_PATTERNS.test(content)) return true;

  // NR-2: 短回应（<5 字且不含 ? ! ？ ！）
  if (rules['NR-2'] && content.length < NR2_SHORT_THRESHOLD && !/[?!？！]/.test(content)) return true;

  // NR-3: 系统消息
  if (rules['NR-3'] && NR3_SYSTEM_KEYWORDS.some((kw) => content.includes(kw))) return true;

  // NR-4: 纯链接消息
  if (rules['NR-4'] && NR4_LINK_PATTERN.test(content)) return true;

  // NR-5: 纯数字/纯标点
  if (rules['NR-5'] && NR5_PURE_NUMBER_OR_PUNCT.test(content)) return true;

  // NR-6: 重复刷屏（同一发言人连续 5 条相同内容）
  if (rules['NR-6'] && isRepeatSpam(content, recentSpeakerMsgs, msg.speaker)) return true;

  return false;
}

// ============================================================================
// PII 脱敏（SRS §5.1.3，强制不可关闭）
// ============================================================================

// 编译配置中的正则字符串为 RegExp，编译失败的规则跳过并记录
// 为什么 try/catch：用户可能在 config.json 中配置错误正则，不应阻塞整条流水线
function compilePrivacyPatterns(patterns: Record<string, string>): Array<{ name: string; regex: RegExp }> {
  const compiled: Array<{ name: string; regex: RegExp }> = [];
  for (const [name, pattern] of Object.entries(patterns)) {
    try {
      compiled.push({ name, regex: new RegExp(pattern, 'gu') });
    } catch (err) {
      // 正则编译失败：跳过该规则，记录到 stderr（不打断主流程）
      // 为什么用 console.error 而非 throw：单条规则失败不应阻塞脱敏，部分脱敏优于完全无脱敏
      console.error(`[qq-preprocess] privacy_pattern "${name}" 编译失败，已跳过: ${(err as Error).message}`);
    }
  }
  return compiled;
}

// 对单条文本执行 PII 脱敏，返回脱敏后文本与是否触发脱敏的标志
function redactPii(text: string, compiledPatterns: Array<{ name: string; regex: RegExp }>): { redacted: string; changed: boolean } {
  let result = text;
  let changed = false;
  for (const { name, regex } of compiledPatterns) {
    const replacement = PII_REPLACEMENTS[name] ?? '[REDACTED]';
    // 重置 lastIndex（g 标志的 RegExp 复用时需手动重置）
    regex.lastIndex = 0;
    const newResult = result.replace(regex, replacement);
    if (newResult !== result) {
      changed = true;
      result = newResult;
    }
  }
  return { redacted: result, changed };
}

// ============================================================================
// 长文本分块（SRS §5.2.1a）
// ============================================================================

// 通用分组函数：按 keyFn 提取的 key 将 items 分组到 Map
// 提取为独立函数降低 chunkByTimeWindow 认知复杂度（S3776），同时复用于按日/按小时分组
function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return groups;
}

// 按时间窗口分块：默认按自然日切分，单日超过阈值再按小时切分
// 为什么时间窗口优先话题聚类：时间窗口实现简单且符合群聊自然节奏，话题聚类需 M2+ 迭代
function chunkByTimeWindow(messages: NormalizedMessage[], threshold: number): NormalizedMessage[][] {
  if (messages.length === 0) return [];
  if (messages.length <= threshold) return [messages];

  const chunks: NormalizedMessage[][] = [];
  // 第一层：按自然日分组（提取日期部分 "2026-07-20T..." → "2026-07-20"）
  const byDay = groupBy(messages, (msg) => msg.ts.slice(0, 10));

  // 第二层：单日超过阈值再按小时切分
  for (const [, dayMsgs] of byDay) {
    if (dayMsgs.length <= threshold) {
      chunks.push(dayMsgs);
    } else {
      // 提取到小时 "2026-07-20T14..." → "2026-07-20T14"
      const byHour = groupBy(dayMsgs, (msg) => msg.ts.slice(0, 13));
      for (const [, hourMsgs] of byHour) {
        // 极端情况：单小时仍超阈值，按 threshold 强制切片（避免单块过大）
        for (let i = 0; i < hourMsgs.length; i += threshold) {
          chunks.push(hourMsgs.slice(i, i + threshold));
        }
      }
    }
  }

  return chunks;
}

// ============================================================================
// 主函数
// ============================================================================

// 预清洗输出数据（不含 rawPath，由路由层调用 vault.archiveRaw 落盘后填入）
// 为什么不在 preprocessQqChat 内直接落盘：VaultService 是 vault 写入的唯一入口，
// 直接写文件会绕过路径越界校验与白名单约束（硬约束：路径解析禁用 CWD + 白名单）
export interface PreprocessOutputData {
  // 预清洗结果（rawPath 字段留空，由路由层填入）
  result: Omit<QqPreprocessResult, 'rawPath'>;
  // 落盘的 JSON 内容（中间格式，SRS §5.1.4）
  jsonContent: string;
  // 落盘文件名（如 "qq-群名-2026-07-01~2026-07-20.json"）
  rawFileName: string;
}

// 预清洗主入口：解析 → 过滤 → 脱敏 → 分块 → 构造输出
// 参数：
//   rawText: 原始文件内容（.txt 或 .json 文本）
//   fileName: 原始文件名（用于 chatName 兜底）
//   config: QQ 子系统配置
// 返回：PreprocessOutputData（含 result/jsonContent/rawFileName，由路由层负责落盘）
export async function preprocessQqChat(
  rawText: string,
  fileName: string,
  config: QqConfig,
): Promise<PreprocessOutputData> {
  // 1. 格式检测与解析
  let chatName: string;
  let messages: NormalizedMessage[];
  try {
    // 优先尝试 JSON 解析（qq-chat-exporter 格式）
    const trimmed = rawText.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const result = parseJsonFormat(rawText);
      chatName = result.chatName;
      messages = result.messages;
    } else {
      throw new Error('非 JSON 格式，回退到 TXT 解析');
    }
  } catch {
    // JSON 解析失败，回退到 TXT 格式（QQ 自带消息管理器）
    const result = parseTxtFormat(rawText);
    chatName = result.chatName;
    messages = result.messages;
  }

  // 兜底：若解析后 chatName 仍为 unknown，使用文件名（去扩展名）
  if (chatName === 'unknown-chat') {
    chatName = fileName.replace(/\.(txt|json)$/i, '');
  }

  const originalCount = messages.length;

  // 2. 噪声过滤
  // recentSpeakerMsgs: 跟踪每个发言人最近的内容（用于 NR-6 重复刷屏检测）
  const recentSpeakerMsgs = new Map<string, string[]>();
  const filteredMessages: NormalizedMessage[] = [];

  for (const msg of messages) {
    if (!isNoise(msg, config, recentSpeakerMsgs)) {
      filteredMessages.push(msg);
    }
    // 更新发言人最近消息队列（无论是否被过滤，都用于 NR-6 连续性判断）
    // 为什么过滤的也记录：NR-6 检测的是"连续相同内容"，被过滤的短回应不应打断连续性判断
    const recent = recentSpeakerMsgs.get(msg.speaker) ?? [];
    recent.push(msg.content);
    // 仅保留最近 NR6_REPEAT_THRESHOLD 条，避免内存膨胀
    if (recent.length > NR6_REPEAT_THRESHOLD * 2) {
      recent.splice(0, recent.length - NR6_REPEAT_THRESHOLD * 2);
    }
    recentSpeakerMsgs.set(msg.speaker, recent);
  }

  // 3. PII 脱敏
  const compiledPatterns = compilePrivacyPatterns(config.privacy_patterns);
  let redactedCount = 0;
  const redactedMessages = filteredMessages.map((msg) => {
    const { redacted, changed } = redactPii(msg.content, compiledPatterns);
    if (changed) redactedCount++;
    return { ...msg, content: redacted };
  });

  // 4. 长文本分块
  const chunks = chunkByTimeWindow(redactedMessages, config.chunk_threshold);

  // 5. 构造输出（不落盘，由路由层调用 vault.archiveRaw）
  const dateRange = computeDateRange(redactedMessages);
  const rawId = crypto.randomUUID();
  // 落盘文件名：qq-<chatName>-<dateRange>.json，chatName 中的非法字符替换为 _
  // 为什么允许中文：vault.archiveRaw 会做 basename + 白名单过滤，此处仅处理文件系统非法字符
  const safeChatName = chatName.replaceAll(/[^\w\u4e00-\u9fa5-]/g, '_');
  const rawFileName = `qq-${safeChatName}-${dateRange}.json`;

  const meta = {
    chatName,
    dateRange,
    originalCount,
    filteredCount: filteredMessages.length,
    redactedCount,
  };

  const output: PreprocessOutput = {
    meta: {
      source: 'qq-chat',
      ...meta,
    },
    chunks,
  };

  return {
    result: { rawId, meta },
    jsonContent: JSON.stringify(output, null, 2),
    rawFileName,
  };
}

// 计算消息列表的时间范围 "YYYY-MM-DD~YYYY-MM-DD"
// 空列表返回 "unknown"
function computeDateRange(messages: NormalizedMessage[]): string {
  if (messages.length === 0) return 'unknown';
  // localeCompare 排序确保多语言日期字符串按本地化规则有序（S2871）
  const dates = messages.map((m) => m.ts.slice(0, 10)).sort((a, b) => a.localeCompare(b));
  const start = dates[0];
  // 用 at(-1) 替代 [length-1] 避免 off-by-one 与可读性问题（S7755）
  const end = dates.at(-1);
  return start === end ? start : `${start}~${end}`;
}

// ============================================================================
// 输出脱敏（SRS §5.1.3 双向脱敏的"输出后"扫描）
// ============================================================================

// 对 LLM 抽取结果执行二次脱敏扫描，防止 LLM 记忆还原 PII
// 为什么需要：LLM 可能从上下文记忆中还原脱敏前的 PII，输出前必须再次扫描
export function redactExtractOutput(text: string, config: QqConfig): string {
  const compiled = compilePrivacyPatterns(config.privacy_patterns);
  const { redacted } = redactPii(text, compiled);
  return redacted;
}
