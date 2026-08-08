// ============================================================================
// 上下文记忆治理模块（Context Memory Governance）
// ----------------------------------------------------------------------------
// 背景：问答历史（线程记忆）会随对话推进不断增长，最终受到 LLM 上下文窗口长度限制。
// 本模块在「把历史注入 LLM 提示词」之前，对对话历史做主动治理，目标：
//
//   1. 语义压缩（compress）   —— 对早期历史提炼关键信息、缩减 token 占用；
//   2. 清理（cleanup）         —— 去重、去除冗余/重复/低价值内容；
//   3. 重组（reorder）         —— 按主题/时间相关性排序，优化模型注意力分配；
//   4. 容量阈值与淘汰（evict） —— 接近上限自动触发上述操作，确保关键信息不丢失、
//                                整体上下文保持连贯可用。
//
// 设计原则：
//   • 纯函数 / 确定性：核心治理逻辑不依赖 LLM，可离线、可单测、可复现。
//   • 不破坏原始数据：治理作用在「注入上下文」这一视图上；线程记忆原始落盘
//     （memory.json）不被改写（除非显式调用 compactMemory 做存储层折叠）。
//   • 关键信息保真：在「未触发淘汰」阶段，最近 recencyWindow 条消息始终保留原文
//     （保证连贯性）；被压缩的早期内容折叠为「历史摘要」，而非直接丢弃。
//     注意：触发容量淘汰阶段，在 token 预算极度紧张时可能进一步裁剪较旧的最近消息，
//     仅保「摘要 + 最新 4 条」作为连贯性底线（见 evictHistory 的 coherenceFloor）。
//
// 数据安全：全部在本地完成，无任何对外传输。
// ============================================================================

import type { HistoryMessage } from './thread-memory-store.js';

// ── 配置 ───────────────────────────────────────────────────────────────────

export interface ContextGovernorConfig {
  /** 总开关：false 时 govern() 原样透传，不做任何治理。 */
  enabled: boolean;
  /**
   * 容量阈值（token 预算）：注入上下文允许的总 token 硬上限。
   * 超过此值将被强制淘汰（evict），保护关键信息（摘要 + 最近窗口）除外。
   */
  maxTokens: number;
  /**
   * 预警比例：投影 token 超过 warnRatio * maxTokens 时触发治理管线
   * （压缩 + 清理 + 重组 + 必要时淘汰）。0~1。
   */
  warnRatio: number;
  /**
   * 最近保留窗口：末尾 N 条消息始终保留原文，不参与压缩/淘汰（保证连贯性）。
   */
  recencyWindow: number;
  /** 消息数硬上限（0 = 不限制）：超过则按淘汰策略裁剪。 */
  maxMessages: number;
  /**
   * 语义压缩策略：
   *   - 'extractive'：抽取式压缩（默认，无需 LLM，确定性），基于关键词/数字/
   *     结论标记提取关键句并合并；
   *   - 'llm'：调用注入的 summarizer（异步）做语义摘要，效果更佳但有开销。
   */
  compressionStrategy: 'extractive' | 'llm';
  /** 压缩摘要最多保留字符数（防摘要自身膨胀）。 */
  summaryMaxChars: number;
  /** 去重相似度阈值（0~1，归一化 token Jaccard）：>= 此值视为重复。 */
  dedupThreshold: number;
  /**
   * 低价值消息最小字符数（保留字段，用于微调与向后兼容）。
   * 当前实现不以"长度短"直接删除消息——短消息只要含实质语义即保留，
   * 以免在小上下文中误删真实提问。低价值判定见 isLowValue（空/纯符号/黑名单）。
   */
  minContentChars: number;
  /** 低价值短语黑名单（问候/确认等）：精确匹配（去空白后）即剔除。 */
  lowValuePatterns: string[];
  /**
   * 重组模式：
   *   - 'chronological'：保持时间序（默认，最连贯）；
   *   - 'relevance'：按与当前问题的主题相关性降序排列（摘要恒置顶，
   *     最近窗口恒置尾，保证即时上下文连贯）。
   */
  reorderMode: 'chronological' | 'relevance';
}

export const DEFAULT_GOVERNOR_CONFIG: ContextGovernorConfig = {
  enabled: true,
  maxTokens: 5000,
  warnRatio: 0.75,
  recencyWindow: 12,
  maxMessages: 30,
  compressionStrategy: 'extractive',
  summaryMaxChars: 1200,
  dedupThreshold: 0.85,
  minContentChars: 10,
  lowValuePatterns: [
    '好的', '谢谢', '感谢', '嗯', '哦', 'ok', 'OK', '好的谢谢', '收到', '了解了',
    '明白了', '哈哈', '好的呢', '没问题', '行', '可以', '好的。',
  ],
  reorderMode: 'chronological',
};

// ── 摘要器（可选 LLM 钩子）───────────────────────────────────────────────────

/**
 * 摘要器：把若干轮历史压缩成一段文字。
 * 返回字符串（可异步）。默认使用抽取式压缩（见 extractiveCompress）。
 */
export type Summarizer = (
  turns: HistoryMessage[],
  config: ContextGovernorConfig,
) => string | Promise<string>;

// ── 统计 ───────────────────────────────────────────────────────────────────

export interface GovernorStats {
  /** 治理前 token 总量。 */
  inputTokens: number;
  /** 治理后注入上下文 token 总量（含摘要）。 */
  outputTokens: number;
  inputMessages: number;
  outputMessages: number;
  /** 因去重移除的消息数。 */
  removedDuplicates: number;
  /** 因低价值移除的消息数。 */
  removedLowValue: number;
  /** 被压缩进摘要的历史轮次数（user/assistant 配对计为一轮）。 */
  compressedTurns: number;
  /** 因超阈值被淘汰的消息数（关键信息保护除外）。 */
  evictedMessages: number;
  /** 是否发生了相关性重组。 */
  reordered: boolean;
  /** 是否触发了主动治理（投影 token 超过预警阈值）。 */
  triggered: boolean;
  /** 生成的摘要字符数（未压缩时为 0）。 */
  summaryChars: number;
}

export interface GovernedContext {
  /** 最终注入 LLM 的历史消息（可能含置顶的「历史摘要」合成消息）。 */
  messages: HistoryMessage[];
  /** 摘要文本（未压缩时为空字符串）。 */
  summary: string;
  stats: GovernorStats;
}

export interface GovernOptions {
  /** 当前用户问题（用于相关性重组与压缩聚焦）。 */
  question?: string;
  /** 覆盖默认配置（与 DEFAULT_GOVERNOR_CONFIG 浅合并）。 */
  config?: Partial<ContextGovernorConfig>;
  /** 自定义摘要器（compressionStrategy='llm' 时使用；未提供则回退抽取式）。 */
  summarizer?: Summarizer;
  /** 已存的持久化摘要（来自 compactMemory），与新压缩内容合并，避免重复摘要。 */
  existingSummary?: string;
}

// ── 工具函数 ───────────────────────────────────────────────────────────────

// 仅匹配 CJK 表意文字（U+3400–U+9FFF），刻意排除全角标点符号（U+3000/U+FF00 区段）
// 与符号，避免把"。！，"等标点当作语义 token（会导致去重 Jaccard 因标点差异而跌破阈值）。
// 同时让 token 估算更贴合真实分词（标点通常不单独计 token）。
const CJK_RE = /[㐀-鿿]/;
const SENT_SPLIT_RE = /(?<=[。！？!?；;\n])/;

/** 估算文本 token 数：CJK 字符约 1 token/字，其余连续非空白串按 4 字符≈1 token。 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  let latinRun = 0;
  const flush = (): void => {
    tokens += Math.ceil(latinRun / 4);
    latinRun = 0;
  };
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      flush();
      tokens += 1;
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      latinRun += 1;
    }
  }
  flush();
  return tokens;
}

/** 把文本切分为归一化 token 集合（CJK 按字、拉丁按小写词），用于相似度/相关性。 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  // CJK 单字
  for (const ch of lower) {
    if (CJK_RE.test(ch)) tokens.add(ch);
  }
  // 拉丁词（连续字母数字）
  const latinWords = lower.match(/[a-z0-9]+/g);
  if (latinWords) for (const w of latinWords) tokens.add(w);
  return tokens;
}

/** 归一化 token 集合的 Jaccard 相似度（0~1）。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 判断消息是否为低价值内容。
 * 判定标准（任一命中即视为低价值）：
 *   1. 空内容或纯空白；
 *   2. 去除空白/标点/符号后无任何实质内容（字母数字或 CJK）—— 即"纯符号"噪声；
 *   3. 精确命中问候/确认黑名单（去空白后），如"好的""谢谢"。
 * 注意：不以"长度短"作为删除依据。短消息（如"继续""如何部署"）只要含有实质
 * 语义即予以保留，避免在小上下文中误删用户的真实提问、破坏连贯性。
 * （config.minContentChars 保留为可调字段，但不再用于硬性截断删除。）
 */
function isLowValue(content: string, config: ContextGovernorConfig): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  // 纯空白/标点/符号（去除后无任何字母数字或 CJK）→ 无实质内容
  const meaningful = trimmed.replace(/[\s\p{P}\p{S}]/gu, '');
  if (meaningful.length === 0) return true;
  // 精确匹配问候/确认黑名单（去空白后）
  if (config.lowValuePatterns.some((p) => trimmed === p || trimmed === p.trim())) {
    return true;
  }
  return false;
}

const KEY_SENTENCE_MARKERS = [
  '结论', '因为', '所以', '总结', '注意', '报错', '错误', '异常', '失败', '解决',
  '方案', '建议', '结果', '关键', '重要', '步骤', '原因', '应该', '必须', '不要',
  '避免', '需要', '应当', '核心', '要点', '答案', '是', '为', '导致', '说明',
];

/** 从一段文本中抽取关键句（抽取式压缩的核心）。 */
function extractKeySentences(text: string, maxChars: number): string {
  const sentences = text
    .split(SENT_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length <= 1) {
    const single = (sentences[0] ?? text).trim();
    return single.length > maxChars ? single.slice(0, maxChars) + '…' : single;
  }

  const scored = sentences.map((s, idx) => {
    let score = 0;
    if (/\d/.test(s)) score += 2; // 含数字（参数/日期/指标）更有价值
    if (KEY_SENTENCE_MARKERS.some((m) => s.includes(m))) score += 3; // 结论性标记
    if (s.includes('```') || s.includes('`') || s.includes('[[') || /https?:\/\//.test(s)) score += 2; // 代码/链接/页面引用
    if (s.length > 120) score -= 1; // 过长句降权（可能是铺垫）
    return { s, idx, score };
  });

  // 按分数降序选句，再按原始顺序排回以保证可读性
  const top = scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(2, Math.ceil(sentences.length / 2)));
  top.sort((a, b) => a.idx - b.idx);

  let out = '';
  for (const t of top) {
    if (out.length + t.s.length + 1 > maxChars) {
      out += '…';
      break;
    }
    out += (out ? ' ' : '') + t.s;
  }
  return out;
}

/**
 * 抽取式压缩：把若干历史消息折叠成一段「历史摘要」。
 * 按 user/assistant 配对为轮次，每轮保留问题（压缩）+ 回答关键句。
 * 纯函数、确定性、无需 LLM。供治理管线与存储层 compactMemory 共用。
 *
 * 压缩率保证：对长回答，每条最多保留其原始长度的 30%（下限 40 字防过度截断），
 * 在长回答主导的历史下整体摘要显著小于原文，确保 token 净缩减而非膨胀；
 * 短回答（<?133 字）因 40 字下限仅做轻量抽取，净压缩率较低——这是有意的兜底。
 */
export function extractiveCompress(
  turns: HistoryMessage[],
  config: ContextGovernorConfig,
): string {
  if (turns.length === 0) return '';
  const perTurn: string[] = [];
  let i = 0;
  while (i < turns.length) {
    const user = turns[i].role === 'user' ? turns[i] : null;
    const assistant = turns[i + 1]?.role === 'assistant' ? turns[i + 1] : null;
    const start = user ? i : i + 1;
    const end = assistant ? i + 2 : i + 1;
    const q = user?.content ?? '';
    const a = assistant?.content ?? (user ? '' : turns[i].content);
    // 问题通常较短，保留并截断到 120 字
    const qCompressed = q.length > 120 ? q.slice(0, 120) + '…' : q;
    // 答案抽取关键句，预算为其原始长度的 30%（下限 40 字）→ 强制压缩
    const ansBudget = Math.max(40, Math.floor(a.length * 0.3));
    const aKey = extractKeySentences(a, ansBudget);
    perTurn.push(`用户：${qCompressed}${aKey ? ` 助手：${aKey}` : ''}`);
    i = end;
  }
  let merged = perTurn.join('\n');
  if (merged.length > config.summaryMaxChars) {
    merged = merged.slice(0, config.summaryMaxChars) + '…';
  }
  return merged;
}

/** 合并既有持久化摘要与新压缩内容（避免重复摘要、控制长度）。 */
function mergeSummaries(existing: string | undefined, fresh: string, maxChars: number): string {
  if (!existing) return fresh;
  if (!fresh) return existing;
  const combined = `${existing}\n${fresh}`;
  return combined.length > maxChars ? combined.slice(0, maxChars) + '…' : combined;
}

// ── 治理管线各阶段 ─────────────────────────────────────────────────────────

interface CleanupResult {
  kept: HistoryMessage[];
  removedDuplicates: number;
  removedLowValue: number;
}

/**
 * 判断两条消息是否重复：高 Jaccard 相似度且不含"显著实体差异"。
 * 显著实体 = 数字（如编号/日期/指标）或页面引用 [[...]]。若两者在这些实体上不同，
 * 即便整体字面高度相似（如"概念0"vs"概念1"的模板化内容），也视为不同内容，不判重。
 * 这样既能剔除真正的重复（重发/复制粘贴，仅标点差异），又不会误删仅主题编号不同的问答。
 */
function isDuplicate(a: Set<string>, b: Set<string>, threshold: number): boolean {
  if (jaccard(a, b) < threshold) return false;
  const significant = (t: string): boolean => /\d/.test(t) || t.includes('[[');
  for (const t of a) if (significant(t) && !b.has(t)) return false;
  for (const t of b) if (significant(t) && !a.has(t)) return false;
  return true;
}

/** 阶段一：清理 —— 去重 + 剔除低价值内容。 */
function cleanupHistory(history: HistoryMessage[], config: ContextGovernorConfig): CleanupResult {
  const kept: HistoryMessage[] = [];
  const keptTokens: Set<string>[] = [];
  let removedDuplicates = 0;
  let removedLowValue = 0;

  for (const msg of history) {
    if (isLowValue(msg.content, config)) {
      removedLowValue += 1;
      continue;
    }
    const tokens = tokenize(msg.content);
    // 与已保留消息做相似度比较，命中阈值且无显著实体差异则判为重复杂糅（保留最早一条）
    let duplicate = false;
    for (const kt of keptTokens) {
      if (isDuplicate(tokens, kt, config.dedupThreshold)) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) {
      removedDuplicates += 1;
      continue;
    }
    kept.push(msg);
    keptTokens.push(tokens);
  }
  return { kept, removedDuplicates, removedLowValue };
}

/** 阶段二：语义压缩 —— 把超出最近窗口的早期历史折叠为摘要。 */
async function compressHistory(
  history: HistoryMessage[],
  config: ContextGovernorConfig,
  opts: GovernOptions,
): Promise<{ summary: string; compressedTurns: number }> {
  const eligibleCount = Math.max(0, history.length - config.recencyWindow);
  if (eligibleCount === 0) {
    return { summary: opts.existingSummary ?? '', compressedTurns: 0 };
  }
  const eligible = history.slice(0, eligibleCount);
  let freshSummary: string;
  if (config.compressionStrategy === 'llm' && opts.summarizer) {
    freshSummary = await opts.summarizer(eligible, config);
  } else {
    freshSummary = extractiveCompress(eligible, config);
  }
  const summary = mergeSummaries(opts.existingSummary, freshSummary, config.summaryMaxChars);
  // 轮次 ≈ 配对数（user+assistant）
  const compressedTurns = Math.ceil(eligibleCount / 2);
  return { summary, compressedTurns };
}

/** 阶段三：重组 —— 相关性排序（摘要置顶、最近窗口置尾）。 */
function reorderHistory(
  messages: HistoryMessage[],
  config: ContextGovernorConfig,
  question?: string,
): { messages: HistoryMessage[]; reordered: boolean } {
  if (config.reorderMode !== 'relevance' || !question || question.trim().length === 0) {
    return { messages, reordered: false };
  }
  const qTokens = tokenize(question);
  if (qTokens.size === 0) return { messages, reordered: false };

  // 摘要消息（若有）恒置顶；最近窗口恒置尾（保证即时上下文连贯）
  const hasSummary = messages.length > 0 && messages[0].content.startsWith('【历史摘要】');
  const head = hasSummary ? [messages[0]] : [];
  const rest = hasSummary ? messages.slice(1) : messages;
  const recent = rest.slice(-config.recencyWindow);
  const older = rest.slice(0, -config.recencyWindow);

  const scored = older
    .map((m) => {
      const mt = tokenize(m.content);
      let overlap = 0;
      for (const t of qTokens) if (mt.has(t)) overlap += 1;
      return { m, score: overlap };
    })
    .sort((a, b) => b.score - a.score || 0);

  const result = [...head, ...scored.map((x) => x.m), ...recent];
  const reordered = scored.some((x, idx) => x.m !== older[idx]);
  return { messages: result, reordered };
}

/** 阶段四：淘汰 —— token/消息数超限时，从最旧的非保护消息开始裁剪。 */
function evictHistory(
  messages: HistoryMessage[],
  config: ContextGovernorConfig,
): { messages: HistoryMessage[]; evicted: number } {
  const hasSummary = messages.length > 0 && messages[0].content.startsWith('【历史摘要】');
  // 连贯性底线：至少保留摘要 + 最近若干条（recencyWindow 但封顶 4 条），
  // 其余较旧的非关键消息在预算受限时允许被淘汰。
  const coherenceFloor = Math.min(config.recencyWindow, 4);
  const protectedCount = (hasSummary ? 1 : 0) + coherenceFloor;

  let working = messages;
  let evicted = 0;

  // 消息数超限：仅当消息总数超过硬上限 maxMessages 时才裁剪（而非一味裁到保护集）
  while (
    config.maxMessages > 0 &&
    working.length > config.maxMessages
  ) {
    const dropIdx = hasSummary ? 1 : 0; // 跳过摘要
    working = [...working.slice(0, dropIdx), ...working.slice(dropIdx + 1)];
    evicted += 1;
  }

  // token 超限：同样从最旧非保护位置裁剪，直至预算内或仅剩保护内容
  let tokens = working.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  while (tokens > config.maxTokens && working.length - protectedCount > 0) {
    const dropIdx = hasSummary ? 1 : 0;
    const dropped = working[dropIdx];
    working = [...working.slice(0, dropIdx), ...working.slice(dropIdx + 1)];
    tokens -= estimateTokens(dropped.content);
    evicted += 1;
  }

  return { messages: working, evicted };
}

// ── 主入口 ─────────────────────────────────────────────────────────────────

/**
 * 对问答历史执行上下文治理，返回注入 LLM 的最终上下文与统计数据。
 *
 * @param history 原始历史（来自线程记忆或前端透传），按时间顺序排列。
 * @param opts    可选：当前问题、配置覆盖、摘要器、既有摘要。
 */
export async function govern(
  history: HistoryMessage[],
  opts: GovernOptions = {},
): Promise<GovernedContext> {
  const config: ContextGovernorConfig = { ...DEFAULT_GOVERNOR_CONFIG, ...(opts.config ?? {}) };

  const emptyStats: GovernorStats = {
    inputTokens: 0,
    outputTokens: 0,
    inputMessages: history.length,
    outputMessages: history.length,
    removedDuplicates: 0,
    removedLowValue: 0,
    compressedTurns: 0,
    evictedMessages: 0,
    reordered: false,
    triggered: false,
    summaryChars: 0,
  };

  // 总开关关闭：原样透传
  if (!config.enabled) {
    return { messages: history, summary: '', stats: { ...emptyStats } };
  }

  const inputTokens = history.reduce((s, m) => s + estimateTokens(m.content), 0);

  // 阶段一：清理（去重 + 低价值）
  const { kept, removedDuplicates, removedLowValue } = cleanupHistory(history, config);

  // 判断是否触发主动治理：投影 token 超预警阈值 或 消息数超限
  const projectedTokens = kept.reduce((s, m) => s + estimateTokens(m.content), 0);
  const triggered =
    projectedTokens > config.warnRatio * config.maxTokens ||
    (config.maxMessages > 0 && kept.length > config.maxMessages);

  let summary = '';
  let compressedTurns = 0;
  let reordered = false;
  let evicted = 0;

  if (triggered) {
    // 阶段二：语义压缩（早期历史 → 摘要）
    const comp = await compressHistory(kept, config, opts);
    summary = comp.summary;
    compressedTurns = comp.compressedTurns;

    // 组装：摘要（合成助手消息）置顶 + 最近窗口原文
    const summaryMsg: HistoryMessage | null = summary
      ? { role: 'assistant', content: `【历史摘要】\n${summary}`, ts: kept[0]?.ts ?? new Date().toISOString() }
      : null;
    const recent = kept.slice(-config.recencyWindow);

    // 阶段三：重组
    const reorderedResult = reorderHistory(
      summaryMsg ? [summaryMsg, ...recent] : recent,
      config,
      opts.question,
    );
    reordered = reorderedResult.reordered;

    // 阶段四：淘汰
    const evictedResult = evictHistory(reorderedResult.messages, config);
    evicted = evictedResult.evicted;

    const finalMessages = evictedResult.messages;
    const outputTokens = finalMessages.reduce((s, m) => s + estimateTokens(m.content), 0);

    return {
      messages: finalMessages,
      summary,
      stats: {
        ...emptyStats,
        inputTokens,
        outputTokens,
        inputMessages: history.length,
        outputMessages: finalMessages.length,
        removedDuplicates,
        removedLowValue,
        compressedTurns,
        evictedMessages: evicted,
        reordered,
        triggered: true,
        summaryChars: summary.length,
      },
    };
  }

  // 未触发：仅清理后的原文透传（仍可能因清理而变短）
  // 未触发时也做一次重组（相关性排序不改变预算，仅优化注意力，代价极低）
  const reorderedResult = reorderHistory(kept, config, opts.question);
  const outputTokens = reorderedResult.messages.reduce((s, m) => s + estimateTokens(m.content), 0);
  return {
    messages: reorderedResult.messages,
    summary: '',
    stats: {
      ...emptyStats,
      inputTokens,
      outputTokens,
      inputMessages: history.length,
      outputMessages: reorderedResult.messages.length,
      removedDuplicates,
      removedLowValue,
      compressedTurns: 0,
      evictedMessages: 0,
      reordered: reorderedResult.reordered,
      triggered: false,
      summaryChars: 0,
    },
  };
}
