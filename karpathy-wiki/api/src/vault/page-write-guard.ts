import matter from 'gray-matter';
import type { VaultService } from './vault-service.js';

// T02923：LLM 修复写入的收窄与护栏。
// ------------------------------------------------------------------
// 事故：修孤立页时 LLM 用 write_file 整页重写 entities/bill-system.md，除预期加链外
// 还静默把 frontmatter 的 updated 从 2025-07-20 改成 2026-08-14（伪造值，log.md 无记录）。
// 口径（本文件是唯一实现，工具层只做转发）：
//   1. 已存在页面：frontmatter 一律以原页为准逐字保留；候选内容里夹带的 frontmatter 变更
//      全部忽略并写入 log.md 审计（旧值 → 新值）。只有显式传 frontmatter 参数才允许改字段，
//      且 updated 永远拒绝（修复动作不改时间戳，否则 stale 检测会被整批抹平）。
//   2. 正文默认只允许最小改动：删除原页标题或大段正文（超过阈值）直接拒绝并给出可读原因；
//      确需重构时必须显式 allowRestructure。
//   3. 新页面（原页不存在）没有可比对的基准，内容原样落盘。

export interface FrontmatterChange {
  key: string;
  from: string | null;
  to: string | null;
}

export interface SplitPage {
  /** 含首尾 --- 分隔行的原始头部（逐字保留）；无 frontmatter 时为空串 */
  header: string;
  body: string;
  data: Record<string, unknown>;
}

export interface GuardedWriteOptions {
  /** 显式声明的 frontmatter 字段修改（唯一允许改 frontmatter 的入口） */
  frontmatter?: Record<string, unknown>;
  /** 显式声明「本页需要重构」，放行标题/大段正文删除 */
  allowRestructure?: boolean;
}

export interface GuardedWriteResult {
  created: boolean;
  /** 已存在页面：frontmatter 是否原样保留（恒为 true，字段级修改见 applied） */
  preservedFrontmatter: boolean;
  applied: FrontmatterChange[];
  ignored: FrontmatterChange[];
}

const UPDATED_KEY = 'updated';

// frontmatter 头部正则：只匹配文件开头的 --- 块。分隔符后的内容即正文。
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

export function splitFrontmatter(raw: string): SplitPage {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { header: '', body: raw, data: {} };
  const header = raw.slice(0, m[0].length);
  const body = raw.slice(m[0].length);
  let data: Record<string, unknown> = {};
  try {
    data = (matter(header).data ?? {}) as Record<string, unknown>;
  } catch {
    // frontmatter 解析失败时退化为「无字段可比对」，正文仍受护栏保护
    data = {};
  }
  return { header, body, data };
}

// 字段值统一转成可读文本：日志里要写「旧值 → 新值」，Date 必须稳定成 ISO 串
function valueText(v: unknown): string {
  if (v === undefined) return '(absent)';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function diffFrontmatter(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FrontmatterChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: FrontmatterChange[] = [];
  for (const key of keys) {
    const a = valueText(before[key]);
    const b = valueText(after[key]);
    if (a !== b) out.push({ key, from: key in before ? a : null, to: key in after ? b : null });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

function formatChanges(changes: FrontmatterChange[]): string {
  return changes
    .map((c) => `${c.key}: ${c.from ?? '(absent)'} → ${c.to ?? '(absent)'}`)
    .join('；');
}

// YAML 标量序列化：只求安全可读，不求覆盖全部 YAML 形态。
// 裸串会改变语义的（布尔/数字/日期/含 YAML 元字符）一律加双引号。
function serializeScalar(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') return JSON.stringify(v);
  const needsQuote =
    !/^[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\-. /\\\u4e00-\u9fa5]*$/.test(v) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(v) ||
    /^[-+]?\d+(\.\d+)?$/.test(v) ||
    /^\d{4}-\d{2}-\d{2}/.test(v);
  return needsQuote ? JSON.stringify(v) : v;
}

// 单行字段写入：命中已有 key 行则整行替换，缺省则插在收尾分隔符之前。
// 为什么不用 YAML stringify 整块重写：那会重排/重格式化其他字段，违背「其余字段逐字保留」。
function setHeaderField(header: string, key: string, value: unknown): string {
  const eol = header.includes('\r\n') ? '\r\n' : '\n';
  const line = `${key}: ${serializeScalar(value)}`;
  const re = new RegExp(`^${escapeRegExp(key)}:[^\\r\\n]*`, 'm');
  if (re.test(header)) {
    // 多行值（YAML 列表/映射）只换首行会把旧值残留在文件里，故直接拒绝而不是写坏
    const match = re.exec(header)!;
    const rest = header.slice(match.index + match[0].length);
    const nextLine = rest.split(/\r?\n/)[1] ?? '';
    if (/^[ \t]/.test(nextLine) || /^-(\s|$)/.test(nextLine)) {
      throw new Error(`写入被拒绝：frontmatter 字段 ${key} 是多行 YAML，暂不支持通过 frontmatter 参数改写`);
    }
    return header.replace(re, line);
  }
  if (header === '') return `---${eol}${line}${eol}---${eol}`;
  return header.replace(/(?:\r?\n)?---[ \t]*(?:\r?\n)?$/, `${eol}${line}${eol}---${eol}`);
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line.trim());
}

export interface BodyGuardReport {
  ok: boolean;
  reason?: string;
  removedHeadings: string[];
  removedNonEmpty: number;
}

function countLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  return counts;
}

/**
 * 正文删除护栏：默认只允许最小改动。
 * 拦截条件（任一命中即拒写）：
 *  1. 原页某个标题在新正文里消失（「删掉三个小节」这类结构性误删）；
 *  2. 被删掉的非空行数超过阈值 max(5, 30% 原非空行数)（大段重写/清空）。
 * 改写单行（如修正断链所在行）、增删少量列表项不受影响；确需重构走 allowRestructure。
 */
export function checkBodyDeletions(
  oldBody: string,
  newBody: string,
  allowRestructure = false,
): BodyGuardReport {
  const oldLines = normalizeEol(oldBody).split('\n').map((l) => l.trimEnd());
  const newCounts = countLines(normalizeEol(newBody).split('\n').map((l) => l.trimEnd()));

  const removed: string[] = [];
  for (const line of oldLines) {
    const n = newCounts.get(line) ?? 0;
    if (n > 0) newCounts.set(line, n - 1);
    else removed.push(line);
  }
  const removedNonEmptyLines = removed.filter((l) => l.trim() !== '');
  const removedNonEmpty = removedNonEmptyLines.length;
  const removedHeadings = [...new Set(removedNonEmptyLines.filter(isHeading))];

  if (allowRestructure) return { ok: true, removedHeadings, removedNonEmpty };

  if (removedHeadings.length > 0) {
    return {
      ok: false,
      removedHeadings,
      removedNonEmpty,
      reason:
        `写入被拒绝：候选正文删除了原页 ${removedHeadings.length} 个标题（${removedHeadings.join('、')}），` +
        '疑似误删与本次修复无关的正文。请改为只追加/最小改动；确需重构本页时显式传 allowRestructure: true。',
    };
  }

  const oldNonEmpty = oldLines.filter((l) => l.trim() !== '').length;
  const threshold = Math.max(5, Math.ceil(oldNonEmpty * 0.3));
  if (removedNonEmpty > threshold) {
    return {
      ok: false,
      removedHeadings,
      removedNonEmpty,
      reason:
        `写入被拒绝：候选正文删除了 ${removedNonEmpty} 行原有内容（阈值 ${threshold}），` +
        '疑似整页重写导致内容丢失。请改为最小改动；确需重构本页时显式传 allowRestructure: true。',
    };
  }

  return { ok: true, removedHeadings, removedNonEmpty };
}

/** 显式声明的字段变更（唯一允许改 frontmatter 的入口）：只记真正变了的字段。 */
function diffExplicitFields(
  data: Record<string, unknown>,
  explicit: Record<string, unknown>,
): FrontmatterChange[] {
  const applied: FrontmatterChange[] = [];
  for (const [key, value] of Object.entries(explicit)) {
    const before = valueText(data[key]);
    const after = valueText(value);
    if (before !== after) applied.push({ key, from: key in data ? before : null, to: after });
  }
  return applied;
}

/** 新页面（原页不存在）：没有可比对的基准，内容原样落盘并按显式声明设置 frontmatter。 */
async function writeNewPage(
  vault: VaultService,
  relativePath: string,
  rawContent: string,
  explicit: Record<string, unknown>,
): Promise<GuardedWriteResult> {
  let content = rawContent;
  let applied: FrontmatterChange[] = [];
  if (Object.keys(explicit).length > 0) {
    const split = splitFrontmatter(content);
    let header = split.header || `---\n---\n`;
    for (const [key, value] of Object.entries(explicit)) {
      header = setHeaderField(header, key, value);
    }
    applied = diffExplicitFields(split.data, explicit);
    content = header + split.body;
  }
  await vault.writeFile(relativePath, content);
  if (applied.length > 0) {
    await vault.appendLog('health-check', [relativePath], `新建页面并按显式声明设置 frontmatter：${formatChanges(applied)}`);
  }
  return { created: true, preservedFrontmatter: false, applied, ignored: [] };
}

/** 已存在页面写盘后的审计：忽略的候选 frontmatter、显式修改、重构放行各记一条。 */
async function appendWriteNotes(
  vault: VaultService,
  relativePath: string,
  notes: { ignored: FrontmatterChange[]; applied: FrontmatterChange[]; allowRestructure: boolean; removedNonEmpty: number },
): Promise<void> {
  const lines: string[] = [];
  if (notes.ignored.length > 0) {
    lines.push(`忽略候选内容中的 frontmatter 变更（以原页为准）：${formatChanges(notes.ignored)}`);
  }
  if (notes.applied.length > 0) {
    lines.push(`按显式声明修改 frontmatter：${formatChanges(notes.applied)}`);
  }
  if (notes.allowRestructure) {
    lines.push(`已按 allowRestructure 放行正文重构（删除非空行 ${notes.removedNonEmpty}）`);
  }
  if (lines.length > 0) {
    await vault.appendLog('health-check', [relativePath], lines.join('；'));
  }
}

/** 已存在页面：原 frontmatter 逐字保留 + 候选正文，正文删除受 checkBodyDeletions 约束。 */
async function writeExistingPage(
  vault: VaultService,
  relativePath: string,
  original: string,
  rawContent: string,
  explicit: Record<string, unknown>,
  allowRestructure: boolean,
): Promise<GuardedWriteResult> {
  const orig = splitFrontmatter(original);
  const cand = splitFrontmatter(rawContent);

  // 候选内容里的 frontmatter 一律不采信（LLM 常整页重写并顺手伪造时间戳）。
  // 只给正文（无 frontmatter 块）时不构成「字段变更意图」，不做字段级 diff。
  const ignored = cand.header === '' ? [] : diffFrontmatter(orig.data, cand.data);
  const applied = diffExplicitFields(orig.data, explicit);

  const guard = checkBodyDeletions(orig.body, cand.body, allowRestructure);
  if (!guard.ok) throw new Error(guard.reason ?? '写入被拒绝');

  let header = orig.header;
  for (const [key, value] of Object.entries(explicit)) {
    header = setHeaderField(header, key, value);
  }

  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const body = normalizeEol(cand.body).replace(/\n/g, eol);
  await vault.writeFile(relativePath, header + body);
  await appendWriteNotes(vault, relativePath, {
    ignored,
    applied,
    allowRestructure,
    removedNonEmpty: guard.removedNonEmpty,
  });
  return { created: false, preservedFrontmatter: true, applied, ignored };
}

/**
 * 带护栏的页面写入（修复工具的唯一落盘入口）。
 * 已存在页面：原 frontmatter 逐字保留 + 候选正文；新页面：内容原样落盘。
 * frontmatter 变更（被忽略的或显式应用的）都会追加到 log.md，保证可审计。
 */
export async function writePageSafely(
  vault: VaultService,
  relativePath: string,
  rawContent: string,
  options: GuardedWriteOptions = {},
): Promise<GuardedWriteResult> {
  const explicit = options.frontmatter ?? {};
  if (UPDATED_KEY in explicit) {
    throw new Error('写入被拒绝：updated 由知识库维护并保留原值，修复流程不得改写时间戳');
  }

  let original: string | null = null;
  try {
    original = await vault.readFile(relativePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'ENOENT') throw err;
  }

  if (original === null) return writeNewPage(vault, relativePath, rawContent, explicit);
  return writeExistingPage(vault, relativePath, original, rawContent, explicit, options.allowRestructure === true);
}
