import { describe, it, expect } from 'vitest';
import { stepStatusLabel } from '../src/utils/status';

// T02459（PRD P3）：编译状态枚举 → 中文，禁止裸枚举渲染给用户
describe('stepStatusLabel (T02459 / PRD P3)', () => {
  it('done → 完成', () => {
    expect(stepStatusLabel('done')).toBe('完成');
  });
  it('failed → 失败', () => {
    expect(stepStatusLabel('failed')).toBe('失败');
  });
  it('error → 失败（时间线/分组实际用 error 而非 failed）', () => {
    expect(stepStatusLabel('error')).toBe('失败');
  });
  it('running → 运行中', () => {
    expect(stepStatusLabel('running')).toBe('运行中');
  });
  it('未知枚举兜底原样返回（不暴漏英文）', () => {
    expect(stepStatusLabel('pending')).toBe('pending');
  });
});
