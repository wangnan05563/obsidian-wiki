// T02918：逐字段对比「已保存快照」与「当前表单」的单一实现。
// ------------------------------------------------------------------
// 为什么必须抽出来：T02637 在 Tunnel.vue 里证明过「表单是草稿、已保存配置是事实」这个口径，
// 但当时是页面内联的一段 computed。Config.vue 有 8 个可编辑页签，如果各自再写一份
// JSON.stringify 对比，很快会出现「某页签把 undefined 当改动」「数组顺序被当成内容变化」
// 之类的分叉。这里统一成结构相等 + 字段中文名，Tunnel 与 Config 共用。
//
// 口径：
//   - 以 saved 的键集合为准（saved 是契约，form 多出来的键不参与）；
//   - 深度结构相等、对象键序无关（JSON.stringify 会把键序当差异）；
//   - saved/form 任一为 null（尚未加载）时不上报脏，避免默认值被误判为改动。
import { computed, toRaw, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue';

/** 字段名 → 面向用户的字段名（用于告警条/提示文案） */
export type DirtyFieldLabels = Record<string, string>;

export interface DirtyFieldsResult {
  dirtyFields: ComputedRef<string[]>;
  isDirty: ComputedRef<boolean>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 结构相等：对象键序无关、数组按序、NaN 与 NaN 相等。
 * 用于快照对比——表单对象常由 `{...a, ...b}` 拼接，键序不稳定。
 */
export function sameSnapshot(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameSnapshot(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameSnapshot(a[key], b[key]));
  }
  return false;
}

/** 深拷贝快照：structuredClone 保留 undefined 键，JSON 方案会丢掉它们（造成假脏）。
 *  注意先 toRaw：ref/reactive 的 .value 是 Proxy，structuredClone 会抛 DataCloneError。 */
export function cloneSnapshot<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    const raw = toRaw(value);
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(raw);
      } catch {
        // 含不可克隆对象时退回 JSON（本次表单均为纯数据，正常不会走到这里）
      }
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 逐字段对比已保存快照与当前表单，返回有改动的字段名（已按 labels 翻译）。
 * @param saved 已保存快照；null/undefined 表示尚未加载，此时不报脏
 * @param form 当前表单，通常传 getter 以保持响应式追踪
 * @param labels 字段中文名；未提供的键回退到键名本身
 */
export function useDirtyFields<T extends object>(
  saved: MaybeRefOrGetter<T | null | undefined>,
  form: MaybeRefOrGetter<T | null | undefined>,
  labels: DirtyFieldLabels = {},
): DirtyFieldsResult {
  const dirtyFields = computed<string[]>(() => {
    const base = toValue(saved);
    const current = toValue(form);
    if (!base || !current) return [];
    const out: string[] = [];
    for (const key of Object.keys(base) as Array<keyof T & string>) {
      if (!sameSnapshot(base[key], current[key])) out.push(labels[key] ?? key);
    }
    return out;
  });
  return {
    dirtyFields,
    isDirty: computed(() => dirtyFields.value.length > 0),
  };
}
