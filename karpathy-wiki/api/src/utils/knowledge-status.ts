// FR-18 知识时效状态判定工具（V4.0）
// 设计原则：knowledge_status 是"派生状态"，由 knowledge_class + updated + reviewed_at + staleDays 动态计算，
// 不落盘（避免 staleDays 调整后需全库重算），在读取/展示/健康检查时按需计算。
import type { KnowledgeClass, KnowledgeStatus } from '../types.js';

export type KnowledgeFrontmatter = {
  knowledge_class?: unknown;
  updated?: unknown;
  reviewed_at?: unknown;
};

// 判断一个日期（string 或 Date）距今是否超过 staleDays 天。
// 为什么兼容 Date：gray-matter 用 js-yaml，YAML 中无引号日期（如 updated: 2026-08-01）
// 会被自动解析为 Date 对象而非字符串，仅判 string 会导致有效期/复核期误判 stale。
// 日期缺失/非法一律视为"已过期"——日期缺失时页面无更新证据，按保守策略判 stale
// （宁可提示复核，不误判新鲜）。
function isOlderThanDays(dateStr: unknown, staleDays: number, now: Date): boolean {
  if (dateStr == null) return true;
  const t = typeof dateStr === 'string'
    ? Date.parse(dateStr)
    : dateStr instanceof Date
      ? dateStr.getTime()
      : NaN;
  if (Number.isNaN(t)) return true; // 非法日期同样保守判过期
  const ageMs = now.getTime() - t;
  return ageMs > staleDays * 24 * 60 * 60 * 1000;
}

// 计算页面知识时效状态。优先级链（确定性）：
// 1. 无 knowledge_class → unknown（存量页面兜底，不阻断）
// 2. class ∈ {timeless, pointer} → ok（长期有效/中转页不承载时效内容）
// 3. class = dated：
//    a. updated 距今 ≤ staleDays → ok（仍在有效期内）
//    b. updated 距今 > staleDays 且有 reviewed_at 且复核距今 ≤ staleDays → ok（复核在保质期内）
//    c. 其余 → stale（逾期未复核，或复核本身已过期）
// 为什么第 3b 引入"复核保质期"：复核本身有时效，避免一次复核永久免检（对齐竞品 OKM 的事实时效语义）。
export function computeKnowledgeStatus(
  frontmatter: KnowledgeFrontmatter,
  staleDays: number,
  now: Date = new Date(),
): KnowledgeStatus {
  const kc = typeof frontmatter.knowledge_class === 'string'
    ? (frontmatter.knowledge_class.toLowerCase() as KnowledgeClass)
    : undefined;
  if (kc !== 'timeless' && kc !== 'dated' && kc !== 'pointer') {
    return 'unknown';
  }
  if (kc === 'timeless' || kc === 'pointer') {
    return 'ok';
  }
  // kc === 'dated'
  if (!isOlderThanDays(frontmatter.updated, staleDays, now)) {
    return 'ok';
  }
  // updated 已超阈值：看 reviewed_at 是否在保质期内
  if (!isOlderThanDays(frontmatter.reviewed_at, staleDays, now)) {
    return 'ok';
  }
  return 'stale';
}