/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { Check, Close, CircleClose } from '@element-plus/icons-vue';
import { useCompileStore } from '../stores/compile';
// 批量编译进度条组件
// 为什么独立组件：Progress.vue 已包含时间线/分组卡片/历史任务等多块逻辑，
//   进度条作为单一职责组件抽出，便于复用与单测，且不污染父组件状态
// 进度数据来源：直接派生自 store.batchGroups，无需新增后端字段
//   - 总数 = batchGroups.length（batch_start 事件初始化）
//   - 已完成 = done + error 数量（无论成功失败都算"已结束"）
//   - 进行中 = running 数量
//   - 待处理 = pending 数量
// 持久化策略：store 状态跨页面切换保留，组件 onMounted 时通过 computed 自动恢复显示
const store = useCompileStore();
// 总文件数：batch_start 事件后初始化 batchGroups，长度即总数
const totalCount = computed(() => store.batchGroups.length);
// 已完成数：done 与 error 都视为"已结束"，参与进度推进
const completedCount = computed(() => store.batchGroups.filter((g) => g.status === 'done' || g.status === 'error').length);
const successCount = computed(() => store.batchGroups.filter((g) => g.status === 'done').length);
const errorCount = computed(() => store.batchGroups.filter((g) => g.status === 'error').length);
const runningCount = computed(() => store.batchGroups.filter((g) => g.status === 'running').length);
const pendingCount = computed(() => store.batchGroups.filter((g) => g.status === 'pending').length);
// 百分比：totalCount 为 0 时返回 0，避免 NaN
const progressPercentage = computed(() => {
    if (totalCount.value === 0)
        return 0;
    return Math.round((completedCount.value / totalCount.value) * 100);
});
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
// 状态文案：用于进度条上方的标题与完成后 banner
// 文案原则：running 态强调"正在处理 + 进度"，done 态强调"成果 + 数量"
const statusTitle = computed(() => {
    switch (currentStatus.value) {
        case 'running':
            return `正在编译 ${completedCount.value}/${totalCount.value} 篇文档`;
        case 'done':
            return `已编译 ${completedCount.value}/${totalCount.value} 篇文档`;
        case 'error':
            return '编译过程出错';
        case 'cancelled':
            return '编译已取消';
        default:
            return '准备开始编译';
    }
});
// 状态副文案：进度条下方一行小字
// running 态展示四态分布便于用户感知节奏；done 态突出失败数便于定位问题
const statusSubtitle = computed(() => {
    switch (currentStatus.value) {
        case 'running':
            return `成功 ${successCount.value} · 失败 ${errorCount.value} · 进行中 ${runningCount.value} · 待处理 ${pendingCount.value}`;
        case 'done':
            return errorCount.value > 0
                ? `共 ${totalCount.value} 篇 · 成功 ${successCount.value} · 失败 ${errorCount.value}`
                : `共 ${totalCount.value} 篇文档全部编译成功`;
        case 'error':
            return store.errorMessage || '未知错误';
        case 'cancelled':
            return `已保留 ${completedCount.value}/${totalCount.value} 篇编译成果`;
        default:
            return '上传文件后将自动开始批量编译';
    }
});
// el-progress 状态映射：'success' | 'exception' | 'warning' | undefined
const elProgressStatus = computed(() => {
    if (currentStatus.value === 'done') {
        // 完成但有失败文件时用 warning，全部成功用 success
        return errorCount.value > 0 ? 'warning' : 'success';
    }
    if (currentStatus.value === 'error')
        return 'exception';
    if (currentStatus.value === 'cancelled')
        return 'warning';
    return undefined;
});
// 颜色：按状态切换，使用 CSS 变量适配主题
// 为什么不用 Element Plus 默认色：项目主题色为霓虹紫/青/粉，需保持视觉一致
const progressColor = computed(() => {
    switch (currentStatus.value) {
        case 'done':
            // 全部成功用青色，有失败用品红
            return errorCount.value > 0 ? 'var(--neon-magenta)' : 'var(--neon-cyan)';
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
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['batch-progress-container']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-progress-container']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-progress-container']} */ ;
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
/** @type {__VLS_StyleScopedClasses['batch-progress-container']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-header']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-title']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-percentage']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-subtitle']} */ ;
/** @type {__VLS_StyleScopedClasses['banner-text']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-subtitle']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "batch-progress-container" },
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
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "progress-percentage" },
});
(__VLS_ctx.progressPercentage);
if (__VLS_ctx.canCancel) {
    const __VLS_0 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
        ...{ 'onClick': {} },
        size: "small",
        type: "danger",
        plain: true,
    }));
    const __VLS_2 = __VLS_1({
        ...{ 'onClick': {} },
        size: "small",
        type: "danger",
        plain: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    let __VLS_4;
    let __VLS_5;
    let __VLS_6;
    const __VLS_7 = {
        onClick: (__VLS_ctx.handleCancel)
    };
    __VLS_3.slots.default;
    var __VLS_3;
}
if (__VLS_ctx.totalCount > 0) {
    const __VLS_8 = {}.ElProgress;
    /** @type {[typeof __VLS_components.ElProgress, typeof __VLS_components.elProgress, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
        percentage: (__VLS_ctx.progressPercentage),
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
    const __VLS_10 = __VLS_9({
        percentage: (__VLS_ctx.progressPercentage),
        color: (__VLS_ctx.progressColor),
        status: (__VLS_ctx.elProgressStatus),
        strokeWidth: (14),
        textInside: (false),
        showText: (false),
        striped: (__VLS_ctx.currentStatus === 'running'),
        stripedFlow: (__VLS_ctx.currentStatus === 'running'),
        duration: (__VLS_ctx.currentStatus === 'running' ? 1 : 0),
        ...{ class: "progress-bar" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
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
if (__VLS_ctx.totalCount > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "progress-subtitle" },
    });
    (__VLS_ctx.statusSubtitle);
}
const __VLS_12 = {}.Transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.Transition, ]} */ ;
// @ts-ignore
const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
    name: "banner-fade",
    mode: "out-in",
}));
const __VLS_14 = __VLS_13({
    name: "banner-fade",
    mode: "out-in",
}, ...__VLS_functionalComponentArgsRest(__VLS_13));
__VLS_15.slots.default;
if (__VLS_ctx.currentStatus === 'done') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: "done",
        ...{ class: "progress-banner success-banner" },
    });
    const __VLS_16 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
        ...{ class: "banner-icon" },
    }));
    const __VLS_18 = __VLS_17({
        ...{ class: "banner-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
    __VLS_19.slots.default;
    const __VLS_20 = {}.Check;
    /** @type {[typeof __VLS_components.Check, ]} */ ;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({}));
    const __VLS_22 = __VLS_21({}, ...__VLS_functionalComponentArgsRest(__VLS_21));
    var __VLS_19;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "banner-text" },
    });
    (__VLS_ctx.totalCount);
    if (__VLS_ctx.errorCount > 0) {
        (__VLS_ctx.successCount);
        (__VLS_ctx.errorCount);
    }
}
else if (__VLS_ctx.currentStatus === 'error') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: "error",
        ...{ class: "progress-banner error-banner" },
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
    const __VLS_28 = {}.Close;
    /** @type {[typeof __VLS_components.Close, ]} */ ;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({}));
    const __VLS_30 = __VLS_29({}, ...__VLS_functionalComponentArgsRest(__VLS_29));
    var __VLS_27;
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
    const __VLS_36 = {}.CircleClose;
    /** @type {[typeof __VLS_components.CircleClose, ]} */ ;
    // @ts-ignore
    const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({}));
    const __VLS_38 = __VLS_37({}, ...__VLS_functionalComponentArgsRest(__VLS_37));
    var __VLS_35;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "banner-text" },
    });
    (__VLS_ctx.completedCount);
    (__VLS_ctx.totalCount);
}
var __VLS_15;
/** @type {__VLS_StyleScopedClasses['batch-progress-container']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-header']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-title-row']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-title']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-percentage']} */ ;
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
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Check: Check,
            Close: Close,
            CircleClose: CircleClose,
            store: store,
            totalCount: totalCount,
            completedCount: completedCount,
            successCount: successCount,
            errorCount: errorCount,
            progressPercentage: progressPercentage,
            currentStatus: currentStatus,
            statusTitle: statusTitle,
            statusSubtitle: statusSubtitle,
            elProgressStatus: elProgressStatus,
            progressColor: progressColor,
            canCancel: canCancel,
            handleCancel: handleCancel,
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
