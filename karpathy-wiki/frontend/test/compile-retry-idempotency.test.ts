// T03591：编译失败重试与幂等的前端状态流转。
// 覆盖：单文件重试预置、批量分组重试（成功/失败/幂等命中）、失败事件的重试信息留存。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setActivePinia, createPinia } from 'pinia';
import { useCompileStore } from '../src/stores/compile';
import { apiFetch } from '../src/utils/apiBase';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '',
  apiFetch: vi.fn(),
}));

const mockedFetch = vi.mocked(apiFetch);

/** 构造正常结束的 SSE Response（每块一帧） */
function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

function fileErrorEvent(overrides: Record<string, unknown> = {}) {
  return {
    step: 'finalize',
    status: 'error',
    message: '编译失败: LLM API 请求被限流（429）',
    retryable: true,
    data: {
      fileIndex: 0,
      fileCount: 1,
      fileName: 'a.doc',
      rawPath: 'raw/a.md',
      retryable: true,
      ...overrides,
    },
  };
}

function seedFailedGroup(store: ReturnType<typeof useCompileStore>) {
  store.prepareBatchCompile(new FormData());
  store.handleEvent('batch_start', { data: { fileCount: 1, rejected: [] } });
  store.handleEvent('file_start', { step: 'archive', status: 'running', data: { fileIndex: 0, fileCount: 1, fileName: 'a.doc' } });
  store.handleEvent('file_error', fileErrorEvent());
}

describe('compile store - 重试与幂等 (T03591)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockedFetch.mockReset();
  });

  it('单文件失败事件携带 retryable 时可进入重试态，且保留上一轮时间线', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: '资料' });
    store.handleEvent('done', {
      step: 'done',
      status: 'error',
      message: '编译失败: 429',
      retryable: true,
    });
    const before = store.timeline.length;

    expect(store.lastErrorRetryable).toBe(true);
    expect(store.beginRetrySingle()).toBe(true);
    expect(store.isCompiling).toBe(true);
    expect(store.errorMessage).toBe('');
    expect(store.lastErrorRetryable).toBe(false);
    expect(store.timeline.length).toBe(before + 1);
    expect(store.timeline.at(-1)!.message).toContain('重试');
  });

  it('无可复用载荷时 beginRetrySingle 返回 false，不制造空重试', () => {
    const store = useCompileStore();
    expect(store.beginRetrySingle()).toBe(false);
    expect(store.isCompiling).toBe(false);
  });

  it('不可重试的失败不亮重试入口（如鉴权失败）', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: '资料' });
    store.handleEvent('done', { step: 'done', status: 'error', message: '认证失败', retryable: false });
    expect(store.lastErrorRetryable).toBe(false);
  });

  it('批量失败事件留存 rawPath/retryable，重试成功后分组回到 done 并清空失败信息', async () => {
    const store = useCompileStore();
    seedFailedGroup(store);

    const group = store.batchGroups[0];
    expect(group.status).toBe('error');
    expect(group.rawPath).toBe('raw/a.md');
    expect(group.retryable).toBe(true);

    mockedFetch.mockResolvedValue(sseResponse([
      'event: progress\ndata: {"step":"extract","status":"running","message":"抽取要点","data":{"fileIndex":0,"fileCount":1,"fileName":"a.doc","path":"raw/a.md"}}\n\n',
      'event: file_done\ndata: {"step":"done","status":"done","message":"编译完成","data":{"fileIndex":0,"fileCount":1,"fileName":"a.doc"}}\n\n',
    ]));

    await store.retryFileGroup(0);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(String(url)).toContain('/compile/retry');
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      rawPath: 'raw/a.md',
      fileName: 'a.doc',
      fileIndex: 0,
      fileCount: 1,
    });

    expect(group.status).toBe('done');
    expect(group.errorMessage).toBe('');
    expect(group.retryable).toBe(false);
    expect(group.attempts).toBe(1);
    expect(store.retryingIndexes).toEqual([]);
    expect(store.isCompiling).toBe(false);
    expect(store.isDone).toBe(true);
    expect(store.errorMessage).toBe('');
  });

  it('重试再次失败：保留可重试入口并记录次数（可追溯）', async () => {
    const store = useCompileStore();
    seedFailedGroup(store);
    mockedFetch.mockResolvedValue(sseResponse([
      `event: file_error\ndata: ${JSON.stringify({ ...fileErrorEvent(), message: '编译失败: 503' })}\n\n`,
    ]));

    await store.retryFileGroup(0);

    const group = store.batchGroups[0];
    expect(group.status).toBe('error');
    expect(group.retryable).toBe(true);
    expect(group.attempts).toBe(1);
    expect(group.errorMessage).toContain('503');
    expect(group.timeline.at(-1)!.message).toContain('第 1 次重试');
    expect(store.isDone).toBe(false);
    expect(store.errorMessage).toContain('仍有 1 个文件失败');
  });

  it('重试命中幂等（deduped）：不误报连接断开，提示已有重试在进行', async () => {
    const store = useCompileStore();
    seedFailedGroup(store);
    mockedFetch.mockResolvedValue(sseResponse([
      'event: deduped\ndata: {"step":"deduped","status":"running","message":"这份资料正在重新编译中","data":{"fileIndex":0,"step":"extract","message":"抽取要点"}}\n\n',
    ]));

    await store.retryFileGroup(0);

    const group = store.batchGroups[0];
    expect(store.dedupeMessage).toBe('这份资料正在重新编译中');
    expect(group.status).toBe('error');
    expect(group.errorMessage).toContain('已有重试正在进行');
    expect(store.isCompiling).toBe(false);
  });

  it('缺少 rawPath 时不发请求（旧后端保持原有失败态）', async () => {
    const store = useCompileStore();
    store.prepareBatchCompile(new FormData());
    store.handleEvent('batch_start', { data: { fileCount: 1, rejected: [] } });
    store.handleEvent('file_error', {
      step: 'finalize',
      status: 'error',
      message: '失败',
      data: { fileIndex: 0, fileCount: 1, fileName: 'a.doc' },
    });

    await store.retryFileGroup(0);

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(store.batchGroups[0].status).toBe('error');
  });

  it('单文件 deduped 事件：中性提示，不标记失败', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: '资料' });

    store.handleEvent('deduped', { step: 'deduped', status: 'running', message: '相同内容正在编译中', data: {} });

    expect(store.dedupeMessage).toBe('相同内容正在编译中');
    expect(store.isCompiling).toBe(false);
    expect(store.errorMessage).toBe('');
    expect(store.isDone).toBe(false);
  });

  it('Progress.vue 提供批量分组重试与单文件重试入口，重试中禁用', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/views/Progress.vue'), 'utf8');
    expect(src).toContain('@click="retryGroup(group.fileIndex)"');
    expect(src).toContain(':disabled="store.retryingIndexes.length > 0"');
    expect(src).toContain('@click="retrySingle"');
    expect(src).toContain('group.retryable && group.rawPath');
  });
});
