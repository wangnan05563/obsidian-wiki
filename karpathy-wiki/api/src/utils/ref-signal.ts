// FR-19 引用信号构建工具（V4.0）
// 作用：把引用页面路径（refs）升级为携带三信号（权威度/完整度/复核）+ 时效状态的对象。
// 设计原则：
// - 纯规则计算，不调 LLM、不做额外 IO（每页一次 readFile，与 extractRefs 已读页面可比）
// - authority 由 frontmatter.source 类别查 config.json refs.authorityMap，未覆盖归 unknown（宁保守不误判）
// - review 表示是否已人工复核（存在 reviewed_at 字段）
// - confidence 用"正文非空"作为完整度代理信号（SRS：字段完整数/正文字数阈值的最小实现）
// - knowledgeStatus 复用 FR-18 的 computeKnowledgeStatus，保证阅读/问答/健康检查三处取值一致
import matter from 'gray-matter';
import type { VaultService } from '../vault/vault-service.js';
import type { AppConfig, RefSignal } from '../types.js';
import { computeKnowledgeStatus } from './knowledge-status.js';

// 为一批引用路径构建信号对象。
// 单页读失败时仍保留该引用（authority/review/confidence 置 unknown/false），
// 保证低置信引用不被静默丢弃（AC-19-6：全部引用保持可见）。
export async function buildRefSignals(
  paths: string[],
  vault: VaultService,
  appConfig?: AppConfig,
): Promise<RefSignal[]> {
  const authorityMap = appConfig?.refs?.authorityMap ?? {};
  // knowledge.staleDays 默认 365，与 defaultConfig 保持一致
  const staleDays = appConfig?.knowledge?.staleDays ?? 365;

  return Promise.all(paths.map(async (p) => {
    let source: unknown;
    let bodyNonEmpty = false;
    let reviewedAt: unknown;
    let knowledgeClass: unknown;
    let updated: unknown;
    try {
      const content = await vault.readFile(p);
      const parsed = matter(content);
      source = parsed.data.source;
      reviewedAt = parsed.data.reviewed_at;
      knowledgeClass = parsed.data.knowledge_class;
      updated = parsed.data.updated;
      bodyNonEmpty = parsed.content.trim().length > 0;
    } catch {
      // 读取失败：信号全 unknown/false，但不丢弃引用
      source = undefined;
      bodyNonEmpty = false;
    }

    const sourceKey = typeof source === 'string' ? source : '';
    const authority = (authorityMap[sourceKey] as RefSignal['authority']) ?? 'unknown';
    // review = 是否存在 reviewed_at 字段。兼容两种情况：
    // 1. YAML 无引号日期（如 reviewed_at: 2026-08-01）会被 js-yaml 解析为 Date 对象（typeof 'object'）
    // 2. 带引号字符串（typeof 'string'）
    // 只要字段存在且非空即视为已人工复核。
    const review = reviewedAt != null && (typeof reviewedAt !== 'string' || reviewedAt.length > 0);
    return {
      path: p,
      authority,
      // 正文非空即视为内容完整可用；空正文可信度低
      confidence: bodyNonEmpty,
      review,
      knowledgeStatus: computeKnowledgeStatus(
        { knowledge_class: knowledgeClass, updated, reviewed_at: reviewedAt },
        staleDays,
      ),
    };
  }));
}