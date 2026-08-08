/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { VideoPlay, VideoPause, Bell, Close } from '@element-plus/icons-vue';
import { useTtsStore } from '../stores/tts';
// §2.x TtsController — TTS 全局浮动控制器。
// 职责：朗读进行时显示在消息区底部，提供暂停/继续/停止控制。
// 设计选择：仅在 state !== 'idle' 时显示，避免遮挡内容。
const ttsStore = useTtsStore();
const statusText = computed(() => {
    if (ttsStore.state === 'playing')
        return '朗读中';
    if (ttsStore.state === 'paused')
        return '已暂停';
    return '';
});
function handlePauseResume() {
    if (ttsStore.state === 'playing') {
        ttsStore.pause();
    }
    else if (ttsStore.state === 'paused') {
        ttsStore.resume();
    }
}
function handleStop() {
    ttsStore.stop();
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.transition, typeof __VLS_components.Transition, typeof __VLS_components.transition, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    name: "slide-up",
}));
const __VLS_2 = __VLS_1({
    name: "slide-up",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
if (__VLS_ctx.ttsStore.state !== 'idle') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "tts-controller" },
    });
    const __VLS_4 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
        ...{ class: "tts-icon" },
    }));
    const __VLS_6 = __VLS_5({
        ...{ class: "tts-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_5));
    __VLS_7.slots.default;
    const __VLS_8 = {}.Bell;
    /** @type {[typeof __VLS_components.Bell, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({}));
    const __VLS_10 = __VLS_9({}, ...__VLS_functionalComponentArgsRest(__VLS_9));
    var __VLS_7;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "tts-status" },
    });
    (__VLS_ctx.statusText);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "tts-controls" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handlePauseResume) },
        ...{ class: "ctrl-btn" },
        title: (__VLS_ctx.ttsStore.state === 'playing' ? '暂停' : '继续'),
    });
    const __VLS_12 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({}));
    const __VLS_14 = __VLS_13({}, ...__VLS_functionalComponentArgsRest(__VLS_13));
    __VLS_15.slots.default;
    const __VLS_16 = ((__VLS_ctx.ttsStore.state === 'playing' ? __VLS_ctx.VideoPause : __VLS_ctx.VideoPlay));
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({}));
    const __VLS_18 = __VLS_17({}, ...__VLS_functionalComponentArgsRest(__VLS_17));
    var __VLS_15;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handleStop) },
        ...{ class: "ctrl-btn" },
        title: "停止",
    });
    const __VLS_20 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({}));
    const __VLS_22 = __VLS_21({}, ...__VLS_functionalComponentArgsRest(__VLS_21));
    __VLS_23.slots.default;
    const __VLS_24 = {}.Close;
    /** @type {[typeof __VLS_components.Close, ]} */ ;
    // @ts-ignore
    const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({}));
    const __VLS_26 = __VLS_25({}, ...__VLS_functionalComponentArgsRest(__VLS_25));
    var __VLS_23;
}
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['tts-controller']} */ ;
/** @type {__VLS_StyleScopedClasses['tts-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tts-status']} */ ;
/** @type {__VLS_StyleScopedClasses['tts-controls']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            VideoPlay: VideoPlay,
            VideoPause: VideoPause,
            Bell: Bell,
            Close: Close,
            ttsStore: ttsStore,
            statusText: statusText,
            handlePauseResume: handlePauseResume,
            handleStop: handleStop,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
