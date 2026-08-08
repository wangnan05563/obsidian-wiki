/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed } from 'vue';
import { ChatRound, ArrowDown, ArrowRight } from '@element-plus/icons-vue';
const props = defineProps();
// 默认折叠：减少视觉噪音，用户主动展开查看思考细节
const expanded = ref(false);
// 折叠态摘要：已思考 N 步 · 搜索 N 次 · 阅读 N 页 · 耗时 X.Xs
// v2 优化：新增耗时统计，体现多输出模式可观测性
const summary = computed(() => {
    const toolCalls = props.steps.filter(s => s.phase === 'tool_call');
    const searches = toolCalls.filter(s => s.tool === 'search_pages').length;
    const reads = toolCalls.filter(s => s.tool === 'read_page').length;
    // 计算思考耗时：第一条到当前时间的差（前端时间），后端 ts 字段补齐可换算
    const first = props.steps[0]?.ts;
    const last = props.steps[props.steps.length - 1]?.ts;
    let duration = '';
    if (first && last) {
        const ms = new Date(last).getTime() - new Date(first).getTime();
        duration = ms < 1000 ? `· ${ms}ms` : `· ${(ms / 1000).toFixed(1)}s`;
    }
    return `已思考 ${props.steps.length} 步 · 搜索 ${searches} 次 · 阅读 ${reads} 页 ${duration}`;
});
function phaseLabel(phase) {
    const labels = {
        thinking: '思考',
        tool_call: '调用',
        composing: '组织',
    };
    return labels[phase] || phase;
}
// v2：单步骤耗时（与上一条 ts 差），让用户感知每个思考节点的耗时
// 为什么用前端差：SSE 接收时序已记录到 ts，可直接相减；后端网络延迟不计入"思考耗时"
function stepDuration(idx, ts) {
    if (!ts || idx === 0)
        return '';
    const prev = props.steps[idx - 1]?.ts;
    if (!prev)
        return '';
    const ms = new Date(ts).getTime() - new Date(prev).getTime();
    return ms < 1000 ? `+${ms}ms` : `+${(ms / 1000).toFixed(1)}s`;
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['thinking-block']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-summary']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-block']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-body']} */ ;
/** @type {__VLS_StyleScopedClasses['step-phase']} */ ;
/** @type {__VLS_StyleScopedClasses['step-phase']} */ ;
/** @type {__VLS_StyleScopedClasses['step-phase']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "thinking-block" },
    ...{ class: ({ collapsed: !__VLS_ctx.expanded }) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.expanded = !__VLS_ctx.expanded;
        } },
    ...{ class: "thinking-header" },
});
const __VLS_0 = {}.ElIcon;
/** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    ...{ class: "thinking-icon" },
}));
const __VLS_2 = __VLS_1({
    ...{ class: "thinking-icon" },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
const __VLS_4 = {}.ChatRound;
/** @type {[typeof __VLS_components.ChatRound, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
var __VLS_3;
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "thinking-summary" },
});
(__VLS_ctx.summary);
const __VLS_8 = {}.ElIcon;
/** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
// @ts-ignore
const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
    ...{ class: "toggle" },
}));
const __VLS_10 = __VLS_9({
    ...{ class: "toggle" },
}, ...__VLS_functionalComponentArgsRest(__VLS_9));
__VLS_11.slots.default;
const __VLS_12 = ((__VLS_ctx.expanded ? __VLS_ctx.ArrowDown : __VLS_ctx.ArrowRight));
// @ts-ignore
const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({}));
const __VLS_14 = __VLS_13({}, ...__VLS_functionalComponentArgsRest(__VLS_13));
var __VLS_11;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "thinking-body" },
});
__VLS_asFunctionalDirective(__VLS_directives.vShow)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.expanded) }, null, null);
for (const [step, idx] of __VLS_getVForSourceType((__VLS_ctx.steps))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: (step.message + idx),
        ...{ class: "thinking-step" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "step-phase" },
        ...{ class: (step.phase) },
    });
    (__VLS_ctx.phaseLabel(step.phase));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "step-message" },
    });
    (step.message);
    if (step.tool) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "step-tool" },
        });
        (step.tool);
    }
    if (step.ts) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "step-duration" },
        });
        (__VLS_ctx.stepDuration(idx, step.ts));
    }
}
/** @type {__VLS_StyleScopedClasses['thinking-block']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-header']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-summary']} */ ;
/** @type {__VLS_StyleScopedClasses['toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-body']} */ ;
/** @type {__VLS_StyleScopedClasses['thinking-step']} */ ;
/** @type {__VLS_StyleScopedClasses['step-phase']} */ ;
/** @type {__VLS_StyleScopedClasses['step-message']} */ ;
/** @type {__VLS_StyleScopedClasses['step-tool']} */ ;
/** @type {__VLS_StyleScopedClasses['step-duration']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            ChatRound: ChatRound,
            ArrowDown: ArrowDown,
            ArrowRight: ArrowRight,
            expanded: expanded,
            summary: summary,
            phaseLabel: phaseLabel,
            stepDuration: stepDuration,
        };
    },
    __typeProps: {},
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
    __typeProps: {},
});
; /* PartiallyEnd: #4569/main.vue */
