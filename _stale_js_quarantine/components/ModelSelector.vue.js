/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useModelStore } from '../stores/model';
import { useQueryStore } from '../stores/query';
// F-3.9 模型切换 UI
// 关键约束（SRS F-3.9 §9.1 R8）：
//   1. 切换前检查 isLoading，in-flight 问答未结束时禁止切换，避免 SSE 中途换模型导致响应错乱
//   2. 切换成功后 Toast 200ms 内出现「已切换到 xxx」
//   3. 切换失败回滚到上一个预设 key，避免 UI 显示与后端实际配置不一致
const store = useModelStore();
const queryStore = useQueryStore();
const previousPresetKey = ref('');
onMounted(async () => {
    try {
        await store.loadPresets();
        previousPresetKey.value = store.selectedPresetKey;
    }
    catch { }
});
async function handleChange(key) {
    // R8 风险缓解：SSE 进行中禁止切换模型
    if (queryStore.isLoading) {
        ElMessage.warning('回答生成中，请稍后再切换模型');
        return;
    }
    if (!key || key === store.selectedPresetKey)
        return;
    previousPresetKey.value = store.selectedPresetKey;
    await store.switchModel(key);
    // 切换失败回滚：switchModel 内部 catch 但不抛出，这里通过比对 selectedPresetKey 判断
    // 为什么不依赖 catch：switchModel 在 fetch 失败时已 selectedPresetKey.value = preset.key
    //（先更新 UI 再发请求），失败后 UI 仍是新值但后端未生效，需手动回滚
    // 通过读取后端 /api/ai/config 验证是否真的生效
    try {
        const res = await fetch(`${API_BASE}/ai/config`);
        if (res.ok) {
            const cfg = await res.json();
            const preset = store.presets.find(p => p.key === key);
            if (preset && cfg.model !== preset.model) {
                // 后端 model 未更新，回滚
                store.selectedPresetKey = previousPresetKey.value;
                ElMessage.error('模型切换失败，已回滚');
                return;
            }
        }
        const presetLabel = store.presets.find(p => p.key === key)?.label ?? key;
        ElMessage.success(`已切换到 ${presetLabel}`);
    }
    catch {
        // 验证失败不阻断（切换请求已发出），仅提示
        ElMessage.success('已切换模型');
    }
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['model-selector']} */ ;
/** @type {__VLS_StyleScopedClasses['model-selector']} */ ;
/** @type {__VLS_StyleScopedClasses['model-selector']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    ...{ onChange: (...[$event]) => {
            __VLS_ctx.handleChange($event.target.value);
        } },
    ...{ class: "model-selector" },
    value: (__VLS_ctx.store.selectedPresetKey),
    disabled: (__VLS_ctx.queryStore.isLoading),
    title: (__VLS_ctx.queryStore.isLoading ? '回答生成中，暂不可切换' : (__VLS_ctx.store.loadError || '选择当前问答模型')),
});
if (__VLS_ctx.store.presets.length === 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        value: "",
        disabled: true,
    });
    (__VLS_ctx.store.loadError ? '模型服务不可用' : '正在加载模型…');
}
for (const [preset] of __VLS_getVForSourceType((__VLS_ctx.store.presets))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        key: (preset.key),
        value: (preset.key),
    });
    (preset.label);
}
/** @type {__VLS_StyleScopedClasses['model-selector']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            store: store,
            queryStore: queryStore,
            handleChange: handleChange,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
