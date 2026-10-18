// T01833：useFormDraft 表单草稿持久化单元测试
// 覆盖：白名单持久化 / 敏感字段脱敏（记住开关）/ 恢复优先于初始加载 / 保存后清除 / 恢复前不写草稿
import { describe, it, expect, beforeEach } from 'vitest';
import { defineComponent, ref, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { useFormDraft } from '../src/composables/useFormDraft';

interface SearchForm {
  provider: string;
  apiKey: string;
  maxResults: number;
  secretNonWhitelisted: string;
}

const KEY = 'test:config:draft:web-search';

function makeHost(options: Omit<Parameters<typeof useFormDraft<SearchForm>>[2], 'remember'>) {
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
      api = useFormDraft<SearchForm>(KEY, form, { ...options, remember, debounceMs: 10 });
      return () => null;
    },
  });
  mount(Host);
  return { api: api!, form, remember };
}

const flushDebounce = () => new Promise((r) => setTimeout(r, 30));

function rawDraft(): Record<string, unknown> | null {
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe('useFormDraft', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('恢复前初始加载/表单变化不写草稿（防止覆盖已有草稿）', async () => {
    localStorage.setItem(KEY, JSON.stringify({ apiKey: 'sk-keep', savedAt: 1 }));
    const { api, form } = makeHost({ whitelist: ['provider', 'apiKey', 'maxResults'] });
    // 模拟初始加载回填
    form.value.apiKey = 'loaded-from-idb';
    await nextTick();
    await flushDebounce();
    // 未调用 restore() 前不得写入，原草稿保持不变
    expect(rawDraft()!.apiKey).toBe('sk-keep');
    // 恢复后草稿覆盖初始加载值
    expect(api.restore()).toBe(true);
    expect(form.value.apiKey).toBe('sk-keep');
  });

  it('无草稿时 restore 返回 false 且不写入', () => {
    const { api } = makeHost({ whitelist: ['provider', 'apiKey', 'maxResults'] });
    expect(api.restore()).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('仅白名单字段落盘与恢复', async () => {
    const { api, form } = makeHost({ whitelist: ['provider', 'apiKey', 'maxResults'] });
    api.restore();
    form.value.apiKey = 'sk-abc';
    form.value.secretNonWhitelisted = 'should-not-save';
    await nextTick();
    await flushDebounce();
    const draft = rawDraft()!;
    expect(draft.apiKey).toBe('sk-abc');
    expect(draft.secretNonWhitelisted).toBeUndefined();

    // 恢复时白名单外字段不被覆盖
    form.value.secretNonWhitelisted = 'kept';
    localStorage.setItem(KEY, JSON.stringify({ secretNonWhitelisted: 'evil', savedAt: 1 }));
    api.restore();
    expect(form.value.secretNonWhitelisted).toBe('kept');
  });

  it('未勾选「记住」时敏感字段不落盘明文', async () => {
    const { api, form } = makeHost({
      whitelist: ['provider', 'apiKey', 'maxResults'],
      sensitive: ['apiKey'],
    });
    api.restore();
    form.value.apiKey = 'sk-secret';
    await nextTick();
    await flushDebounce();
    expect(rawDraft()!.apiKey).toBe('');
    expect(rawDraft()!.remember).toBe(false);
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
    await flushDebounce();
    expect(rawDraft()!.apiKey).toBe('sk-persist-me');
    expect(rawDraft()!.remember).toBe(true);

    // 取消勾选：立即从草稿抹除明文
    ctx.remember.value = false;
    await nextTick();
    await flushDebounce();
    expect(rawDraft()!.apiKey).toBe('');

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
    localStorage.setItem(
      KEY,
      JSON.stringify({ apiKey: 'sk-remembered', remember: true, savedAt: 1 }),
    );
    const { api, form, remember } = makeHost({
      whitelist: ['provider', 'apiKey', 'maxResults'],
      sensitive: ['apiKey'],
    });
    api.restore();
    expect(remember.value).toBe(true);
    expect(form.value.apiKey).toBe('sk-remembered');
  });

  it('保存成功后 clear() 清除草稿', async () => {
    const { api, form } = makeHost({ whitelist: ['provider', 'apiKey', 'maxResults'] });
    api.restore();
    form.value.provider = 'bing';
    await nextTick();
    await flushDebounce();
    expect(rawDraft()!.provider).toBe('bing');
    api.clear();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(api.hasDraft.value).toBe(false);
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
          { whitelist: ['provider', 'apiKey', 'maxResults'], remember, debounceMs: 10 },
        );
        return () => null;
      },
    });
    mount(Host);

    // 预设 A：写入草稿
    api.restore();
    form.value.apiKey = 'sk-for-glm';
    await nextTick();
    await flushDebounce();
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
