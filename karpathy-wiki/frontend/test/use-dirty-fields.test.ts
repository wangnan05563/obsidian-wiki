// T02918：未保存改动口径的单一实现（useDirtyFields）
// ------------------------------------------------------------------
// 这套判定同时被 Tunnel.vue（T02637 的既有能力）与 Config.vue（8 个页签）使用，
// 所以先把口径本身钉住：键序无关、嵌套结构递归、NaN/undefined 不误报、未加载不误报。
// 页面级用例见 config-dirty-markers.test.ts（那里证明的是「改字段 → 导航出现标记」）。
import { describe, it, expect } from 'vitest';
import { nextTick, ref } from 'vue';
import { cloneSnapshot, sameSnapshot, useDirtyFields } from '../src/composables/useDirtyFields';

describe('sameSnapshot：结构相等（键序无关）', () => {
  it('同一对象 / 基本类型相等', () => {
    expect(sameSnapshot(1, 1)).toBe(true);
    expect(sameSnapshot('a', 'a')).toBe(true);
    expect(sameSnapshot(true, true)).toBe(true);
    expect(sameSnapshot(null, null)).toBe(true);
    expect(sameSnapshot(undefined, undefined)).toBe(true);
  });

  it('对象键序不同但内容相同 ⇒ 相等（JSON.stringify 会误判的场景）', () => {
    expect(sameSnapshot({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameSnapshot({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
  });

  it('数组按序比较，嵌套对象递归比较', () => {
    expect(sameSnapshot(['md', 'txt'], ['md', 'txt'])).toBe(true);
    expect(sameSnapshot(['md', 'txt'], ['txt', 'md'])).toBe(false);
    expect(sameSnapshot([{ n: 'a', e: true }], [{ n: 'a', e: true }])).toBe(true);
    expect(sameSnapshot([{ n: 'a', e: true }], [{ n: 'a', e: false }])).toBe(false);
  });

  it('键的增减都算不同；undefined 与缺失键不同', () => {
    expect(sameSnapshot({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameSnapshot({ a: 1, b: undefined }, { a: 1 })).toBe(false);
    expect(sameSnapshot({ a: undefined }, { a: undefined })).toBe(true);
  });

  it('NaN 与 NaN 相等、类型不同不相等', () => {
    expect(sameSnapshot(NaN, NaN)).toBe(true);
    expect(sameSnapshot(1, '1')).toBe(false);
  });
});

describe('cloneSnapshot：快照保留 undefined 键', () => {
  it('structuredClone 语义下 undefined 键不丢，避免「一加载就显脏」', () => {
    const source = { a: 1, b: undefined as string | undefined };
    const copy = cloneSnapshot(source);
    expect(Object.keys(copy)).toEqual(['a', 'b']);
    expect('b' in copy).toBe(true);
    expect(copy).not.toBe(source);
  });

  it('深拷贝：改副本不影响原对象', () => {
    const source = { nested: { n: 1 }, list: [1, 2] };
    const copy = cloneSnapshot(source);
    copy.nested.n = 9;
    copy.list.push(3);
    expect(source.nested.n).toBe(1);
    expect(source.list).toEqual([1, 2]);
  });
});

describe('useDirtyFields：逐字段对比', () => {
  it('saved 为 null（尚未加载）⇒ 不上报脏，默认值不算改动', () => {
    const form = ref({ a: 1 });
    const saved = ref<{ a: number } | null>(null);
    const { dirtyFields, isDirty } = useDirtyFields(saved, form, { a: '甲' });
    expect(dirtyFields.value).toEqual([]);
    expect(isDirty.value).toBe(false);
  });

  it('字段变化返回中文标签；saved 的键集合为准，form 多出的键不参与', () => {
    const saved = ref({ a: 1, b: 'x' });
    const form = ref({ a: 2, b: 'x', extra: true });
    const { dirtyFields } = useDirtyFields(saved, form, { a: '甲', b: '乙' });
    expect(dirtyFields.value).toEqual(['甲']);
  });

  it('未提供标签时回退到键名', () => {
    const saved = ref({ localPort: 3000 });
    const form = ref({ localPort: 3001 });
    expect(useDirtyFields(saved, form).dirtyFields.value).toEqual(['localPort']);
  });

  it('响应式：改表单 / 保存后前移基线都会即时反映', async () => {
    const saved = ref({ maxSteps: 20 });
    const form = ref({ maxSteps: 20 });
    const { dirtyFields, isDirty } = useDirtyFields(saved, form, { maxSteps: '最大步数' });
    expect(isDirty.value).toBe(false);

    form.value.maxSteps = 30;
    await nextTick();
    expect(dirtyFields.value).toEqual(['最大步数']);

    // 保存成功：基线追上表单 ⇒ 标记清零
    saved.value = cloneSnapshot(form.value);
    await nextTick();
    expect(isDirty.value).toBe(false);
  });

  it('Tunnel 口径：authtoken 不回显，saved 侧为空串 ⇒ 填了才算改动、清空即干净', async () => {
    const saved = ref({ authtoken: '', localPort: 3000 });
    const form = ref({ authtoken: '', localPort: 3000 });
    const { dirtyFields } = useDirtyFields(saved, form, { authtoken: 'Authtoken', localPort: '本地端口' });
    expect(dirtyFields.value).toEqual([]);

    form.value.authtoken = 'tskey-abc';
    await nextTick();
    expect(dirtyFields.value).toEqual(['Authtoken']);

    form.value.authtoken = '';
    await nextTick();
    expect(dirtyFields.value).toEqual([]);
  });

  it('嵌套整组（生图/视频）改一个子字段也算该组有改动', async () => {
    const saved = ref({ image: { model: 'a', size: '1024x768' }, video: { model: 'v' } });
    const form = ref({ image: { model: 'a', size: '1024x768' }, video: { model: 'v' } });
    const { dirtyFields } = useDirtyFields(saved, form, { image: '生图配置', video: '视频配置' });
    form.value.image.size = '1280x720';
    await nextTick();
    expect(dirtyFields.value).toEqual(['生图配置']);
  });
});
