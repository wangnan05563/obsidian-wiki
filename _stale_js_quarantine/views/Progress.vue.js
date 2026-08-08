/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { onMounted, onBeforeUnmount, computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Loading, Check, Close, Lightning } from '@element-plus/icons-vue';
import { useCompileStore } from '../stores/compile';
import { consumeSSE } from '../utils/sse';
import BatchProgressBar from '../components/BatchProgressBar.vue';
import SingleFileProgressBar from '../components/SingleFileProgressBar.vue';
// LLM Provider 快捷切换：编译失败时无需跳转 Config 页面即可切换
// 为什么在 Progress.vue 提供：LLM 服务故障时用户最常做的操作就是切换 provider 重试，
// 跳转 Config 页面切换后再返回 Progress 流程割裂，快捷切换提升体验
const llmPresets = ref([]);
const switchingProvider = ref(false);
async function loadLlmPresets() {
    try {
        const res = await fetch(`${API_BASE}/ai/presets`);
        if (!res.ok)
            return;
        const data = await res.json();
        llmPresets.value = Array.isArray(data) ? data : (data.presets ?? []);
    }
    catch {
        // 预设加载失败不阻断编译流程
    }
}
async function quickSwitchProvider(preset) {
    if (switchingProvider.value)
        return;
    switchingProvider.value = true;
    try {
        const res = await fetch(`${API_BASE}/ai/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: preset.provider,
                baseUrl: preset.baseUrl,
                model: preset.model,
                apiKeyRef: preset.apiKeyRef,
            }),
        });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        ElMessage.success(`已切换到 ${preset.label}，可重新编译`);
        // 切换后清除错误状态，让用户能重新点击"重新投递"
        store.errorMessage = '';
    }
    catch (err) {
        ElMessage.error('切换 provider 失败：' + err.message);
    }
    finally {
        switchingProvider.value = false;
    }
}
const emit = defineEmits();
const store = useCompileStore();
let abortController = null;
const logDialogVisible = ref(false);
const viewingRunId = ref('');
const STEP_LABEL = {
    archive: '存档原始资料',
    read_schema: '读取 SCHEMA',
    extract: '提取要点',
    generate_page: '生成页面',
    update_index: '更新索引',
    update_log: '记录日志',
    finalize: '收尾'
};
const robotMood = computed(() => {
    if (store.errorMessage)
        return 'sad';
    if (store.isDone)
        return 'happy';
    return 'thinking';
});
const showRunsList = computed(() => !store.isCompiling && !store.isDone && !store.errorMessage && !store.isCancelled);
async function startCompile(payload) {
    const isFormData = payload instanceof FormData;
    abortController = new AbortController();
    try {
        // 批量模式调用 /api/compile/batch，单文件模式调用 /api/compile
        // 为什么用 API_BASE 拼接：vite.config.ts 的 base 为 '/wiki/'，API_BASE='/wiki/api'，
        // 仅 '/api/compile' 会绕过 vite proxy 的 '/wiki/api' 规则导致 dev 模式 404
        const endpoint = store.isBatchMode ? `${API_BASE}/compile/batch` : `${API_BASE}/compile`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: isFormData ? {} : { 'Content-Type': 'application/json' },
            body: isFormData ? payload : JSON.stringify(payload),
            signal: abortController.signal
        });
        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
        }
        await consumeCompileSSE(response);
    }
    catch (err) {
        if (err.name === 'AbortError') {
            // 中止时仅复位 isCompiling，不污染 errorMessage：
            // 用户切走/切回是正常导航操作，不应显示为错误
            store.abortCompile();
            return;
        }
        store.handleEvent('error', { message: err.message });
        ElMessage.error('编译请求失败：' + err.message);
    }
    finally {
        abortController = null;
    }
}
async function startResume(runId) {
    // §优化方案3：resume 前保留已恢复的 stageTimings/compileStartedAt，避免 reset 清空
    // 为什么需要保留：后端 resume 从断点继续，已完成阶段的耗时不会重新产生，
    //   若不保留则切回后 stage-timings 面板为空，无法体现完整耗时分布
    const preservedTimings = { ...store.stageTimings };
    const preservedStartedAt = store.compileStartedAt;
    store.reset();
    store.stageTimings = preservedTimings;
    store.compileStartedAt = preservedStartedAt;
    // 直接修改：compile store 未暴露 startCompile action，此字段是简单状态
    store.isCompiling = true;
    abortController = new AbortController();
    try {
        const response = await fetch(`${API_BASE}/compile/resume/${runId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: abortController.signal
        });
        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
        }
        await consumeCompileSSE(response);
    }
    catch (err) {
        if (err.name === 'AbortError') {
            store.abortCompile();
            return;
        }
        store.handleEvent('error', { message: err.message });
        ElMessage.error('恢复失败：' + err.message);
    }
    finally {
        abortController = null;
    }
}
// SSE 流消费委托给 utils/sse.ts 的通用 consumeSSE，降低本函数认知复杂度（S3776）
// compile store 使用 handleEvent 统一入口分发事件
// §优化方案3：每次事件处理后同步持久化，确保切走页面时 localStorage 是最新状态
function handleSSE(eventType, parsed) {
    store.handleEvent(eventType, parsed);
    store.persistState();
}
async function consumeCompileSSE(response) {
    await consumeSSE(response, handleSSE);
}
// 用户主动取消编译（批量模式）：触发 abortController 中止 SSE 流，并通过 store.cancelCompile 标记取消态
// 为什么不在 BatchProgressBar 内部直接 abort：abortController 是 Progress.vue 的局部变量，
//   子组件无法访问；通过 emit 事件委托父组件处理是 Vue 单向数据流的惯用模式
function handleBatchCancel() {
    abortController?.abort();
    store.cancelCompile();
    ElMessage.info('已取消批量编译');
}
// §优化方案1：用户主动取消编译（单文件模式）
// 与 handleBatchCancel 分离：文案与日志语义不同，避免误导用户
function handleSingleCancel() {
    abortController?.abort();
    store.cancelCompile();
    // 单文件取消后清除持久化状态，避免切回时误恢复
    store.clearPersistedState();
    ElMessage.info('已取消编译');
}
onMounted(() => {
    // 加载 LLM 预设列表：编译失败时供用户快捷切换 provider
    loadLlmPresets();
    // §优化方案3：先尝试从 localStorage 恢复上次的编译状态
    // 为什么在 onMounted 最前面：恢复的 pendingPayload/isDone 等会影响后续 startCompile 判断，
    //   必须在判断之前完成恢复
    const needResume = store.loadPersistedState();
    // §done 态恢复后清除 localStorage：用户已看到结果，下次刷新不需要再恢复
    // 为什么不清除 running 态：running 态需要 resume 接续，localStorage 是 resume 的数据源
    // 为什么不清除 error/cancelled 态：保留让用户切走再切回仍能看到失败原因，避免"消失了"的困惑
    if (store.isDone && !needResume) {
        store.clearPersistedState();
    }
    // 批量模式优先检测 pendingBatchPayload，否则检测单文件 pendingPayload
    // 守卫逻辑（注意是 isCompiling 而非 !isCompiling）：
    //   - 首次从 Ingest 切入：prepareBatchCompile/prepareCompile 已设置 isCompiling=true 表示"应该开始编译"，
    //     此时 isCompiling=true → 触发 startCompile 发起 SSE 请求
    //   - 编译进行中切走再切回：onBeforeUnmount 已调用 abortCompile 复位 isCompiling=false，
    //     此时 isCompiling=false → 跳过 startCompile，避免重复触发导致 SSE 流重置（批量编译会从头开始重复编译）
    //   - 编译完成/出错/取消后切回：isDone/errorMessage/isCancelled 任一为真 → 跳过
    // 之前用 !isCompiling 是逻辑反向 bug：首次进入时 isCompiling=true 导致 !isCompiling=false，
    //   startCompile 永远不会被调用，页面卡在"正在编译… 0/0 0%"
    if (store.isBatchMode && store.pendingBatchPayload && !store.isDone && store.isCompiling && !store.isCancelled) {
        startCompile(store.pendingBatchPayload);
    }
    else if (store.pendingPayload && !store.isDone && store.isCompiling && !store.isCancelled) {
        startCompile(store.pendingPayload);
    }
    else if (needResume && store.currentRunId) {
        // §优化方案3：切走时正在编译且记录了 runId → 调用 resume 接口恢复未完成的编译
        // 为什么独立分支：startCompile 会重置状态从头开始，与 resume 语义冲突
        startResume(store.currentRunId);
    }
    else {
        store.loadRuns();
    }
});
async function openLogDialog(run) {
    viewingRunId.value = run.runId;
    logDialogVisible.value = true;
    await store.loadLog(run.runId);
}
function formatTime(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    catch {
        return iso;
    }
}
function runStatusType(status) {
    if (status === 'done')
        return 'success';
    if (status === 'failed')
        return 'danger';
    return 'warning';
}
function runStatusLabel(status) {
    if (status === 'done')
        return '完成';
    if (status === 'failed')
        return '失败';
    return '运行中';
}
onBeforeUnmount(() => {
    abortController?.abort();
    // §优化方案3：切走时若仍在编译中，先持久化当前状态再中止
    // 为什么 persistState 在 abortCompile 之前：abortCompile 会复位 isCompiling，
    //   persistState 内部判断 isBatchMode 才跳过，单文件模式依赖 isCompiling 标识"需恢复"
    //   实际持久化的 isCompiling 字段来自 state.isCompiling，与 store 当前值同步即可
    if (store.isCompiling && !store.isBatchMode) {
        store.persistState();
    }
    // 通知 store 编译已中止：让 isCompiling 复位，避免切回时 onMounted 误判为"正在编译"
    // 而跳过 startCompile 重入，导致进度条卡死
    store.abortCompile();
});
function handleRestart() {
    store.reset();
    emit('restart');
}
function stepLabelOf(item) {
    return STEP_LABEL[item.step] ?? item.step;
}
function dotTypeOf(item) {
    if (item.status === 'done')
        return 'success';
    if (item.status === 'error')
        return 'danger';
    return 'primary';
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['tl-status']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-status']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-status']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-page']} */ ;
/** @type {__VLS_StyleScopedClasses['result-card']} */ ;
/** @type {__VLS_StyleScopedClasses['result-list']} */ ;
/** @type {__VLS_StyleScopedClasses['result-list']} */ ;
/** @type {__VLS_StyleScopedClasses['result-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['run-item']} */ ;
/** @type {__VLS_StyleScopedClasses['log-line']} */ ;
/** @type {__VLS_StyleScopedClasses['error']} */ ;
/** @type {__VLS_StyleScopedClasses['log-line']} */ ;
/** @type {__VLS_StyleScopedClasses['done']} */ ;
/** @type {__VLS_StyleScopedClasses['rejected-item']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group']} */ ;
/** @type {__VLS_StyleScopedClasses['running']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group']} */ ;
/** @type {__VLS_StyleScopedClasses['done']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group']} */ ;
/** @type {__VLS_StyleScopedClasses['error']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group-status']} */ ;
/** @type {__VLS_StyleScopedClasses['running']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group-status']} */ ;
/** @type {__VLS_StyleScopedClasses['done']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group-status']} */ ;
/** @type {__VLS_StyleScopedClasses['error']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "progress-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card progress-card fade-up" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "progress-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "head-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "head-title" },
});
if (__VLS_ctx.store.isCompiling) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "grad-text" },
    });
}
else if (__VLS_ctx.store.isDone) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "grad-text" },
    });
}
else if (__VLS_ctx.store.errorMessage) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "head-tip" },
});
if (__VLS_ctx.robotMood === 'thinking') {
}
else if (__VLS_ctx.robotMood === 'happy') {
    (__VLS_ctx.store.generatedPages.length);
}
else {
    (__VLS_ctx.store.errorMessage);
}
if (__VLS_ctx.store.isBatchMode) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "batch-view" },
    });
    /** @type {[typeof BatchProgressBar, ]} */ ;
    // @ts-ignore
    const __VLS_0 = __VLS_asFunctionalComponent(BatchProgressBar, new BatchProgressBar({
        ...{ 'onCancel': {} },
    }));
    const __VLS_1 = __VLS_0({
        ...{ 'onCancel': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_0));
    let __VLS_3;
    let __VLS_4;
    let __VLS_5;
    const __VLS_6 = {
        onCancel: (__VLS_ctx.handleBatchCancel)
    };
    var __VLS_2;
    if (__VLS_ctx.store.batchRejected.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "batch-rejected" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "rejected-title" },
        });
        (__VLS_ctx.store.batchRejected.length);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
            ...{ class: "rejected-list" },
        });
        for (const [r, idx] of __VLS_getVForSourceType((__VLS_ctx.store.batchRejected))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
                key: (idx),
                ...{ class: "rejected-item" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
            (r.name);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "rejected-reason" },
            });
            (r.reason);
        }
    }
    if (__VLS_ctx.store.batchGroups.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "batch-groups" },
        });
        for (const [group] of __VLS_getVForSourceType((__VLS_ctx.store.batchGroups))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (group.fileIndex),
                ...{ class: "batch-group" },
                ...{ class: (group.status) },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "batch-group-head" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "batch-group-idx" },
            });
            (group.fileIndex + 1);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "batch-group-name" },
            });
            (group.fileName || '待处理');
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "batch-group-status" },
                ...{ class: (group.status) },
            });
            if (group.status === 'running') {
                const __VLS_7 = {}.ElIcon;
                /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
                // @ts-ignore
                const __VLS_8 = __VLS_asFunctionalComponent(__VLS_7, new __VLS_7({
                    ...{ class: "spin-icon" },
                }));
                const __VLS_9 = __VLS_8({
                    ...{ class: "spin-icon" },
                }, ...__VLS_functionalComponentArgsRest(__VLS_8));
                __VLS_10.slots.default;
                const __VLS_11 = {}.Loading;
                /** @type {[typeof __VLS_components.Loading, ]} */ ;
                // @ts-ignore
                const __VLS_12 = __VLS_asFunctionalComponent(__VLS_11, new __VLS_11({}));
                const __VLS_13 = __VLS_12({}, ...__VLS_functionalComponentArgsRest(__VLS_12));
                var __VLS_10;
            }
            else if (group.status === 'done') {
                const __VLS_15 = {}.ElIcon;
                /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
                // @ts-ignore
                const __VLS_16 = __VLS_asFunctionalComponent(__VLS_15, new __VLS_15({}));
                const __VLS_17 = __VLS_16({}, ...__VLS_functionalComponentArgsRest(__VLS_16));
                __VLS_18.slots.default;
                const __VLS_19 = {}.Check;
                /** @type {[typeof __VLS_components.Check, ]} */ ;
                // @ts-ignore
                const __VLS_20 = __VLS_asFunctionalComponent(__VLS_19, new __VLS_19({}));
                const __VLS_21 = __VLS_20({}, ...__VLS_functionalComponentArgsRest(__VLS_20));
                var __VLS_18;
            }
            else if (group.status === 'error') {
                const __VLS_23 = {}.ElIcon;
                /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
                // @ts-ignore
                const __VLS_24 = __VLS_asFunctionalComponent(__VLS_23, new __VLS_23({}));
                const __VLS_25 = __VLS_24({}, ...__VLS_functionalComponentArgsRest(__VLS_24));
                __VLS_26.slots.default;
                const __VLS_27 = {}.Close;
                /** @type {[typeof __VLS_components.Close, ]} */ ;
                // @ts-ignore
                const __VLS_28 = __VLS_asFunctionalComponent(__VLS_27, new __VLS_27({}));
                const __VLS_29 = __VLS_28({}, ...__VLS_functionalComponentArgsRest(__VLS_28));
                var __VLS_26;
            }
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (group.status);
            if (group.timeline.length > 0) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "batch-group-timeline" },
                });
                for (const [item, idx] of __VLS_getVForSourceType((group.timeline))) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                        key: (idx),
                        ...{ class: "batch-tl-item" },
                    });
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                        ...{ class: "batch-tl-step" },
                    });
                    (__VLS_ctx.stepLabelOf(item));
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                        ...{ class: "batch-tl-msg" },
                    });
                    (item.message);
                    if (item.page) {
                        __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
                            ...{ class: "batch-tl-page" },
                        });
                        (item.page.title);
                    }
                }
            }
            if (group.errorMessage) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "batch-group-error" },
                });
                (group.errorMessage);
            }
            if (group.pages.length > 0) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "batch-group-pages" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "pages-label" },
                });
                for (const [p] of __VLS_getVForSourceType((group.pages))) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
                        key: (p.path),
                        ...{ class: "batch-page-code" },
                    });
                    (p.title);
                }
            }
        }
    }
}
else if (!__VLS_ctx.store.isBatchMode) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "single-view" },
    });
    /** @type {[typeof SingleFileProgressBar, ]} */ ;
    // @ts-ignore
    const __VLS_31 = __VLS_asFunctionalComponent(SingleFileProgressBar, new SingleFileProgressBar({
        ...{ 'onCancel': {} },
    }));
    const __VLS_32 = __VLS_31({
        ...{ 'onCancel': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_31));
    let __VLS_34;
    let __VLS_35;
    let __VLS_36;
    const __VLS_37 = {
        onCancel: (__VLS_ctx.handleSingleCancel)
    };
    var __VLS_33;
    if (__VLS_ctx.store.timeline.length > 0) {
        const __VLS_38 = {}.ElTimeline;
        /** @type {[typeof __VLS_components.ElTimeline, typeof __VLS_components.elTimeline, typeof __VLS_components.ElTimeline, typeof __VLS_components.elTimeline, ]} */ ;
        // @ts-ignore
        const __VLS_39 = __VLS_asFunctionalComponent(__VLS_38, new __VLS_38({
            ...{ class: "timeline" },
        }));
        const __VLS_40 = __VLS_39({
            ...{ class: "timeline" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_39));
        __VLS_41.slots.default;
        for (const [item, idx] of __VLS_getVForSourceType((__VLS_ctx.store.timeline))) {
            const __VLS_42 = {}.ElTimelineItem;
            /** @type {[typeof __VLS_components.ElTimelineItem, typeof __VLS_components.elTimelineItem, typeof __VLS_components.ElTimelineItem, typeof __VLS_components.elTimelineItem, ]} */ ;
            // @ts-ignore
            const __VLS_43 = __VLS_asFunctionalComponent(__VLS_42, new __VLS_42({
                key: (idx),
                type: (__VLS_ctx.dotTypeOf(item)),
                hollow: (item.status === 'running'),
                size: "large",
            }));
            const __VLS_44 = __VLS_43({
                key: (idx),
                type: (__VLS_ctx.dotTypeOf(item)),
                hollow: (item.status === 'running'),
                size: "large",
            }, ...__VLS_functionalComponentArgsRest(__VLS_43));
            __VLS_45.slots.default;
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tl-row" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tl-head" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "tl-step" },
            });
            (__VLS_ctx.stepLabelOf(item));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "tl-status" },
                ...{ class: (item.status) },
            });
            if (item.status === 'running') {
                const __VLS_46 = {}.ElIcon;
                /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
                // @ts-ignore
                const __VLS_47 = __VLS_asFunctionalComponent(__VLS_46, new __VLS_46({
                    ...{ class: "spin-icon" },
                }));
                const __VLS_48 = __VLS_47({
                    ...{ class: "spin-icon" },
                }, ...__VLS_functionalComponentArgsRest(__VLS_47));
                __VLS_49.slots.default;
                const __VLS_50 = {}.Loading;
                /** @type {[typeof __VLS_components.Loading, ]} */ ;
                // @ts-ignore
                const __VLS_51 = __VLS_asFunctionalComponent(__VLS_50, new __VLS_50({}));
                const __VLS_52 = __VLS_51({}, ...__VLS_functionalComponentArgsRest(__VLS_51));
                var __VLS_49;
            }
            else if (item.status === 'done') {
                const __VLS_54 = {}.ElIcon;
                /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
                // @ts-ignore
                const __VLS_55 = __VLS_asFunctionalComponent(__VLS_54, new __VLS_54({}));
                const __VLS_56 = __VLS_55({}, ...__VLS_functionalComponentArgsRest(__VLS_55));
                __VLS_57.slots.default;
                const __VLS_58 = {}.Check;
                /** @type {[typeof __VLS_components.Check, ]} */ ;
                // @ts-ignore
                const __VLS_59 = __VLS_asFunctionalComponent(__VLS_58, new __VLS_58({}));
                const __VLS_60 = __VLS_59({}, ...__VLS_functionalComponentArgsRest(__VLS_59));
                var __VLS_57;
            }
            else {
                const __VLS_62 = {}.ElIcon;
                /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
                // @ts-ignore
                const __VLS_63 = __VLS_asFunctionalComponent(__VLS_62, new __VLS_62({}));
                const __VLS_64 = __VLS_63({}, ...__VLS_functionalComponentArgsRest(__VLS_63));
                __VLS_65.slots.default;
                const __VLS_66 = {}.Close;
                /** @type {[typeof __VLS_components.Close, ]} */ ;
                // @ts-ignore
                const __VLS_67 = __VLS_asFunctionalComponent(__VLS_66, new __VLS_66({}));
                const __VLS_68 = __VLS_67({}, ...__VLS_functionalComponentArgsRest(__VLS_67));
                var __VLS_65;
            }
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (item.status);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tl-message" },
            });
            (item.message);
            if (item.page) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "tl-page" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "page-icon" },
                });
                (item.page.title);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
                (item.page.path);
            }
            var __VLS_45;
        }
        var __VLS_41;
    }
}
if (__VLS_ctx.store.isDone && __VLS_ctx.store.result?.cached) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "cache-hit-banner" },
    });
    const __VLS_70 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_71 = __VLS_asFunctionalComponent(__VLS_70, new __VLS_70({
        ...{ class: "cache-icon" },
    }));
    const __VLS_72 = __VLS_71({
        ...{ class: "cache-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_71));
    __VLS_73.slots.default;
    const __VLS_74 = {}.Lightning;
    /** @type {[typeof __VLS_components.Lightning, ]} */ ;
    // @ts-ignore
    const __VLS_75 = __VLS_asFunctionalComponent(__VLS_74, new __VLS_74({}));
    const __VLS_76 = __VLS_75({}, ...__VLS_functionalComponentArgsRest(__VLS_75));
    var __VLS_73;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "cache-text" },
    });
}
if (__VLS_ctx.store.isDone && __VLS_ctx.store.result) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "done-section" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "result-card" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "result-title" },
    });
    if (__VLS_ctx.store.doneMessage) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "done-message" },
        });
        (__VLS_ctx.store.doneMessage);
    }
    if (__VLS_ctx.store.result.pages.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
            ...{ class: "result-list" },
        });
        for (const [p] of __VLS_getVForSourceType((__VLS_ctx.store.result.pages))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
                key: (p),
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
            (p);
        }
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "result-meta" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    (__VLS_ctx.store.result.indexUpdated ? '是' : '否');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "restart-bar" },
    });
    const __VLS_78 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_79 = __VLS_asFunctionalComponent(__VLS_78, new __VLS_78({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
    }));
    const __VLS_80 = __VLS_79({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
    }, ...__VLS_functionalComponentArgsRest(__VLS_79));
    let __VLS_82;
    let __VLS_83;
    let __VLS_84;
    const __VLS_85 = {
        onClick: (__VLS_ctx.handleRestart)
    };
    __VLS_81.slots.default;
    var __VLS_81;
}
else if (__VLS_ctx.store.isBatchMode && __VLS_ctx.store.isDone) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "done-section" },
    });
    if (__VLS_ctx.store.doneMessage) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "done-message" },
        });
        (__VLS_ctx.store.doneMessage);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "restart-bar" },
    });
    const __VLS_86 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_87 = __VLS_asFunctionalComponent(__VLS_86, new __VLS_86({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
    }));
    const __VLS_88 = __VLS_87({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
    }, ...__VLS_functionalComponentArgsRest(__VLS_87));
    let __VLS_90;
    let __VLS_91;
    let __VLS_92;
    const __VLS_93 = {
        onClick: (__VLS_ctx.handleRestart)
    };
    __VLS_89.slots.default;
    var __VLS_89;
}
else if (__VLS_ctx.store.isBatchMode && __VLS_ctx.store.isCancelled) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "done-section" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "restart-bar" },
    });
    const __VLS_94 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_95 = __VLS_asFunctionalComponent(__VLS_94, new __VLS_94({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
    }));
    const __VLS_96 = __VLS_95({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
    }, ...__VLS_functionalComponentArgsRest(__VLS_95));
    let __VLS_98;
    let __VLS_99;
    let __VLS_100;
    const __VLS_101 = {
        onClick: (__VLS_ctx.handleRestart)
    };
    __VLS_97.slots.default;
    var __VLS_97;
}
else if (__VLS_ctx.store.errorMessage) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "restart-bar" },
    });
    const __VLS_102 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_103 = __VLS_asFunctionalComponent(__VLS_102, new __VLS_102({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
    }));
    const __VLS_104 = __VLS_103({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
    }, ...__VLS_functionalComponentArgsRest(__VLS_103));
    let __VLS_106;
    let __VLS_107;
    let __VLS_108;
    const __VLS_109 = {
        onClick: (__VLS_ctx.handleRestart)
    };
    __VLS_105.slots.default;
    var __VLS_105;
    if (__VLS_ctx.llmPresets.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "quick-switch-provider" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "quick-switch-label" },
        });
        for (const [preset] of __VLS_getVForSourceType((__VLS_ctx.llmPresets))) {
            const __VLS_110 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_111 = __VLS_asFunctionalComponent(__VLS_110, new __VLS_110({
                ...{ 'onClick': {} },
                key: (preset.key),
                size: "small",
                loading: (__VLS_ctx.switchingProvider),
            }));
            const __VLS_112 = __VLS_111({
                ...{ 'onClick': {} },
                key: (preset.key),
                size: "small",
                loading: (__VLS_ctx.switchingProvider),
            }, ...__VLS_functionalComponentArgsRest(__VLS_111));
            let __VLS_114;
            let __VLS_115;
            let __VLS_116;
            const __VLS_117 = {
                onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.store.isDone && __VLS_ctx.store.result))
                        return;
                    if (!!(__VLS_ctx.store.isBatchMode && __VLS_ctx.store.isDone))
                        return;
                    if (!!(__VLS_ctx.store.isBatchMode && __VLS_ctx.store.isCancelled))
                        return;
                    if (!(__VLS_ctx.store.errorMessage))
                        return;
                    if (!(__VLS_ctx.llmPresets.length > 0))
                        return;
                    __VLS_ctx.quickSwitchProvider(preset);
                }
            };
            __VLS_113.slots.default;
            (preset.label);
            var __VLS_113;
        }
    }
}
if (__VLS_ctx.showRunsList) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "runs-section" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "runs-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "runs-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "title-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "title-bracket" },
    });
    const __VLS_118 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_119 = __VLS_asFunctionalComponent(__VLS_118, new __VLS_118({
        ...{ 'onClick': {} },
        size: "small",
        loading: (__VLS_ctx.store.loadingRuns),
    }));
    const __VLS_120 = __VLS_119({
        ...{ 'onClick': {} },
        size: "small",
        loading: (__VLS_ctx.store.loadingRuns),
    }, ...__VLS_functionalComponentArgsRest(__VLS_119));
    let __VLS_122;
    let __VLS_123;
    let __VLS_124;
    const __VLS_125 = {
        onClick: (...[$event]) => {
            if (!(__VLS_ctx.showRunsList))
                return;
            __VLS_ctx.store.loadRuns();
        }
    };
    __VLS_121.slots.default;
    var __VLS_121;
    if (__VLS_ctx.store.loadingRuns) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "section-loading" },
        });
    }
    else if (__VLS_ctx.store.runs.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "runs-empty" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "runs-list" },
        });
        for (const [run] of __VLS_getVForSourceType((__VLS_ctx.store.runs))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (run.runId),
                ...{ class: "run-item hover-glow" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.showRunsList))
                            return;
                        if (!!(__VLS_ctx.store.loadingRuns))
                            return;
                        if (!!(__VLS_ctx.store.runs.length === 0))
                            return;
                        __VLS_ctx.openLogDialog(run);
                    } },
                ...{ class: "run-info" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "run-id" },
            });
            (run.runId.slice(0, 8));
            const __VLS_126 = {}.ElTag;
            /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
            // @ts-ignore
            const __VLS_127 = __VLS_asFunctionalComponent(__VLS_126, new __VLS_126({
                type: (__VLS_ctx.runStatusType(run.status)),
                size: "small",
            }));
            const __VLS_128 = __VLS_127({
                type: (__VLS_ctx.runStatusType(run.status)),
                size: "small",
            }, ...__VLS_functionalComponentArgsRest(__VLS_127));
            __VLS_129.slots.default;
            (__VLS_ctx.runStatusLabel(run.status));
            var __VLS_129;
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "run-meta" },
            });
            (run.step);
            (run.tokenUsed);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "run-actions" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "run-time" },
            });
            (__VLS_ctx.formatTime(run.startedAt));
            if (run.status === 'failed') {
                const __VLS_130 = {}.ElButton;
                /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
                // @ts-ignore
                const __VLS_131 = __VLS_asFunctionalComponent(__VLS_130, new __VLS_130({
                    ...{ 'onClick': {} },
                    size: "small",
                    type: "primary",
                }));
                const __VLS_132 = __VLS_131({
                    ...{ 'onClick': {} },
                    size: "small",
                    type: "primary",
                }, ...__VLS_functionalComponentArgsRest(__VLS_131));
                let __VLS_134;
                let __VLS_135;
                let __VLS_136;
                const __VLS_137 = {
                    onClick: (...[$event]) => {
                        if (!(__VLS_ctx.showRunsList))
                            return;
                        if (!!(__VLS_ctx.store.loadingRuns))
                            return;
                        if (!!(__VLS_ctx.store.runs.length === 0))
                            return;
                        if (!(run.status === 'failed'))
                            return;
                        __VLS_ctx.startResume(run.runId);
                    }
                };
                __VLS_133.slots.default;
                var __VLS_133;
            }
        }
    }
}
const __VLS_138 = {}.ElDialog;
/** @type {[typeof __VLS_components.ElDialog, typeof __VLS_components.elDialog, typeof __VLS_components.ElDialog, typeof __VLS_components.elDialog, ]} */ ;
// @ts-ignore
const __VLS_139 = __VLS_asFunctionalComponent(__VLS_138, new __VLS_138({
    modelValue: (__VLS_ctx.logDialogVisible),
    title: "编译运行日志",
    width: "700px",
    ...{ class: "log-dialog" },
}));
const __VLS_140 = __VLS_139({
    modelValue: (__VLS_ctx.logDialogVisible),
    title: "编译运行日志",
    width: "700px",
    ...{ class: "log-dialog" },
}, ...__VLS_functionalComponentArgsRest(__VLS_139));
__VLS_141.slots.default;
if (__VLS_ctx.store.loadingLog) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-loading" },
    });
}
else if (__VLS_ctx.store.logEntries.length === 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "runs-empty" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "log-list" },
    });
    for (const [entry, idx] of __VLS_getVForSourceType((__VLS_ctx.store.logEntries))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (idx),
            ...{ class: "log-line" },
            ...{ class: (entry.event) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "log-ts" },
        });
        (__VLS_ctx.formatTime(entry.ts));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "log-step" },
        });
        (entry.step);
        if (entry.tool) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "log-tool" },
            });
            (entry.tool);
        }
        if (entry.tokenUsed != null) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "log-token" },
            });
            (entry.tokenUsed);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "log-msg" },
        });
        (entry.message);
        if (entry.error) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "log-err" },
            });
            (entry.error);
        }
    }
}
var __VLS_141;
/** @type {__VLS_StyleScopedClasses['progress-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-view']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-rejected']} */ ;
/** @type {__VLS_StyleScopedClasses['rejected-title']} */ ;
/** @type {__VLS_StyleScopedClasses['rejected-list']} */ ;
/** @type {__VLS_StyleScopedClasses['rejected-item']} */ ;
/** @type {__VLS_StyleScopedClasses['rejected-reason']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-groups']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group-head']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group-idx']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group-name']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group-status']} */ ;
/** @type {__VLS_StyleScopedClasses['spin-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group-timeline']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-tl-item']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-tl-step']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-tl-msg']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-tl-page']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group-error']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-group-pages']} */ ;
/** @type {__VLS_StyleScopedClasses['pages-label']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-page-code']} */ ;
/** @type {__VLS_StyleScopedClasses['single-view']} */ ;
/** @type {__VLS_StyleScopedClasses['timeline']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-row']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-head']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-step']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-status']} */ ;
/** @type {__VLS_StyleScopedClasses['spin-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-message']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-page']} */ ;
/** @type {__VLS_StyleScopedClasses['page-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['cache-hit-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['cache-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['cache-text']} */ ;
/** @type {__VLS_StyleScopedClasses['done-section']} */ ;
/** @type {__VLS_StyleScopedClasses['result-card']} */ ;
/** @type {__VLS_StyleScopedClasses['result-title']} */ ;
/** @type {__VLS_StyleScopedClasses['done-message']} */ ;
/** @type {__VLS_StyleScopedClasses['result-list']} */ ;
/** @type {__VLS_StyleScopedClasses['result-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['restart-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['done-section']} */ ;
/** @type {__VLS_StyleScopedClasses['done-message']} */ ;
/** @type {__VLS_StyleScopedClasses['restart-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['done-section']} */ ;
/** @type {__VLS_StyleScopedClasses['restart-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['restart-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['quick-switch-provider']} */ ;
/** @type {__VLS_StyleScopedClasses['quick-switch-label']} */ ;
/** @type {__VLS_StyleScopedClasses['runs-section']} */ ;
/** @type {__VLS_StyleScopedClasses['runs-head']} */ ;
/** @type {__VLS_StyleScopedClasses['runs-title']} */ ;
/** @type {__VLS_StyleScopedClasses['title-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['title-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['section-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['runs-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['runs-list']} */ ;
/** @type {__VLS_StyleScopedClasses['run-item']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['run-info']} */ ;
/** @type {__VLS_StyleScopedClasses['run-id']} */ ;
/** @type {__VLS_StyleScopedClasses['run-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['run-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['run-time']} */ ;
/** @type {__VLS_StyleScopedClasses['log-dialog']} */ ;
/** @type {__VLS_StyleScopedClasses['section-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['runs-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['log-list']} */ ;
/** @type {__VLS_StyleScopedClasses['log-line']} */ ;
/** @type {__VLS_StyleScopedClasses['log-ts']} */ ;
/** @type {__VLS_StyleScopedClasses['log-step']} */ ;
/** @type {__VLS_StyleScopedClasses['log-tool']} */ ;
/** @type {__VLS_StyleScopedClasses['log-token']} */ ;
/** @type {__VLS_StyleScopedClasses['log-msg']} */ ;
/** @type {__VLS_StyleScopedClasses['log-err']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Loading: Loading,
            Check: Check,
            Close: Close,
            Lightning: Lightning,
            BatchProgressBar: BatchProgressBar,
            SingleFileProgressBar: SingleFileProgressBar,
            llmPresets: llmPresets,
            switchingProvider: switchingProvider,
            quickSwitchProvider: quickSwitchProvider,
            store: store,
            logDialogVisible: logDialogVisible,
            robotMood: robotMood,
            showRunsList: showRunsList,
            startResume: startResume,
            handleBatchCancel: handleBatchCancel,
            handleSingleCancel: handleSingleCancel,
            openLogDialog: openLogDialog,
            formatTime: formatTime,
            runStatusType: runStatusType,
            runStatusLabel: runStatusLabel,
            handleRestart: handleRestart,
            stepLabelOf: stepLabelOf,
            dotTypeOf: dotTypeOf,
        };
    },
    __typeEmits: {},
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
    __typeEmits: {},
});
; /* PartiallyEnd: #4569/main.vue */
