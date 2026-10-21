// T01833：useFormDraft 表单草稿持久化单元测试
// 覆盖：白名单持久化 / 敏感字段脱敏（记住开关）/ 恢复优先于初始加载 / 保存后清除 / 恢复前不写草稿
//
// T02753 改造（两点，缺一不可）：
//  1. 等待口径：`await flushDebounce()`（写死 30ms）换成进展感知轮询；
//     只有「断言的是没有发生」这一处保留定时，且预算由被测契约常量 DEBOUNCE_MS 推导。
//  2. 隔离口径：每个用例独占一个 storage key。原实现七个用例共用同一个 KEY，
//     而上一个用例挂载的宿主组件从不卸载——它 pending 的防抖定时器会在**下一个用例**
//     清空 localStorage 之后补写一份旧草稿。旧写法靠 30ms 睡过头把这段脏写吃在睡眠里，
//     改成轮询真实终点后立刻暴露（并发全套实测：下一用例读到上一用例的 'sk-abc'）。
//     也就是说这不是改造引入的不稳定，而是原本就存在、被固定时长掩盖的竞态。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineComponent, ref, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { useFormDraft } from '../src/composables/useFormDraft';
import { waitForProgress, contractSleep, NO_TIMER_CHAIN } from './helpers/waitForProgress';

interface SearchForm {
  provider: string;
  apiKey: string;
  maxResults: number;
  secretNonWhitelisted: string;
}

// 本文件传给被测组合式的防抖时长。
// 来源：src/composables/useFormDraft.ts:83 `options.debounceMs ?? 500`（默认 500ms，测试里压到 10ms 提速）。
// T02753：凡是要「等防抖窗口过去」的预算，都从这个常量推导，不再裸写 30ms。
const DEBOUNCE_MS = 10;

const KEY_BASE = 'test:config:draft:web-search';
let keySeq = 0;
const mountedWrappers: Array<{ unmount(): void }> = [];

/** 读任意 key 下的草稿（未落盘返回空对象，便于在轮询谓词里直接点字段） */
function draftOf(storageKey: string): Record<string, any> {
  const raw = localStorage.getItem(storageKey);
  return raw ? (JSON.parse(raw) as Record<string, any>) : {};
}

/** 未落盘返回 null（用于「草稿到底有没有写过」这类断言） */
function rawDraftAt(storageKey: string): Record<string, unknown> | null {
  const raw = localStorage.getItem(storageKey);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function makeHost(
  options: Omit<Parameters<typeof useFormDraft<SearchForm>>[2], 'remember'>,
  fixedKey?: string,
) {
  // 每个用例独占一个 key（见文件头说明）；需要预置草稿的用例显式传 fixedKey，
  // 避免依赖「第几个用例」的隐式编号
  const storageKey = fixedKey ?? `${KEY_BASE}#${++keySeq}`;
  let api: ReturnType<typeof useFormDraft<SearchForm>> | null = null;
  const form = ref<SearchForm>({
    provider: 'tavily',
    apiKey: '',
    maxResults: 5,
    secretNonWhitelisted: '',
  });
  const remember = ref(false);
  const Host = defineComponent({
    setup() {
      api = useFormDraft<SearchForm>(storageKey, form, {
        ...options,
        remember,
        debounceMs: DEBOUNCE_MS,
      });
      return () => null;
    },
  });
  mountedWrappers.push(mount(Host));
  return {
    api: api!,
    form,
    remember,
    storageKey,
    /** 本用例自己的草稿（null = 从未写过） */
    draft: () => rawDraftAt(storageKey),
    /** 本用例自己的草稿字段（未落盘时为 undefined） */
    field: (name: string) => draftOf(storageKey)[name],
  };
}

describe('useFormDraft', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    // 卸载本用例挂载的宿主，停掉它的 watch；配合独占 key，
    // 即便 pending 的防抖定时器晚一拍落下来，也只写自己那个 key，不污染后续用例
    while (mountedWrappers.length) mountedWrappers.pop()!.unmount();
  });

  it('恢复前初始加载/表单变化不写草稿（防止覆盖已有草稿）', async () => {
    const ctx = makeHost({ whitelist: ['provider', 'apiKey', 'maxResults'] });
    localStorage.setItem(ctx.storageKey, JSON.stringify({ apiKey: 'sk-keep', savedAt: 1 }));
    // 模拟初始加载回填
    ctx.form.value.apiKey = 'loaded-from-idb';
    await nextTick();
    // 终点是「没有发生写入」——不可观测，只能等防抖窗口过去。
    // 预算 = DEBOUNCE_MS × 3：覆盖原写法（30ms = 3 个防抖窗口），且不靠机器快慢赌。
    await contractSleep(
      'useFormDraft.ts:83 options.debounceMs（本文件传 10）× 3 个防抖窗口，断言的是「未写入」',
      DEBOUNCE_MS * 3,
    );
    // 未调用 restore() 前不得写入，原草稿保持不变
    expect(ctx.draft()!.apiKey).toBe('sk-keep');
    // 恢复后草稿覆盖初始加载值
    expect(ctx.api.restore()).toBe(true);
    expect(ctx.form.value.apiKey).toBe('sk-keep');
  });

  it('无草稿时 restore 返回 false 且不写入', () => {
    const ctx = makeHost({ whitelist: ['provider', 'apiKey', 'maxResults'] });
    expect(ctx.api.restore()).toBe(false);
    expect(localStorage.getItem(ctx.storageKey)).toBeNull();
  });

  it('仅白名单字段落盘与恢复', async () => {
    const ctx = makeHost({ whitelist: ['provider', 'apiKey', 'maxResults'] });
    ctx.api.restore();
    ctx.form.value.apiKey = 'sk-abc';
    ctx.form.value.secretNonWhitelisted = 'should-not-save';
    await nextTick();
    // 终点可观测：草稿里出现了这次写入的值 → 轮询它，不再猜时长
    await waitForProgress(
      '防抖写入已落盘（apiKey=sk-abc）',
      () => ctx.field('apiKey') === 'sk-abc',
      NO_TIMER_CHAIN,
    );
    const draft = ctx.draft()!;
    expect(draft.apiKey).toBe('sk-abc');
    expect(draft.secretNonWhitelisted).toBeUndefined();

    // 恢复时白名单外字段不被覆盖
    ctx.form.value.secretNonWhitelisted = 'kept';
    localStorage.setItem(ctx.storageKey, JSON.stringify({ secretNonWhitelisted: 'evil', savedAt: 1 }));
    ctx.api.restore();
    expect(ctx.form.value.secretNonWhitelisted).toBe('kept');
  });

  it('未勾选「记住」时敏感字段不落盘明文', async () => {
    const ctx = makeHost({
      whitelist: ['provider', 'apiKey', 'maxResults'],
      sensitive: ['apiKey'],
    });
    ctx.api.restore();
    ctx.form.value.apiKey = 'sk-secret';
    await nextTick();
    // 终点可观测：本用例独占的 key 上出现了第一份草稿（= 本宿主的防抖写入已完成）
    await waitForProgress('草稿已落盘', () => ctx.draft() !== null, NO_TIMER_CHAIN);
    expect(ctx.draft()!.apiKey).toBe('');
    expect(ctx.draft()!.remember).toBe(false);
  });

  it('勾选「记住」后敏感字段落盘，取消勾选立即抹除', async () => {
    const ctx = makeHost({
      whitelist: ['provider', 'apiKey', 'maxResults'],
      sensitive: ['apiKey'],
    });
    ctx.api.restore();
    ctx.remember.value = true;
    ctx.form.value.apiKey = 'sk-persist-me';
    await nextTick();
    await waitForProgress(
      '勾选「记住」后敏感明文已落盘',
      () => ctx.field('apiKey') === 'sk-persist-me',
      NO_TIMER_CHAIN,
    );
    expect(ctx.draft()!.apiKey).toBe('sk-persist-me');
    expect(ctx.draft()!.remember).toBe(true);

    // 取消勾选：立即从草稿抹除明文（这条走 remember 监听，不经过防抖）
    ctx.remember.value = false;
    await nextTick();
    await waitForProgress(
      '取消勾选后草稿里的明文已抹除',
      () => ctx.field('apiKey') === '',
      NO_TIMER_CHAIN,
    );
    expect(ctx.draft()!.apiKey).toBe('');

    // 重新挂载恢复：未记住 → 敏感字段不回填，remember 保持 false
    const ctx2 = makeHost({
      whitelist: ['provider', 'apiKey', 'maxResults'],
      sensitive: ['apiKey'],
    });
    ctx2.api.restore();
    expect(ctx2.remember.value).toBe(false);
    expect(ctx2.form.value.apiKey).toBe('');
  });

  it('恢复时草稿记录的「记住」标记自动回填并带回敏感字段', () => {
    const storageKey = `${KEY_BASE}#remembered`;
    localStorage.setItem(
      storageKey,
      JSON.stringify({ apiKey: 'sk-remembered', remember: true, savedAt: 1 }),
    );
    const { api, form, remember } = makeHost(
      {
        whitelist: ['provider', 'apiKey', 'maxResults'],
        sensitive: ['apiKey'],
      },
      storageKey,
    );
    api.restore();
    expect(remember.value).toBe(true);
    expect(form.value.apiKey).toBe('sk-remembered');
  });

  it('保存成功后 clear() 清除草稿', async () => {
    const ctx = makeHost({ whitelist: ['provider', 'apiKey', 'maxResults'] });
    ctx.api.restore();
    ctx.form.value.provider = 'bing';
    await nextTick();
    await waitForProgress(
      '防抖写入已落盘（provider=bing）',
      () => ctx.field('provider') === 'bing',
      NO_TIMER_CHAIN,
    );
    expect(ctx.draft()!.provider).toBe('bing');
    ctx.api.clear();
    expect(localStorage.getItem(ctx.storageKey)).toBeNull();
    expect(ctx.api.hasDraft.value).toBe(false);
  });

  it('响应式 key：切换 key 后草稿按新 key 隔离存取（按预设隔离场景）', async () => {
    const presetKey = ref('glm');
    let api!: ReturnType<typeof useFormDraft<SearchForm>>;
    const form = ref<SearchForm>({
      provider: 'tavily',
      apiKey: '',
      maxResults: 5,
      secretNonWhitelisted: '',
    });
    const remember = ref(false);
    const Host = defineComponent({
      setup() {
        api = useFormDraft<SearchForm>(
          () => `test:config:draft:ai:${presetKey.value}`,
          form,
          { whitelist: ['provider', 'apiKey', 'maxResults'], remember, debounceMs: DEBOUNCE_MS },
        );
        return () => null;
      },
    });
    mountedWrappers.push(mount(Host));

    // 预设 A：写入草稿
    api.restore();
    form.value.apiKey = 'sk-for-glm';
    await nextTick();
    await waitForProgress(
      '预设 A 的草稿已按自己的 key 落盘',
      () => draftOf('test:config:draft:ai:glm').apiKey === 'sk-for-glm',
      NO_TIMER_CHAIN,
    );
    expect(JSON.parse(localStorage.getItem('test:config:draft:ai:glm')!).apiKey).toBe('sk-for-glm');

    // 切换预设 B：模拟 applyPreset 用 B 的已保存配置重载表单，再恢复 B 的草稿（无草稿=不覆盖）
    presetKey.value = 'qwen';
    await nextTick();
    form.value.apiKey = ''; // B 预设已保存快照回填
    api.restore();
    expect(form.value.apiKey).toBe('');
    expect(JSON.parse(localStorage.getItem('test:config:draft:ai:glm')!).apiKey).toBe('sk-for-glm');

    // 切回预设 A：恢复 A 的草稿
    presetKey.value = 'glm';
    await nextTick();
    api.restore();
    expect(form.value.apiKey).toBe('sk-for-glm');
  });
});
