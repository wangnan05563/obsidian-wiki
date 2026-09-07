// 歧义检测器：通过一次轻量 LLM 调用，判断用户问题是否存在多义解读，并产出结构化解读选项。
// 实现要点：
// 1. 复用调用方的 harnessConfig（含 BYOK per-user LLM 覆盖），单轮无工具调用，预算极小；
// 2. fail-open：任何异常（网络/超时/JSON 解析失败/字段非法）都返回 null，由门禁跳过澄清，
//    绝不阻断主问答（与降级链哲学一致：澄清是增值能力，不是可靠性依赖）；
// 3. 结果严格校验 + 归一化，防 LLM 输出脏数据（代码块包裹、多余文本、字段缺失）。
import type { HarnessConfig } from '@wiki/harness';
import { Harness } from '@wiki/harness';
import fs from 'node:fs/promises';
import { getPromptPath } from '../../utils/runtime.js';
import type { AmbiguityReport } from './clarify-types.js';

// 加载 clarify prompt 单点存储（与 query/compile 共用 prompts/ 目录，保证两阶段等价）
let _clarifyPromptCache: string | null = null;
async function loadClarifyPrompt(): Promise<string> {
  if (_clarifyPromptCache !== null) return _clarifyPromptCache;
  _clarifyPromptCache = await fs.readFile(getPromptPath('clarify.md'), 'utf8');
  return _clarifyPromptCache;
}

// 从 LLM 输出中稳健提取 JSON：容忍 ```json ... ``` 代码块包裹与前后多余文本。
// 策略：取首个 '{' 到末个 '}' 之间的子串尝试解析，失败返回 null。
// 导出供单元测试直接覆盖解析容错场景。
export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

// 归一化 + 校验 LLM 返回的报告：非法字段回退默认值，不抛异常。
// 导出供单元测试直接覆盖解析容错场景（mock harness 不便时）。
export function normalizeReport(data: unknown): AmbiguityReport | null {
  // 数组在 typeof 下也是 'object'，需显式排除（LLM 可能输出 JSON 数组等畸形结构）
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const ambiguous = d.ambiguous === true || d.ambiguous === false ? d.ambiguous : false;
  const confidence =
    typeof d.confidence === 'number' && Number.isFinite(d.confidence)
      ? Math.min(1, Math.max(0, d.confidence))
      : 0;
  // interpretations 归一化：仅保留 label/description 均为非空字符串的项
  const interpretations = Array.isArray(d.interpretations)
    ? d.interpretations
        .map((it) => {
          if (typeof it !== 'object' || it === null) return null;
          const label = typeof (it as Record<string, unknown>).label === 'string'
            ? ((it as Record<string, unknown>).label as string).trim()
            : '';
          const description = typeof (it as Record<string, unknown>).description === 'string'
            ? ((it as Record<string, unknown>).description as string).trim()
            : '';
          if (!label && !description) return null;
          return {
            // label 缺失时用 description 前 10 字兜底
            label: label || description.slice(0, 10),
            description,
          };
        })
        .filter((it): it is NonNullable<typeof it> => it !== null)
    : [];
  const recommendedIndex =
    typeof d.recommendedIndex === 'number' && Number.isInteger(d.recommendedIndex)
      ? d.recommendedIndex
      : 0;
  return { ambiguous, confidence, interpretations, recommendedIndex };
}

// 构造 clarify 检测 prompt：模板 + 用户问题 + 可选历史对话（帮助消解指代）
async function buildClarifyTask(question: string, history?: Array<{ role: string; content: string }>): Promise<string> {
  const template = await loadClarifyPrompt();
  const historyText = history && history.length > 0
    ? `\n## 历史对话（用于消解指代）\n${history.map((h) => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`).join('\n')}`
    : '';
  return `${template.replace('{question}', question)}${historyText}`;
}

// 执行歧义检测。返回 null 表示「无法判定」（视为无歧义，不中断）。
// harnessConfig：复用调用方配置（含 per-user 覆盖）；仅做单轮无工具调用，token 开销极低。
export async function detectAmbiguity(
  harnessConfig: HarnessConfig,
  question: string,
  history?: Array<{ role: string; content: string }>,
): Promise<AmbiguityReport | null> {
  if (!question || !question.trim()) return null;
  const task = await buildClarifyTask(question.trim(), history);
  const clarifyConfig: HarnessConfig = {
    ...harnessConfig,
    tools: [],
    // 单轮 + 小预算：澄清检测是轻量预检，不参与 ReAct 循环
    budget: { maxSteps: 1, tokenBudget: 2048 },
    hooks: {},
  };
  const harness = new Harness(clarifyConfig);
  const result = await harness.run({ task });
  if (result.status === 'failed') return null;
  const report = normalizeReport(extractJsonObject(result.finalContent || ''));
  return report;
}
