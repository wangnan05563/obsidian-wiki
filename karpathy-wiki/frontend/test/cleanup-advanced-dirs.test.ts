// T02808 前端侧：清理页「高级」面板列出真实扫描的运行状态目录。
// ------------------------------------------------------------------
// 缺陷形态：T02772 修好后，「运行状态」卡的数字是对的，但页面上只有一个合并后的数字。
// 用户看不出这些文件落在几个位置、其中多少是升级前的历史落点，也就无法判断
// 「清完会不会再来」；更糟的是「高级」面板里那行 `.harness/state/*.json` 是写死的示意路径，
// 与后端真正扫描的目录没有任何关系——写着技术细节，给的却不是事实。
// 本文件锁三件事：
//   A) 面板里的路径逐字等于后端 status.runState.dirs（前端不重排、不改写）；
//   B) 「当前存放位置 / 旧存放位置」的措辞与清理预览的条目标注同一份（cleanupPresentation 单一来源）；
//   C) 状态没回来时走 StateBlock 三态出口，不在这里手写「加载中…」方言。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Cleanup from '../src/views/Cleanup.vue';
import { apiFetch } from '../src/utils/apiBase';
import {
  RUN_STATE_ROLE_TEXT,
  legacyRunStateHint,
  runStateDirRows,
} from '../src/utils/cleanupPresentation';
import type { CleanupRunStateDir, CleanupStorageStatus } from '../src/types';

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

// 后端真实清单的形状：首项 = 写入侧规范目录，其余是历史落点与「还没建出来」的位置
const CANONICAL = 'D:\\wiki\\karpathy-wiki\\data\\.harness\\state';
const LEGACY = 'D:\\wiki\\karpathy-wiki\\api\\.harness\\state';
const MISSING = 'C:\\Users\\demo\\.harness\\state';

function dirsFixture(): CleanupRunStateDir[] {
  return [
    { path: CANONICAL, fileCount: 1, sizeMb: 1, role: 'canonical', exists: true },
    { path: LEGACY, fileCount: 2, sizeMb: 2, role: 'legacy', exists: true },
    { path: MISSING, fileCount: 0, sizeMb: 0, role: 'legacy', exists: false },
  ];
}

/** 按 GET /api/cleanup/status 的线上形状构造：卡计数 = 各目录计数之和 */
function statusFixture(): Record<string, unknown> {
  const dirs = dirsFixture();
  const status: CleanupStorageStatus = {
    active: { compile: 0, query: 0, blockedTargets: [], blockedReasons: [] },
    compileCache: { exists: true, sizeMb: 0.4, entryCount: 12 },
    runState: {
      fileCount: dirs.reduce((n, d) => n + d.fileCount, 0),
      sizeMb: dirs.reduce((n, d) => n + d.sizeMb, 0),
      oldest: '2026-09-20',
      dirs,
    },
    runLogs: { fileCount: 9, sizeMb: 4.5, oldest: '2026-08-11' },
    rawArchive: { fileCount: 3, sizeMb: 2.2, oldest: '2026-07-30' },
  };
  return status as unknown as Record<string, unknown>;
}

function makeResponse(data: unknown, httpStatus = 200) {
  return { ok: httpStatus < 400, status: httpStatus, json: () => Promise.resolve(data) } as never;
}

async function mountWithStatus(handler: (url: string) => Promise<never>) {
  vi.mocked(apiFetch).mockImplementation((url: string | URL | Request) => handler(String(url)));
  const wrapper = mount(Cleanup, { global: { plugins: [ElementPlus] } });
  await flushPromises();
  // 面板默认收起（技术细节不打扰主流程），点开才断言
  await wrapper.find('.advanced-toggle').trigger('click');
  await flushPromises();
  return wrapper;
}

describe('T02808 目录清单的展示口径（纯函数）', () => {
  it('措辞只有一份：canonical=当前存放位置，legacy=旧存放位置（与清理预览同一措辞）', () => {
    expect(RUN_STATE_ROLE_TEXT).toEqual({ canonical: '当前存放位置', legacy: '旧存放位置' });
    const rows = runStateDirRows(dirsFixture());
    expect(rows.map((r) => r.roleText)).toEqual(['当前存放位置', '旧存放位置', '旧存放位置']);
    expect(rows.map((r) => r.legacy)).toEqual([false, true, true]);
  });

  it('路径逐字透传，既不相对化也不重排；计数与体积成一行', () => {
    const rows = runStateDirRows(dirsFixture());
    expect(rows.map((r) => r.path)).toEqual([CANONICAL, LEGACY, MISSING]);
    expect(rows[0].countText).toBe('1 个文件 · 1.00 MB');
    // 「没有这个目录」与「目录在但空」必须是两种说法，否则用户以为后端漏扫
    expect(rows[2].countText).toBe('还没有这个位置');
  });

  it('遗留目录里确实有文件才给一句话说明；全空时空串（模板据此不渲染）', () => {
    expect(legacyRunStateHint(dirsFixture())).toContain('其中 2 个在旧存放位置');
    expect(
      legacyRunStateHint([
        { path: CANONICAL, fileCount: 3, sizeMb: 0.1, role: 'canonical', exists: true },
        { path: LEGACY, fileCount: 0, sizeMb: 0, role: 'legacy', exists: false },
      ]),
    ).toBe('');
  });
});

describe('T02808 清理页「高级」面板渲染', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('面板把每个真实目录的路径、角色、计数逐条列出（路径含反斜杠也原样显示）', async () => {
    const wrapper = await mountWithStatus((url) =>
      Promise.resolve(makeResponse(url.includes('/cleanup/status') ? statusFixture() : {})),
    );
    const panel = wrapper.find('#cleanup-advanced-dirs');
    expect(panel.exists()).toBe(true);
    const rows = panel.findAll('.advanced-row');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.find('.advanced-path').text())).toEqual([CANONICAL, LEGACY, MISSING]);
    expect(rows.map((r) => r.find('.dir-role').text())).toEqual(['当前存放位置', '旧存放位置', '旧存放位置']);
    expect(rows[2].find('.advanced-note').text()).toBe('还没有这个位置');
  });

  it('验收不变量：「运行状态」卡的文件数 = 高级面板各目录计数之和', async () => {
    const fixture = statusFixture();
    const wrapper = await mountWithStatus((url) =>
      Promise.resolve(makeResponse(url.includes('/cleanup/status') ? fixture : {})),
    );
    const dirs = (fixture.runState as Record<string, unknown>).dirs as CleanupRunStateDir[];
    const sum = dirs.reduce((n, d) => n + d.fileCount, 0);
    const legacySum = dirs.filter((d) => d.role === 'legacy').reduce((n, d) => n + d.fileCount, 0);
    const cardMeta = wrapper.findAll('.status-block')[1].find('.status-meta').text();
    expect(cardMeta).toContain(`${sum} 个文件`);
    expect(wrapper.find('#cleanup-advanced-dirs').findAll('.advanced-row')).toHaveLength(dirs.length);
    expect(wrapper.find('#cleanup-advanced-dirs').text()).toContain(`其中 ${legacySum} 个在旧存放位置`);
  });

  it('后端还没有目录清单前不渲染假路径：加载中走 StateBlock 的加载态', async () => {
    let release: ((v: never) => void) | null = null;
    const wrapper = await mountWithStatus(
      () => new Promise<never>((resolve) => { release = resolve as (v: never) => void; }),
    );
    // mountWithStatus 已 flush 过：此时 status 请求仍未回，面板必须是加载态而不是空白
    const panel = wrapper.find('#cleanup-advanced-dirs');
    expect(panel.find('.state-block[role="status"]').exists()).toBe(true);
    expect(panel.findAll('.advanced-path')).toHaveLength(0);
    release?.(makeResponse(statusFixture()) as never);
    await flushPromises();
    expect(wrapper.find('#cleanup-advanced-dirs').findAll('.advanced-row')).toHaveLength(3);
  });

  it('状态接口失败时给出可重试的失败态，而不是把上一次的目录清单当成现状', async () => {
    const wrapper = await mountWithStatus(() => Promise.resolve(makeResponse({ error: 'boom' }, 500)));
    const panel = wrapper.find('#cleanup-advanced-dirs');
    expect(panel.find('.state-block[role="alert"]').exists()).toBe(true);
    expect(panel.findAll('.advanced-path')).toHaveLength(0);
    // 重试按钮走的就是本页原有的 loadStatus（不另起一套刷新逻辑）
    const callsBefore = vi.mocked(apiFetch).mock.calls.length;
    await panel.find('.state-retry').trigger('click');
    await flushPromises();
    expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
