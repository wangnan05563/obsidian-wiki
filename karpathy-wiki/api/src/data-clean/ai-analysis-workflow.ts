// AI 智能清洗分析工作流（数据清洗页「AI分析」按钮后端）
//
// 设计要点：
// 1. 确定性预分析先行 —— 复用 scanVaultRaw / deduplicatePages 产生"候选集"，
//    把 LLM 的输入收缩到少量高价值候选（冗余/重复组/重命名），避免向大模型
//    倾倒整个 vault（1500+ 文件的 token 灾难）。
// 2. LLM 单轮 JSON 调用 —— 与 tag-suggest-workflow 同模式：OpenAI 兼容端点，
//    代码解析输出、容错 ```json 包裹，不直接拼装写入（结论由用户在前端确认后才执行）。
// 3. LLM 失败优雅降级 —— 网络/鉴权/超时异常时回退到纯确定性候选，保证功能始终可用。
// 4. BYOK —— 仅用请求体携带的用户 llmConfig 调用，密钥不落服务端（与 query 管线一致）。
//
// 数据流：
//   scanVaultRaw → pages(+content)
//   deduplicatePages → 重复分组
//   确定性候选提取（冗余/重命名）
//     → 组装紧凑 payload（仅候选元数据，不含正文）
//     → callLlmForAnalysis(prompt, payload, config)
//     → parseAiAnalysisOutput(text) 容错解析
//     → 合并：LLM 结果优先，缺项回退确定性候选，并补齐标题/分数等元数据
//     → 返回 AiCleanAnalysisResult

import fs from 'node:fs/promises';
import path from 'node:path';
import type { VaultService } from '../vault/vault-service.js';
import type { PageQualityScore, DeduplicateResult, AppConfig } from '../types.js';
import { getEffectiveApiKey } from '../config.js';
import { getPromptPath } from '../utils/runtime.js';
import { scanVaultRaw } from './quality-scanner.js';
import { deduplicatePages } from './dedup-engine.js';

// ─── 类型（与前端 frontend/src/types.ts AiCleanAnalysis* 对齐）───

export interface AiAnalysisRedundantItem {
  path: string;
  title: string;
  reason: string;
  score?: number;
  wordCount?: number;
  fileSizeBytes?: number;
}

export interface AiAnalysisDuplicateGroup {
  representativePath: string;
  paths: string[];
  reason: string;
  totalWordsInGroup?: number;
}

export interface AiAnalysisRenameItem {
  path: string;
  title: string;
  currentName: string;
  suggestedName: string;
  suggestedPath: string;
  reason: string;
}

export interface AiCleanAnalysisResult {
  analyzedAt: string;
  summary: {
    totalPages: number;
    scannedCandidatePages: number;
    redundantCount: number;
    duplicateGroupsCount: number;
    renameCount: number;
  };
  redundant: AiAnalysisRedundantItem[];
  duplicates: AiAnalysisDuplicateGroup[];
  renames: AiAnalysisRenameItem[];
  rawLlm?: string;
}

export interface AiAnalysisOptions {
  /** 重命名候选发送给 LLM 的数量上限，避免大 vault 下 payload 过大 */
  renameCap?: number;
  /** 注入 LLM 调用（测试用）；缺省走全局 fetch callLlmForAnalysis */
  llmCall?: (prompt: string, payloadJson: string, config: AppConfig) => Promise<string>;
}

// ─── LLM 调用（与 tag-suggest-workflow.callLlmForTagSuggest 同模式）───

const PROMPT_PATH = getPromptPath('ai-clean-analysis.md');
let cachedPrompt: string | null = null;

async function loadAiAnalysisPrompt(): Promise<string> {
  if (cachedPrompt !== null) return cachedPrompt;
  cachedPrompt = await fs.readFile(PROMPT_PATH, 'utf8');
  return cachedPrompt;
}

/**
 * 调用 LLM（OpenAI 兼容 /chat/completions）获取清洗分类。
 * 隔离为独立函数，便于单测通过 options.llmCall 注入或 mock 全局 fetch。
 */
export async function callLlmForAnalysis(
  prompt: string,
  payloadJson: string,
  config: AppConfig,
): Promise<string> {
  const baseUrl = config.llm.baseUrl.trim();
  const model = config.llm.model;
  const apiKey = getEffectiveApiKey(config);

  // BYOK：无 key 且非本地端点 → 明确拒绝（与 query 管线一致，不回落服务端共享 key）
  if (!apiKey && !baseUrl.includes('localhost')) {
    throw new Error('API Key 未设置，无法调用 AI 分析');
  }

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: payloadJson },
        ],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`LLM API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) throw new Error('LLM 返回空内容');
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── 确定性候选提取（纯函数，可单测）───

const REDUNDANT_NAME = /(^|\/)(test-|proxy-test|.*-copy|.*副本|.*草稿|.*draft|.*tmp|.*temp|.*~|copy of )/i;

/** 判断某页是否为"可安全删除"的冗余候选，返回原因或 null */
export function isRedundantCandidate(p: PageQualityScore): string | null {
  if (p.metadata.wordCount === 0 || p.metadata.fileSizeBytes < 50) {
    return '内容几乎为空（仅 frontmatter 或无正文），可安全删除';
  }
  if (p.qualityScore < 20 && p.metadata.wordCount < 30) {
    return '质量分极低且无实质内容，疑似废弃草稿';
  }
  if (REDUNDANT_NAME.test(p.path.split('/').pop() || '')) {
    return '文件名含测试/草稿/副本等冗余标记';
  }
  return null;
}

/** 文件名是否需要规范化重命名（kebab-case 校验） */
export function needsRename(fileName: string): boolean {
  const base = fileName.replace(/\.md$/i, '');
  if (/[A-Z]/.test(base)) return true; // 大写字母
  if (/[\s_]/.test(base)) return true; // 空格或下划线
  if (/^[-]|[-]$/.test(base)) return true; // 首尾连字符
  if (/--/.test(base)) return true; // 连续连字符
  if (/(copy|副本|草稿|draft|backup|bak|tmp|temp|～|~)/i.test(base)) return true; // 冗余词
  if (/[^A-Za-z0-9一-龥-]/.test(base)) return true; // 其他不允许字符
  return false;
}

/** 把任意文件名规范化为 kebab-case .md（确定性兜底，LLM 可覆盖） */
export function toKebabName(fileName: string): string {
  const base = fileName.replace(/\.md$/i, '');
  const s = base
    .replace(/(copy of|副本|草稿|draft|backup|bak|tmp|temp|～|~)/gi, ' ')
    .replace(/[_\s]+/g, '-')
    .replace(/[A-Z]+/g, (m) => m.toLowerCase())
    .replace(/[^A-Za-z0-9一-龥-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'untitled') + '.md';
}

/** 规范化 LLM 给出的 suggestedName：取 basename、强制 kebab-case .md */
export function normalizeSuggestedName(input: string): string {
  const base = (input || '').split('/').pop() || '';
  return toKebabName(base);
}

interface RenameCandidate {
  path: string;
  title: string;
  currentName: string;
  suggestedName: string;
  suggestedPath: string;
  reason: string;
}

function buildRenameCandidates(
  pages: PageQualityScore[],
  cap: number,
): RenameCandidate[] {
  return pages
    .filter((p) => needsRename(p.path.split('/').pop() || ''))
    .slice(0, cap)
    .map((p) => {
      const fileName = p.path.split('/').pop() || '';
      const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '';
      const suggestedName = toKebabName(fileName);
      return {
        path: p.path,
        title: p.title,
        currentName: fileName,
        suggestedName,
        suggestedPath: dir ? `${dir}/${suggestedName}` : suggestedName,
        reason: '文件名不符合 kebab-case 规范，建议规范化',
      };
    });
}

// ─── LLM 输出解析（容错）───

interface ParsedAiAnalysis {
  redundant: Array<{ path: string; reason: string }>;
  duplicates: Array<{ representativePath: string; paths: string[]; reason: string }>;
  renames: Array<{ path: string; suggestedName: string; reason: string }>;
}

/** 容错解析 LLM 返回的 JSON（处理 ```json 围栏、前后多余文本、缺字段） */
export function parseAiAnalysisOutput(text: string): ParsedAiAnalysis {
  let cleaned = text.trim();
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(cleaned);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  if (!cleaned.startsWith('{')) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  }

  let parsed: any = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = {};
  }

  const redundant = Array.isArray(parsed.redundant)
    ? parsed.redundant
        .filter((x: any) => x && typeof x.path === 'string')
        .map((x: any) => ({ path: x.path, reason: typeof x.reason === 'string' ? x.reason : 'AI 判定为冗余' }))
    : [];

  const duplicates = Array.isArray(parsed.duplicates)
    ? parsed.duplicates
        .filter((x: any) => x && typeof x.representativePath === 'string' && Array.isArray(x.paths))
        .map((x: any) => ({
          representativePath: x.representativePath,
          paths: x.paths.filter((p: any) => typeof p === 'string'),
          reason: typeof x.reason === 'string' ? x.reason : '内容重复，建议合并去重',
        }))
    : [];

  const renames = Array.isArray(parsed.renames)
    ? parsed.renames
        .filter((x: any) => x && typeof x.path === 'string' && typeof x.suggestedName === 'string')
        .map((x: any) => ({
          path: x.path,
          suggestedName: x.suggestedName,
          reason: typeof x.reason === 'string' ? x.reason : '文件名建议规范化',
        }))
    : [];

  return { redundant, duplicates, renames };
}

// ─── 主入口 ───

/**
 * 分析整个 vault 并产出清洗分类结论。
 * LLM 调用失败（网络/鉴权/超时/畸形 JSON）时优雅降级为纯确定性候选，保证始终有结论。
 */
export async function analyzeVaultForCleanup(
  vault: VaultService,
  config: AppConfig,
  options: AiAnalysisOptions = {},
): Promise<AiCleanAnalysisResult> {
  const llmCall = options.llmCall ?? ((prompt, payload) => callLlmForAnalysis(prompt, payload, config));
  const renameCap = options.renameCap ?? 60;

  // 单次扫描：内容仅用于扫描，LLM payload 只用元数据
  const scanned = await scanVaultRaw(vault);
  const pages = scanned.map((s) => s.page);
  const pageByPath = new Map(pages.map((p) => [p.path, p]));
  const dedup: DeduplicateResult = await deduplicatePages(vault);

  // 确定性候选
  const redundantCands = pages
    .map((p) => ({ p, reason: isRedundantCandidate(p) }))
    .filter((x) => x.reason)
    .map((x) => ({
      path: x.p.path,
      title: x.p.title,
      qualityScore: x.p.qualityScore,
      wordCount: x.p.metadata.wordCount,
      fileSizeBytes: x.p.metadata.fileSizeBytes,
      reason: x.reason as string,
    }));

  const renameCands = buildRenameCandidates(pages, renameCap);

  // 组装紧凑 payload（仅候选元数据）
  const payload = JSON.stringify(
    {
      totalPages: pages.length,
      candidates: {
        redundant: redundantCands.map((c) => ({
          path: c.path,
          title: c.title,
          qualityScore: c.qualityScore,
          wordCount: c.wordCount,
          fileSizeBytes: c.fileSizeBytes,
          reason: c.reason,
        })),
        duplicates: dedup.duplicateGroups.map((g) => ({
          representativePath: g.representativePath,
          paths: g.pages,
          totalWordsInGroup: g.totalWordsInGroup,
        })),
        renames: renameCands.map((c) => ({
          path: c.path,
          title: c.title,
          currentName: c.currentName,
          suggestedName: c.suggestedName,
          reason: c.reason,
        })),
      },
    },
    null,
    2,
  );

  const prompt = await loadAiAnalysisPrompt();
  let rawLlm = '';
  let parsed: ParsedAiAnalysis = { redundant: [], duplicates: [], renames: [] };
  try {
    rawLlm = await llmCall(prompt, payload, config);
    parsed = parseAiAnalysisOutput(rawLlm);
  } catch (err) {
    // 优雅降级：保留 rawLlm（若有部分输出）以便排查，但结论回退确定性候选
    console.warn('[AI-ANALYSIS] LLM 调用失败，回退确定性候选:', err);
    if (!rawLlm && err instanceof Error) rawLlm = '';
  }

  // 合并 redundant：LLM 优先，缺项回退确定性候选
  const redundantSource = parsed.redundant.length
    ? parsed.redundant
    : redundantCands.map((c) => ({ path: c.path, reason: c.reason }));
  const redundant: AiAnalysisRedundantItem[] = redundantSource
    .map((item): AiAnalysisRedundantItem | null => {
      const p = pageByPath.get(item.path);
      if (!p) return null;
      return {
        path: item.path,
        title: p.title,
        reason: item.reason,
        score: p.qualityScore,
        wordCount: p.metadata.wordCount,
        fileSizeBytes: p.metadata.fileSizeBytes,
      };
    })
    .filter((x): x is AiAnalysisRedundantItem => x !== null);

  // 合并 duplicates：LLM 筛选；否则全部 dedup 组
  const dupSource = parsed.duplicates.length
    ? parsed.duplicates
    : dedup.duplicateGroups.map((g) => ({
        representativePath: g.representativePath,
        paths: g.pages,
        reason: '内容重复，建议合并去重',
      }));
  const duplicates: AiAnalysisDuplicateGroup[] = dupSource
    .map((d) => {
      const g = dedup.duplicateGroups.find((x) => x.representativePath === d.representativePath);
      const paths = (g?.pages?.length ? g.pages : d.paths).filter((pp) => pageByPath.has(pp));
      return {
        representativePath: d.representativePath,
        paths,
        reason: d.reason,
        totalWordsInGroup: g?.totalWordsInGroup,
      };
    })
    .filter((d) => d.paths.length >= 2 && pageByPath.has(d.representativePath));

  // 合并 renames：LLM 优先，缺项回退确定性候选
  const renameSource = parsed.renames.length
    ? parsed.renames
    : renameCands.map((c) => ({ path: c.path, suggestedName: c.suggestedName, reason: c.reason }));
  const renames: AiAnalysisRenameItem[] = renameSource
    .map((r) => {
      const p = pageByPath.get(r.path);
      if (!p) return null;
      const suggestedName = normalizeSuggestedName(r.suggestedName);
      const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '';
      const suggestedPath = dir ? `${dir}/${suggestedName}` : suggestedName;
      // 过滤无效：路径不存在 / 建议名非法 / 与原名相同 / 越权
      if (!suggestedName.endsWith('.md') || suggestedPath === r.path || suggestedPath.includes('..')) {
        return null;
      }
      return {
        path: r.path,
        title: p.title,
        currentName: r.path.split('/').pop() || '',
        suggestedName,
        suggestedPath,
        reason: r.reason,
      };
    })
    .filter((x): x is AiAnalysisRenameItem => x !== null);

  return {
    analyzedAt: new Date().toISOString(),
    summary: {
      totalPages: pages.length,
      scannedCandidatePages: redundantCands.length + renameCands.length + dedup.duplicateGroups.length,
      redundantCount: redundant.length,
      duplicateGroupsCount: duplicates.length,
      renameCount: renames.length,
    },
    redundant,
    duplicates,
    renames,
    ...(rawLlm ? { rawLlm } : {}),
  };
}
