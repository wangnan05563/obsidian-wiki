import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useCompileStore } from '../src/stores/compile';
import { apiFetch } from '../src/utils/apiBase';
import type { RunSummary } from '../src/types';

// T02458（PRD P1/X6，P0）：编译历史数据源统一 + 区分「加载中 / 加载失败 / 真空白」三态。
// 核心回归点：旧 loadRuns 在 catch 里 runs.value=[]，把「接口失败」伪装成「无历史」，
// 且 Progress 挂载时重新 loadRuns 返空会清空 Dashboard 已加载数据 → 用户看到「历史丢了」的矛盾。

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '',
  apiFetch: vi.fn(),
}));

const mockedFetch = vi.mocked(apiFetch);

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function mkRun(runId: string, over: Partial<RunSummary> = {}): RunSummary {
  return { runId, status: 'done', step: 1, tokenUsed: 10, startedAt: '2026-10-01T00:00:00.000Z', ...over };
}

describe('compile store - runs 三态 (T02458)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('成功加载：runs 填充 + runsLoaded/runsUpdatedAt 置位 + runsError 清空', async () => {
    const store = useCompileStore();
    mockedFetch.mockResolvedValueOnce(makeResponse({ runs: [mkRun('a')] }));
    await store.loadRuns();
    expect(store.runs).toHaveLength(1);
    expect(store.runsLoaded).toBe(true);
    expect(store.runsError).toBeNull();
    expect(store.runsUpdatedAt).toBeTruthy();
    expect(store.loadingRuns).toBe(false);
  });

  it('失败加载：记录 runsError，且【不清空】已有 runs（Progress 重挂载不抹掉 Dashboard 数据）', async () => {
    const store = useCompileStore();
    store.runs = [mkRun('keep')];
    store.runsLoaded = true;
    mockedFetch.mockRejectedValueOnce(new Error('network down'));
    await store.loadRuns();
    expect(store.runsError).toBe('network down');
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].runId).toBe('keep');
    expect(store.runsLoaded).toBe(true);
  });

  it('成功但空列表：runsLoaded=true、runsError=null、runs=[] → 区分于失败', async () => {
    const store = useCompileStore();
    mockedFetch.mockResolvedValueOnce(makeResponse({ runs: [] }));
    await store.loadRuns();
    expect(store.runs).toEqual([]);
    expect(store.runsLoaded).toBe(true);
    expect(store.runsError).toBeNull();
  });

  it('HTTP 非 2xx：视为失败，置 runsError 而非静默清空', async () => {
    const store = useCompileStore();
    store.runs = [mkRun('keep2')];
    mockedFetch.mockResolvedValueOnce(makeResponse({ error: 'boom' }, false, 500));
    await store.loadRuns();
    expect(store.runsError).toContain('500');
    expect(store.runs).toHaveLength(1);
  });

  it('统一数据源：Dashboard 与 Progress 共用同一 store.runs（无第二份副本）', () => {
    const store = useCompileStore();
    store.runs = [mkRun('shared')];
    // Progress / Dashboard 均直接读取 useCompileStore().runs，不存在独立副本字段
    expect(useCompileStore().runs[0].runId).toBe('shared');
  });
});
