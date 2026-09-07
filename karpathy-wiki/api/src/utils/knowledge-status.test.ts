// knowledge-status.ts 单元测试：覆盖 AC-18 的判定优先级链
import { describe, it, expect } from 'vitest';
import { computeKnowledgeStatus } from './knowledge-status.js';

const now = new Date('2026-08-31T00:00:00Z');
const DAYS_30 = 30 * 24 * 60 * 60 * 1000;
const dayAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('computeKnowledgeStatus（FR-18 判定优先级链）', () => {
  it('无 knowledge_class → unknown（存量页面兜底）', () => {
    expect(computeKnowledgeStatus({ updated: dayAgo(1) }, 365, now)).toBe('unknown');
    expect(computeKnowledgeStatus({}, 365, now)).toBe('unknown');
  });

  it('timeless → 恒 ok，不受 updated 年龄影响', () => {
    expect(computeKnowledgeStatus({ knowledge_class: 'timeless', updated: dayAgo(3650) }, 365, now)).toBe('ok');
  });

  it('pointer → ok', () => {
    expect(computeKnowledgeStatus({ knowledge_class: 'pointer' }, 365, now)).toBe('ok');
  });

  it('dated 且未超 staleDays → ok', () => {
    expect(computeKnowledgeStatus({ knowledge_class: 'dated', updated: dayAgo(200) }, 365, now)).toBe('ok');
  });

  it('dated 且超 staleDays 且无 reviewed_at → stale', () => {
    expect(computeKnowledgeStatus({ knowledge_class: 'dated', updated: dayAgo(400) }, 365, now)).toBe('stale');
  });

  it('dated 超阈值但 reviewed_at 在保质期内 → ok（复核有效）', () => {
    expect(computeKnowledgeStatus(
      { knowledge_class: 'dated', updated: dayAgo(400), reviewed_at: dayAgo(30) }, 365, now,
    )).toBe('ok');
  });

  it('dated 超阈值且 reviewed_at 超保质期 → stale（复核本身过期）', () => {
    expect(computeKnowledgeStatus(
      { knowledge_class: 'dated', updated: dayAgo(400), reviewed_at: dayAgo(400) }, 365, now,
    )).toBe('stale');
  });

  it('大小写不规范 normalized 为小写判定', () => {
    expect(computeKnowledgeStatus({ knowledge_class: 'Dated', updated: dayAgo(400) }, 365, now)).toBe('stale');
  });

  it('updated 缺失 → 保守判 stale（dated 场景）', () => {
    expect(computeKnowledgeStatus({ knowledge_class: 'dated' }, 365, now)).toBe('stale');
  });

  it('非法 knowledge_class → unknown', () => {
    expect(computeKnowledgeStatus({ knowledge_class: 'bogus', updated: dayAgo(1) }, 365, now)).toBe('unknown');
  });
});

describe('computeKnowledgeStatus Date 兼容（YAML 无引号日期被 js-yaml 解析为 Date）', () => {
  const dateAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
  it('updated/reviewed_at 为 Date 对象时判定不误报 stale', () => {
    // dated + Date 型 updated 在有效期内 → ok
    expect(computeKnowledgeStatus({ knowledge_class: 'dated', updated: dateAgo(100) }, 365, now)).toBe('ok');
    // dated + Date 型 updated 超阈值但 Date 型 reviewed_at 在保质期内 → ok
    expect(computeKnowledgeStatus(
      { knowledge_class: 'dated', updated: dateAgo(500), reviewed_at: dateAgo(30) }, 365, now,
    )).toBe('ok');
  });
});