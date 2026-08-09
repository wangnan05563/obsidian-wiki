// QQ 聊天记录预清洗模块（SRS §5.1 环节1）。
// 物理位置调整说明：SRS §3.3 设计为项目根 qq-ingest/preprocess/，通过 tsconfig paths 映射。
// 实际放置在 api/src/qq-ingest/preprocess/ 以避免 tsx 运行时 paths 解析不可靠的问题，
// 同时保持与 routes/vault/auth 等模块平级的源码结构。SRS §3.3 的 qq-ingest/ 目录仍保留
// 用于存放规格文档（SRS.md/REVIEW.md）与 prompt 模板（qq-extract.md）。

import crypto from 'node:crypto';
import type { QqConfig, QqPreprocessResult } from '../../types.js';
// 复用 office-convert 的 zip 解压与 entity 解码，避免在本模块重复实现
import { parseZip, decodeXmlEntities } from '../../utils/office-convert.js';
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

// ============================================================================
// QQChatExporter V5+ 格式解析（第三方导出工具，字段式块状结构）
// 与 QQ 自带消息管理器的"时间戳+昵称"单行格式不同，QQChatExporter 采用
// "发送者:\n时间:\n内容:\n[可选字段:]" 的多行字段式结构，需独立解析器
// ============================================================================

// 检测是否为 QQChatExporter 格式
// 为什么需要独立检测：QQChatExporter 的字段式结构与自带导出器格式完全不同，
//   混用 parseTxtFormat 的单行正则会全部失配，导致消息数为 0
function isQqChatExporterFormat(rawText: string): boolean {
  // V5+ 文件头标识行（最可靠的特征）
  if (/^\[QQChatExporter\s/i.test(rawText.trim())) return true;
  // 兜底：同时含"聊天名称:"头字段与"时间:"消息字段（无文件头标识的变体）
  // 冒号支持英文 : 与中文 ：（QQChatExporter 部分版本/系统用中文冒号）
  const hasChatName = /^聊天名称[:：]\s*\S/m.test(rawText);
  const hasTimeField = /^时间[:：]\s*\d{4}-\d{2}-\d{2}/m.test(rawText);
  return hasChatName && hasTimeField;
}

// QQChatExporter V5+ 字段名集合（遇到这些字段行不视为发送者名）
// 为什么需要：发送者行格式为"昵称:"，与字段行"时间:"/"内容:"结构相同，
//   必须用已知字段名排除，否则会把字段行误识别为发送者
const QQCE_FIELD_NAMES = new Set([
  '时间', '内容', '提及', '回复', '资源', // 消息块字段
  '聊天名称', '聊天类型', '导出时间', '消息总数', '时间范围', // 文件头字段
]);

// 在 QQChatExporter 格式中，从时间行上方最近的非空行提取发送者
// 提取为独立函数降低 parseQqChatExporterFormat 认知复杂度（S3776）
function findQqceSpeaker(lines: string[], timeIndex: number): string {
  for (let j = timeIndex - 1; j >= 0; j--) {
    const prev = lines[j].trim();
    if (!prev) continue;
    const speakerMatch = /^(.+?)[:：]\s*$/.exec(prev);
    if (speakerMatch) {
      const name = speakerMatch[1].trim();
      if (!QQCE_FIELD_NAMES.has(name)) {
        return name;
      }
    }
    break; // 只看时间行上方最近的非空行
  }
  return 'unknown';
}

// 跳过资源字段后的缩进详情行（"  - image: xxx"）
// 提取为独立函数降低 collectQqceContent 认知复杂度（S3776）
function skipQqceResourceDetailLines(lines: string[], startIndex: number): number {
  let j = startIndex;
  while (j + 1 < lines.length && /^\s+-\s/.test(lines[j + 1])) {
    j++;
  }
  return j;
}

// 检测当前行是否为下一条消息的发送者行（"昵称:" 空值）
// 提取为独立函数降低 collectQqceContent 认知复杂度（S3776）
function isQqceNextSpeakerLine(line: string): boolean {
  const speakerMatch = /^(.+?)[:：]\s*$/.exec(line);
  return speakerMatch ? !QQCE_FIELD_NAMES.has(speakerMatch[1].trim()) : false;
}

// 在 QQChatExporter 格式中，从时间行下方收集消息内容
// 提取为独立函数降低 parseQqChatExporterFormat 认知复杂度（S3776）
function collectQqceContent(lines: string[], // NOSONAR - 参数过多是函数签名要求
  timeIndex: number): string {
  const CONTENT_PATTERN = /^内容[:：]\s*(.*)$/;
  let content = '';
  let contentStarted = false;
  for (let j = timeIndex + 1; j < lines.length; j++) {
    const nextTrimmed = lines[j].trim();
    if (!nextTrimmed) break; // 空行结束消息

    const contentMatch = CONTENT_PATTERN.exec(nextTrimmed);
    if (contentMatch && !contentStarted) {
      content = contentMatch[1];
      contentStarted = true;
      continue;
    }

    // 已知字段行（提及/回复/资源等）：跳过
    const fieldMatch = /^([^:：]+?)[:：]\s*(.*)$/.exec(nextTrimmed);
    if (fieldMatch && QQCE_FIELD_NAMES.has(fieldMatch[1].trim())) {
      // 资源字段后跟缩进详情行（"  - image: xxx"），一并跳过
      if (fieldMatch[1].trim() === '资源') {
        j = skipQqceResourceDetailLines(lines, j);
      }
      continue;
    }

    // 已开始收集内容且当前行非字段行：视为内容续行（多行消息）
    if (contentStarted) {
      // 检测下一个消息的发送者行（"昵称:" 空值），避免吞入下一条
      if (isQqceNextSpeakerLine(nextTrimmed)) {
        break;
      }
      content += '\n' + nextTrimmed;
      continue;
    }

    // 未开始收集内容就遇到非字段行：停止（通常是下一条消息的发送者）
    break;
  }
  return content;
}

// 解析 QQChatExporter V5+ 格式
// 策略：用"时间: YYYY-MM-DD HH:MM:SS"行作为消息锚点（格式固定唯一），
//   向上找最近的"昵称:"行作为发送者，向下找"内容:"行作为正文
// 为什么用时间行作锚点而非状态机：时间行格式唯一不会与昵称/内容混淆，
//   状态机方案在遇到含冒号的正文或文件头标识行时易误判
function parseQqChatExporterFormat(rawText: string): { chatName: string; messages: NormalizedMessage[] } {
  const lines = rawText.split(/\r?\n/);
  const messages: NormalizedMessage[] = [];
  let chatName = 'unknown-chat';

  // 1. 从文件头提取 chatName（"聊天名称: xxx"）
  for (const line of lines) {
    const m = /^聊天名称[:：]\s*(.+)$/.exec(line.trim());
    if (m) {
      chatName = m[1].trim();
      break;
    }
  }

  // 2. 用"时间:"行作为消息锚点逐条解析
  for (let i = 0; i < lines.length; i++) {
    const timeMatch = /^时间[:：]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/.exec(lines[i].trim());
    if (!timeMatch) continue;

    const ts = timeMatch[1];
    const speaker = findQqceSpeaker(lines, i);
    const content = collectQqceContent(lines, i);

    // 仅保留有内容的消息（纯图片/纯系统消息 content 为空，由噪声过滤统一处理）
    if (content.trim()) {
      messages.push({
        ts: normalizeTimestamp(ts),
        speaker,
        content,
        type: 'text',
      });
    }
  }

  return { chatName, messages };
}

function parseTxtFormat(rawText: string): { chatName: string; messages: NormalizedMessage[] } {
  // 优先检测 QQChatExporter V5+ 格式（字段式块状结构），命中则用专用解析器
  // 为什么在 parseTxtFormat 内分发：主函数 preprocessQqChat 将非 JSON 文本统一回退到此，
  //   在此分发可避免改动主函数控制流，且语义上"TXT 格式有多种变体，由 parseTxtFormat 负责识别"
  if (isQqChatExporterFormat(rawText)) {
    return parseQqChatExporterFormat(rawText);
  }

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
// HTML 格式解析（qq-chat-exporter 等工具的 HTML 导出）
// ============================================================================

// 从 Html 剥离后的文本行中提取时间戳后的 speaker 和初始 content
// 提取为独立函数降低 parseHtmlFormat 认知复杂度（S3776）
function parseHtmlSpeakerAndContent(trimmed: string, tsMatch: RegExpExecArray): { speaker: string; initialContent: string } {
  const after = trimmed.slice(tsMatch.index + tsMatch[0].length).trim();
  const speakerMatch = /^([^<]+)(?:<([^>]+)>)?/.exec(after);
  const speaker = speakerMatch?.[1]?.trim() || 'unknown';
  const initialContent = speakerMatch ? after.slice(speakerMatch[0].length).trim() : '';
  return { speaker, initialContent };
}

// 解析 qq-chat-exporter 等工具导出的 HTML 格式
// 为什么不依赖具体 HTML 模板：QQ 导出工具的 HTML 模板可能变化，
//   用"剥离标签 → 按时间戳切分"的通用策略保持兼容性
function parseHtmlFormat(rawText: string): { chatName: string; messages: NormalizedMessage[] } {
  // 1. 移除 script/style/注释块（避免 JS/CSS 干扰文本提取）
  const cleaned = rawText
    .replace(/<script[^]*?<\/script>/gi, '')
    .replace(/<style[^]*?<\/style>/gi, '')
    .replace(/<!--[^]*?-->/g, '');

  // 2. 从 <title> 提取 chatName 兜底
  // 为什么复用 tryParseChatName：QQ 导出 HTML 的 title 通常是 "群名 聊天记录" 格式，
  //   与 TXT 首行格式一致，复用同一解析逻辑保持 chatName 风格统一
  let chatName = 'unknown-chat';
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(cleaned);
  if (titleMatch?.[1]?.trim()) {
    const titleName = tryParseChatName(titleMatch[1].trim());
    chatName = titleName ?? titleMatch[1].trim();
  }

  // 3. 剥离所有标签：块级元素结尾换行（让不同消息天然分行），其他标签直接移除
  // 为什么不解析 DOM：避免引入 cheerio/jsdom 依赖，纯文本提取对消息结构足够
  // 为什么 span 等内联元素结尾不换行：内联元素通常是时间戳/发言人/内容的容器，
  //   若每个都换行会让时间戳行缺 speaker，破坏后续 speaker 提取；合并到同一行可保留
  //   "时间戳 speaker content" 的可识别结构
  const textOnly = cleaned
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|article|section|ul|ol|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const decoded = decodeXmlEntities(textOnly);

  // 4. 按时间戳切分消息：时间戳行后到下个时间戳前的所有行作为一条消息
  // 为什么不直接复用 parseTxtFormat：HTML 剥离后时间戳可能独占一行（无 speaker），
  //   不匹配 TXT_LINE_PATTERN 的 "时间戳 + 空格 + speaker<email>" 完整格式；
  //   用宽松策略：检测含时间戳的行作为消息起点，时间戳后的非空文本依次为 speaker/content
  const lines = decoded.split(/\r?\n/);
  const messages: NormalizedMessage[] = [];
  let currentMsg: NormalizedMessage | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const tsMatch = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/.exec(trimmed);
    if (tsMatch) {
      // 新消息开始：先保存上一条
      if (currentMsg) messages.push(currentMsg);
      const ts = tsMatch[1].replace(/\s+/, 'T') + 'Z';
      const { speaker, initialContent } = parseHtmlSpeakerAndContent(trimmed, tsMatch);
      currentMsg = { ts, speaker, content: initialContent, type: 'text' };
    } else if (currentMsg) {
      // 非时间戳行：追加到当前消息 content（已有内容用 \n 连接，与 TXT 模式一致）
      currentMsg.content = currentMsg.content
        ? currentMsg.content + '\n' + trimmed
        : trimmed;
    }
    // 时间戳前的行（无 currentMsg）跳过：通常是页面导航/标题
  }
  if (currentMsg) messages.push(currentMsg);

  // 5. 若按时间戳切分无结果（页面结构特殊），回退到 TXT 解析（容错兜底）
  if (messages.length === 0) {
    return parseTxtFormat(decoded);
  }
  return { chatName, messages };
}

// ============================================================================
// Excel(.xlsx) 格式解析（qq-chat-exporter 等工具的 Excel 导出）
// ============================================================================

// 列字母转数字（A=0, B=1, ..., AA=26）
function colToNumber(colStr: string): number {
  let num = 0;
  for (const ch of colStr) {
    num = num * 26 + (ch.codePointAt(0)! - 65);
  }
  return num;
}

// 解析 xlsx 共享字符串表（sharedStrings.xml），返回索引→文本映射
// 提取为独立函数降低 parseXlsxFormat 认知复杂度（S3776）
function parseXlsxSharedStrings(entries: Map<string, Buffer>): Map<number, string> {
  const stringCache = new Map<number, string>();
  const ssBuffer = entries.get('xl/sharedStrings.xml');
  if (!ssBuffer) return stringCache;

  const ssXml = ssBuffer.toString('utf8');
  const siRegex = /<si>([^]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;
  let idx = 0;
  while ((siMatch = siRegex.exec(ssXml)) !== null) {
    // 单个 si 可能含多个 <t>（富文本格式），拼接所有 <t> 内容
    const textParts = siMatch[1].match(/<t[^>]*>([^<]*)<\/t>/g) || [];
    let text = '';
    for (const t of textParts) {
      const m = />([^<]*)</.exec(t);
      if (m?.[1] !== undefined) text += m[1];
    }
    stringCache.set(idx++, decodeXmlEntities(text));
  }
  return stringCache;
}

// 从 xlsx 单元格 XML 中提取文本值
// 提取为独立函数降低 parseXlsxFormat 认知复杂度（S3776）
function parseXlsxCellValue(cellContent: string, cellType: string | undefined, stringCache: Map<number, string>): string {
  const vMatch = /<v>([^<]*)<\/v>/.exec(cellContent);
  if (vMatch?.[1] !== undefined) {
    if (cellType === 's') {
      // 共享字符串：用索引从 stringCache 取
      return stringCache.get(parseInt(vMatch[1], 10)) ?? vMatch[1];
    }
    return vMatch[1];
  }
  // 内联字符串（t="inlineStr" 或无 v 标签的纯文本）
  const inlineTMatch = /<t[^>]*>([^<]*)<\/t>/.exec(cellContent);
  if (inlineTMatch?.[1] !== undefined) {
    return decodeXmlEntities(inlineTMatch[1]);
  }
  return '';
}

// 从 sheetXml 中解析所有单元格，按行号分组返回
// 提取为独立函数降低 parseXlsxFormat 认知复杂度（S3776）
function parseXlsxCells(sheetXml: string, stringCache: Map<number, string>): Map<number, Array<{ col: number; value: string }>> {
  const rows = new Map<number, Array<{ col: number; value: string }>>();
  const cellRegex = /<c\b([^>]*)>([^]*?)<\/c>/g;
  let cellMatch: RegExpExecArray | null;
  while ((cellMatch = cellRegex.exec(sheetXml)) !== null) {
    const attrs = cellMatch[1];
    const cellContent = cellMatch[2];

    // 从属性串中分别提取 r="A1" 与 t="s"
    const rMatch = /\br="([A-Z]+)(\d+)"/.exec(attrs);
    if (!rMatch) continue;
    const colStr = rMatch[1];
    const rowNum = parseInt(rMatch[2], 10);
    const tMatch = /\bt="([^"]*)"/.exec(attrs);
    const cellType = tMatch ? tMatch[1] : undefined;
    const colNum = colToNumber(colStr);

    const value = parseXlsxCellValue(cellContent, cellType, stringCache);

    if (!rows.has(rowNum)) rows.set(rowNum, []);
    rows.get(rowNum)!.push({ col: colNum, value });
  }
  return rows;
}

// 检测 xlsx 第一行是否为表头，返回列映射和是否跳过表头
// 提取为独立函数降低 parseXlsxFormat 认知复杂度（S3776）
function detectXlsxHeader(sortedRows: Array<[number, Array<{ col: number; value: string }>]>): {
  colMap: { ts: number; speaker: number; content: number };
  headerSkipped: boolean;
} {
  const colMap: { ts?: number; speaker?: number; content?: number } = {};
  let headerSkipped = false;

  if (sortedRows.length > 0) {
    const firstRow = [...sortedRows[0][1]].sort((a, b) => a.col - b.col);
    firstRow.forEach((cell, idx) => {
      const v = cell.value.trim();
      if (/^(时间|timestamp|time|date|日期)$/i.test(v)) colMap.ts = idx;
      else if (/^(发送人|发言人|speaker|sender|user|昵称|name|名称)$/i.test(v)) colMap.speaker = idx;
      else if (/^(消息|内容|content|message|text|正文)$/i.test(v)) colMap.content = idx;
    });
    if (colMap.ts !== undefined || colMap.speaker !== undefined || colMap.content !== undefined) {
      headerSkipped = true;
    }
  }

  // 默认列序：[timestamp, speaker, content]
  if (colMap.ts === undefined) colMap.ts = 0;
  if (colMap.speaker === undefined) colMap.speaker = 1;
  if (colMap.content === undefined) colMap.content = 2;

  return { colMap: colMap as { ts: number; speaker: number; content: number }, headerSkipped };
}

// 解析 xlsx：ZIP 包内含 sharedStrings.xml + worksheets/sheet1.xml
// 表头识别 [时间/发送人/消息]，未识别时按 [timestamp, speaker, content] 顺序假设
async function parseXlsxFormat(buffer: Buffer): Promise<{ chatName: string; messages: NormalizedMessage[] }> {
  const entries = await parseZip(buffer);

  // 1. 读取共享字符串表（xlsx 中字符串统一存于此，单元格内只存索引）
  const stringCache = parseXlsxSharedStrings(entries);

  // 2. 读取工作簿 sheet 列表，第一个 sheet 名称作为 chatName 兜底
  const wbBuffer = entries.get('xl/workbook.xml');
  if (!wbBuffer) {
    throw new Error('xlsx 文件缺少 xl/workbook.xml，可能不是标准 Excel 格式');
  }
  const wbXml = wbBuffer.toString('utf8');
  const sheetMatch = /<sheet [^>]*name="([^"]*)"/.exec(wbXml);
  const chatName = sheetMatch ? sheetMatch[1] : 'unknown-chat';

  // 3. 读取第一个 sheet（QQ 导出通常单 sheet）
  const sheetBuf = entries.get('xl/worksheets/sheet1.xml');
  if (!sheetBuf) {
    return { chatName, messages: [] };
  }
  const sheetXml = sheetBuf.toString('utf8');

  // 4. 解析所有单元格，按行号分组
  const rows = parseXlsxCells(sheetXml, stringCache);

  // 5. 按行号排序，构造 NormalizedMessage[]
  const sortedRows = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  const { colMap, headerSkipped } = detectXlsxHeader(sortedRows);

  const messages: NormalizedMessage[] = [];
  for (let i = headerSkipped ? 1 : 0; i < sortedRows.length; i++) {
    const cells = [...sortedRows[i][1]].sort((a, b) => a.col - b.col);
    const ts = cells[colMap.ts]?.value?.trim();
    const speaker = cells[colMap.speaker]?.value?.trim();
    const content = cells[colMap.content]?.value?.trim();

    // 全空行跳过，避免噪声
    if (!ts && !speaker && !content) continue;

    messages.push({
      ts: normalizeTimestamp(ts || '1970-01-01 00:00:00'),
      speaker: speaker || 'unknown',
      content: content || '',
      type: 'text',
    });
  }

  return { chatName, messages };
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

// 根据文件后缀和内容自动选择解析器并执行
// 提取为独立函数降低 detectAndParseInput 认知复杂度（S3776）
async function dispatchFormatParse(
  input: Buffer | string,
  lowerName: string,
): Promise<{ chatName: string; messages: NormalizedMessage[] }> {
  if (lowerName.endsWith('.xlsx')) {
    const buffer = typeof input === 'string' ? Buffer.from(input, 'binary') : input;
    return await parseXlsxFormat(buffer);
  } else if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
    const rawText = typeof input === 'string' ? input : input.toString('utf8');
    return parseHtmlFormat(rawText);
  }
  const rawText = typeof input === 'string' ? input : input.toString('utf8');
  const trimmed = rawText.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseJsonFormat(rawText);
  }
  throw new Error('非 JSON 格式，回退到 TXT 解析');
}

// 根据文件后缀和内容自动检测格式并解析，返回 chatName 和消息列表
// 提取为独立函数降低 preprocessQqChat 认知复杂度（S3776）
async function detectAndParseInput(
  input: Buffer | string,
  fileName: string,
): Promise<{ chatName: string; messages: NormalizedMessage[] }> {
  const lowerName = fileName.toLowerCase();
  let chatName: string;
  let messages: NormalizedMessage[];
  try {
    const result = await dispatchFormatParse(input, lowerName);
    chatName = result.chatName;
    messages = result.messages;
  } catch (err) {
    // .xlsx/.html 回退到 TXT 解析无意义，直接抛错
    if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
      throw err;
    }
    const rawText = typeof input === 'string' ? input : input.toString('utf8');
    const result = parseTxtFormat(rawText);
    chatName = result.chatName;
    messages = result.messages;
  }

  // 兜底：若解析后 chatName 仍为 unknown，使用文件名（去扩展名）
  if (chatName === 'unknown-chat') {
    chatName = fileName.replace(/\.(txt|json|html?|xlsx)$/i, '');
  }

  return { chatName, messages };
}

// 预清洗主入口：解析 → 过滤 → 脱敏 → 分块 → 构造输出
// 参数：
//   input: 原始文件内容（.txt/.json/.html 文本字符串，或 .xlsx 二进制 Buffer）
//   fileName: 原始文件名（用于 chatName 兜底与格式分发）
//   config: QQ 子系统配置
// 返回：PreprocessOutputData（含 result/jsonContent/rawFileName，由路由层负责落盘）
// 为什么 input 支持 Buffer | string：xlsx 是二进制 ZIP，不能 toString('utf8')，
//   必须以 Buffer 形式传入 parseZip；其他格式仍是字符串
export async function preprocessQqChat(
  input: Buffer | string,
  fileName: string,
  config: QqConfig,
): Promise<PreprocessOutputData> {
  // 1. 格式检测与解析：按文件后缀优先分发，避免二进制格式被误当文本
  const { chatName, messages } = await detectAndParseInput(input, fileName);

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
