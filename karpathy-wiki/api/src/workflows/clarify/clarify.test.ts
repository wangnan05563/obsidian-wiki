// 意图澄清模块单元测试。
// 覆盖：
// 1. ClarifySessionStore：TTL 过期清理、容量上限淘汰最旧、get/upsert 基本行为
// 2. runClarifyGate 全部分支：开关/输出模式跳过、clarifyId 归属校验、选项解析（合法/越界/-1）、
//    轮次递增与上限、置信度阈值、选项截断、单一解读、检测器失败 fail-open
// 3. ambiguity-detector：LLM 脏输出解析容错（代码块包裹/字段缺失/非法类型归一化）
import { describe, it, expect, vi } from 'vitest';
import { ClarifySessionStore } from './clarify-store.js';
import { runClarifyGate, buildClarificationPrompt } from './gate.js';
import { normalizeReport, extractJsonObject } from './ambiguity-detector.js';
import { DEFAULT_CLARIFY_CONFIG } from './clarify-types.js';
import type { ClarifyConfig, ClarifySession } from './clarify-types.js';

// 测试配置：阈值 0.6 / 最多 2 轮 / 最多 3 选项 / TTL 大值避免误过期
const TEST_CONFIG: ClarifyConfig = {
  ...DEFAULT_CLARIFY_CONFIG,
  ttlMs: 60_000,
};

// 构造一个合法会话（供 store 测试）
function makeSession(overrides: Partial<ClarifySession> = {}): ClarifySession {
  const now = Date.now();
  return {
    id: 'c-test-1',
    threadId: null,
    question: '什么是苹果？',
    round: 1,
    options: [
      { index: 0, label: '水果苹果', description: '指可食用的苹果水果' },
      { index: 1, label: '苹果公司', description: '指 Apple 公司相关话题' },
    ],
    recommendedIndex: 0,
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

// 门禁测试的默认参数（detect 注入 mock）
type GateParams = Parameters<typeof runClarifyGate>[0];
function gateParams(
  overrides: Partial<GateParams> = {},
  detect?: GateParams['detect'],
): GateParams {
  return {
    harnessConfig: { llm: {} } as GateParams['harnessConfig'],
    config: TEST_CONFIG,
    store: new ClarifySessionStore(),
    question: '什么是苹果？',
    threadId: null,
    detect,
    ...overrides,
  };
}

describe('ClarifySessionStore', () => {
  it('upsert 后可 get 到同一会话', () => {
    const store = new ClarifySessionStore();
    const s = makeSession();
    store.upsert(s);
    expect(store.get('c-test-1')).toEqual(s);
    expect(store.get('missing')).toBeUndefined();
  });

  it('TTL 过期后 get 返回 undefined（懒清理）', () => {
    const store = new ClarifySessionStore();
    const s = makeSession({ expiresAt: Date.now() - 1 });
    store.upsert(s);
    expect(store.get('c-test-1')).toBeUndefined();
    // 过期项已清理
    expect(store.size).toBe(0);
  });

  it('超出容量上限时淘汰最早创建的会话', () => {
    const store = new ClarifySessionStore();
    // 填满上限
    for (let i = 0; i < ClarifySessionStore.MAX_SESSIONS; i++) {
      store.upsert(makeSession({ id: `c-${i}`, createdAt: 1000 + i }));
    }
    expect(store.size).toBe(ClarifySessionStore.MAX_SESSIONS);
    // 再插入一个 → 最早创建（c-0）被淘汰
    store.upsert(makeSession({ id: 'c-new', createdAt: 999_999 }));
    expect(store.size).toBe(ClarifySessionStore.MAX_SESSIONS);
    expect(store.get('c-0')).toBeUndefined();
    expect(store.get('c-new')).toBeDefined();
  });
});

describe('runClarifyGate — 跳过条件（fail-open）', () => {
  it('配置关闭 → continue/disabled，不调用检测器', async () => {
    const detect = vi.fn(async () => ({ ambiguous: true, confidence: 0.9, interpretations: [], recommendedIndex: 0 }));
    const result = await runClarifyGate(gateParams({ config: { ...TEST_CONFIG, enabled: false } }, detect as never));
    expect(result).toEqual({ type: 'continue', skipReason: 'disabled' });
    expect(detect).not.toHaveBeenCalled();
  });

  it('outputMode 命中 skipWhenOutputMode → continue/disabled', async () => {
    const detect = vi.fn(async () => null);
    const result = await runClarifyGate(gateParams({ outputMode: 'mindmap' }, detect as never));
    expect(result.type).toBe('continue');
    if (result.type !== 'continue') return;
    expect(result.skipReason).toBe('disabled');
    expect(detect).not.toHaveBeenCalled();
  });

  it('携带附件 → continue/disabled（附件提供上下文，续答不重传附件）', async () => {
    const detect = vi.fn(async () => null);
    const result = await runClarifyGate(gateParams({ hasAttachments: true }, detect as never));
    expect(result.type).toBe('continue');
    if (result.type !== 'continue') return;
    expect(result.skipReason).toBe('disabled');
    expect(detect).not.toHaveBeenCalled();
  });

  it('检测器抛异常 → continue/detector-error（不阻断主问答）', async () => {
    const result = await runClarifyGate(gateParams({}, (async () => {
      throw new Error('llm down');
    }) as never));
    expect(result.type).toBe('continue');
    if (result.type !== 'continue') return;
    expect(result.skipReason).toBe('detector-error');
  });
});

describe('runClarifyGate — 无歧义路径', () => {
  it('检测为无歧义 → continue/no-ambiguity', async () => {
    const result = await runClarifyGate(gateParams({}, (async () => ({
      ambiguous: false,
      confidence: 0.2,
      interpretations: [],
      recommendedIndex: 0,
    })) as never));
    expect(result).toEqual({ type: 'continue', skipReason: 'no-ambiguity' });
  });

  it('判定歧义但置信度低于阈值 → continue/no-ambiguity', async () => {
    const result = await runClarifyGate(gateParams({}, (async () => ({
      ambiguous: true,
      confidence: 0.3,
      interpretations: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      recommendedIndex: 0,
    })) as never));
    expect(result).toEqual({ type: 'continue', skipReason: 'no-ambiguity' });
  });

  it('检测返回 null（解析失败）→ continue/no-ambiguity', async () => {
    const result = await runClarifyGate(gateParams({}, (async () => null) as never));
    expect(result.type).toBe('continue');
    if (result.type !== 'continue') return;
    expect(result.skipReason).toBe('no-ambiguity');
  });

  it('只有一个有效解读 → continue/no-ambiguity（避免"一个选项怎么选"的尴尬卡片）', async () => {
    const result = await runClarifyGate(gateParams({}, (async () => ({
      ambiguous: true,
      confidence: 0.9,
      interpretations: [{ label: '唯一解读', description: 'x' }],
      recommendedIndex: 0,
    })) as never));
    expect(result).toEqual({ type: 'continue', skipReason: 'no-ambiguity' });
  });
});

describe('runClarifyGate — 中断路径', () => {
  const ambiguousReport = (interpretations = [
    { label: '水果苹果', description: '指可食用的苹果水果' },
    { label: '苹果公司', description: '指 Apple 公司' },
    { label: '苹果设备', description: '指 iPhone 等设备' },
  ]) => ({
    ambiguous: true,
    confidence: 0.85,
    interpretations,
    recommendedIndex: 0,
  });

  it('检测到歧义且置信度达标 → interrupt，payload 正确（round=1）', async () => {
    const store = new ClarifySessionStore();
    const result = await runClarifyGate(gateParams({ store }, (async () => ambiguousReport()) as never));
    expect(result.type).toBe('interrupt');
    if (result.type !== 'interrupt') return;
    expect(result.payload.round).toBe(1);
    expect(result.payload.maxRounds).toBe(TEST_CONFIG.maxRounds);
    expect(result.payload.question).toBe('什么是苹果？');
    expect(result.payload.interpretations.length).toBe(3);
    // 选项 index 重新编号 0..N
    expect(result.payload.interpretations.map((o) => o.index)).toEqual([0, 1, 2]);
    // 提示语含"选择"引导
    expect(result.payload.prompt).toContain('请选择');
    // 会话已写入 store（前端携带 id 续答）
    expect(store.get(result.payload.id)).toBeDefined();
  });

  it('LLM 给的选项超过 maxInterpretations 时截断', async () => {
    const five = ambiguousReport([
      { label: 'A', description: '1' },
      { label: 'B', description: '2' },
      { label: 'C', description: '3' },
      { label: 'D', description: '4' },
      { label: 'E', description: '5' },
    ]);
    const result = await runClarifyGate(gateParams({}, (async () => five) as never));
    expect(result.type).toBe('interrupt');
    if (result.type !== 'interrupt') return;
    expect(result.payload.interpretations.length).toBe(3);
  });

  it('第二轮携带同一 clarifyId 且再次歧义 → 同一 id、round=2', async () => {
    const store = new ClarifySessionStore();
    const first = await runClarifyGate(gateParams({ store }, (async () => ambiguousReport()) as never));
    expect(first.type).toBe('interrupt');
    if (first.type !== 'interrupt') return;
    const id = first.payload.id;
    // 用户选择第 0 项后重发，但仍检测到歧义
    const second = await runClarifyGate(gateParams({
      store,
      clarifyId: id,
      choiceIndex: 0,
    }, (async () => ambiguousReport([
      { label: '解读X', description: 'x' },
      { label: '解读Y', description: 'y' },
    ])) as never));
    expect(second.type).toBe('interrupt');
    if (second.type !== 'interrupt') return;
    expect(second.payload.id).toBe(id);
    expect(second.payload.round).toBe(2);
    expect(second.payload.prompt).toContain('第 2 次确认');
  });
});

describe('runClarifyGate — 用户确认后继续', () => {
  it('合法 choiceIndex → continue + confirmedIntent 为所选解读', async () => {
    const store = new ClarifySessionStore();
    // 先产生一轮澄清
    const first = await runClarifyGate(gateParams({ store }, (async () => ({
      ambiguous: true,
      confidence: 0.85,
      interpretations: [
        { label: '水果苹果', description: '指可食用的苹果水果' },
        { label: '苹果公司', description: '指 Apple 公司' },
      ],
      recommendedIndex: 0,
    })) as never));
    expect(first.type).toBe('interrupt');
    if (first.type !== 'interrupt') return;
    // 用户选择第 1 项（苹果公司），重发且不再歧义
    const second = await runClarifyGate(gateParams({
      store,
      clarifyId: first.payload.id,
      choiceIndex: 1,
    }, (async () => ({ ambiguous: false, confidence: 0.1, interpretations: [], recommendedIndex: 0 })) as never));
    expect(second.type).toBe('continue');
    if (second.type !== 'continue') return;
    expect(second.confirmedIntent).toBe('苹果公司：指 Apple 公司');
    expect(second.skipReason).toBe('no-ambiguity');
  });

  it('choiceIndex=-1（按推荐直接回答）→ confirmedIntent 为推荐解读', async () => {
    const store = new ClarifySessionStore();
    const first = await runClarifyGate(gateParams({ store }, (async () => ({
      ambiguous: true,
      confidence: 0.8,
      interpretations: [
        { label: '解读A', description: 'a' },
        { label: '解读B', description: 'b' },
      ],
      recommendedIndex: 1,
    })) as never));
    expect(first.type).toBe('interrupt');
    if (first.type !== 'interrupt') return;
    const second = await runClarifyGate(gateParams({
      store,
      clarifyId: first.payload.id,
      choiceIndex: -1,
    }, (async () => null) as never));
    expect(second.type).toBe('continue');
    if (second.type !== 'continue') return;
    expect(second.confirmedIntent).toBe('解读B：b');
  });

  it('非法 choiceIndex（越界）→ 视为未选择，重新检测', async () => {
    const store = new ClarifySessionStore();
    const first = await runClarifyGate(gateParams({ store }, (async () => ({
      ambiguous: true,
      confidence: 0.8,
      interpretations: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
      recommendedIndex: 0,
    })) as never));
    expect(first.type).toBe('interrupt');
    if (first.type !== 'interrupt') return;
    // 越界 index=9 + 检测器再次报告歧义 → 再次中断（新建 round=1，因为旧会话校验失败被废弃）
    const second = await runClarifyGate(gateParams({
      store,
      clarifyId: first.payload.id,
      choiceIndex: 9,
    }, (async () => ({
      ambiguous: true,
      confidence: 0.8,
      interpretations: [
        { label: 'X', description: 'x' },
        { label: 'Y', description: 'y' },
      ],
      recommendedIndex: 0,
    })) as never));
    expect(second.type).toBe('interrupt');
    if (second.type !== 'interrupt') return;
    expect(second.payload.round).toBe(1);
  });

  it('clarifyId 对应的问题与当前不一致 → 视为新提问', async () => {
    const store = new ClarifySessionStore();
    const first = await runClarifyGate(gateParams({ store }, (async () => ({
      ambiguous: true,
      confidence: 0.8,
      interpretations: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
      recommendedIndex: 0,
    })) as never));
    expect(first.type).toBe('interrupt');
    if (first.type !== 'interrupt') return;
    // 换了问题但携带旧 clarifyId → 归属校验失败，重新检测
    const second = await runClarifyGate(gateParams({
      store,
      clarifyId: first.payload.id,
      question: '完全不同的另一个问题',
    }, (async () => null) as never));
    expect(second.type).toBe('continue');
    if (second.type !== 'continue') return;
    expect(second.skipReason).toBe('no-ambiguity');
  });

  it('已确认意图且轮次已满 → continue/round-exceeded，不再调用检测器', async () => {
    const store = new ClarifySessionStore();
    const first = await runClarifyGate(gateParams({ store }, (async () => ({
      ambiguous: true,
      confidence: 0.85,
      interpretations: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
      recommendedIndex: 0,
    })) as never));
    expect(first.type).toBe('interrupt');
    if (first.type !== 'interrupt') return;
    const id = first.payload.id;
    // 第二轮确认（round 2 = maxRounds）
    const second = await runClarifyGate(gateParams({
      store,
      clarifyId: id,
      choiceIndex: 0,
    }, (async () => ({
      ambiguous: true,
      confidence: 0.85,
      interpretations: [
        { label: 'X', description: 'x' },
        { label: 'Y', description: 'y' },
      ],
      recommendedIndex: 0,
    })) as never));
    expect(second.type).toBe('interrupt');
    // 第三轮：round 已满 → 强制继续，带已确认意图
    const detect = vi.fn(async () => ({ ambiguous: true, confidence: 0.99, interpretations: [], recommendedIndex: 0 }));
    const third = await runClarifyGate(gateParams({
      store,
      clarifyId: id,
      choiceIndex: 1,
    }, detect as never));
    expect(third.type).toBe('continue');
    if (third.type !== 'continue') return;
    expect(third.skipReason).toBe('round-exceeded');
    expect(third.confirmedIntent).toBe('Y：y');
    expect(detect).not.toHaveBeenCalled();
  });

  it('轮次已满但无已确认意图（从未选择过）→ 按推荐解读强制继续', async () => {
    const store = new ClarifySessionStore();
    // 手工构造 round=maxRounds 的会话（模拟用户反复触发但没成功选择）
    const s = makeSession({
      id: 'c-full',
      round: TEST_CONFIG.maxRounds,
      options: [
        { index: 0, label: '推荐解读', description: '最可能' },
        { index: 1, label: '备选解读', description: '次可能' },
      ],
      recommendedIndex: 0,
    });
    store.upsert(s);
    const result = await runClarifyGate(gateParams({
      store,
      clarifyId: 'c-full',
      choiceIndex: undefined,
    }, (async () => ({
      ambiguous: true,
      confidence: 0.99,
      interpretations: [
        { label: '推荐解读', description: '最可能' },
        { label: '备选解读', description: '次可能' },
      ],
      recommendedIndex: 0,
    })) as never));
    expect(result.type).toBe('continue');
    if (result.type !== 'continue') return;
    expect(result.skipReason).toBe('round-exceeded');
    // 无已确认意图时，以本轮检测的推荐解读继续
    expect(result.confirmedIntent).toBe('推荐解读：最可能');
  });

  it('threadId 不匹配 → 归属校验失败，重新检测', async () => {
    const store = new ClarifySessionStore();
    const first = await runClarifyGate(gateParams({ store, threadId: 'thread-A' }, (async () => ({
      ambiguous: true,
      confidence: 0.8,
      interpretations: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
      recommendedIndex: 0,
    })) as never));
    expect(first.type).toBe('interrupt');
    if (first.type !== 'interrupt') return;
    // 换线程但携带旧 clarifyId
    const second = await runClarifyGate(gateParams({
      store,
      threadId: 'thread-B',
      clarifyId: first.payload.id,
    }, (async () => null) as never));
    expect(second.type).toBe('continue');
  });
});

describe('buildClarificationPrompt', () => {
  it('首轮与后续轮次提示语不同，体现"第 N 次确认"', () => {
    expect(buildClarificationPrompt(1)).toContain('请选择');
    expect(buildClarificationPrompt(2)).toContain('第 2 次确认');
    expect(buildClarificationPrompt(3)).toContain('第 3 次确认');
  });
});

describe('ambiguity-detector 解析容错', () => {
  it('正常 JSON 直接解析', () => {
    const report = normalizeReport({ ambiguous: true, confidence: 0.7, interpretations: [{ label: 'A', description: 'a' }], recommendedIndex: 0 });
    expect(report?.ambiguous).toBe(true);
    expect(report?.confidence).toBe(0.7);
  });

  it('confidence 越界时夹紧到 [0,1]', () => {
    expect(normalizeReport({ ambiguous: true, confidence: 1.5, interpretations: [], recommendedIndex: 0 })?.confidence).toBe(1);
    expect(normalizeReport({ ambiguous: true, confidence: -2, interpretations: [], recommendedIndex: 0 })?.confidence).toBe(0);
    expect(normalizeReport({ ambiguous: true, confidence: 'x', interpretations: [], recommendedIndex: 0 })?.confidence).toBe(0);
  });

  it('interpretations 脏项过滤（空 label/空 description 全空的丢弃；label 缺失用 description 前 10 字兜底）', () => {
    const report = normalizeReport({
      ambiguous: true,
      confidence: 0.9,
      interpretations: [
        { label: '', description: '' }, // 全空 → 丢弃
        null, // 非对象 → 丢弃
        { label: '', description: '这是一段很长的说明文字用于兜底' }, // label 兜底
        { label: '正常', description: 'ok' },
      ],
      recommendedIndex: 0,
    });
    expect(report?.interpretations.length).toBe(2);
    expect(report?.interpretations[0].label).toBe('这是一段很长的说明文');
    expect(report?.interpretations[1].label).toBe('正常');
  });

  it('非对象输入 → null', () => {
    expect(normalizeReport(null)).toBeNull();
    expect(normalizeReport('junk')).toBeNull();
    expect(normalizeReport([])).toBeNull();
  });

  it('extractJsonObject 容忍 Markdown 代码块包裹与前后杂文本', () => {
    const raw = '好的，分析如下：\n```json\n{"ambiguous": true, "confidence": 0.8}\n```\n以上。';
    const parsed = extractJsonObject(raw) as { ambiguous: boolean };
    expect(parsed?.ambiguous).toBe(true);
    // 无法提取时返回 null
    expect(extractJsonObject('没有 JSON')).toBeNull();
  });
});
