import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useCompileStore } from '../src/stores/compile';

// T02459（PRD P4）：阶段标签单一来源 —— 所有视图经 store.stepLabel 取中文，
// 不再各自维护私有 STEP_LABEL（7 步 / 5 步 / 硬编码 8 三套不一致）。
describe('compile store - stepLabel 单一来源 (T02459 / PRD P4)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('覆盖全部 7 个编译步骤的中文标签', () => {
    const store = useCompileStore();
    const expected: Record<string, string> = {
      archive: '存档原始资料',
      read_schema: '读取 SCHEMA',
      extract: '提取要点',
      generate_page: '生成页面',
      update_index: '更新索引',
      update_log: '记录日志',
      finalize: '收尾',
    };
    for (const [step, label] of Object.entries(expected)) {
      expect(store.stepLabel(step)).toBe(label);
    }
  });

  it('未知步骤兜底返回原 key（不丢信息）', () => {
    const store = useCompileStore();
    expect(store.stepLabel('unknown_step')).toBe('unknown_step');
  });

  it('null 返回空串', () => {
    const store = useCompileStore();
    expect(store.stepLabel(null)).toBe('');
  });
});
