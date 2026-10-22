// T02808 前端侧：清理页「高级」面板列出真实扫描的目录清单。
// T02887：从「只有运行状态有清单」扩成四类目标各一组真实清单。
// ------------------------------------------------------------------
// 缺陷形态：T02808 只补了运行状态；编译缓存/运行日志/原始资料三卡仍旧只有
// 「高级」面板里一行写死的示意路径（.harness/compile-cache.json 之类）——
// 写着技术细节，给的却不是事实，多根落盘时用户照样看不出「东西在另一处」。
// 本文件锁四件事：
//   A) 四组面板的路径逐字等于后端 status 各卡 dirs（前端不重排、不改写）；
//   B) 「当前存放位置 / 旧存放位置」的措辞与清理预览的条目标注同一份（cleanupPresentation 单一来源）；
//   C) 计数恒等式逐卡成立：卡面计数 = 各目录计数之和（夹具里卡面计数与目录计数
//      是两个独立写死的数，不是同一次 reduce 算出来的——这正是它能咬住分叉的原因）；
//   D) techPath 示意降级为口径说明，不再以「实际位置」的身份出现。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Cleanup from '../src/views/Cleanup.vue';
import { apiFetch } from '../src/utils/apiBase';
import {
  RUN_STATE_ROLE_TEXT,
  legacyDirHint,
  storageDirRows,
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

// 后端真实清单的形状：首项 = 写入侧规范位置，其余是历史落点与「还没建出来」的位置
const CANONICAL_HARNESS = 'D:\\wiki\\karpathy-wiki\\data\\.harness';
const LEGACY_HARNESS = 'D:\\wiki\\karpathy-wiki\\api\\.harness';
const CANONICAL_STATE = `${CANONICAL_HARNESS}\\state`;
const LEGACY_STATE = `${LEGACY_HARNESS}\\state`;
const MISSING_LOGS = 'C:\\Users\\demo\\.harness\\logs';
const RAW_DIR = 'D:\\wiki\\karpathy-wiki\\data\\vault\\raw';

function dirsFixture(): Record<'compileCache' | 'runState' | 'runLogs' | 'rawArchive', CleanupRunStateDir[]> {
  return {
    // 卡面 entryCount = 12 = 8 + 4（两个数各自独立写死，见 statusFixture）
    compileCache: [
      { path: CANONICAL_HARNESS, fileCount: 8, sizeMb: 0.8, role: 'canonical', exists: true },
      { path: LEGACY_HARNESS, fileCount: 4, sizeMb: 0.4, role: 'legacy', exists: true },
    ],
    runState: [
      { path: CANONICAL_STATE, fileCount: 1, sizeMb: 1, role: 'canonical', exists: true },
      { path: LEGACY_STATE, fileCount: 2, sizeMb: 2, role: 'legacy', exists: true },
    ],
    // 缺失位置与「目录在但空」都要出现：9 = 9 + 0
    runLogs: [
      { path: `${CANONICAL_HARNESS}\\logs`, fileCount: 9, sizeMb: 4.5, role: 'canonical', exists: true },
      { path: MISSING_LOGS, fileCount: 0, sizeMb: 0, role: 'legacy', exists: false },
    ],
    // raw 目录单一写入口径，清单恒单项 canonical
    rawArchive: [{ path: RAW_DIR, fileCount: 3, sizeMb: 2.2, role: 'canonical', exists: true }],
  };
}

/** 按 GET /api/cleanup/status 的线上形状构造：卡面计数是独立写死的数（不靠 reduce 生成） */
function statusFixture(): CleanupStorageStatus {
  const dirs = dirsFixture();
  return {
    active: { compile: 0, query: 0, blockedTargets: [], blockedReasons: [] },
    compileCache: { exists: true, sizeMb: 1.2, entryCount: 12, dirs: dirs.compileCache },
    runState: {
      fileCount: 3,
      sizeMb: 3,
      oldest: '2026-09-20',
      dirs: dirs.runState,
    },
    runLogs: { fileCount: 9, sizeMb: 4.5, oldest: '2026-08-11', dirs: dirs.runLogs },
    rawArchive: { fileCount: 3, sizeMb: 2.2, oldest: '2026-07-30', dirs: dirs.rawArchive },
  } satisfies CleanupStorageStatus;
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

describe('T02887 目录清单的展示口径（纯函数）', () => {
  it('措辞只有一份：canonical=当前存放位置，legacy=旧存放位置（与清理预览同一措辞）', () => {
    expect(RUN_STATE_ROLE_TEXT).toEqual({ canonical: '当前存放位置', legacy: '旧存放位置' });
    const rows = storageDirRows(dirsFixture().runState);
    expect(rows.map((r) => r.roleText)).toEqual(['当前存放位置', '旧存放位置']);
    expect(rows.map((r) => r.legacy)).toEqual([false, true]);
  });

  it('路径逐字透传，既不相对化也不重排；计数与体积成一行', () => {
    const rows = storageDirRows(dirsFixture().runState);
    expect(rows.map((r) => r.path)).toEqual([CANONICAL_STATE, LEGACY_STATE]);
    expect(rows[0].countText).toBe('1 个文件 · 1.00 MB');
  });

  it('「还没有这个位置」只给确实不存在的位置（目录在但空 ≠ 位置不存在）', () => {
    const rows = storageDirRows(dirsFixture().runLogs);
    expect(rows[0].countText).toBe('9 个文件 · 4.50 MB');
    expect(rows[1].countText).toBe('还没有这个位置');
  });

  it('遗留说明按卡取材：运行状态提进度文件、编译缓存提缓存，raw 无遗留概念', () => {
    expect(legacyDirHint('runState', dirsFixture().runState)).toContain('其中 2 个在旧存放位置');
    expect(legacyDirHint('runState', dirsFixture().runState)).toContain('进度文件');
    expect(legacyDirHint('compileCache', dirsFixture().compileCache)).toContain('编译缓存改存到统一目录');
    // 全空时空串（模板据此不渲染）
    expect(
      legacyDirHint('runState', [
        { path: CANONICAL_STATE, fileCount: 3, sizeMb: 0.1, role: 'canonical', exists: true },
        { path: LEGACY_STATE, fileCount: 0, sizeMb: 0, role: 'legacy', exists: false },
      ]),
    ).toBe('');
    // rawArchive 恒 canonical，说明永不触发
    expect(legacyDirHint('rawArchive', dirsFixture().rawArchive)).toBe('');
  });
});

describe('T02887 清理页「高级」面板渲染（四类目标各一组）', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('四组面板都在，各组的路径、角色、计数逐条列出（路径含反斜杠也原样显示）', async () => {
    const wrapper = await mountWithStatus((url) =>
      Promise.resolve(makeResponse(url.includes('/cleanup/status') ? statusFixture() : {})),
    );
    for (const key of ['compileCache', 'runState', 'runLogs', 'rawArchive']) {
      expect(wrapper.find(`#cleanup-advanced-dirs-${key}`).exists()).toBe(true);
    }
    const stateRows = wrapper.find('#cleanup-advanced-dirs-runState').findAll('.advanced-row');
    expect(stateRows.map((r) => r.find('.advanced-path').text())).toEqual([CANONICAL_STATE, LEGACY_STATE]);
    expect(stateRows.map((r) => r.find('.dir-role').text())).toEqual(['当前存放位置', '旧存放位置']);
    // 编译缓存的遗留根也原样列出
    const cacheRows = wrapper.find('#cleanup-advanced-dirs-compileCache').findAll('.advanced-row');
    expect(cacheRows.map((r) => r.find('.advanced-path').text())).toEqual([CANONICAL_HARNESS, LEGACY_HARNESS]);
    // 原始资料恒单项 canonical
    const rawRows = wrapper.find('#cleanup-advanced-dirs-rawArchive').findAll('.advanced-row');
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0].find('.dir-role').text()).toBe('当前存放位置');
    expect(rawRows[0].find('.advanced-path').text()).toBe(RAW_DIR);
  });

  it('techPath 降级为口径说明：出现在每组说明行里，但不再冒充实际位置路径', async () => {
    const wrapper = await mountWithStatus((url) =>
      Promise.resolve(makeResponse(url.includes('/cleanup/status') ? statusFixture() : {})),
    );
    const cacheGroup = wrapper.find('#cleanup-advanced-dirs-compileCache');
    expect(cacheGroup.find('.dirs-caliber').text()).toContain('.harness/compile-cache.json');
    // 实际位置行里的是真实绝对路径，不是示意模式
    expect(cacheGroup.find('.advanced-path').text()).toBe(CANONICAL_HARNESS);
    expect(cacheGroup.find('.advanced-path').text()).not.toContain('.harness/compile-cache.json');
  });

  it('验收不变量：四张卡的卡面计数各自等于其目录计数之和（夹具两数独立写死）', async () => {
    const wrapper = await mountWithStatus((url) =>
      Promise.resolve(makeResponse(url.includes('/cleanup/status') ? statusFixture() : {})),
    );
    const blocks = wrapper.findAll('.status-block');
    const status = statusFixture();
    const sum = (dirs: CleanupRunStateDir[]) => dirs.reduce((n, d) => n + d.fileCount, 0);
    // 卡面文案：compileCache 是「N 条缓存」，其余三类是「N 个文件」
    expect(blocks[0].find('.status-meta').text()).toContain(`${status.compileCache.entryCount} 条缓存`);
    expect(status.compileCache.entryCount).toBe(sum(status.compileCache.dirs));
    expect(blocks[1].find('.status-meta').text()).toContain(`${status.runState.fileCount} 个文件`);
    expect(status.runState.fileCount).toBe(sum(status.runState.dirs));
    expect(blocks[2].find('.status-meta').text()).toContain(`${status.runLogs.fileCount} 个文件`);
    expect(status.runLogs.fileCount).toBe(sum(status.runLogs.dirs));
    expect(blocks[3].find('.status-meta').text()).toContain(`${status.rawArchive.fileCount} 个文件`);
    expect(status.rawArchive.fileCount).toBe(sum(status.rawArchive.dirs));
    // 面板行数 = 各组 dirs 行数
    expect(wrapper.find('#cleanup-advanced-dirs-runState').findAll('.advanced-row')).toHaveLength(status.runState.dirs.length);
    expect(wrapper.find('#cleanup-advanced-dirs-compileCache').findAll('.advanced-row')).toHaveLength(status.compileCache.dirs.length);
    expect(wrapper.find('#cleanup-advanced-dirs-runLogs').findAll('.advanced-row')).toHaveLength(status.runLogs.dirs.length);
    expect(wrapper.find('#cleanup-advanced-dirs-rawArchive').findAll('.advanced-row')).toHaveLength(status.rawArchive.dirs.length);
  });

  it('后端还没有目录清单前不渲染假路径：加载中走 StateBlock 的加载态', async () => {
    let release: ((v: never) => void) | null = null;
    const wrapper = await mountWithStatus(
      () => new Promise<never>((resolve) => { release = resolve as (v: never) => void; }),
    );
    // mountWithStatus 已 flush 过：此时 status 请求仍未回，面板必须是加载态而不是空白
    const panel = wrapper.find('#cleanup-advanced-dirs-runState');
    expect(panel.find('.state-block[role="status"]').exists()).toBe(true);
    expect(panel.findAll('.advanced-path')).toHaveLength(0);
    release?.(makeResponse(statusFixture()) as never);
    await flushPromises();
    expect(wrapper.find('#cleanup-advanced-dirs-runState').findAll('.advanced-row')).toHaveLength(2);
  });

  it('状态接口失败时给出可重试的失败态，而不是把上一次的目录清单当成现状', async () => {
    const wrapper = await mountWithStatus(() => Promise.resolve(makeResponse({ error: 'boom' }, 500)));
    const panel = wrapper.find('#cleanup-advanced-dirs-runState');
    expect(panel.find('.state-block[role="alert"]').exists()).toBe(true);
    expect(panel.findAll('.advanced-path')).toHaveLength(0);
    // 重试按钮走的就是本页原有的 loadStatus（不另起一套刷新逻辑）
    const callsBefore = vi.mocked(apiFetch).mock.calls.length;
    await panel.find('.state-retry').trigger('click');
    await flushPromises();
    expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
