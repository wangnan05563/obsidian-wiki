import { ref, watch } from 'vue';
export function usePersistentState(key, defaultValue, storage = localStorage) {
    const loadFromStorage = () => {
        try {
            const raw = storage.getItem(key);
            return raw === null ? defaultValue : JSON.parse(raw);
        }
        catch {
            return defaultValue;
        }
    };
    const state = ref(loadFromStorage());
    watch(state, (value) => {
        try {
            storage.setItem(key, JSON.stringify(value));
        }
        catch { }
    }, { deep: true });
    return state;
}
