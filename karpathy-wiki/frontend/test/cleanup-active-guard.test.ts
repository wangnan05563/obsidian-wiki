// T02655 前端侧：有活跃任务时，真实删除入口必须「看得见地」被拦住。
// ------------------------------------------------------------------
// 这一单的验收口径不是「后端返回了 409」，而是用户不会在编译跑到一半时把
// 运行状态删掉。所以两层都要锁：
//   1) 纯函数层：置灰判定与文案只信后端 status.active，前端不再自己数任务；
//   2) 组件层：Cleanup.vue 真的把被拦的卡渲染成禁用态，且 409 时给出可读原因
//      （而不是「清理失败：HTTP 409」这种让人再点一次的文案）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Cleanup from '../src/views/Cleanup.vue';
import { apiFetch } from '../src/utils/apiBase';
import {
  blockedTipFor,
  cleanupButtonState,
  cardOf,
  confirmText,
  CLEANUP_CARDS,
} from '../src/utils/cleanupPresentation';
import type { CleanupActiveState, CleanupStorageStatus } from '../src/types';

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

const idle: CleanupActiveState = { compile: 0, query: 0, blockedTargets: [], blockedReasons: [] };
const compileBusy: CleanupActiveState = {
  compile: 1,
  query: 0,
  blockedTargets: ['run_state', 'raw_archive'],
  blockedReasons: [
    { target: 'run_state', reason: '有编译任务正在进行：清理会删掉它的断点续传基准，这次编译会直接失败或从头重跑。' },
    { target: 'raw_archive', reason: '有编译任务正在进行：它要读的原始资料存档可能在这次清理里被删掉。' },
  ],
};

function statusOf(over: Partial<CleanupStorageStatus> = {}): CleanupStorageStatus {
  return {
    active: idle,
    compileCache: {
      exists: true,
      sizeMb: 1.2,
      entryCount: 42,
      // T02887：四类目标都带真实目录清单（卡计数 = 各目录计数之和）
      dirs: [{ path: '/tmp/wiki-data/.harness', fileCount: 42, sizeMb: 1.2, role: 'canonical', exists: true }],
    },
    runState: {
      fileCount: 3,
      sizeMb: 0.1,
      oldest: '2026-09-01',
      // T02808：与卡计数成对（各目录计数之和 = fileCount）
      dirs: [
        { path: '/tmp/wiki-data/.harness/state', fileCount: 3, sizeMb: 0.1, role: 'canonical', exists: true },
      ],
    },
    runLogs: {
      fileCount: 12,
      sizeMb: 4.5,
      oldest: '2026-08-11',
      dirs: [{ path: '/tmp/wiki-data/.harness/logs', fileCount: 12, sizeMb: 4.5, role: 'canonical', exists: true }],
    },
    rawArchive: {
      fileCount: 7,
      sizeMb: 2.2,
      oldest: '2026-07-30',
      dirs: [{ path: '/tmp/wiki-data/vault/raw', fileCount: 7, sizeMb: 2.2, role: 'canonical', exists: true }],
    },
    ...over,
  };
}

function makeResponse(data: unknown, status = 200) {
  return { ok: status < 400, status, json: () => Promise.resolve(data) } as never;
}

describe('T02655 置灰判定：只信后端 active', () => {
  it('被拦目标返回原文原因（措辞与后端 409 同源）', () => {
    expect(blockedTipFor('run_state', compileBusy)).toContain('断点续传基准');
    expect(blockedTipFor('raw_archive', compileBusy)).toContain('原始资料存档');
  });

  it('未被拦的两类与无活跃任务时不拦', () => {
    expect(blockedTipFor('compile_cache', compileBusy)).toBeNull();
    expect(blockedTipFor('run_logs', compileBusy)).toBeNull();
    expect(blockedTipFor('run_state', idle)).toBeNull();
  });

  it('后端没给 active 时按不拦处理（避免整页假置灰）', () => {
    expect(blockedTipFor('run_state', undefined)).toBeNull();
    expect(blockedTipFor('run_state', null)).toBeNull();
  });

  it('真实删除模式下被拦 → 禁用 + 「有任务进行中」+ 原因写进 data-tip', () => {
    const s = statusOf({ active: compileBusy });
    const state = cleanupButtonState('runState', s, false);
    expect(state.disabled).toBe(true);
    expect(state.label).toBe('有任务进行中');
    expect(state.tip).toContain('有编译任务正在进行');
    // 提示里必须给出路：告诉用户还能用预览，而不是一个死按钮
    expect(state.tip).toContain('仅预览');
  });

  it('预览模式不置灰：预览不删文件，拦它只会让人连「会删哪些」都看不到', () => {
    const s = statusOf({ active: compileBusy });
    for (const key of ['runState', 'rawArchive'] as const) {
      expect(cleanupButtonState(key, s, true).disabled).toBe(false);
    }
  });

  it('可清对象为 0 时仍优先说「无需清理」，不拿拦截文案糊弄', () => {
    const s = statusOf({ active: compileBusy, runState: { fileCount: 0, sizeMb: 0, oldest: null } });
    expect(cleanupButtonState('runState', s, false).label).toBe('无需清理');
  });
});

describe('T02655 文案：把两种代价说清', () => {
  it('「运行状态」卡区分历史进度与进行中进价的代价', () => {
    const text = cardOf('runState').consequence;
    expect(text).toContain('重跑');
    expect(text).toContain('直接失败');
  });

  it('二次确认不再是"建议先确认无活跃任务"这种无人能执行的软提示', () => {
    const text = confirmText('运行状态');
    expect(text).not.toContain('建议先确认');
    expect(text).toContain('后端会直接拒绝');
  });

  it('4 张卡的描述仍不泄露内部路径与实现词（T02470 S3 不回退）', () => {
    const JARGON = ['.harness', 'SHA-256', 'JSONL', 'resume', 'input-*.md', 'compile-cache'];
    for (const card of CLEANUP_CARDS) {
      const visible = `${card.plain} ${card.consequence}`;
      for (const word of JARGON) {
        expect(visible, `${card.title} 的描述里出现了 ${word}`).not.toContain(word);
      }
    }
  });
});

describe('T02655 Cleanup.vue 组件层', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  function buttonsOf(wrapper: ReturnType<typeof mount>) {
    return wrapper.findAll('button');
  }
  function buttonOf(wrapper: ReturnType<typeof mount>, label: string) {
    return buttonsOf(wrapper).find((b) => b.text().includes(label));
  }

  // 首屏状态由参数决定；页内每次「刷新状态」都返回 compileBusy，供 409 后的重拉断言
  async function mountWithStatus(first: CleanupStorageStatus) {
    let getStatus = 0;
    vi.mocked(apiFetch).mockImplementation((url: string | URL | Request) => {
      if (String(url).includes('/cleanup/status')) {
        getStatus += 1;
        return Promise.resolve(makeResponse(getStatus === 1 ? first : statusOf({ active: compileBusy })));
      }
      return Promise.resolve(makeResponse({}));
    });
    const wrapper = mount(Cleanup, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    return wrapper;
  }

  it('有编译在跑 + 关掉预览 → 运行状态/原始资料两张卡的按钮转禁用态并显示活体指示', async () => {
    const wrapper = await mountWithStatus(statusOf({ active: compileBusy }));
    // 页顶活体指示：这是唯一一处「现在到底有没有任务在跑」的直白呈现
    expect(wrapper.find('#cleanup-active-hint').exists()).toBe(true);
    expect(wrapper.find('#cleanup-active-hint').text()).toContain('编译 1');

    await wrapper.find('#cleanup-preview-switch').trigger('click');
    await flushPromises();

    const runState = buttonOf(wrapper, '有任务进行中');
    expect(runState, '运行状态卡应出现「有任务进行中」禁用按钮').toBeTruthy();
    expect(runState!.attributes('disabled')).toBeDefined();
    // 未列入拦截范围的编译缓存仍应可点（否则就是整页拦，用户会以为功能坏了）
    expect(buttonOf(wrapper, '清理编译缓存')?.attributes('disabled')).toBeUndefined();
  });

  it('无活跃任务时不出现活体指示，四张卡都可点', async () => {
    const wrapper = await mountWithStatus(statusOf());
    expect(wrapper.find('#cleanup-active-hint').exists()).toBe(false);
    await wrapper.find('#cleanup-preview-switch').trigger('click');
    await flushPromises();
    for (const card of CLEANUP_CARDS) {
      const btn = buttonOf(wrapper, `清理${card.title}`);
      expect(btn?.attributes('disabled'), `${card.title} 不应被置灰`).toBeUndefined();
    }
  });

  it('状态滞后时被后端当场拒绝：409 给出原因并刷新置灰，而不是「清理失败：HTTP 409」', async () => {
    const blockedBody = {
      error: '存在进行中任务（1 个编译），已拦截真实删除：运行状态。请先停止或等待任务结束，或改用「仅预览」。',
      code: 'cleanup_blocked_by_active_task',
      target: 'run_state',
      blocked: ['run_state'],
      reasons: ['有编译任务正在进行：清理会删掉它的断点续传基准，这次编译会直接失败或从头重跑。'],
      active: compileBusy,
    };
    const wrapper = await mountWithStatus(statusOf());
    await wrapper.find('#cleanup-preview-switch').trigger('click');
    await flushPromises();

    // 前端状态是滞后的（用户加载页面时确实没任务），点下去才由后端硬拦
    const before = buttonOf(wrapper, '清理运行状态');
    expect(before?.attributes('disabled')).toBeUndefined();
    vi.mocked(apiFetch).mockImplementation((url: string | URL | Request) => {
      if (String(url).endsWith('/cleanup/status')) {
        return Promise.resolve(makeResponse(statusOf({ active: compileBusy })));
      }
      return Promise.resolve({
        ok: false,
        status: 409,
        json: () => Promise.resolve(blockedBody),
      } as never);
    });
    await before!.trigger('click');
    await flushPromises();

    const { ElMessage } = await import('element-plus');
    const warn = vi.mocked(ElMessage).warning;
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('已拦截真实删除');
    // 结果区显示的是原因，不是 HTTP 状态码
    expect(wrapper.text()).toContain('断点续传基准');
    // 409 后重新拉状态 → 卡面跟上后端事实
    expect(buttonOf(wrapper, '有任务进行中')).toBeTruthy();
  });

  // T02895：三种拒绝码前端各补一句「下一步做什么」——error 回答发生了什么，指引回答该干什么，
  // 避免用户把「被拦」当故障连点。三值由 BLOCKED_GUIDANCE 的 Record 全覆盖，缺一档编译期即红；
  // 这里锁的是「指引文案真的进结果区、且随 code 切换」。
  async function mountAndTrigger409(code: string) {
    const blockedBody = {
      error: `拒绝样本（${code}）`,
      code,
      target: 'run_state',
      blocked: [],
      reasons: [],
      active: statusOf().active,
    };
    const wrapper = await mountWithStatus(statusOf());
    await wrapper.find('#cleanup-preview-switch').trigger('click');
    await flushPromises();
    const btn = buttonOf(wrapper, '清理运行状态');
    vi.mocked(apiFetch).mockImplementation((url: string | URL | Request) => {
      if (String(url).endsWith('/cleanup/status')) {
        return Promise.resolve(makeResponse(statusOf()));
      }
      return Promise.resolve({
        ok: false,
        status: 409,
        json: () => Promise.resolve(blockedBody),
      } as never);
    });
    await btn!.trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('409 code=other_process → 结果区给「去另一实例等结果」指引（T02895）', async () => {
    const wrapper = await mountAndTrigger409('cleanup_blocked_by_other_process');
    expect(wrapper.text()).toContain('另一个服务实例正在删除，去那边等结果即可');
  });

  it('409 code=concurrent_cleanup → 结果区给「等本页上一次删除完成」指引（T02895）', async () => {
    const wrapper = await mountAndTrigger409('cleanup_blocked_by_concurrent_cleanup');
    expect(wrapper.text()).toContain('本页上一次真实删除还没结束');
  });

  it('409 code=active_task → 结果区给「等任务消失/先预览」指引（T02895）', async () => {
    const wrapper = await mountAndTrigger409('cleanup_blocked_by_active_task');
    expect(wrapper.text()).toContain('等页顶「进行中任务」消失后再试');
  });
});
