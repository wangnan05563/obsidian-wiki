import { ref, watch, onMounted, computed, type Ref, type MaybeRefOrGetter } from 'vue';
import { toValue } from 'vue';

export interface UseFormDraftOptions<T extends object> {
  /**
   * 允许持久化到 localStorage 的字段白名单。
   * 只有白名单内的字段会被保存；恢复时也只覆盖白名单内的字段。
   */
  whitelist: Array<keyof T>;
  /**
   * 敏感字段列表（如 apiKey）。这些字段只有在 remember 为 true 时才会落盘；
   * 否则保存时被置空，避免明文泄露。
   */
  sensitive?: Array<keyof T>;
  /**
   * 是否「记住」敏感字段（通常绑定 el-checkbox）。
   * 该标记本身会随草稿持久化：下次恢复时若草稿记录了「记住」，会自动回填勾选状态与敏感字段。
   */
  remember?: Ref<boolean>;
  /**
   * 自定义恢复逻辑。默认使用 Object.assign 将草稿合并进 form。
   * reactive 对象建议传入逐字段赋值，避免破坏引用。
   */
  onRestore?: (draft: Partial<T>) => void;
  /**
   * 防抖等待时间（毫秒）。默认 500ms。
   */
  debounceMs?: number;
  /**
   * 是否在组件 mounted 时自动恢复草稿。默认 false。
   * 当表单初始值来自异步加载（服务端/IndexedDB）时，应保持 false 并在加载完成后显式调用 restore()，
   * 保证「草稿覆盖已保存快照」的正确顺序。
   */
  autoRestore?: boolean;
}

interface DraftPayload {
  savedAt: number;
  remember?: boolean;
}

function isSensitiveKey<T extends object>(key: keyof T, sensitive?: Array<keyof T>): boolean {
  return !!sensitive && sensitive.includes(key);
}

function pickDraft<T extends object>(form: T, options: UseFormDraftOptions<T>): Partial<T> {
  const { whitelist, sensitive, remember } = options;
  const draft: Record<string, unknown> = {};
  for (const key of whitelist) {
    if (isSensitiveKey(key, sensitive) && !remember?.value) {
      // 敏感字段未勾选「记住」时不落盘明文
      draft[key as string] = '';
      continue;
    }
    draft[key as string] = (form as Record<string, unknown>)[key as string];
  }
  return draft as Partial<T>;
}

/**
 * 表单草稿持久化 Composable（配置中心通用需求：本地草稿 + 敏感字段脱敏 + 快照覆盖恢复）。
 *
 * 行为约定：
 * - 首次 restore() 之前，深度监听不写草稿（避免初始异步加载把已有草稿覆盖掉）；
 * - restore() 将 localStorage 草稿按白名单覆盖合并进表单（未提交草稿优先于已保存快照）；
 * - 表单变化（防抖）自动写草稿；保存成功后由调用方调用 clear() 清除草稿；
 * - 敏感字段（如 API Key）仅在「记住」勾选时落盘明文，取消勾选立即从草稿中抹除。
 */
export function useFormDraft<T extends object>(
  storageKey: MaybeRefOrGetter<string>,
  form: Ref<T>,
  options: UseFormDraftOptions<T>,
): {
  hasDraft: Ref<boolean>;
  restore: () => boolean;
  clear: () => void;
  saveSnapshot: () => void;
} {
  // 支持响应式 key（如按预设隔离：draft key 随 selectedPresetKey 变化）
  const keyRef = computed(() => toValue(storageKey));
  const hasDraft = ref(false);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debounceMs = options.debounceMs ?? 500;
  // 首次恢复完成前禁止写草稿：防止初始加载覆盖 localStorage 中已有草稿
  let restoredOnce = false;

  function readDraft(): (Partial<T> & DraftPayload) | null {
    try {
      const raw = localStorage.getItem(keyRef.value);
      if (!raw) return null;
      return JSON.parse(raw) as Partial<T> & DraftPayload;
    } catch {
      return null;
    }
  }

  function writeDraft(draft: Partial<T>): void {
    if (!restoredOnce) return;
    try {
      const payload: Partial<T> & DraftPayload = {
        ...draft,
        remember: options.remember?.value ?? undefined,
        savedAt: Date.now(),
      };
      localStorage.setItem(keyRef.value, JSON.stringify(payload));
      hasDraft.value = true;
    } catch {
      // localStorage 不可用时静默降级
    }
  }

  function clear(): void {
    try {
      localStorage.removeItem(keyRef.value);
    } catch { /* 静默 */ }
    hasDraft.value = false;
  }

  /**
   * 恢复草稿：把 localStorage 中未提交的草稿按白名单覆盖进表单。
   * 返回是否实际恢复了草稿。
   */
  function restore(): boolean {
    restoredOnce = true;
    const draft = readDraft();
    if (!draft) {
      hasDraft.value = false;
      return false;
    }
    // 先恢复「记住」标记，再决定敏感字段是否回填
    if (options.remember && draft.remember === true) {
      options.remember.value = true;
    }
    const filtered: Record<string, unknown> = {};
    for (const key of options.whitelist) {
      if (!(key in draft)) continue;
      if (isSensitiveKey(key, options.sensitive) && !options.remember?.value) continue;
      filtered[key as string] = draft[key];
    }
    if (Object.keys(filtered).length > 0) {
      if (options.onRestore) {
        options.onRestore(filtered as Partial<T>);
      } else {
        Object.assign(form.value, filtered);
      }
    }
    hasDraft.value = true;
    return true;
  }

  function saveSnapshot(): void {
    restoredOnce = true;
    const draft = pickDraft(form.value, options);
    try {
      const payload: Partial<T> & DraftPayload = {
        ...draft,
        remember: options.remember?.value ?? undefined,
        savedAt: Date.now(),
      };
      localStorage.setItem(keyRef.value, JSON.stringify(payload));
      hasDraft.value = true;
    } catch { /* 静默 */ }
  }

  // key 变化（如切换预设）时刷新 hasDraft 存在性标记；恢复仍由调用方在加载完成后显式触发
  watch(keyRef, () => {
    try {
      hasDraft.value = localStorage.getItem(keyRef.value) !== null;
    } catch {
      hasDraft.value = false;
    }
  });

  if (options.autoRestore) {
    onMounted(() => {
      restore();
    });
  }

  watch(
    () => form.value,
    () => {
      if (!restoredOnce) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        writeDraft(pickDraft(form.value, options));
      }, debounceMs);
    },
    { deep: true },
  );

  // 「记住」勾选变化时立即重写草稿：取消勾选即刻从落盘内容中抹除敏感明文
  if (options.remember) {
    watch(options.remember, () => {
      if (!restoredOnce) return;
      writeDraft(pickDraft(form.value, options));
    });
  }

  return { hasDraft, restore, clear, saveSnapshot };
}
