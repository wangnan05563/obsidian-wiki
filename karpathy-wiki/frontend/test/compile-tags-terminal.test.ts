import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setActivePinia, createPinia } from 'pinia';
import { useCompileStore } from '../src/stores/compile';
import { STEP_LABEL } from '../src/stores/compile';

// T03613 / T03614（由 T03610 的根因 C、D 派生）
//   C：generate_tags 阶段只有 1 条聚合 running、没有聚合终态，且 done 早于 tag 阶段推送，
//      前端逐条追加 → 时间线永久残留「运行中」，与「编译完成」并存。
//   D：结果卡的 indexUpdated / pages 在全前端唯一赋值点被写死 false / []。

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '',
  apiFetch: vi.fn(),
}));

const STORAGE_KEY = 'wiki:compile:state';

type Ev = { step: string; status: string; message: string; data?: Record<string, unknown> };

function feed(store: ReturnType<typeof useCompileStore>, events: Ev[]): void {
  for (const e of events) store.handleEvent('progress', e as never);
}

describe('compile store - generate_tags 收口 (T03613)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('聚合 running + 逐页明细 + 聚合终态：时间线只留一行且为 done', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: 'x' });
    feed(store, [
      { step: 'archive', status: 'running', message: '存档中' },
      { step: 'archive', status: 'done', message: '已存档' },
      { step: 'generate_page', status: 'done', message: '步骤 1: write_file', data: { path: 'concepts/a.md' } },
      { step: 'update_index', status: 'done', message: '步骤 2: append_index', data: { title: 'a' } },
      { step: 'generate_tags', status: 'running', message: '正在为 2 个页面生成 AI tag 建议' },
      { step: 'generate_tags', status: 'done', message: '页面 concepts/a.md 生成 3 个 tag 建议', data: { path: 'concepts/a.md' } },
      { step: 'generate_tags', status: 'done', message: '页面 concepts/b.md 生成 2 个 tag 建议', data: { path: 'concepts/b.md' } },
      { step: 'generate_tags', status: 'done', message: 'AI tag 建议已生成 2/2 个页面' },
    ]);

    const tagRows = store.timeline.filter((t) => t.step === 'generate_tags');
    expect(tagRows).toHaveLength(1);
    expect(tagRows[0].status).toBe('done');
    // 折叠保留的是最后一条（聚合终态），而不是第一条 running
    expect(tagRows[0].message).toContain('AI tag 建议已生成 2/2');
    expect(store.timeline.some((t) => t.status === 'running')).toBe(false);
  });

  it('阶段行折叠不吞掉不同步骤的行', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: 'x' });
    feed(store, [
      { step: 'generate_page', status: 'done', message: 'page a', data: { path: 'concepts/a.md' } },
      { step: 'generate_page', status: 'done', message: 'page b', data: { path: 'concepts/b.md' } },
      { step: 'update_index', status: 'done', message: 'index' },
    ]);
    expect(store.timeline.map((t) => t.step)).toEqual(['generate_page', 'generate_page', 'update_index']);
  });

  it('done 事件在 tag 阶段之后到达：结果卡出现时已无运行中的 tag 行', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: 'x' });
    feed(store, [
      { step: 'generate_tags', status: 'running', message: '正在为 1 个页面生成 AI tag 建议' },
      { step: 'generate_tags', status: 'done', message: 'AI tag 建议已生成 1/1 个页面' },
    ]);
    // tag 进行中时不应有结果卡（后端不再提前推 done）
    expect(store.isDone).toBe(false);
    expect(store.timeline.filter((t) => t.step === 'generate_tags')).toHaveLength(1);

    store.handleEvent('done', { step: 'done', status: 'done', message: '编译完成，共 3 步' });
    expect(store.isDone).toBe(true);
    expect(store.timeline.filter((t) => t.step === 'generate_tags')).toHaveLength(1);
    expect(store.timeline.some((t) => t.status === 'running')).toBe(false);
  });

  it('STEP_LABEL 覆盖 generate_tags，界面不裸显英文枚举', () => {
    expect(STEP_LABEL['generate_tags']).toBe('生成 AI 标签建议');
  });

  it('刷新恢复：残留的 running 行降级为「已中断」，不再转圈', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        isCompiling: true,
        timeline: [
          { step: 'generate_page', status: 'done', message: 'page', timestamp: 1 },
          { step: 'generate_tags', status: 'running', message: '正在生成', timestamp: 2 },
        ],
      }),
    );
    setActivePinia(createPinia());
    const store = useCompileStore();
    store.loadPersistedState();

    const tagRow = store.timeline.find((t) => t.step === 'generate_tags');
    expect(tagRow?.status).toBe('interrupted');
    expect(store.timeline.some((t) => t.status === 'running')).toBe(false);
    // 已完成的行保持原样，不被误标
    expect(store.timeline[0].status).toBe('done');
  });

  it('Progress.vue 用 info 灰点渲染「已中断」而非失败红点', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/views/Progress.vue'), 'utf8');
    expect(src).toContain("status === 'interrupted'");
    const statusSrc = fs.readFileSync(path.resolve(__dirname, '../src/utils/status.ts'), 'utf8');
    expect(statusSrc).toContain('已中断');
  });
});

describe('compile store - 结果卡真值推导 (T03614)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('时间线有 update_index done：indexUpdated 为 true，pages 收齐去重路径', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: 'x' });
    feed(store, [
      { step: 'generate_page', status: 'done', message: 'a', data: { path: 'concepts/a.md' } },
      { step: 'generate_page', status: 'done', message: 'b', data: { path: 'concepts/b.md' } },
      // 同页覆写第二次：路径重复，结果卡不应列两遍
      { step: 'generate_page', status: 'done', message: 'a2', data: { path: 'concepts/a.md' } },
      { step: 'update_index', status: 'done', message: 'index' },
    ]);
    store.handleEvent('done', { step: 'done', status: 'done', message: '编译完成' });

    expect(store.result?.indexUpdated).toBe(true);
    expect(store.result?.pages).toEqual(['concepts/a.md', 'concepts/b.md']);
  });

  it('没有 append_index 事件：indexUpdated 仍为 false（不谎报）', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: 'x' });
    feed(store, [{ step: 'generate_page', status: 'done', message: 'a', data: { path: 'concepts/a.md' } }]);
    store.handleEvent('done', { step: 'done', status: 'done', message: '编译完成' });

    expect(store.result?.indexUpdated).toBe(false);
    expect(store.result?.pages).toEqual(['concepts/a.md']);
  });

  it('update_index 只到 running（未收口）不算索引更新', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: 'x' });
    feed(store, [{ step: 'update_index', status: 'running', message: '正在更新索引' }]);
    store.handleEvent('done', { step: 'done', status: 'done', message: '编译完成' });

    expect(store.result?.indexUpdated).toBe(false);
  });

  it('generate_tags 的逐页明细不会污染 pages（取最后一次折叠后的聚合行）', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: 'x' });
    feed(store, [
      { step: 'generate_page', status: 'done', message: 'a', data: { path: 'concepts/a.md' } },
      { step: 'generate_tags', status: 'running', message: 'tag running' },
      { step: 'generate_tags', status: 'done', message: '页面 concepts/a.md 生成 1 个 tag 建议', data: { path: 'concepts/a.md' } },
      { step: 'generate_tags', status: 'done', message: 'AI tag 建议已生成 1/1 个页面' },
    ]);
    store.handleEvent('done', { step: 'done', status: 'done', message: '编译完成' });

    expect(store.result?.pages).toEqual(['concepts/a.md']);
  });

  it('读取步（extract）的 page 不算产出：结果卡只列 write_file 生成的页面', () => {
    // 真机实测（/wiki/ 入口，T03613/14 验收）曾把 SCHEMA.md 与 raw/ 原件也列进「本次编译结果」，
    // 因为时间线里读取步同样带 page。结果卡语义是「产出了什么」，读了什么不该出现在这里。
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: 'x' });
    feed(store, [
      { step: 'extract', status: 'done', message: '步骤 0: read_file', data: { path: 'SCHEMA.md' } },
      { step: 'extract', status: 'done', message: '步骤 0: read_file', data: { path: 'raw/src.md' } },
      { step: 'generate_page', status: 'running', message: '写文件中', data: { path: 'concepts/partial.md' } },
      { step: 'generate_page', status: 'done', message: '步骤 1: write_file', data: { path: 'concepts/new.md' } },
    ]);
    store.handleEvent('done', { step: 'done', status: 'done', message: '编译完成' });

    expect(store.result?.pages).toEqual(['concepts/new.md']);
  });

  it('缓存命中：done 带 cached 标识时结果卡仍保留，pages 为空数组而不是 undefined', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: 'x' });
    store.handleEvent('done', {
      step: 'done',
      status: 'done',
      message: '内容已编译过（缓存命中）',
      data: { cached: true },
    });

    expect(store.result?.cached).toBe(true);
    expect(store.result?.pages).toEqual([]);
    expect(store.result?.indexUpdated).toBe(false);
  });

  it('批量模式不受影响：batch_done 不写单文件 result，分组时间线同样折叠', () => {
    const store = useCompileStore();
    store.prepareBatchCompile(new FormData());
    store.handleEvent('batch_start', { data: { fileCount: 1 } });
    store.handleEvent('file_start', {
      step: 'archive',
      status: 'running',
      data: { fileIndex: 0, fileCount: 1, fileName: 'a.doc' },
    });
    store.handleEvent('progress', {
      step: 'generate_tags',
      status: 'running',
      message: '正在为 1 个页面生成 AI tag 建议',
      data: { fileIndex: 0 },
    } as never);
    store.handleEvent('progress', {
      step: 'generate_tags',
      status: 'done',
      message: 'AI tag 建议已生成 1/1 个页面',
      data: { fileIndex: 0 },
    } as never);

    const group = store.batchGroups[0];
    expect(group.timeline.filter((t) => t.step === 'generate_tags')).toHaveLength(1);
    expect(group.timeline[0].status).toBe('done');
    expect(store.result).toBeNull();
  });

  it('失败态 done 不写结果卡：保留错误分支原样', () => {
    const store = useCompileStore();
    store.prepareCompile({ type: 'text', content: 'x' });
    feed(store, [
      { step: 'generate_page', status: 'done', message: 'a', data: { path: 'concepts/a.md' } },
      { step: 'update_index', status: 'done', message: 'index' },
    ]);
    store.handleEvent('done', { step: 'done', status: 'error', message: '编译失败: 超时' });

    expect(store.isDone).toBe(false);
    expect(store.errorMessage).toBe('编译失败: 超时');
    expect(store.result).toBeNull();
  });
});
