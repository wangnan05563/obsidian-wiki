// T02917「技能启用状态」的语义开关用例（AI 伙伴族）。
// ------------------------------------------------------------------
// 为什么单子落在这一族：导入型技能（SKILL.md）今日没有任何 LLM 消费方——
// `grep -rn skill-service api/src` 只有 routes/skill.ts 一处引用，因此工单第 4 条
// 「禁用后问答确实不加载」在导入技能上无法成立。真正在问答链路里生效的是
// SkillPreset（config.json 的 AI 伙伴），而它此前有两处不看 enabled：
//   ① routes/ai.ts 用 skills.find(id) 直接取预设，禁用后提示词仍留在 adapter 内存；
//   ② 启动时压根没恢复预设，重启后界面显示已选、问答却不带指令。
// 本文件同时锁住「禁用 = 不加载」的判定口径与两处接线。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { AppConfig, EngineAdapter, SkillPreset } from '../src/types.js';
import { resolveActivePreset, buildPresetUpdates, applyActivePresetToAdapter } from '../src/skill/active-preset.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));

function preset(over: Partial<SkillPreset> = {}): SkillPreset {
  return {
    id: 'partner-a',
    name: '研究员',
    enabled: true,
    scope: { folder: 'concepts' },
    systemPrompt: '只引用已发布页面',
    outputFormat: 'qa',
    ...over,
  };
}

describe('resolveActivePreset：enabled 是唯一开关', () => {
  it('启用 ⇒ 返回预设', () => {
    expect(resolveActivePreset([preset()], 'partner-a')?.id).toBe('partner-a');
  });

  it('禁用 ⇒ 不加载（返回 undefined）', () => {
    expect(resolveActivePreset([preset({ enabled: false })], 'partner-a')).toBeUndefined();
  });

  it('缺 enabled 字段 ⇒ 按启用（存量 config.json 不得静默失效）', () => {
    const legacy = preset();
    delete (legacy as Partial<SkillPreset>).enabled;
    expect(resolveActivePreset([legacy], 'partner-a')?.id).toBe('partner-a');
  });

  it('未选 / 选中的 id 不存在 ⇒ 不加载', () => {
    expect(resolveActivePreset([preset()], '')).toBeUndefined();
    expect(resolveActivePreset([preset()], undefined)).toBeUndefined();
    expect(resolveActivePreset([preset()], 'partner-x')).toBeUndefined();
    expect(resolveActivePreset(undefined, 'partner-a')).toBeUndefined();
  });
});

describe('buildPresetUpdates：禁用时提示词/范围必须回落默认值', () => {
  it('启用 ⇒ 带上 systemPrompt 与 scope', () => {
    const u = buildPresetUpdates('partner-a', preset());
    expect(u.activeSkill).toBe('partner-a');
    expect(u.systemPrompt).toBe('只引用已发布页面');
    expect(u.scope).toEqual({ folder: 'concepts' });
    expect(u.outputFormat).toBe('qa');
  });

  it('禁用 ⇒ 空提示词 + 全库范围（不会残留上一次的伙伴指令）', () => {
    const u = buildPresetUpdates('partner-a', undefined);
    expect(u.systemPrompt).toBe('');
    expect(u.scope).toBe('all');
    expect(u.outputFormat).toBe('');
    expect(u.model).toBeUndefined();
  });

  it('预设声明 model 时透传，否则不动全局模型', () => {
    expect(buildPresetUpdates('partner-a', preset({ model: 'gpt-x' })).model).toBe('gpt-x');
    expect(buildPresetUpdates('partner-a', preset()).model).toBeUndefined();
  });
});

describe('applyActivePresetToAdapter：启动恢复走同一口径', () => {
  it('启用的伙伴会被灌进 adapter', () => {
    const calls: Array<Record<string, unknown>> = [];
    const adapter = { updateConfig: (u: Record<string, unknown>) => calls.push(u) } as unknown as EngineAdapter;
    const config = { skills: [preset()], activeSkill: 'partner-a' } as unknown as AppConfig;

    applyActivePresetToAdapter(adapter, config);

    expect(calls).toHaveLength(1);
    expect(calls[0].activeSkill).toBe('partner-a');
    expect(calls[0].systemPrompt).toBe('只引用已发布页面');
  });

  it('被禁用的伙伴不会被灌进 adapter（这就是「禁用后不加载」的服务端断言）', () => {
    const calls: Array<Record<string, unknown>> = [];
    const adapter = { updateConfig: (u: Record<string, unknown>) => calls.push(u) } as unknown as EngineAdapter;
    const config = { skills: [preset({ enabled: false })], activeSkill: 'partner-a' } as unknown as AppConfig;

    applyActivePresetToAdapter(adapter, config);

    expect(calls).toHaveLength(1);
    expect(calls[0].systemPrompt).toBe('');
    expect(calls[0].scope).toBe('all');
  });
});

describe('源码守护：两处接线不得退回各自解读', () => {
  const read = (rel: string) => readFileSync(path.resolve(SRC, rel), 'utf8');

  it('PUT /api/ai/config 走 resolveActivePreset，不再裸 find', () => {
    const src = read('../src/routes/ai.ts');
    expect(src).toContain("from '../skill/active-preset.js'");
    expect(src).toContain('resolveActivePreset(merged.skills, activeSkill)');
    expect(src).not.toMatch(/merged\.skills\?\.find\(\(s\)\s*=>\s*s\.id === activeSkill\)/);
  });

  it('启动时恢复伙伴（之前只在保存配置时才灌入）', () => {
    const src = read('../src/index.ts');
    expect(src).toContain('applyActivePresetToAdapter(adapter, config)');
  });
});
