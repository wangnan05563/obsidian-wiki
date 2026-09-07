// 意图澄清（Clarify）模块类型定义。
// 参考 Trae / WorkBuddy 的「中断提问」机制：当 LLM 判定用户问题存在歧义（置信度达标）
// 且澄清轮次未耗尽时，暂停生成最终回答，改为向用户列出多义解读选项；用户确认意图后
// 再基于该意图继续检索与回答，从而显著降低「答非所问 / 幻觉」概率。
//
// 设计原则：
// 1. 可复用：本目录（workflows/clarify/）为自包含模块，不依赖 query-workflow 内部实现，
//    任何「先澄清、后执行」的入口（query / 子任务派发）均可复用 runClarifyGate。
// 2. 配置化触发：confidenceThreshold / maxRounds / maxInterpretations / ttlMs /
//    skipWhenOutputMode 全量可配，由 AppConfig.clarify 注入（config.json 可覆盖）。
// 3. 不过度打断：中断次数受 maxRounds 约束；检测调用失败/解析失败一律静默跳过，
//    绝不阻塞主问答（fail-open）。

// ── 配置 ────────────────────────────────────────────────────────────────────
export interface ClarifyConfig {
  // 总开关：false 时整条澄清链路跳过（零破坏回退）
  enabled: boolean;
  // 触发阈值：LLM 判定「存在歧义」的置信度 >= 该值才中断提问（0~1，默认 0.6）。
  // 含义：模型对「确实存在多重解读」越确定才越值得打断用户。
  confidenceThreshold: number;
  // 中断轮次上限：同一 clarifyId 最多打断用户几次（默认 2）。
  // 超过后即使再检测到歧义也强制按最新推荐解读继续，兑现「不过度打断」。
  maxRounds: number;
  // 单次最多列出的解读选项数（默认 3；LLM 产出更多时截断）
  maxInterpretations: number;
  // 澄清会话有效期（ms，默认 10 分钟）：过期后 clarifyId 视为无效，
  // 用户携带过期 clarifyId 重发时按「新提问」重新检测。
  ttlMs: number;
  // 在这些 outputMode（多模态输出）下跳过澄清：多模态任务要求结构化产出，
  // 打断会破坏流程完整性；默认跳过 mindmap/faq/timeline/image/ppt。
  skipWhenOutputMode: string[];
}

export const DEFAULT_CLARIFY_CONFIG: ClarifyConfig = {
  enabled: true,
  confidenceThreshold: 0.6,
  maxRounds: 2,
  maxInterpretations: 3,
  ttlMs: 10 * 60 * 1000,
  skipWhenOutputMode: ['mindmap', 'faq', 'timeline', 'image', 'ppt'],
};

// ── 歧义检测报告（LLM 结构化输出）────────────────────────────────────────────
export interface AmbiguityInterpretation {
  label: string; // 短标题（≤10 字），用于选项按钮
  description: string; // 一句话说明该解读的具体含义
}

export interface AmbiguityReport {
  ambiguous: boolean;
  // 模型对「存在歧义」判断的置信度 0~1
  confidence: number;
  interpretations: AmbiguityInterpretation[];
  // interpretations 中最符合原意的下标
  recommendedIndex: number;
}

// ── 服务端澄清会话（内存态）──────────────────────────────────────────────────
export interface ClarifySession {
  // 澄清会话 ID（uuid）：前端每轮确认都携带同一 id，后端据此计数轮次并校验选项
  id: string;
  // 归属线程：校验用户携带的 clarifyId 与当前 threadId 匹配，防串用
  threadId: string | null;
  // 归属问题：携带 clarifyId 重发时若问题不一致则视为新提问
  question: string;
  // 已确认轮次（1 起）：收到一次用户选择则 +1，>= maxRounds 后不再打断
  round: number;
  options: Array<{ index: number; label: string; description: string }>;
  recommendedIndex: number;
  createdAt: number;
  expiresAt: number;
}

// ── 下发前端的澄清 payload（SSE clarify 事件）────────────────────────────────
export interface ClarificationPayload {
  id: string;
  round: number;
  maxRounds: number;
  question: string;
  // 中断提示语：随轮次变化（第 1 次 vs 再次确认），由 buildClarificationPrompt 生成
  prompt: string;
  interpretations: Array<{ index: number; label: string; description: string }>;
  recommendedIndex: number;
  // 归属线程 id：由 queryWorkflow 在中断 yield 时附加。用户选择后重发必须携带同一
  // threadId（后端对 clarifyId 做线程归属校验），否则后端视为新提问重新检测、
  // 轮次计数与中断上限全部失效。
  threadId?: string;
}

// ── 澄清门禁结果 ─────────────────────────────────────────────────────────────
export type ClarifySkipReason =
  | 'disabled' // 配置关闭 / 中间件关闭 / outputMode 命中跳过列表
  | 'no-ambiguity' // 检测为无歧义 / 解读不足 2 个
  | 'detector-error' // 检测调用失败或解析失败（fail-open，不阻断）
  | 'round-exceeded'; // 轮次已满：按已确认意图（或推荐解读）继续

export type ClarifyGateResult =
  // 中断：停止生成最终回答，向前端下发澄清卡片
  | { type: 'interrupt'; payload: ClarificationPayload }
  // 继续：进入正常检索回答；confirmedIntent 为用户已确认的意图文本（可能为空）
  | { type: 'continue'; confirmedIntent?: string; skipReason: ClarifySkipReason };
