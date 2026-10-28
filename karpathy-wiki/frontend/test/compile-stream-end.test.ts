import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setActivePinia, createPinia } from 'pinia';
import { useCompileStore } from '../src/stores/compile';

// T03438：编译流「干净结束但没有终止事件」时不能停在「正在编译」。
// 生产现象：40 文档批量编译后进度页永久停在「正在编译 0/0 个页面 0%」，
// 既无错误提示也无重试入口——根因是流的读取正常返回（服务端重启/代理断流），
// 前端只把 isCompiling 留在 true，没有任何兜底。

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '',
  apiFetch: vi.fn(),
}));

const STORAGE_KEY = 'wiki:compile:state';

describe('compile store - 流静默断开兜底 (T03438)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('编译中流干净结束：退出编译态 + 明确错误文案 + 清持久化', () => {
    const store = useCompileStore();
    store.prepareBatchCompile(new FormData());
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ isCompiling: true }));

    store.handleStreamEnd();

    expect(store.isCompiling).toBe(false);
    expect(store.errorMessage).toContain('编译连接已断开');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('自定义原因优先：停服原因直接透出给用户', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: 'x' });

    store.handleStreamEnd('服务端已重启，编译连接已中断');

    expect(store.errorMessage).toBe('服务端已重启，编译连接已中断');
  });

  it('正常完成后调用是空操作：不把成功伪装成失败', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: 'x' });
    store.handleEvent('done', { step: 'finalize', status: 'done', message: '完成' });

    store.handleStreamEnd();

    expect(store.errorMessage).toBe('');
    expect(store.isDone).toBe(true);
  });

  it('未在编译时调用是空操作：不产生无源错误', () => {
    const store = useCompileStore();

    store.handleStreamEnd();

    expect(store.errorMessage).toBe('');
    expect(store.isCompiling).toBe(false);
  });

  it('server-shutdown 事件：批量模式置错误态，保留已编译分组供查看', () => {
    const store = useCompileStore();
    store.prepareBatchCompile(new FormData());
    store.handleEvent('batch_start', { data: { fileCount: 2 } });
    store.handleEvent('file_start', {
      step: 'archive',
      status: 'running',
      data: { fileIndex: 0, fileCount: 2, fileName: 'a.doc' },
    });

    store.handleEvent('server-shutdown', { reason: 'SIGTERM' });

    expect(store.isCompiling).toBe(false);
    expect(store.errorMessage).toContain('服务端已重启');
    expect(store.batchGroups).toHaveLength(2);
  });

  it('server-shutdown 后不再触碰分组状态：后续事件不会把错误态改回成功', () => {
    const store = useCompileStore();
    store.prepareBatchCompile(new FormData());
    store.handleEvent('batch_start', { data: { fileCount: 1 } });

    store.handleEvent('server-shutdown', { reason: 'SIGTERM' });

    expect(store.isDone).toBe(false);
    expect(store.isCancelled).toBe(false);
  });

  it('Progress.vue 的首连与 resume 两条消费路径都接了兜底', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/views/Progress.vue'), 'utf8');
    const parts = src.split('await consumeCompileSSE(response);');
    // 两条消费路径：startCompile（首次投递）与 startResume（断点续传）
    expect(parts).toHaveLength(3);
    for (const after of parts.slice(1)) {
      expect(after.slice(0, 400)).toContain('store.handleStreamEnd()');
    }
  });
});
