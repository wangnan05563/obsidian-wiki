/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { Check, Close, CircleClose, Timer } from '@element-plus/icons-vue';
import { useCompileStore } from '../stores/compile';
// 单文件编译进度条组件
// 为什么独立组件：单文件模式与批量模式进度计算逻辑差异大（单文件按阶段百分比，批量按文件数），
//   独立组件避免 Progress.vue 模板条件嵌套过深，且便于后续单测
// 数据来源：直接派生自 store.timeline / store.stageTimings，无新增后端字段
//   - 进度百分比 = 已完成阶段数 / 估算总阶段数（ESTIMATED_TOTAL_STEPS=8）
//   - 总耗时 = store.totalElapsedMs（编译中实时累加，完成后固定）
//   - 各阶段耗时 = store.stageTimings（key=step名，value=累计 ms）
const store = useCompileStore();
const currentStatus = computed(() => {
    if (store.errorMessage)
        return 'error';
    if (store.isCancelled)
        return 'cancelled';
    if (store.isDone)
        return 'done';
    if (store.isCompiling)
        return 'running';
    return 'idle';
});
// 状态标题：用于进度条上方的标题
// 文案原则：running 态强调"当前阶段 + 进度"，done 态强调"成果"
const statusTitle = computed(() => {
    switch (currentStatus.value) {
        case 'running':
            return '机器人正在编译…';
        case 'done':
            return '编译完成';
        case 'error':
            return '编译出错';
        case 'cancelled':
            return '编译已取消';
        default:
            return '准备开始编译';
    }
});
// 当前阶段中文标签：从 store.currentStep 取，未开始时显示"等待开始"
const STEP_LABEL = {
    archive: '存档原始资料',
    read_schema: '读取 SCHEMA',
    extract: '提取要点',
    generate_page: '生成页面',
    finalize: '收尾'
};
const currentStageLabel = computed(() => {
    if (!store.currentStep)
        return '等待开始';
    return STEP_LABEL[store.currentStep] ?? store.currentStep;
});
// el-progress 状态映射：'success' | 'exception' | 'warning' | undefined
const elProgressStatus = computed(() => {
    if (currentStatus.value === 'done')
        return 'success';
    if (currentStatus.value === 'error')
        return 'exception';
    if (currentStatus.value === 'cancelled')
        return 'warning';
    return undefined;
});
// 进度条颜色：按状态切换，使用 CSS 变量适配主题
// 为什么不用 Element Plus 默认色：项目主题色为霓虹紫/青/粉，需保持视觉一致
const progressColor = computed(() => {
    switch (currentStatus.value) {
        case 'done':
            return 'var(--neon-cyan)';
        case 'error':
            return 'var(--neon-magenta)';
        case 'cancelled':
            return 'var(--neon-pink)';
        case 'running':
            return 'var(--neon-pink)';
        default:
            return 'var(--neon-purple)';
    }
});
// 是否显示取消按钮：仅运行中显示
const canCancel = computed(() => currentStatus.value === 'running');
const emit = defineEmits();
function handleCancel() {
    emit('cancel');
}
// 格式化耗时（ms → 人类可读）
// 为什么不用 dayjs：单文件场景格式简单，原生实现避免引入额外依赖
function formatDuration(ms) {
    if (ms <= 0)
        return '0s';
    if (ms < 1000)
        return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60)
        return `${seconds}.${Math.floor((ms % 1000) / 100)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainSeconds = seconds % 60;
    return `${minutes}m${remainSeconds}s`;
}
// 各阶段耗时明细列表：按耗时降序排列，便于用户快速定位瓶颈
// 为什么不按 step 顺序：用户更关心"哪个阶段最慢"而非"哪个阶段先执行"
const stageTimingList = computed(() => {
    const timings = store.stageTimings;
    const items = Object.entries(timings).map(([step, ms]) => ({
        step,
        label: STEP_LABEL[step] ?? step,
        ms,
        formatted: formatDuration(ms),
    }));
    // 按耗时降序：最慢的在最前
    items.sort((a, b) => b.ms - a.ms);
    return items;
});
// 是否显示阶段耗时明细：有任意一项耗时 > 0 即显示
const showStageTimings = computed(() => stageTimingList.value.length > 0 && currentStatus.value !== 'idle');
// 总耗时是否有效：用于计算各阶段耗时占比
const hasTotalElapsed = computed(() => store.totalElapsedMs > 0);
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['single-progress-container']} */ ;
/** @type {__VLS_StyleScopedClasses['single-progress-container']} */ ;
/** @type {__VLS_StyleScopedClasses['single-progress-container']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['done']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['error']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['cancelled']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['success-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['error-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['cancelled-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['single-progress-container']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-header']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-title']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-percentage']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-subtitle']} */ ;
/** @type {__VLS_StyleScopedClasses['banner-text']} */ ;
/** @type {__VLS_StyleScopedClasses['stage-label']} */ ;
/** @type {__VLS_StyleScopedClasses['stage-duration']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-subtitle']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "single-progress-container" },
    ...{ class: (__VLS_ctx.currentStatus) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "progress-header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "progress-title-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "progress-status-dot" },
    ...{ class: (__VLS_ctx.currentStatus) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "progress-title" },
});
(__VLS_ctx.statusTitle);
if (__VLS_ctx.currentStatus === 'running') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "progress-stage" },
    });
    (__VLS_ctx.currentStageLabel);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "progress-percentage" },
});
(__VLS_ctx.store.progressPercentage);
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "progress-meta-right" },
});
if (__VLS_ctx.hasTotalElapsed) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "progress-elapsed" },
    });
    const __VLS_0 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
        ...{ class: "elapsed-icon" },
    }));
    const __VLS_2 = __VLS_1({
        ...{ class: "elapsed-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    __VLS_3.slots.default;
    const __VLS_4 = {}.Timer;
    /** @type {[typeof __VLS_components.Timer, ]} */ ;
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
    const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
    var __VLS_3;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    (__VLS_ctx.formatDuration(__VLS_ctx.store.totalElapsedMs));
}
if (__VLS_ctx.canCancel) {
    const __VLS_8 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
        ...{ 'onClick': {} },
        size: "small",
        type: "danger",
        plain: true,
    }));
    const __VLS_10 = __VLS_9({
        ...{ 'onClick': {} },
        size: "small",
        type: "danger",
        plain: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
    let __VLS_12;
    let __VLS_13;
    let __VLS_14;
    const __VLS_15 = {
        onClick: (__VLS_ctx.handleCancel)
    };
    __VLS_11.slots.default;
    var __VLS_11;
}
if (__VLS_ctx.store.progressPercentage > 0 || __VLS_ctx.currentStatus === 'running') {
    const __VLS_16 = {}.ElProgress;
    /** @type {[typeof __VLS_components.ElProgress, typeof __VLS_components.elProgress, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
        percentage: (__VLS_ctx.store.progressPercentage),
        color: (__VLS_ctx.progressColor),
        status: (__VLS_ctx.elProgressStatus),
        strokeWidth: (14),
        textInside: (false),
        showText: (false),
        striped: (__VLS_ctx.currentStatus === 'running'),
        stripedFlow: (__VLS_ctx.currentStatus === 'running'),
        duration: (__VLS_ctx.currentStatus === 'running' ? 1 : 0),
        ...{ class: "progress-bar" },
    }));
    const __VLS_18 = __VLS_17({
        percentage: (__VLS_ctx.store.progressPercentage),
        color: (__VLS_ctx.progressColor),
        status: (__VLS_ctx.elProgressStatus),
        strokeWidth: (14),
        textInside: (false),
        showText: (false),
        striped: (__VLS_ctx.currentStatus === 'running'),
        stripedFlow: (__VLS_ctx.currentStatus === 'running'),
        duration: (__VLS_ctx.currentStatus === 'running' ? 1 : 0),
        ...{ class: "progress-bar" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "progress-empty" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "empty-dots" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
}
if (__VLS_ctx.currentStatus === 'running') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "progress-subtitle" },
    });
    (__VLS_ctx.store.completedStepCount);
    (__VLS_ctx.currentStageLabel);
}
const __VLS_20 = {}.Transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.Transition, ]} */ ;
// @ts-ignore
const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
    name: "banner-fade",
    mode: "out-in",
}));
const __VLS_22 = __VLS_21({
    name: "banner-fade",
    mode: "out-in",
}, ...__VLS_functionalComponentArgsRest(__VLS_21));
__VLS_23.slots.default;
if (__VLS_ctx.currentStatus === 'done') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: "done",
        ...{ class: "progress-banner success-banner" },
    });
    const __VLS_24 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
        ...{ class: "banner-icon" },
    }));
    const __VLS_26 = __VLS_25({
        ...{ class: "banner-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_25));
    __VLS_27.slots.default;
    const __VLS_28 = {}.Check;
    /** @type {[typeof __VLS_components.Check, ]} */ ;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({}));
    const __VLS_30 = __VLS_29({}, ...__VLS_functionalComponentArgsRest(__VLS_29));
    var __VLS_27;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "banner-text" },
    });
    (__VLS_ctx.store.generatedPages.length);
    if (__VLS_ctx.store.result?.cached) {
    }
}
else if (__VLS_ctx.currentStatus === 'error') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: "error",
        ...{ class: "progress-banner error-banner" },
    });
    const __VLS_32 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
        ...{ class: "banner-icon" },
    }));
    const __VLS_34 = __VLS_33({
        ...{ class: "banner-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_33));
    __VLS_35.slots.default;
    const __VLS_36 = {}.Close;
    /** @type {[typeof __VLS_components.Close, ]} */ ;
    // @ts-ignore
    const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({}));
    const __VLS_38 = __VLS_37({}, ...__VLS_functionalComponentArgsRest(__VLS_37));
    var __VLS_35;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "banner-text" },
    });
    (__VLS_ctx.store.errorMessage || '编译过程出错');
}
else if (__VLS_ctx.currentStatus === 'cancelled') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: "cancelled",
        ...{ class: "progress-banner cancelled-banner" },
    });
    const __VLS_40 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
        ...{ class: "banner-icon" },
    }));
    const __VLS_42 = __VLS_41({
        ...{ class: "banner-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_41));
    __VLS_43.slots.default;
    const __VLS_44 = {}.CircleClose;
    /** @type {[typeof __VLS_components.CircleClose, ]} */ ;
    // @ts-ignore
    const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({}));
    const __VLS_46 = __VLS_45({}, ...__VLS_functionalComponentArgsRest(__VLS_45));
    var __VLS_43;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "banner-text" },
    });
    (__VLS_ctx.store.completedStepCount);
}
var __VLS_23;
if (__VLS_ctx.showStageTimings) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stage-timings" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stage-timings-title" },
    });
    const __VLS_48 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({}));
    const __VLS_50 = __VLS_49({}, ...__VLS_functionalComponentArgsRest(__VLS_49));
    __VLS_51.slots.default;
    const __VLS_52 = {}.Timer;
    /** @type {[typeof __VLS_components.Timer, ]} */ ;
    // @ts-ignore
    const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({}));
    const __VLS_54 = __VLS_53({}, ...__VLS_functionalComponentArgsRest(__VLS_53));
    var __VLS_51;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stage-list" },
    });
    for (const [item] of __VLS_getVForSourceType((__VLS_ctx.stageTimingList))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (item.step),
            ...{ class: "stage-item" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "stage-label" },
        });
        (item.label);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "stage-bar-wrap" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "stage-bar" },
            ...{ style: ({ width: __VLS_ctx.hasTotalElapsed ? `${(item.ms / __VLS_ctx.store.totalElapsedMs) * 100}%` : '0%' }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "stage-duration" },
        });
        (item.formatted);
    }
}
/** @type {__VLS_StyleScopedClasses['single-progress-container']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-header']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-title-row']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-title']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-stage']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-percentage']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-meta-right']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-elapsed']} */ ;
/** @type {__VLS_StyleScopedClasses['elapsed-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-subtitle']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['success-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['banner-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['banner-text']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['error-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['banner-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['banner-text']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['cancelled-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['banner-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['banner-text']} */ ;
/** @type {__VLS_StyleScopedClasses['stage-timings']} */ ;
/** @type {__VLS_StyleScopedClasses['stage-timings-title']} */ ;
/** @type {__VLS_StyleScopedClasses['stage-list']} */ ;
/** @type {__VLS_StyleScopedClasses['stage-item']} */ ;
/** @type {__VLS_StyleScopedClasses['stage-label']} */ ;
/** @type {__VLS_StyleScopedClasses['stage-bar-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['stage-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['stage-duration']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Check: Check,
            Close: Close,
            CircleClose: CircleClose,
            Timer: Timer,
            store: store,
            currentStatus: currentStatus,
            statusTitle: statusTitle,
            currentStageLabel: currentStageLabel,
            elProgressStatus: elProgressStatus,
            progressColor: progressColor,
            canCancel: canCancel,
            handleCancel: handleCancel,
            formatDuration: formatDuration,
            stageTimingList: stageTimingList,
            showStageTimings: showStageTimings,
            hasTotalElapsed: hasTotalElapsed,
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
