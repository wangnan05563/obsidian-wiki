// 澄清门禁（clarify gate）：query 工作流「先澄清、后执行」的编排核心。
// 职责：
//   1. 解析上一轮用户选择（携带 clarifyId + choiceIndex 的续答请求）；
//   2. 决定本轮是否中断（检测到歧义 + 置信度达标 + 轮次未耗尽）；
//   3. 中断时生成 ClarificationPayload（含随轮次变化的中断提示语）并写入会话 store；
//   4. 继续时返回用户已确认的意图文本，供上层注入 prompt。
// 纯模块：不依赖 query-workflow 内部实现，任何入口可复用。
import { randomUUID } from 'node:crypto';
import type { HarnessConfig } from '@wiki/harness';
import { detectAmbiguity } from './ambiguity-detector.js';
import type {
  ClarificationPayload,
  ClarifyConfig,
  ClarifyGateResult,
  ClarifySession,
} from './clarify-types.js';
import type { ClarifySessionStore } from './clarify-store.js';

// 中断提示语：随轮次变化，让用户感知「这是第几次确认」，避免机械重复的打断感。
export function buildClarificationPrompt(round: number): string {
  if (round <= 1) {
    return '你的问题可能存在多种理解。为避免答非所问，请选择最符合你意图的一种，我将基于该理解继续检索回答。';
  }
  return `仍然存在多种理解（第 ${round} 次确认）。请再确认一次你的真实意图，我将严格基于它继续回答。`;
}

// 把服务端会话转换为下发给前端的澄清 payload
export function buildClarificationPayload(session: ClarifySession, config: ClarifyConfig): ClarificationPayload {
  return {
    id: session.id,
    round: session.round,
    maxRounds: config.maxRounds,
    question: session.question,
    prompt: buildClarificationPrompt(session.round),
    interpretations: session.options,
    recommendedIndex: session.recommendedIndex,
  };
}

export interface ClarifyGateParams {
  harnessConfig: HarnessConfig;
  config: ClarifyConfig;
  store: ClarifySessionStore;
  question: string;
  // 续答请求携带的澄清上下文（首轮为空）
  clarifyId?: string;
  // 用户选择的选项下标；-1 或缺失表示「按推荐理解直接回答」
  choiceIndex?: number;
  // 当前线程 id（校验 clarifyId 归属；无线程隔离时为 null）
  threadId: string | null;
  // 多模态输出模式：命中 config.skipWhenOutputMode 时跳过澄清
  outputMode?: string;
  // 是否携带附件：附件提供强上下文，歧义概率低，且澄清续答不会重传附件（避免上下文丢失），故跳过
  hasAttachments?: boolean;
  // 历史对话（帮助消解指代）
  history?: Array<{ role: string; content: string }>;
  // 检测器注入点（测试用）：默认使用内置 detectAmbiguity；注入 mock 可覆盖 LLM 行为
  detect?: typeof detectAmbiguity;
}

// 门禁主流程。全部决策集中在此，便于单元测试。
export async function runClarifyGate(params: ClarifyGateParams): Promise<ClarifyGateResult> {
  const { config, store, question, clarifyId, choiceIndex, threadId, outputMode, hasAttachments, history, harnessConfig } = params;
  // 检测器：支持测试注入（默认内置 detectAmbiguity）
  const detector = params.detect ?? detectAmbiguity;

  // ── 0. 开关与跳过条件（fail-open 的第一道闸）──
  if (!config.enabled) return { type: 'continue', skipReason: 'disabled' };
  if (outputMode && config.skipWhenOutputMode.includes(outputMode)) {
    return { type: 'continue', skipReason: 'disabled' };
  }
  if (hasAttachments) {
    return { type: 'continue', skipReason: 'disabled' };
  }

  // ── 1. 解析上一轮用户选择（若有 clarifyId）──
  let session: ClarifySession | null = null;
  let confirmedIntent: string | null = null;
  if (clarifyId) {
    const found = store.get(clarifyId);
    // 归属校验：会话存在 + 问题一致 + 线程一致，否则视为新提问（防串用/防过期复用）
    if (found && found.question === question && (found.threadId ?? null) === (threadId ?? null)) {
      session = found;
      const chosen = Number.isInteger(choiceIndex) ? (choiceIndex as number) : -1;
      const option = chosen === -1
        ? session.options[session.recommendedIndex]
        : session.options[chosen];
      if (option) {
        confirmedIntent = `${option.label}：${option.description}`;
      } else {
        // 非法选项（越界/非整数）：视为未选择过，重新检测
        session = null;
      }
    }
  }

  // ── 2. 已确认过意图且轮次已满 → 不再打断，带已确认意图继续 ──
  // 兑现「不过度打断」：用户每确认一次即信任其意图；轮次耗尽后即便仍有歧义也强制继续。
  if (session && confirmedIntent && session.round >= config.maxRounds) {
    return { type: 'continue', confirmedIntent, skipReason: 'round-exceeded' };
  }

  // ── 3. 歧义检测（fail-open：任何失败都跳过澄清继续回答）──
  let report = null;
  let detectorFailed = false;
  try {
    report = await detector(harnessConfig, question, history);
  } catch {
    report = null;
    detectorFailed = true;
  }
  if (detectorFailed) {
    return { type: 'continue', confirmedIntent: confirmedIntent ?? undefined, skipReason: 'detector-error' };
  }
  if (!report || !report.ambiguous || report.confidence < config.confidenceThreshold) {
    return { type: 'continue', confirmedIntent: confirmedIntent ?? undefined, skipReason: 'no-ambiguity' };
  }

  // ── 4. 截断解读选项并校验 ──
  const options = report.interpretations
    .slice(0, Math.max(2, config.maxInterpretations))
    .map((it, i) => ({ index: i, label: it.label, description: it.description }));
  // 少于 2 个有效解读 → 不算真歧义，直接继续（避免「一个选项怎么选」的尴尬卡片）
  if (options.length < 2) {
    return { type: 'continue', confirmedIntent: confirmedIntent ?? undefined, skipReason: 'no-ambiguity' };
  }
  const recommendedIndex = Math.min(
    Math.max(0, report.recommendedIndex ?? 0),
    options.length - 1,
  );

  // ── 5. 轮次递增：创建或更新澄清会话 ──
  const nextRound = (session?.round ?? 0) + 1;
  if (nextRound > config.maxRounds) {
    // 防御兜底：轮次已满仍检测到歧义 → 按推荐解读继续（不产出第 maxRounds+1 张卡片）
    const recommended = options[recommendedIndex];
    return {
      type: 'continue',
      confirmedIntent: confirmedIntent ?? `${recommended.label}：${recommended.description}`,
      skipReason: 'round-exceeded',
    };
  }
  const nextSession: ClarifySession = {
    id: session?.id ?? randomUUID(),
    threadId,
    question,
    round: nextRound,
    options,
    recommendedIndex,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.ttlMs,
  };
  store.upsert(nextSession);

  // ── 6. 中断：停止生成最终回答，把澄清卡片交给前端 ──
  return { type: 'interrupt', payload: buildClarificationPayload(nextSession, config) };
}
