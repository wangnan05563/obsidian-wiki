// T02773 前端行为侧：清理成功后「释放 X MB」必须真的出现在界面上。
// ------------------------------------------------------------------
// 后端字段名叫 totalFreedMb、前端读 total_freed_mb 时，两侧类型各自都能编译通过，
// 页面也不报错——只是那段正反馈永远不显示。这类「显示吃掉事实」的缺陷，
// 用源码文本断言只能证明「读的是这个名字」，证明不了「读得到并渲染出来」，
// 所以这里走组件层：按后端真实响应体喂数据，断言 toast 与结果区的文案。
//
// 三个必锁的分支：
//   1) 有释放量 → toast 与结果区都出现「释放 X MB」；
//   2) 后端没给这个字段（没删任何文件 / 仅预览）→ 不出现「释放」，而不是出现「释放 0 MB」；
//   3) 释放量真的是 0 → 仍然显示（存在性判断必须是 !== undefined，
//      被 S7735 的「auto-fix」改成 truthy 判断就会把 0 吃掉，口径重新分叉）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Cleanup from '../src/views/Cleanup.vue';
import { apiFetch } from '../src/utils/apiBase';
import type { CleanupStorageStatus } from '../src/types';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/wiki/api',
  apiFetch: vi.fn(),
}));
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
    ElMessageBox: { confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn(), alert: vi.fn() },
  };
});

// 逐字照 POST /api/cleanup 的真实响应体构造（键名由 api/test/cleanup-freed-contract.test.ts 锁死）。
// 这里刻意不加 `as CleanupResult`：喂给组件的必须是「线上形状」，
// 一旦前端镜像类型改名而组件跟着改，这个 fixture 仍按后端形状渲染，用例就会红。
function wireResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target: 'run_logs',
    days: 7,
    dry_run: false,
    cleaned: ['已删除日志 run-2026-09.log (1.5MB)'],
    errors: [],
    count: 1,
    total_freed_mb: 1.5,
    ...over,
  };
}

const status: CleanupStorageStatus = {
  active: { compile: 0, query: 0, blockedTargets: [], blockedReasons: [] },
  compileCache: { exists: true, sizeMb: 0.4, entryCount: 12 },
  runState: {
    fileCount: 2,
    sizeMb: 0.1,
    oldest: '2026-09-20',
    // T02808：卡计数与目录清单成对（各目录计数之和 = fileCount）
    dirs: [{ path: '/data/.harness/state', fileCount: 2, sizeMb: 0.1, role: 'canonical', exists: true }],
  },
  runLogs: { fileCount: 9, sizeMb: 4.5, oldest: '2026-08-11' },
  rawArchive: { fileCount: 3, sizeMb: 2.2, oldest: '2026-07-30' },
};

function makeResponse(data: unknown, httpStatus = 200) {
  return { ok: httpStatus < 400, status: httpStatus, json: () => Promise.resolve(data) } as never;
}

async function mountCleanup(payload: Record<string, unknown>) {
  vi.mocked(apiFetch).mockImplementation((url: string | URL | Request) => {
    if (String(url).includes('/cleanup/status')) return Promise.resolve(makeResponse(status));
    return Promise.resolve(makeResponse(payload));
  });
  const wrapper = mount(Cleanup, { global: { plugins: [ElementPlus] } });
  await flushPromises();
  return wrapper;
}

async function clickRunLogsCleanup(wrapper: ReturnType<typeof mount>, realDelete: boolean) {
  if (realDelete) {
    // 预览开关默认打开（安全默认），真实删除要先把页级开关关掉
    await wrapper.find('#cleanup-preview-switch').trigger('click');
    await flushPromises();
  }
  const btn = wrapper.findAll('button').find((b) => b.text().includes('清理运行日志'));
  expect(btn, '运行日志卡应出现「清理运行日志」按钮').toBeTruthy();
  await btn!.trigger('click');
  await flushPromises();
  return btn;
}

describe('T02773 「释放 X MB」渲染', () => {
  beforeEach(async () => {
    vi.mocked(apiFetch).mockReset();
    // element-plus 的 mock 工厂在整个文件里只建一次，ElMessage.success 的调用记录
    // 不会随用例结束而清空——不清就会读到上一条用例的 toast（实测踩过）。
    const { ElMessage } = await import('element-plus');
    for (const kind of ['success', 'info', 'warning', 'error'] as const) {
      vi.mocked(ElMessage[kind]).mockReset();
    }
  });

  /** 取最近一次 toast 文案（真实删除路径只会弹一次 success） */
  async function lastToast(kind: 'success' | 'info' = 'success'): Promise<string> {
    const { ElMessage } = await import('element-plus');
    const calls = vi.mocked(ElMessage[kind]).mock.calls;
    expect(calls.length, `没有调用 ElMessage.${kind}`).toBeGreaterThan(0);
    return String(calls[calls.length - 1]?.[0] ?? '');
  }

  it('真实删除有释放量时，toast 与结果区都给出「释放 1.5 MB」', async () => {
    const wrapper = await mountCleanup(wireResult());
    await clickRunLogsCleanup(wrapper, true);

    const toast = await lastToast();
    expect(toast, `toast 文案应含释放量，实际：${toast}`).toContain('清理完成：处理 1 项，释放 1.5 MB');

    const area = wrapper.find('.result-area');
    expect(area.exists()).toBe(true);
    expect(area.text().replace(/\s+/g, ' ')).toContain('释放 1.5 MB');
    expect(area.text()).toContain('完成 1 项');
  });

  it('后端没给这个字段（没删文件）时不显示「释放」，而不是显示「释放 0 MB」', async () => {
    const payload = wireResult({ cleaned: [], count: 0 });
    delete payload.total_freed_mb;
    const wrapper = await mountCleanup(payload);
    await clickRunLogsCleanup(wrapper, true);

    const toast = await lastToast();
    expect(toast).toContain('清理完成');
    expect(toast).not.toContain('释放');
    expect(wrapper.text()).not.toContain('释放 0 MB');
  });

  it('释放量确实是 0 时仍然显示：存在性判断是 !== undefined，不是 truthy', async () => {
    const wrapper = await mountCleanup(wireResult({ total_freed_mb: 0 }));
    await clickRunLogsCleanup(wrapper, true);

    expect(await lastToast()).toContain('释放 0 MB');
    expect(wrapper.find('.result-area').text()).toContain('释放 0 MB');
  });

  it('预览模式不报释放量（一个文件都没删，报数会让人以为已经清理过）', async () => {
    const wrapper = await mountCleanup(wireResult({ dry_run: true, cleaned: ['[预览] 将删除日志 run-2026-09.log (1.5MB)'] }));
    // 保持默认预览开关不动
    await clickRunLogsCleanup(wrapper, false);

    expect(wrapper.text()).not.toContain('释放');
    expect(wrapper.find('.result-area').text()).toContain('预览 1 项');
  });

  // 字段名与 `!== undefined` 判断形态的文本锁放在
  // api/test/cleanup-freed-contract.test.ts 的「前后端镜像类型」一节：
  // 那里同时读 api 与 frontend 两份源码做逐字比对，比在本文件里再抄一份口径更不容易漂移。
});
