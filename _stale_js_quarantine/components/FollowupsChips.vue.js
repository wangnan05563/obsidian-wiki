/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ChatRound } from '@element-plus/icons-vue';
const props = defineProps();
const emit = defineEmits();
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['chips-scroll']} */ ;
/** @type {__VLS_StyleScopedClasses['followup-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['followup-chip']} */ ;
// CSS variable injection 
// CSS variable injection end 
if (props.followups.length > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "followups-chips" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "followups-label" },
    });
    const __VLS_0 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
        ...{ class: "label-icon" },
    }));
    const __VLS_2 = __VLS_1({
        ...{ class: "label-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    __VLS_3.slots.default;
    const __VLS_4 = {}.ChatRound;
    /** @type {[typeof __VLS_components.ChatRound, ]} */ ;
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
    const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
    var __VLS_3;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "chips-scroll" },
    });
    for (const [f, i] of __VLS_getVForSourceType((__VLS_ctx.followups))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(props.followups.length > 0))
                        return;
                    __VLS_ctx.emit('click', f);
                } },
            key: (f),
            ...{ class: "followup-chip" },
            title: ('点击继续追问'),
        });
        (f);
    }
}
/** @type {__VLS_StyleScopedClasses['followups-chips']} */ ;
/** @type {__VLS_StyleScopedClasses['followups-label']} */ ;
/** @type {__VLS_StyleScopedClasses['label-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['chips-scroll']} */ ;
/** @type {__VLS_StyleScopedClasses['followup-chip']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            ChatRound: ChatRound,
            emit: emit,
        };
    },
    __typeEmits: {},
    __typeProps: {},
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
    __typeEmits: {},
    __typeProps: {},
});
; /* PartiallyEnd: #4569/main.vue */
