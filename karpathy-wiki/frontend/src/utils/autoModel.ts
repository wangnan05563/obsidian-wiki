// auto（自动）模型模式：与 workbuddy 的 auto 机制一致——
// 用户无需手动指定具体模型，系统从「已配置好的模型列表」中自动选择最合适的模型进行问答。
//
// 为什么放前端解析：本应用的模型密钥为 BYOK（每用户各自配置、存于客户端 IndexedDB），
// 后端不持有用户的 per-preset API Key，因此「自动选择」必须在前端完成——
// 选定预设后取该用户的 BYOK 配置（provider/baseUrl/apiKey/model）下发，后端仅做 BYOK 校验。
// 该纯函数作为 auto 选择的单一事实来源，桌面与移动端共用，保证两端逻辑完全一致。

import type { LlmPreset } from '../types';
import { loadAiUserConfigForPreset, type AiUserConfig } from '../services/userConfig';

// auto 模式哨兵值。选中 auto 时模型记为该值，实际模型在发起问答时由 resolveAutoPreset 动态择优。
export const AUTO_MODEL = 'auto';

// 自动模式能力优先级（配置化，按"能力更强 → 更弱"排序的模型名子串）。
// auto 时优先选用能力更强的已配置模型；单点维护，避免散落硬编码（CODING config-driven）。
// 与 workbuddy 的 auto 模型选择机制对齐：从已配置模型列表中按能力优先级自动择优。
// 调序即可调整 auto 的取向，无需改动选择逻辑本身。
export const AUTO_MODEL_PRIORITY: string[] = [
  'gpt-4o',
  'claude',
  'glm-4',
  'deepseek',
  'qwen-max',
  'qwen2.5',
  'qwen-plus',
  'gpt-4',
  'gpt-3.5',
  'glm-3',
  'moonshot',
  'doubao',
  'agnes',
  'ollama',
];

// 从已配置模型列表（presets）自动选择最合适的预设。
// 选择逻辑（与 workbuddy auto 一致：能力更强的默认模型优先，无命中则用列表首个 = 系统默认）：
//   1) 命中 AUTO_MODEL_PRIORITY 中任一子串的预设（按优先级顺序，首个命中即返回）——能力最优；
//   2) 否则返回列表第一个预设（系统默认模型）；
//   3) 空列表返回 null。
// 仅依赖 preset.model 子串匹配，与厂商/baseUrl 无关，新增预设无需改此处。
export function resolveAutoPreset(presets: LlmPreset[] | null | undefined): LlmPreset | null {
  if (!presets || presets.length === 0) return null;
  const lower = AUTO_MODEL_PRIORITY.map((s) => s.toLowerCase());
  for (const key of lower) {
    const hit = presets.find((p) => (p.model || '').toLowerCase().includes(key));
    if (hit) return hit;
  }
  return presets[0];
}

// 按能力优先级排序预设：命中 AUTO_MODEL_PRIORITY 子串的排前（保持优先级顺序），
// 未命中的排后（保持原列表顺序）。作为 auto 择优的统一遍历顺序，保证桌面/移动端一致。
// 仅依赖 preset.model 子串匹配，与厂商/baseUrl 无关，新增预设无需改此处。
export function orderPresetsByAutoPriority(presets: LlmPreset[]): LlmPreset[] {
  const lower = AUTO_MODEL_PRIORITY.map((s) => s.toLowerCase());
  const ranked: Array<{ p: LlmPreset; idx: number }> = [];
  const rest: LlmPreset[] = [];
  for (const p of presets) {
    const idx = lower.findIndex((k) => (p.model || '').toLowerCase().includes(k));
    if (idx >= 0) ranked.push({ p, idx });
    else rest.push(p);
  }
  ranked.sort((a, b) => a.idx - b.idx);
  return [...ranked.map((r) => r.p), ...rest];
}

// auto（自动）模式「已配置」择优：从**用户已配置 apiKey** 的预设中按能力优先级挑选，
// 保证 auto 选中并发往后端的模型必然已配置，杜绝「解析到用户未配置的预设 →
// 前端判定无 apiKey 不发 llmConfig → 后端 BYOK 校验 400（请求参数有误）」的问题。
// 复用 loadAiUserConfigForPreset（与单选预设、下发 llmConfig 完全一致的校验口径），
// 因此 selected=auto 时实际下发的 llmConfig 必然来自一个真实可用的预设。
// 退化路径：若用户任一预设都未配置 apiKey，回退优先级首个（交后端 400 给出明确的「请先配置 API」指引），
// 再回退列表首个（presets 非空但优先级未命中时）。空列表返回 null。
export async function resolveAutoPresetForUser(
  userId: string,
  presets: LlmPreset[] | null | undefined,
): Promise<{ preset: LlmPreset | null; config: AiUserConfig | null }> {
  if (!presets || presets.length === 0) return { preset: null, config: null };
  const ordered = orderPresetsByAutoPriority(presets);
  for (const p of ordered) {
    const cfg = await loadAiUserConfigForPreset(userId, p.key, p);
    if (cfg && cfg.apiKey && cfg.apiKey.trim() !== '') {
      return { preset: p, config: cfg };
    }
  }
  // 无任一预设已配置：回退优先级首个，使后端返回清晰的「请先配置 API」提示
  // （而非选中不可用的预设却不发 llmConfig 造成更隐晦的失败）。
  const first = ordered[0];
  const cfg = first ? await loadAiUserConfigForPreset(userId, first.key, first) : null;
  return { preset: first ?? null, config: cfg };
}
