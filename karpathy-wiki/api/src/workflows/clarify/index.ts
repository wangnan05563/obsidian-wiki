// 意图澄清模块统一出口。
// 对外暴露：类型 / 默认配置 / 会话存储 / 门禁编排 / 检测器（供测试）。
// 使用方法：
//   const store = new ClarifySessionStore();
//   const result = await runClarifyGate({ harnessConfig, config, store, question, threadId });
//   if (result.type === 'interrupt') { /* yield clarify 事件并结束流 */ }
//   else { /* 注入 result.confirmedIntent 到 prompt 后继续问答 */ }
export type {
  AmbiguityInterpretation,
  AmbiguityReport,
  ClarificationPayload,
  ClarifyConfig,
  ClarifyGateResult,
  ClarifySession,
  ClarifySkipReason,
} from './clarify-types.js';
export { DEFAULT_CLARIFY_CONFIG } from './clarify-types.js';
export { ClarifySessionStore } from './clarify-store.js';
export { buildClarificationPayload, buildClarificationPrompt, runClarifyGate } from './gate.js';
export type { ClarifyGateParams } from './gate.js';
export { detectAmbiguity } from './ambiguity-detector.js';
