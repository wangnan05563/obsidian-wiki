/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { onMounted, onBeforeUnmount, computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Loading, Check, Close } from '@element-plus/icons-vue';
import RobotAvatar from '../components/RobotAvatar.vue';
import { useCompileStore } from '../stores/compile';
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
const showRunsList = computed(() => !store.isCompiling && !store.isDone && !store.errorMessage);
async function startCompile(payload) {
    const isFormData = payload instanceof FormData;
    abortController = new AbortController();
    try {
        const response = await fetch('/api/compile', {
            method: 'POST',
            headers: isFormData ? {} : { 'Content-Type': 'application/json' },
            body: isFormData ? payload : JSON.stringify(payload),
            signal: abortController.signal
        });
        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
        }
        await consumeSSE(response);
    }
    catch (err) {
        if (err.name === 'AbortError')
            return;
        store.handleEvent('error', { message: err.message });
        ElMessage.error('编译请求失败：' + err.message);
    }
    finally {
        abortController = null;
    }
}
async function startResume(runId) {
    store.reset();
    store.isCompiling = true;
    abortController = new AbortController();
    try {
        const response = await fetch(`/api/compile/resume/${runId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: abortController.signal
        });
        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
        }
        await consumeSSE(response);
    }
    catch (err) {
        if (err.name === 'AbortError')
            return;
        store.handleEvent('error', { message: err.message });
        ElMessage.error('恢复失败：' + err.message);
    }
    finally {
        abortController = null;
    }
}
async function consumeSSE(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const evt of events) {
            const lines = evt.split('\n');
            let eventType = '';
            let data = '';
            for (const line of lines) {
                if (line.startsWith('event: '))
                    eventType = line.slice(7);
                if (line.startsWith('data: '))
                    data = line.slice(6);
            }
            if (eventType && data) {
                try {
                    store.handleEvent(eventType, JSON.parse(data));
                }
                catch {
                    // 非 JSON 数据跳过
                }
            }
        }
    }
}
onMounted(() => {
    if (store.pendingPayload && !store.isDone) {
        void startCompile(store.pendingPayload);
    }
    else {
        void store.loadRuns();
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
/** @type {[typeof RobotAvatar, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
    size: (100),
    floating: (__VLS_ctx.store.isCompiling),
}));
const __VLS_1 = __VLS_0({
    size: (100),
    floating: (__VLS_ctx.store.isCompiling),
}, ...__VLS_functionalComponentArgsRest(__VLS_0));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "head-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "head-tag" },
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
if (__VLS_ctx.store.timeline.length > 0) {
    const __VLS_3 = {}.ElTimeline;
    /** @type {[typeof __VLS_components.ElTimeline, typeof __VLS_components.elTimeline, typeof __VLS_components.ElTimeline, typeof __VLS_components.elTimeline, ]} */ ;
    // @ts-ignore
    const __VLS_4 = __VLS_asFunctionalComponent(__VLS_3, new __VLS_3({
        ...{ class: "timeline" },
    }));
    const __VLS_5 = __VLS_4({
        ...{ class: "timeline" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_4));
    __VLS_6.slots.default;
    for (const [item, idx] of __VLS_getVForSourceType((__VLS_ctx.store.timeline))) {
        const __VLS_7 = {}.ElTimelineItem;
        /** @type {[typeof __VLS_components.ElTimelineItem, typeof __VLS_components.elTimelineItem, typeof __VLS_components.ElTimelineItem, typeof __VLS_components.elTimelineItem, ]} */ ;
        // @ts-ignore
        const __VLS_8 = __VLS_asFunctionalComponent(__VLS_7, new __VLS_7({
            key: (idx),
            type: (__VLS_ctx.dotTypeOf(item)),
            hollow: (item.status === 'running'),
            size: "large",
        }));
        const __VLS_9 = __VLS_8({
            key: (idx),
            type: (__VLS_ctx.dotTypeOf(item)),
            hollow: (item.status === 'running'),
            size: "large",
        }, ...__VLS_functionalComponentArgsRest(__VLS_8));
        __VLS_10.slots.default;
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
            const __VLS_11 = {}.ElIcon;
            /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
            // @ts-ignore
            const __VLS_12 = __VLS_asFunctionalComponent(__VLS_11, new __VLS_11({
                ...{ class: "spin-icon" },
            }));
            const __VLS_13 = __VLS_12({
                ...{ class: "spin-icon" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_12));
            __VLS_14.slots.default;
            const __VLS_15 = {}.Loading;
            /** @type {[typeof __VLS_components.Loading, ]} */ ;
            // @ts-ignore
            const __VLS_16 = __VLS_asFunctionalComponent(__VLS_15, new __VLS_15({}));
            const __VLS_17 = __VLS_16({}, ...__VLS_functionalComponentArgsRest(__VLS_16));
            var __VLS_14;
        }
        else if (item.status === 'done') {
            const __VLS_19 = {}.ElIcon;
            /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
            // @ts-ignore
            const __VLS_20 = __VLS_asFunctionalComponent(__VLS_19, new __VLS_19({}));
            const __VLS_21 = __VLS_20({}, ...__VLS_functionalComponentArgsRest(__VLS_20));
            __VLS_22.slots.default;
            const __VLS_23 = {}.Check;
            /** @type {[typeof __VLS_components.Check, ]} */ ;
            // @ts-ignore
            const __VLS_24 = __VLS_asFunctionalComponent(__VLS_23, new __VLS_23({}));
            const __VLS_25 = __VLS_24({}, ...__VLS_functionalComponentArgsRest(__VLS_24));
            var __VLS_22;
        }
        else {
            const __VLS_27 = {}.ElIcon;
            /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
            // @ts-ignore
            const __VLS_28 = __VLS_asFunctionalComponent(__VLS_27, new __VLS_27({}));
            const __VLS_29 = __VLS_28({}, ...__VLS_functionalComponentArgsRest(__VLS_28));
            __VLS_30.slots.default;
            const __VLS_31 = {}.Close;
            /** @type {[typeof __VLS_components.Close, ]} */ ;
            // @ts-ignore
            const __VLS_32 = __VLS_asFunctionalComponent(__VLS_31, new __VLS_31({}));
            const __VLS_33 = __VLS_32({}, ...__VLS_functionalComponentArgsRest(__VLS_32));
            var __VLS_30;
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
        var __VLS_10;
    }
    var __VLS_6;
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-progress" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "empty-dots" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
}
if (__VLS_ctx.store.isDone && __VLS_ctx.store.result?.cached) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "cache-hit-banner" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "cache-icon" },
    });
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
    const __VLS_35 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_36 = __VLS_asFunctionalComponent(__VLS_35, new __VLS_35({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
    }));
    const __VLS_37 = __VLS_36({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
    }, ...__VLS_functionalComponentArgsRest(__VLS_36));
    let __VLS_39;
    let __VLS_40;
    let __VLS_41;
    const __VLS_42 = {
        onClick: (__VLS_ctx.handleRestart)
    };
    __VLS_38.slots.default;
    var __VLS_38;
}
else if (__VLS_ctx.store.errorMessage) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "restart-bar" },
    });
    const __VLS_43 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_44 = __VLS_asFunctionalComponent(__VLS_43, new __VLS_43({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
    }));
    const __VLS_45 = __VLS_44({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
    }, ...__VLS_functionalComponentArgsRest(__VLS_44));
    let __VLS_47;
    let __VLS_48;
    let __VLS_49;
    const __VLS_50 = {
        onClick: (__VLS_ctx.handleRestart)
    };
    __VLS_46.slots.default;
    var __VLS_46;
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
    const __VLS_51 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_52 = __VLS_asFunctionalComponent(__VLS_51, new __VLS_51({
        ...{ 'onClick': {} },
        size: "small",
        loading: (__VLS_ctx.store.loadingRuns),
    }));
    const __VLS_53 = __VLS_52({
        ...{ 'onClick': {} },
        size: "small",
        loading: (__VLS_ctx.store.loadingRuns),
    }, ...__VLS_functionalComponentArgsRest(__VLS_52));
    let __VLS_55;
    let __VLS_56;
    let __VLS_57;
    const __VLS_58 = {
        onClick: (...[$event]) => {
            if (!(__VLS_ctx.showRunsList))
                return;
            __VLS_ctx.store.loadRuns();
        }
    };
    __VLS_54.slots.default;
    var __VLS_54;
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
            const __VLS_59 = {}.ElTag;
            /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
            // @ts-ignore
            const __VLS_60 = __VLS_asFunctionalComponent(__VLS_59, new __VLS_59({
                type: (__VLS_ctx.runStatusType(run.status)),
                size: "small",
            }));
            const __VLS_61 = __VLS_60({
                type: (__VLS_ctx.runStatusType(run.status)),
                size: "small",
            }, ...__VLS_functionalComponentArgsRest(__VLS_60));
            __VLS_62.slots.default;
            (__VLS_ctx.runStatusLabel(run.status));
            var __VLS_62;
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
                const __VLS_63 = {}.ElButton;
                /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
                // @ts-ignore
                const __VLS_64 = __VLS_asFunctionalComponent(__VLS_63, new __VLS_63({
                    ...{ 'onClick': {} },
                    size: "small",
                    type: "primary",
                }));
                const __VLS_65 = __VLS_64({
                    ...{ 'onClick': {} },
                    size: "small",
                    type: "primary",
                }, ...__VLS_functionalComponentArgsRest(__VLS_64));
                let __VLS_67;
                let __VLS_68;
                let __VLS_69;
                const __VLS_70 = {
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
                __VLS_66.slots.default;
                var __VLS_66;
            }
        }
    }
}
const __VLS_71 = {}.ElDialog;
/** @type {[typeof __VLS_components.ElDialog, typeof __VLS_components.elDialog, typeof __VLS_components.ElDialog, typeof __VLS_components.elDialog, ]} */ ;
// @ts-ignore
const __VLS_72 = __VLS_asFunctionalComponent(__VLS_71, new __VLS_71({
    modelValue: (__VLS_ctx.logDialogVisible),
    title: "编译运行日志",
    width: "700px",
    ...{ class: "log-dialog" },
}));
const __VLS_73 = __VLS_72({
    modelValue: (__VLS_ctx.logDialogVisible),
    title: "编译运行日志",
    width: "700px",
    ...{ class: "log-dialog" },
}, ...__VLS_functionalComponentArgsRest(__VLS_72));
__VLS_74.slots.default;
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
var __VLS_74;
/** @type {__VLS_StyleScopedClasses['progress-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['timeline']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-row']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-head']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-step']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-status']} */ ;
/** @type {__VLS_StyleScopedClasses['spin-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-message']} */ ;
/** @type {__VLS_StyleScopedClasses['tl-page']} */ ;
/** @type {__VLS_StyleScopedClasses['page-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-progress']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-dots']} */ ;
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
/** @type {__VLS_StyleScopedClasses['restart-bar']} */ ;
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
            RobotAvatar: RobotAvatar,
            store: store,
            logDialogVisible: logDialogVisible,
            robotMood: robotMood,
            showRunsList: showRunsList,
            startResume: startResume,
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
