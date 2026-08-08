/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { useId } from 'vue';
const __VLS_props = withDefaults(defineProps(), {
    size: 120,
    floating: false
}); // NOSONAR - Vue macro 调用，返回值在编译期被处理
// SVG id 唯一前缀：避免多实例同时渲染时 id 冲突导致渐变/滤镜互相覆盖
const uid = useId();
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_withDefaultsArg = (function (t) { return t; })({
    size: 120,
    floating: false
});
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "robot-avatar" },
    ...{ class: ({ 'robot-floating': __VLS_ctx.floating }) },
    ...{ style: ({ width: __VLS_ctx.size + 'px', height: __VLS_ctx.size + 'px' }) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
    viewBox: "0 0 120 120",
    xmlns: "http://www.w3.org/2000/svg",
    ...{ class: "robot-svg" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.defs, __VLS_intrinsicElements.defs)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.linearGradient, __VLS_intrinsicElements.linearGradient)({
    id: (`cyberHead-${__VLS_ctx.uid}`),
    x1: "0",
    y1: "0",
    x2: "1",
    y2: "1",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.stop)({
    offset: "0%",
    'stop-color': "var(--robot-head-1)",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.stop)({
    offset: "50%",
    'stop-color': "var(--robot-head-2)",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.stop)({
    offset: "100%",
    'stop-color': "var(--robot-head-3)",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.linearGradient, __VLS_intrinsicElements.linearGradient)({
    id: (`cyberBody-${__VLS_ctx.uid}`),
    x1: "0",
    y1: "0",
    x2: "1",
    y2: "1",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.stop)({
    offset: "0%",
    'stop-color': "var(--robot-body-1)",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.stop)({
    offset: "100%",
    'stop-color': "var(--robot-body-2)",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.radialGradient, __VLS_intrinsicElements.radialGradient)({
    id: (`eyeGlow-${__VLS_ctx.uid}`),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.stop)({
    offset: "0%",
    'stop-color': "#ffffff",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.stop)({
    offset: "40%",
    'stop-color': "var(--robot-eye)",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.stop)({
    offset: "100%",
    'stop-color': "var(--robot-eye-deep)",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.radialGradient, __VLS_intrinsicElements.radialGradient)({
    id: (`antennaGlow-${__VLS_ctx.uid}`),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.stop)({
    offset: "0%",
    'stop-color': "#ffffff",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.stop)({
    offset: "50%",
    'stop-color': "var(--robot-antenna)",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.stop)({
    offset: "100%",
    'stop-color': "var(--robot-accent)",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.filter, __VLS_intrinsicElements.filter)({
    id: (`neonGlow-${__VLS_ctx.uid}`),
    x: "-50%",
    y: "-50%",
    width: "200%",
    height: "200%",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.feGaussianBlur)({
    stdDeviation: "2",
    result: "blur",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.feMerge, __VLS_intrinsicElements.feMerge)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.feMergeNode)({
    in: "blur",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.feMergeNode)({
    in: "SourceGraphic",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
    x1: "60",
    y1: "8",
    x2: "60",
    y2: "22",
    stroke: "var(--robot-accent)",
    'stroke-width': "2",
    'stroke-linecap': "round",
    filter: (`url(#neonGlow-${__VLS_ctx.uid})`),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
    cx: "60",
    cy: "6",
    r: "4",
    fill: (`url(#antennaGlow-${__VLS_ctx.uid})`),
    filter: (`url(#neonGlow-${__VLS_ctx.uid})`),
    ...{ class: "antenna-pulse" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.rect)({
    x: "22",
    y: "22",
    width: "76",
    height: "58",
    rx: "18",
    ry: "18",
    fill: (`url(#cyberHead-${__VLS_ctx.uid})`),
    stroke: "var(--robot-accent)",
    'stroke-width': "1.5",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.rect)({
    x: "22",
    y: "22",
    width: "76",
    height: "58",
    rx: "18",
    ry: "18",
    fill: "none",
    stroke: "var(--robot-eye)",
    'stroke-width': "0.8",
    opacity: "0.6",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
    x1: "26",
    y1: "30",
    x2: "26",
    y2: "72",
    stroke: "var(--robot-antenna)",
    'stroke-width': "0.8",
    opacity: "0.5",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
    x1: "94",
    y1: "30",
    x2: "94",
    y2: "72",
    stroke: "var(--robot-eye)",
    'stroke-width': "0.8",
    opacity: "0.5",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
    x1: "24",
    y1: "0",
    x2: "96",
    y2: "0",
    stroke: "var(--robot-eye)",
    'stroke-width': "2",
    opacity: "0.8",
    ...{ class: "scan-line" },
    filter: (`url(#neonGlow-${__VLS_ctx.uid})`),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.g, __VLS_intrinsicElements.g)({
    ...{ class: "robot-eyes" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
    cx: "45",
    cy: "48",
    r: "7",
    fill: (`url(#eyeGlow-${__VLS_ctx.uid})`),
    filter: (`url(#neonGlow-${__VLS_ctx.uid})`),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
    cx: "75",
    cy: "48",
    r: "7",
    fill: (`url(#eyeGlow-${__VLS_ctx.uid})`),
    filter: (`url(#neonGlow-${__VLS_ctx.uid})`),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
    cx: "47",
    cy: "46",
    r: "2",
    fill: "#ffffff",
    opacity: "0.9",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
    cx: "77",
    cy: "46",
    r: "2",
    fill: "#ffffff",
    opacity: "0.9",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.polyline)({
    points: "50,66 56,70 60,68 64,70 70,66",
    fill: "none",
    stroke: "var(--robot-antenna)",
    'stroke-width': "2",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
    filter: (`url(#neonGlow-${__VLS_ctx.uid})`),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.rect)({
    x: "32",
    y: "80",
    width: "56",
    height: "32",
    rx: "12",
    ry: "12",
    fill: (`url(#cyberBody-${__VLS_ctx.uid})`),
    stroke: "var(--robot-accent)",
    'stroke-width': "1.5",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.rect)({
    x: "32",
    y: "80",
    width: "56",
    height: "32",
    rx: "12",
    ry: "12",
    fill: "none",
    stroke: "var(--robot-eye)",
    'stroke-width': "0.8",
    opacity: "0.5",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
    cx: "60",
    cy: "96",
    r: "3.5",
    fill: "var(--robot-antenna)",
    filter: (`url(#neonGlow-${__VLS_ctx.uid})`),
    ...{ class: "core-pulse" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
    cx: "46",
    cy: "96",
    r: "2",
    fill: "var(--robot-eye)",
    filter: (`url(#neonGlow-${__VLS_ctx.uid})`),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
    cx: "74",
    cy: "96",
    r: "2",
    fill: "var(--robot-accent)",
    filter: (`url(#neonGlow-${__VLS_ctx.uid})`),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
    x1: "36",
    y1: "88",
    x2: "44",
    y2: "88",
    stroke: "var(--robot-eye)",
    'stroke-width': "0.8",
    opacity: "0.6",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
    x1: "76",
    y1: "88",
    x2: "84",
    y2: "88",
    stroke: "var(--robot-antenna)",
    'stroke-width': "0.8",
    opacity: "0.6",
});
/** @type {__VLS_StyleScopedClasses['robot-avatar']} */ ;
/** @type {__VLS_StyleScopedClasses['robot-svg']} */ ;
/** @type {__VLS_StyleScopedClasses['antenna-pulse']} */ ;
/** @type {__VLS_StyleScopedClasses['scan-line']} */ ;
/** @type {__VLS_StyleScopedClasses['robot-eyes']} */ ;
/** @type {__VLS_StyleScopedClasses['core-pulse']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            uid: uid,
        };
    },
    __typeProps: {},
    props: {},
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
    __typeProps: {},
    props: {},
});
; /* PartiallyEnd: #4569/main.vue */
