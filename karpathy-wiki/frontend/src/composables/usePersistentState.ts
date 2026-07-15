import { ref, watch, type Ref } from 'vue';

export function usePersistentState<T>(
  key: string,
  defaultValue: T,
  storage: Storage = localStorage,
): Ref<T> {
  const loadFromStorage = (): T => {
    try {
      const raw = storage.getItem(key);
      return raw === null ? defaultValue : JSON.parse(raw) as T;
    } catch {
      return defaultValue;
    }
  };

  const state = ref(loadFromStorage()) as Ref<T>;
  watch(state, (value) => {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {}
  }, { deep: true });

  return state;
}
