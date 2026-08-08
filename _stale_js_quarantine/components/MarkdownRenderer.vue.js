/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import MarkdownIt from 'markdown-it';
// Markdown 渲染组件。
// v1：用于把 LLM 流式输出的 Markdown 文本实时渲染为 HTML。
// v2 改造：添加图片点击放大预览（el-image-viewer）。
// 设计选择：
// - html: false：禁止源 HTML 直通，markdown-it 默认会转义 < >，防 XSS
// - breaks: true：聊天场景下单换行应渲染为 <br>，否则需要两个空格才换行，体验差
// - linkify: true：URL 自动转链接，方便用户点击
// - typographer: false：禁用排版替换（如 " -> "），避免中文标点被误替换
const md = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: true,
    typographer: false,
});
const props = defineProps();
const html = computed(() => {
    if (!props.content)
        return '';
    return md.render(props.content);
});
// v2：图片预览状态
const previewSrc = ref('');
const previewVisible = ref(false);
const rootRef = ref(null);
// 事件委托处理器：提取为命名函数以便卸载时移除
const handleClick = (e) => {
    const target = e.target;
    if (target.tagName === 'IMG') {
        e.preventDefault();
        previewSrc.value = target.src;
        previewVisible.value = true;
    }
};
// 事件委托：监听根元素 click，若点击目标是 img 则触发预览
// 为什么用事件委托而非在 v-html 中注入 onclick：v-html 内容不经过 Vue 编译，无法绑定 Vue 事件
onMounted(() => {
    rootRef.value?.addEventListener('click', handleClick);
});
onBeforeUnmount(() => {
    rootRef.value?.removeEventListener('click', handleClick);
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ref: "rootRef",
    ...{ class: "md-body" },
});
__VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.html) }, null, null);
/** @type {typeof __VLS_ctx.rootRef} */ ;
if (__VLS_ctx.previewVisible) {
    const __VLS_0 = {}.ElImageViewer;
    /** @type {[typeof __VLS_components.ElImageViewer, typeof __VLS_components.elImageViewer, ]} */ ;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
        ...{ 'onClose': {} },
        urlList: ([__VLS_ctx.previewSrc]),
    }));
    const __VLS_2 = __VLS_1({
        ...{ 'onClose': {} },
        urlList: ([__VLS_ctx.previewSrc]),
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    let __VLS_4;
    let __VLS_5;
    let __VLS_6;
    const __VLS_7 = {
        onClose: (...[$event]) => {
            if (!(__VLS_ctx.previewVisible))
                return;
            __VLS_ctx.previewVisible = false;
        }
    };
    var __VLS_3;
}
/** @type {__VLS_StyleScopedClasses['md-body']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            html: html,
            previewSrc: previewSrc,
            previewVisible: previewVisible,
            rootRef: rootRef,
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
