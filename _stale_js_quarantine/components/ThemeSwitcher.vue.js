/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useTheme } from '../composables/useTheme';
const props = withDefaults(defineProps(), {
    embedded: false,
});
const { currentTheme, themes, setTheme } = useTheme();
const open = ref(false);
const panelRef = ref(null);
// 缓存当前主题信息，避免模板中重复 themes.find 调用导致的多次遍历
const currentThemeInfo = computed(() => themes.find((t) => t.key === currentTheme.value));
const currentLabel = computed(() => currentThemeInfo.value?.label ?? '');
const currentSwatch = computed(() => currentThemeInfo.value?.swatch ?? ['', '']);
// 渐变样式字符串，供 trigger-swatch 直接绑定，避免模板内拼接
const triggerGradient = computed(() => `linear-gradient(135deg, ${currentSwatch.value[0]} 0%, ${currentSwatch.value[1]} 100%)`);
// 切换器标题：macaron 主题存在时显示双语标题
// 用 .some() 表达"存在性"语义，比 .find() 更准确
const hasMacaron = computed(() => themes.some((t) => t.key === 'macaron'));
const panelTitle = computed(() => (hasMacaron.value ? 'Theme Switch' : 'Theme'));
function toggle() {
    open.value = !open.value;
}
function select(key) {
    setTheme(key);
    open.value = false;
}
// 点击面板外部时关闭：contains 返回 false 表示点击发生在面板外
function handleClickOutside(e) {
    if (panelRef.value && !panelRef.value.contains(e.target)) {
        open.value = false;
    }
}
onMounted(() => {
    document.addEventListener('click', handleClickOutside);
});
onBeforeUnmount(() => {
    document.removeEventListener('click', handleClickOutside);
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_withDefaultsArg = (function (t) { return t; })({
    embedded: false,
});
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['theme-switcher']} */ ;
/** @type {__VLS_StyleScopedClasses['trigger']} */ ;
/** @type {__VLS_StyleScopedClasses['trigger']} */ ;
/** @type {__VLS_StyleScopedClasses['trigger']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['trigger-swatch']} */ ;
/** @type {__VLS_StyleScopedClasses['trigger']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['trigger-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['trigger-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['embedded']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-item']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-item']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-item']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-swatch']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-switcher']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-switcher']} */ ;
/** @type {__VLS_StyleScopedClasses['embedded']} */ ;
/** @type {__VLS_StyleScopedClasses['embedded']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "theme-switcher" },
    ...{ class: ({ embedded: props.embedded }) },
    ref: "panelRef",
});
/** @type {typeof __VLS_ctx.panelRef} */ ;
if (!props.embedded) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.toggle) },
        ...{ class: "trigger hover-glow" },
        ...{ class: ({ active: __VLS_ctx.open }) },
        title: (`Current theme: ${__VLS_ctx.currentLabel}`),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "trigger-swatch" },
        ...{ style: ({ background: __VLS_ctx.triggerGradient }) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
        ...{ class: "trigger-icon" },
        ...{ class: ({ spin: __VLS_ctx.open }) },
        viewBox: "0 0 24 24",
        width: "16",
        height: "16",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M12 2L2 7l10 5 10-5-10-5z",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
        'stroke-linejoin': "round",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M2 17l10 5 10-5M2 12l10 5 10-5",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
        'stroke-linejoin': "round",
    });
}
const __VLS_0 = {}.transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.transition, typeof __VLS_components.Transition, typeof __VLS_components.transition, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    name: "panel",
}));
const __VLS_2 = __VLS_1({
    name: "panel",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
if (__VLS_ctx.open || props.embedded) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "panel glass-card" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "panel-header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "panel-title" },
    });
    (__VLS_ctx.panelTitle);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "panel-sub" },
    });
    (__VLS_ctx.themes.length);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "theme-list" },
    });
    for (const [theme] of __VLS_getVForSourceType((__VLS_ctx.themes))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.open || props.embedded))
                        return;
                    __VLS_ctx.select(theme.key);
                } },
            key: (theme.key),
            ...{ class: "theme-item hover-glow" },
            ...{ class: ({ selected: theme.key === __VLS_ctx.currentTheme }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "theme-swatch" },
            ...{ style: ({
                    background: `linear-gradient(135deg, ${theme.swatch[0]} 0%, ${theme.swatch[1]} 100%)`
                }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "theme-info" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "theme-label" },
        });
        (theme.label);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "theme-desc" },
        });
        (theme.description);
        if (theme.key === __VLS_ctx.currentTheme) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "theme-check" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
                viewBox: "0 0 24 24",
                width: "14",
                height: "14",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
                d: "M5 13l4 4L19 7",
                fill: "none",
                stroke: "currentColor",
                'stroke-width': "3",
                'stroke-linecap': "round",
                'stroke-linejoin': "round",
            });
        }
    }
}
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['theme-switcher']} */ ;
/** @type {__VLS_StyleScopedClasses['trigger']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['trigger-swatch']} */ ;
/** @type {__VLS_StyleScopedClasses['trigger-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-header']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-sub']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-list']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-item']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-swatch']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-info']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-label']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-check']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            currentTheme: currentTheme,
            themes: themes,
            open: open,
            panelRef: panelRef,
            currentLabel: currentLabel,
            triggerGradient: triggerGradient,
            panelTitle: panelTitle,
            toggle: toggle,
            select: select,
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
