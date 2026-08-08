/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed } from 'vue';
import { Reading, ArrowDown, ArrowRight } from '@element-plus/icons-vue';
const props = defineProps();
// 默认折叠：减少视觉噪音，用户主动展开查看参考资料
const expanded = ref(false);
// F-3.8 默认展开前 3 条，超过的折叠为「展开更多」按钮
const COLLAPSE_THRESHOLD = 3;
const showAll = ref(false);
// F-3.8 折叠整个区块时重置 showAll，避免下次展开仍停留在「全部展示」状态
// 为什么不保留 showAll：用户主动折叠表示重新审视，应回到默认前 3 条视图
function toggleExpanded() {
    expanded.value = !expanded.value;
    if (!expanded.value) {
        showAll.value = false;
    }
}
const visibleRefs = computed(() => {
    if (showAll.value)
        return props.refs;
    return props.refs.slice(0, COLLAPSE_THRESHOLD);
});
const hiddenCount = computed(() => Math.max(0, props.refs.length - COLLAPSE_THRESHOLD));
// 统计 vault / web 来源数，用于徽章展示
const vaultCount = computed(() => props.refs.filter(r => r.source === 'vault').length);
const webCount = computed(() => props.refs.filter(r => r.source === 'web').length);
// 项目未引入 vue-router（使用 ref 切换 currentView 的轻量架构）
// 通过 CustomEvent + sessionStorage 跨组件传递跳转目标：
//   - RefsList 仅负责派发 karpathy:jump-vault 事件并暂存目标路径
//   - App.vue 监听该事件并切换到 browse 视图
//   - Browse.vue onMounted 时读取 sessionStorage.jumpPath 自动定位
function handleRefClick(ref) {
    if (ref.source === 'vault' && ref.path) {
        sessionStorage.setItem('karpathy:jumpPath', ref.path);
        globalThis.dispatchEvent(new CustomEvent('karpathy:jump-vault', { detail: { path: ref.path } }));
    }
    else if (ref.url) {
        // web 引用：新窗口打开外部链接，加 noopener+noreferrer 防止 tab nabbing
        globalThis.open(ref.url, '_blank', 'noopener,noreferrer');
    }
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['source-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['source-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['ref-item']} */ ;
/** @type {__VLS_StyleScopedClasses['ref-item']} */ ;
/** @type {__VLS_StyleScopedClasses['vault']} */ ;
/** @type {__VLS_StyleScopedClasses['ref-item']} */ ;
/** @type {__VLS_StyleScopedClasses['web']} */ ;
/** @type {__VLS_StyleScopedClasses['source-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['vault']} */ ;
/** @type {__VLS_StyleScopedClasses['source-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['web']} */ ;
/** @type {__VLS_StyleScopedClasses['show-more-btn']} */ ;
// CSS variable injection 
// CSS variable injection end 
if (__VLS_ctx.refs.length > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "refs-list" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (__VLS_ctx.toggleExpanded) },
        ...{ class: "refs-header" },
    });
    const __VLS_0 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
        ...{ class: "refs-icon" },
    }));
    const __VLS_2 = __VLS_1({
        ...{ class: "refs-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    __VLS_3.slots.default;
    const __VLS_4 = {}.Reading;
    /** @type {[typeof __VLS_components.Reading, ]} */ ;
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
    const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
    var __VLS_3;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "refs-title" },
    });
    (__VLS_ctx.refs.length);
    if (__VLS_ctx.vaultCount > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "source-stat vault" },
        });
        (__VLS_ctx.vaultCount);
    }
    if (__VLS_ctx.webCount > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "source-stat web" },
        });
        (__VLS_ctx.webCount);
    }
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
    if (__VLS_ctx.expanded) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "refs-body" },
        });
        for (const [ref] of __VLS_getVForSourceType((__VLS_ctx.visibleRefs))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.refs.length > 0))
                            return;
                        if (!(__VLS_ctx.expanded))
                            return;
                        __VLS_ctx.handleRefClick(ref);
                    } },
                key: (ref.url || ref.path || ref.citeIndex),
                id: (`ref-${ref.citeIndex}`),
                ...{ class: "ref-item" },
                ...{ class: (ref.source) },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "ref-cite" },
            });
            (ref.citeIndex);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "ref-info" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "ref-title-row" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "ref-title" },
            });
            (ref.title);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "source-badge" },
                ...{ class: (ref.source) },
            });
            (ref.source === 'vault' ? 'VAULT' : 'WEB');
            if (ref.snippet) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "ref-snippet" },
                });
                (ref.snippet);
            }
        }
        if (__VLS_ctx.hiddenCount > 0 && !__VLS_ctx.showAll) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.refs.length > 0))
                            return;
                        if (!(__VLS_ctx.expanded))
                            return;
                        if (!(__VLS_ctx.hiddenCount > 0 && !__VLS_ctx.showAll))
                            return;
                        __VLS_ctx.showAll = true;
                    } },
                ...{ class: "show-more-btn" },
            });
            (__VLS_ctx.hiddenCount);
        }
        else if (__VLS_ctx.hiddenCount > 0 && __VLS_ctx.showAll) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.refs.length > 0))
                            return;
                        if (!(__VLS_ctx.expanded))
                            return;
                        if (!!(__VLS_ctx.hiddenCount > 0 && !__VLS_ctx.showAll))
                            return;
                        if (!(__VLS_ctx.hiddenCount > 0 && __VLS_ctx.showAll))
                            return;
                        __VLS_ctx.showAll = false;
                    } },
                ...{ class: "show-more-btn" },
            });
        }
    }
}
/** @type {__VLS_StyleScopedClasses['refs-list']} */ ;
/** @type {__VLS_StyleScopedClasses['refs-header']} */ ;
/** @type {__VLS_StyleScopedClasses['refs-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['refs-title']} */ ;
/** @type {__VLS_StyleScopedClasses['source-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['vault']} */ ;
/** @type {__VLS_StyleScopedClasses['source-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['web']} */ ;
/** @type {__VLS_StyleScopedClasses['toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['refs-body']} */ ;
/** @type {__VLS_StyleScopedClasses['ref-item']} */ ;
/** @type {__VLS_StyleScopedClasses['ref-cite']} */ ;
/** @type {__VLS_StyleScopedClasses['ref-info']} */ ;
/** @type {__VLS_StyleScopedClasses['ref-title-row']} */ ;
/** @type {__VLS_StyleScopedClasses['ref-title']} */ ;
/** @type {__VLS_StyleScopedClasses['source-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['ref-snippet']} */ ;
/** @type {__VLS_StyleScopedClasses['show-more-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['show-more-btn']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Reading: Reading,
            ArrowDown: ArrowDown,
            ArrowRight: ArrowRight,
            expanded: expanded,
            showAll: showAll,
            toggleExpanded: toggleExpanded,
            visibleRefs: visibleRefs,
            hiddenCount: hiddenCount,
            vaultCount: vaultCount,
            webCount: webCount,
            handleRefClick: handleRefClick,
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
