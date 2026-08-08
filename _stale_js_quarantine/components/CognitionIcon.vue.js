/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { useTheme } from '../composables/useTheme';
const __VLS_props = withDefaults(defineProps(), {
    size: 96,
    floating: false
});
const { currentTheme } = useTheme();
// 浅色主题清单：与 Login.vue 中的视觉分类保持一致
const lightThemes = ['macaron', 'ecommerce'];
// 为什么用 import.meta.env.BASE_URL：vite.config.ts 配置了 base: '/wiki/'，
// 硬编码 '/images/...' 会被浏览器解析为 host 根路径导致 404，必须拼接 base 前缀
const iconSrc = computed(() => {
    const isLight = lightThemes.includes(currentTheme.value);
    return isLight
        ? `${import.meta.env.BASE_URL}images/login/cognition-icon-light.png`
        : `${import.meta.env.BASE_URL}images/login/cognition-icon.png`;
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_withDefaultsArg = (function (t) { return t; })({
    size: 96,
    floating: false
});
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "cognition-icon" },
    ...{ class: ({ 'icon-floating': __VLS_ctx.floating }) },
    ...{ style: ({ width: __VLS_ctx.size + 'px', height: __VLS_ctx.size + 'px' }) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.img)({
    src: (__VLS_ctx.iconSrc),
    alt: "Luminous Cognition",
    ...{ class: "cognition-img" },
    draggable: "false",
});
/** @type {__VLS_StyleScopedClasses['cognition-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['cognition-img']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            iconSrc: iconSrc,
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
