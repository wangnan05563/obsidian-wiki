// FR-12「AI 伙伴」预设的激活口径（T02917 收敛为单一函数）。
//
// 为什么需要独立模块：技能是否「被加载」此前有两处各自解读——
//   ① routes/ai.ts 的 syncAdapterConfig 用 `skills.find(s => s.id === activeSkill)`，
//      完全不看 enabled，所以在 config.json 里把当前伙伴改成 enabled:false 后，
//      它的 systemPrompt / scope 仍留在 adapter 内存里继续影响问答；
//   ② 进程启动时根本没有恢复伙伴，adapter 的 activeSystemPrompt 是 undefined，
//      于是「界面显示已选伙伴、实际问答不带伙伴指令」，重启即失效。
// 两处都改走本模块，enabled 才真的是加载开关。
import type { AppConfig, EngineAdapter, SkillPreset } from '../types.js';

/**
 * 解析当前激活的预设。
 *
 * 返回 undefined 表示「不加载任何伙伴指令」，以下三种情况同等对待：
 * 没有 activeSkill、列表里找不到该 id、找到了但被显式禁用。
 * `enabled` 缺失按启用处理（`=== false` 才算禁用），与 SkillMeta.enabled 同一默认口径，
 * 避免存量 config.json（写于该字段可选之前）升级后静默失效。
 */
export function resolveActivePreset(
  skills: SkillPreset[] | undefined,
  activeSkill: string | undefined,
): SkillPreset | undefined {
  if (!activeSkill) return undefined;
  const found = skills?.find((s) => s.id === activeSkill);
  if (!found || found.enabled === false) return undefined;
  return found;
}

/**
 * 把激活预设的运行字段整理成 adapter.updateConfig 的入参。
 * 未激活时一律回落默认值（空提示词 + 全库范围），让「禁用」在内存里也立刻生效。
 */
export function buildPresetUpdates(
  activeSkill: string | undefined,
  preset: SkillPreset | undefined,
): { activeSkill: string; systemPrompt: string; scope: SkillPreset['scope']; outputFormat: string; model?: string } {
  const updates = {
    activeSkill: activeSkill ?? '',
    systemPrompt: preset?.systemPrompt ?? '',
    scope: preset?.scope ?? 'all',
    outputFormat: preset?.outputFormat ?? '',
  };
  // 与既有行为一致：预设没声明 model 时不改全局模型（不在此单里扩成「回落全局 model」）
  if (preset?.model) {
    return { ...updates, model: preset.model };
  }
  return updates;
}

/**
 * 进程启动时按落盘的 config.json 恢复伙伴（禁用项不恢复）。
 * 为什么单独导出：index.ts 只留一行调用，避免启动主流程继续膨胀。
 */
export function applyActivePresetToAdapter(adapter: EngineAdapter, config: AppConfig): void {
  const preset = resolveActivePreset(config.skills, config.activeSkill);
  adapter.updateConfig(buildPresetUpdates(config.activeSkill, preset));
}
