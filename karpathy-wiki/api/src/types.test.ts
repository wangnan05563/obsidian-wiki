// types.ts 中 V4.0 引用信号工具 normalizeRefs 的单元测试
// 覆盖：旧 string[] → 信号对象映射、对象透传与字段补齐、非法/空输入兜底

import { describe, it, expect } from 'vitest';
import { normalizeRefs } from './types.js';

describe('normalizeRefs（V4.0 refs 双形态兼容映射）', () => {
  it('空输入返回空数组', () => {
    expect(normalizeRefs(undefined)).toEqual([]);
    expect(normalizeRefs([])).toEqual([]);
  });

  it('旧 string[] 形态映射为全 unknown/false 信号', () => {
    const result = normalizeRefs(['page-a.md', 'page-b.md']);
    expect(result).toEqual([
      { path: 'page-a.md', authority: 'unknown', confidence: false, review: false, knowledgeStatus: 'unknown' },
      { path: 'page-b.md', authority: 'unknown', confidence: false, review: false, knowledgeStatus: 'unknown' },
    ]);
  });

  it('对象形态透传已有信号', () => {
    const result = normalizeRefs([
      { path: 'page.md', authority: 'high', confidence: true, review: true, knowledgeStatus: 'stale' },
    ]);
    expect(result).toEqual([
      { path: 'page.md', authority: 'high', confidence: true, review: true, knowledgeStatus: 'stale' },
    ]);
  });

  it('对象形态缺省字段补齐为默认值', () => {
    const result = normalizeRefs([{ path: 'p.md' }]);
    expect(result[0]).toEqual({
      path: 'p.md',
      authority: 'unknown',
      confidence: false,
      review: false,
      knowledgeStatus: 'unknown',
    });
  });

  it('混合形态（string 与对象并存）逐项映射', () => {
    const result = normalizeRefs(['old.md', { path: 'new.md', authority: 'low', confidence: true, review: false, knowledgeStatus: 'ok' }]);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('old.md');
    expect(result[0].authority).toBe('unknown');
    expect(result[1].path).toBe('new.md');
    expect(result[1].authority).toBe('low');
    expect(result[1].knowledgeStatus).toBe('ok');
  });
});