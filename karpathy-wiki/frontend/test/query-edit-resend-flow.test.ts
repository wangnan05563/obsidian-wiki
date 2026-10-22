// 集成测试：真实挂载 Query.vue，实跑「编辑用户消息 → 修改 → 确认发送」全流程，
// 验证编辑重发是否真的触发新一轮 sendQuestion（而非仅本地截断或无反应）。
// 目的：定位「编辑并重新发送功能不起作用」到底是逻辑 bug 还是环境问题。
import 'fake-indexeddb/auto'; // 提供可用内存 IndexedDB，避免 openChatDB 在测试环境 reject
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import Query from '../src/views/Query.vue';
import { useQueryStore } from '../src/stores/query';
import { useAuthStore } from '../src/stores/auth';
import { useConversationsStore } from '../src/stores/conversations';
import { useModelStore } from '../src/stores/model';
import { waitForProgress, type ProgressWaitOptions, type WaitResult } from './helpers/waitForProgress';

// 构造一个最小可消费的 SSE 响应（仅成功结束，不依赖 happy-dom 的 Response 实现）
function fakeResponse() {
  const enc = new TextEncoder();
  const chunk =
    'event: answer\ndata: {"type":"answer","text":"ok"}\n\n' +
    'event: done\ndata: {"type":"done"}\n\n';
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

// 可中断的 SSE 流：先推一帧，随后保持打开，直到 signal 被 abort（真实 fetch 行为）才中断。
// 用于模拟「正在流式生成」的在途问答，验证编辑重发能否在中断后正确重发。
function abortableResponse(signal?: AbortSignal) {
  const enc = new TextEncoder();
  let controller: ReadableStreamDefaultController | null = null;
  const body = new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(enc.encode('event: answer\ndata: {"type":"answer","text":"partial"}\n\n'));
      // 真实 fetch 中 signal.abort 会让 reader.read() 以 AbortError 拒绝；
      // 此处手动构造的流需在 abort 时以相同方式中断，才能正确触发 sendQuestion 的 finally→重发。
      if (signal) {
        signal.addEventListener('abort', () => {
          try {
            controller?.error(new DOMException('aborted', 'AbortError'));
          } catch {
            /* 已中断 */
          }
        });
      }
    },
    cancel() {
      try {
        controller?.close();
      } catch {
        /* 已关闭 */
      }
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

// 吞掉中断的 SSE 流：推一帧后永久挂起，且**忽略 AbortSignal**。
// 对应生产代码里 S3 兜底定时器存在的前提——「后端/代理不尊重 AbortSignal」时，
// sendQuestion 的 finally 永不执行，编辑重发只能靠 EDIT_RESEND_FALLBACK_MS(3000ms) 兜底触发。
// 用于确定性复现「重发发生在第 3 秒」这条路径（旧的 2000ms 墙钟预算在此必然判失败）。
function hangingResponse() {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('event: answer\ndata: {"type":"answer","text":"partial"}\n\n'));
      // 故意不 close、也不响应 abort：reader.read() 永远 pending
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const stubs = {
  ConversationSidebar: true,
  AttachmentUploader: true,
  InputToolbar: true,
  ThinkingBlock: true,
  ModelSelector: true,
  RefsList: true,
  MultimodalOutputCard: true,
};

// ————————————————————————————————————————————————————————————
// 等待策略（T02687：加固本文件的墙钟 waitFor 假失败）
//
// 历史问题（旧实现：`deadline = Date.now() + 2000`，到点即抛）：
//  1. 2000ms 是「猜出来的机器时长」，与被测逻辑无关。sendQuestion → collectAttachments/buildQueryBody
//     （内含 IndexedDB 往返）→ fetch → 落消息 这条链跨多少轮微任务/定时器，取决于本机负载；
//     全套并发跑时同批 worker 抢占事件循环，同一份代码单跑 3/3 通过、全量跑偶发「waitFor 超时」
//     ——假失败（T02472 门禁实测记录）。
//  2. 更本质的口径错误：2000ms 小于产品自己的兜底契约。Query.vue 的 S3 兜底定时器
//     EDIT_RESEND_FALLBACK_MS = 3000ms（Query.vue:297）——当传输层吞掉中断（后端/代理不尊重
//     AbortSignal）、sendQuestion 的 finally 不执行时，重发**最迟在第 3 秒**才发生。
//     预算 2000ms 等于断言「产品必须在第 2 秒做到它承诺第 3 秒才做的事」：这条路径下断言永远不可达，
//     不是不稳定而是必然失败。本文件末尾的用例把这条路径显式跑出来并断言其耗时 ≥ 3000ms 作为取证。
//
// 现在的做法（不跳过用例、不放宽任何断言，谓词与原来完全一致）：
//  a) 把「总时长上限」换成「契约下限 + 无进展上限 + 硬上限」：只要进展签名（fetch 调用次数 /
//     isLoading / 消息条数）还在变化就续期等待；超过契约下限后连续 idleMs 毫无变化才判超时。
//     机器再慢也不会误判，真卡死仍会被抓出来（下限的存在理由见 CONTRACT_FLOOR_MS 注释）。
//  b) 上下限均由生产契约推导（兜底定时器 3000 + 一轮完整问答链 2000 + 余量 1000），不是随手大数。
//  c) 超时抛错带取证快照（已等待时长、轮次、最后一次进展时刻与签名），
//     下次再失败可一眼区分「逻辑坏了」还是「环境慢」。
//  d) 轮询让出方式为 setTimeout(0) + flushPromises，去掉旧实现每轮固定 5ms 的量化损耗。
//
// 每个用例显式传第 3 参 timeout（vitest 默认 5000ms 会先于本预算判死，把取证信息换成
// 一句 "Test timed out in 5000ms"，正是本单要消除的假失败观感）。
// ————————————————————————————————————————————————————————————

// 与 Query.vue:297 同源：生产侧改动 EDIT_RESEND_FALLBACK_MS 时，这里的预算推导要同步。
const EDIT_RESEND_FALLBACK_MS = 3_000;
// 契约下限：早于「生产承诺的最迟时刻 + 余量」时，一律不判失败。
// 为什么必须有它：S3 兜底路径上，abort 被传输层吞掉后**没有任何可观测进展**——
// 实测签名会静止整 3 秒（calls/loading/msgs 全不变），纯「无进展 X ms」规则会把
// 这个合法等待期误判成卡死（本单开发过程中实测复现：2503ms 处误报）。
// 所以判据是「超过契约下限 且 连续 idleMs 无进展」，两个条件缺一不可。
const CONTRACT_FLOOR_MS = EDIT_RESEND_FALLBACK_MS + 500;
// 超过契约下限后，进展签名连续多少毫秒毫无变化才判「真的卡住」
const IDLE_BUDGET_MS = 2_500;
// 绝对上限：生产兜底最迟 3000ms 触发重发，再叠加一轮完整问答链与余量
const HARD_CAP_MS = EDIT_RESEND_FALLBACK_MS + 2_000 + 1_000;
// 单个用例的 vitest 超时：需覆盖硬上限 + 用例自身的挂载开销
const CASE_TIMEOUT_MS = 20_000;

// T02753：等待实现已抽到 helpers/waitForProgress.ts（全站只有一份），本文件只保留自己的契约常量，
// 下面的 waitFor 是给那些常量做默认值的薄适配层，不是第二套实现。
// T02904-allow: 契约常量默认值薄适配层，内部直接转发 helpers/waitForProgress，非第二套等待实现
const waitFor = (
  label: string,
  predicate: () => boolean,
  options: Partial<ProgressWaitOptions> = {},
): Promise<WaitResult> =>
  waitForProgress(label, predicate, {
    floorMs: CONTRACT_FLOOR_MS,
    idleMs: IDLE_BUDGET_MS,
    capMs: HARD_CAP_MS,
    ...options,
  });

/** 进展签名：把「异步链是否还在动」可观测化的最小集合 */
function progressSignature(
  fetchCallCount: number,
  store: { isLoading: boolean; messages: unknown[] },
): string {
  return `calls=${fetchCallCount} loading=${store.isLoading ? 1 : 0} msgs=${store.messages.length}`;
}

describe('Query.vue 编辑重发端到端', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('点击编辑按钮进入可编辑态，确认发送触发新一轮问答', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const authStore = useAuthStore();
    const convStore = useConversationsStore();
    const modelStore = useModelStore();
    const queryStore = useQueryStore();

    // 避免 IndexedDB 依赖
    convStore.loadConversations = vi.fn().mockResolvedValue(undefined);
    // 提供用户与一个预设，避免 loadAiUserConfigForPreset 传 undefined
    (authStore as any).user = { id: 'u1', role: 'admin' };
    modelStore.$patch({ presets: [{ key: 'p1' } as any], selectedPresetKey: 'p1' });

    const authFetch = vi.fn().mockResolvedValue(fakeResponse());
    authStore.authFetch = authFetch as any;

    const wrapper = mount(Query, {
      global: { plugins: [pinia, ElementPlus], stubs },
      attachTo: document.body,
    });
    await flushPromises();

    // 种子一条已完成的问答
    queryStore.submitQuestion('原始问题');
    queryStore.appendAnswer('旧回答');
    queryStore.finalizeAnswer('sess', 0);
    await flushPromises();

    // 找到用户消息的编辑按钮（第一条消息即 user）
    const editBtn = wrapper.find('button[title="编辑并重新发送"]');
    expect(editBtn.exists(), '编辑按钮应存在').toBe(true);

    await editBtn.trigger('click');
    await flushPromises();

    // 进入可编辑态：textarea 出现
    const textarea = wrapper.find('.msg-edit textarea');
    expect(textarea.exists(), '点击编辑后应出现 textarea').toBe(true);

    // 修改文本并确认发送
    await textarea.setValue('修改后的问题');
    const confirmBtn = wrapper.find('button[data-testid="confirm-edit"]');
    expect(confirmBtn.exists(), '确认发送按钮应存在').toBe(true);
    await confirmBtn.trigger('click');

    // 等待异步 sendQuestion 完成（轮询真实状态而非固定时长）
    const bodyHasNew = () =>
      authFetch.mock.calls.some((c: any[]) => {
        const body = c[1]?.body;
        return typeof body === 'string' && body.includes('修改后的问题');
      });
    await waitFor('authFetch 请求体应包含修改后的文本', bodyHasNew, {
      progress: () => progressSignature(authFetch.mock.calls.length, queryStore),
    });

    // 断言：新一轮问答被触发（authFetch 被调用，且请求体包含新文本）
    expect(authFetch).toHaveBeenCalled();
    expect(bodyHasNew(), 'authFetch 请求体应包含修改后的文本').toBe(true);

    // 断言：对话里存在以新文本开头的 user 消息
    const hasNewUser = queryStore.messages.some(
      (m) => m.role === 'user' && m.content === '修改后的问题',
    );
    expect(hasNewUser, '对话中应包含修改后的用户消息').toBe(true);

    wrapper.unmount();
  }, CASE_TIMEOUT_MS);

  it('流式生成中编辑首条消息并确认发送，中断后正确重发', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const authStore = useAuthStore();
    const convStore = useConversationsStore();
    const modelStore = useModelStore();
    const queryStore = useQueryStore();

    convStore.loadConversations = vi.fn().mockResolvedValue(undefined);
    (authStore as any).user = { id: 'u1', role: 'admin' };
    modelStore.$patch({ presets: [{ key: 'p1' } as any], selectedPresetKey: 'p1' });

    const authFetch = vi.fn().mockImplementation((_url: string, opts?: any) =>
      abortableResponse(opts?.signal),
    );
    authStore.authFetch = authFetch as any;

    const wrapper = mount(Query, {
      global: { plugins: [pinia, ElementPlus], stubs },
      attachTo: document.body,
    });
    await flushPromises();

    // 种子一条已完成的问答（user idx0 / assistant idx1）
    queryStore.submitQuestion('原始问题');
    queryStore.appendAnswer('旧回答');
    queryStore.finalizeAnswer('sess', 0);
    await flushPromises();

    // 发起一条在途问答（真实 abortController，isLoading=true）
    wrapper.vm.inputQuestion = '第二个问题';
    wrapper.vm.handleSubmit();
    await waitFor('应处于流式生成中', () => queryStore.isLoading, {
      progress: () => progressSignature(authFetch.mock.calls.length, queryStore),
    });
    expect(queryStore.isLoading, '应处于流式生成中').toBe(true);

    // 编辑首条 user 消息（idx0）
    const editBtn = wrapper.find('button[title="编辑并重新发送"]');
    expect(editBtn.exists()).toBe(true);
    await editBtn.trigger('click');
    await flushPromises();

    const textarea = wrapper.find('.msg-edit textarea');
    expect(textarea.exists(), '编辑态 textarea 应出现').toBe(true);
    await textarea.setValue('修改后的问题');

    await wrapper.find('button[data-testid="confirm-edit"]').trigger('click');

    // 等待中断 finally → 重发（轮询真实状态而非固定时长）
    const resendCalled = () =>
      authFetch.mock.calls.some(
        (c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('修改后的问题'),
      );
    const { elapsedMs: resendElapsedMs } = await waitFor(
      '中断后应触发携带新文本的重发',
      resendCalled,
      { progress: () => progressSignature(authFetch.mock.calls.length, queryStore) },
    );
    // 取证输出：本轮实测等待时长（用于标定预算——见文件头等待策略说明）
    console.info(`[T02687] 正常 abort→finally 重发实测等待 ${resendElapsedMs}ms（硬上限 ${HARD_CAP_MS}ms）`);
    expect(resendCalled(), '中断后应触发携带新文本的重发').toBe(true);

    wrapper.unmount();
  }, CASE_TIMEOUT_MS);

  it('未修改内容直接确认发送也触发新一轮问答（回归：不应因内容未变而跳过重发）', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const authStore = useAuthStore();
    const convStore = useConversationsStore();
    const modelStore = useModelStore();
    const queryStore = useQueryStore();

    convStore.loadConversations = vi.fn().mockResolvedValue(undefined);
    (authStore as any).user = { id: 'u1', role: 'admin' };
    modelStore.$patch({ presets: [{ key: 'p1' } as any], selectedPresetKey: 'p1' });

    const authFetch = vi.fn().mockResolvedValue(fakeResponse());
    authStore.authFetch = authFetch as any;

    const wrapper = mount(Query, {
      global: { plugins: [pinia, ElementPlus], stubs },
      attachTo: document.body,
    });
    await flushPromises();

    // 种子一条已完成的问答
    queryStore.submitQuestion('原始问题');
    queryStore.appendAnswer('旧回答');
    queryStore.finalizeAnswer('sess', 0);
    await flushPromises();

    // 进入编辑态，但保持内容不变（不 setValue）
    const editBtn = wrapper.find('button[title="编辑并重新发送"]');
    await editBtn.trigger('click');
    await flushPromises();
    const textarea = wrapper.find('.msg-edit textarea');
    expect(textarea.exists(), '编辑态 textarea 应出现').toBe(true);

    // 直接确认发送（内容未变）
    await wrapper.find('button[data-testid="confirm-edit"]').trigger('click');
    const calledWithOriginal = () =>
      authFetch.mock.calls.some(
        (c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('原始问题'),
      );
    await waitFor('未修改内容也应触发携带原文本的重发', calledWithOriginal, {
      progress: () => progressSignature(authFetch.mock.calls.length, queryStore),
    });

    // 回归点：内容未变也须触发重发（此前会因 newText===original 直接 return，sendQuestion 不调用）
    expect(authFetch).toHaveBeenCalled();
    expect(calledWithOriginal(), '未修改内容也应触发携带原文本的重发').toBe(true);

    wrapper.unmount();
  }, CASE_TIMEOUT_MS);

  // T02687 新增：把「S3 兜底定时器」路径显式跑出来。
  // 这条路径不是异常，而是 Query.vue 明文承诺的行为（handleConfirmEdit 注释 + 兜底定时器）：
  // 传输层吞掉中断时，重发最迟在第 3 秒完成。旧实现 2000ms 墙钟预算断的是一个不可达状态，
  // 因此本用例同时充当「预算 ≥ 生产契约」的回归守卫——若有人把预算改回小于兜底阈值，它会失败。
  it('传输层吞掉中断时由 S3 兜底定时器完成重发（预算必须覆盖生产契约）', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const authStore = useAuthStore();
    const convStore = useConversationsStore();
    const modelStore = useModelStore();
    const queryStore = useQueryStore();

    convStore.loadConversations = vi.fn().mockResolvedValue(undefined);
    (authStore as any).user = { id: 'u1', role: 'admin' };
    modelStore.$patch({ presets: [{ key: 'p1' } as any], selectedPresetKey: 'p1' });

    // 关键差异：响应流忽略 AbortSignal（模拟后端/代理吞掉中断）→ sendQuestion 的 finally 不执行，
    // pendingResend 只能由 EDIT_RESEND_FALLBACK_MS 兜底定时器消费。
    const authFetch = vi.fn().mockImplementation(() => hangingResponse());
    authStore.authFetch = authFetch as any;

    const wrapper = mount(Query, {
      global: { plugins: [pinia, ElementPlus], stubs },
      attachTo: document.body,
    });
    await flushPromises();

    queryStore.submitQuestion('原始问题');
    queryStore.appendAnswer('旧回答');
    queryStore.finalizeAnswer('sess', 0);
    await flushPromises();

    wrapper.vm.inputQuestion = '第二个问题';
    wrapper.vm.handleSubmit();
    await waitFor('应处于流式生成中', () => queryStore.isLoading, {
      progress: () => progressSignature(authFetch.mock.calls.length, queryStore),
    });

    await wrapper.find('button[title="编辑并重新发送"]').trigger('click');
    await flushPromises();
    const textarea = wrapper.find('.msg-edit textarea');
    expect(textarea.exists(), '编辑态 textarea 应出现').toBe(true);
    await textarea.setValue('修改后的问题');
    // 计时起点取在「派发确认点击」这一刻：兜底定时器是在点击处理里 arm 的，
    // 从 waitFor 调用起算会少掉点击自身花掉的若干毫秒（实测 2978ms），
    // 那是度量口径错，不是产品走错了路径。
    const clickedAt = Date.now();
    await wrapper.find('button[data-testid="confirm-edit"]').trigger('click');

    const resendCalled = () =>
      authFetch.mock.calls.some(
        (c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('修改后的问题'),
      );
    const { elapsedMs } = await waitFor('S3 兜底定时器应触发携带新文本的重发', resendCalled, {
      progress: () => progressSignature(authFetch.mock.calls.length, queryStore),
    });
    const sinceClickMs = Date.now() - clickedAt;
    console.info(
      `[T02687] S3 兜底重发：点击后 ${sinceClickMs}ms（兜底阈值 ${EDIT_RESEND_FALLBACK_MS}ms）/ ` +
        `其中 waitFor 轮询 ${elapsedMs}ms`,
    );

    // 取证断言：重发确实发生在兜底定时器阈值之后——旧 2000ms 墙钟预算在此必然判失败。
    expect(
      sinceClickMs,
      '重发由 S3 兜底定时器触发，距确认点击应不早于兜底阈值；若小于阈值说明走错了路径',
    ).toBeGreaterThanOrEqual(EDIT_RESEND_FALLBACK_MS);
    // 断言本身仍成立（未放宽）：兜底路径同样丢弃被编辑消息并重插编辑后的文本
    expect(resendCalled(), 'S3 兜底应触发携带新文本的重发').toBe(true);
    expect(
      queryStore.messages.some((m) => m.role === 'user' && m.content === '修改后的问题'),
      '兜底重发后对话中应包含编辑后的用户消息',
    ).toBe(true);
    expect(queryStore.isLoading, '兜底重发的新一轮请求应已发出并处于生成中').toBe(true);

    wrapper.unmount();
  }, CASE_TIMEOUT_MS);
});
