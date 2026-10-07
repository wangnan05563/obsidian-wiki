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

const stubs = {
  ConversationSidebar: true,
  AttachmentUploader: true,
  InputToolbar: true,
  ThinkingBlock: true,
  ModelSelector: true,
  RefsList: true,
  MultimodalOutputCard: true,
};

// 轮询等待异步链完成，替代「固定 setTimeout(N ms) + flushPromises」的经验值等待。
// 为什么改：sendQuestion → buildQueryBody(含 await 配置加载) → fetch → 落消息 的微任务链
// 长度取决于机器负载；本机在 SonarQube TS 分析并行时 CPU 争用，10/20/40ms 会不够，
// 导致同一用例在单跑时通过、全量跑时偶发失败（假阳性）。轮询到断言条件成立即返回，
// 超时上限 2000ms——条件不变、断言不变，只是把「猜时长」换成「等真实状态」。
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor 超时（${timeoutMs}ms）：${label}`);
    }
    await flushPromises();
    await new Promise((r) => setTimeout(r, 5));
  }
  await flushPromises();
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
    await waitFor('authFetch 请求体应包含修改后的文本', bodyHasNew);

    // 断言：新一轮问答被触发（authFetch 被调用，且请求体包含新文本）
    expect(authFetch).toHaveBeenCalled();
    expect(bodyHasNew(), 'authFetch 请求体应包含修改后的文本').toBe(true);

    // 断言：对话里存在以新文本开头的 user 消息
    const hasNewUser = queryStore.messages.some(
      (m) => m.role === 'user' && m.content === '修改后的问题',
    );
    expect(hasNewUser, '对话中应包含修改后的用户消息').toBe(true);

    wrapper.unmount();
  });

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
    await waitFor('应处于流式生成中', () => queryStore.isLoading);
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
    await waitFor('中断后应触发携带新文本的重发', resendCalled);
    expect(resendCalled(), '中断后应触发携带新文本的重发').toBe(true);

    wrapper.unmount();
  });

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
    await waitFor('未修改内容也应触发携带原文本的重发', calledWithOriginal);

    // 回归点：内容未变也须触发重发（此前会因 newText===original 直接 return，sendQuestion 不调用）
    expect(authFetch).toHaveBeenCalled();
    expect(calledWithOriginal(), '未修改内容也应触发携带原文本的重发').toBe(true);

    wrapper.unmount();
  });
});
