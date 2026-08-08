/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
// FR-09-2 多模态输出卡片：渲染 mindmap/faq/timeline/image/ppt 结构化输出
// - mindmap: 使用 mermaid.js 渲染思维导图（动态导入，避免首屏加载 mermaid）
// - faq: 渲染 Markdown 问答对（复用 renderMarkdown）
// - timeline: 渲染 Markdown 时间线（复用 renderMarkdown）
// - image: 渲染图像（img 标签 + 下载归档链接）
// - ppt: 使用 @marp-team/marp-core 渲染 Marp Markdown 为 HTML 幻灯片（动态导入）
// 设计选择：mermaid/marp 动态 import 减少首屏体积；faq/timeline/image 复用现有渲染管线
import { ref, watch, onBeforeUnmount, nextTick } from 'vue';
import { DataAnalysis, Picture, Document } from '@element-plus/icons-vue';
import { renderMarkdown } from '../utils/markdown';
const props = defineProps();
// mermaid 渲染容器引用，动态导入 mermaid 后挂载渲染结果
const mermaidContainer = ref(null);
// marp 渲染容器引用，动态导入 marp-core 后挂载渲染结果
const marpContainer = ref(null);
// 是否已加载 mermaid 库（避免重复加载）
let mermaidLoaded = false;
// 是否已加载 marp-core 库（避免重复加载）
let marpLoaded = false;
// 渲染错误信息（mermaid/marp 语法错误时显示原始文本）
const renderError = ref('');
// 动态加载 mermaid 并渲染 mindmap
// 为什么动态加载：mermaid 库 ~600KB，首屏加载会拖慢初始渲染；仅在首次使用 mindmap 时加载
async function renderMindmap(content) {
    if (!mermaidContainer.value)
        return;
    try {
        if (!mermaidLoaded) {
            // 动态 import mermaid，避免打包到主 chunk
            const mermaid = (await import('mermaid')).default;
            // 为什么 mermaid.initialize：配置主题与安全策略，避免 XSS
            // suppressErrorRendering: true 关键：mermaid 11.x 默认在 parse/draw 失败时向容器注入
            //   含 "Syntax error in text" 文字的错误 SVG（error-icon + error-text），启用此选项后
            //   失败时仅调用 removeTempElements() 清理临时元素并直接抛错，避免污染 .mermaid-output
            mermaid.initialize({
                startOnLoad: false,
                theme: 'default',
                securityLevel: 'strict',
                suppressErrorRendering: true,
                mindmap: { padding: 16 },
            });
            mermaidLoaded = true;
        }
        // F-3.x 先清空容器：避免上次错误 SVG（如 "Syntax error in text"）残留
        mermaidContainer.value.innerHTML = '';
        // F-3.x 预解析语法：mermaid 11.x 的 render() 在 parse 失败时除了抛错，还可能注入临时 div/svg
        //   （即使 suppressErrorRendering: true 也会走 Diagram.fromText("error") 分支）。
        //   先用 parse() 单独验证语法，失败时只抛错不污染容器；此处配合 try/catch 清空容器兜底。
        await (await import('mermaid')).default.parse(content);
        // 预解析通过后再渲染：成功路径，正常挂载 SVG
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { svg } = await (await import('mermaid')).default.render(id, content);
        // F-3.x render 成功后也要清空容器：mermaid 11.x 内部在挂载 SVG 前可能向容器插入临时 wrapper div
        //   （即使 suppressErrorRendering 已开，正常路径仍会创建 enclosingDiv），innerHTML = svg 覆盖避免残留
        mermaidContainer.value.innerHTML = '';
        mermaidContainer.value.innerHTML = svg;
        renderError.value = '';
    }
    catch (err) {
        // 兜底：mermaid 11.x 在某些版本/分支下 parse 失败后仍可能向容器注入错误 SVG。
        // 清空容器避免用户看到 mermaid 内置的 "Syntax error in text" 错误图标
        if (mermaidContainer.value) {
            mermaidContainer.value.innerHTML = '';
        }
        // mermaid 语法错误时显示原始文本，让用户看到 LLM 输出内容便于排查
        renderError.value = err instanceof Error ? err.message : String(err);
    }
}
// 动态加载 marpit 并渲染 PPT 幻灯片
// 为什么用 marpit 而非 marp-core：marp-core 依赖 Node.js 内置 util 模块（util.deprecate），
// Vite 在浏览器中无法提供完整 polyfill，导致渲染时报 "u2 is not a function"；
// marpit 是 marp-core 的浏览器友好核心子库，提供相同的 Marp Markdown → HTML/CSS 渲染能力
// 为什么动态加载：marpit 库较大，首屏加载会拖慢初始渲染
async function renderPpt(markdown) {
    if (!marpContainer.value)
        return;
    try {
        if (!marpLoaded) {
            // 动态 import marpit，避免打包到主 chunk
            // marpit 是 CJS 模块，Vite 预构建后命名导出挂在 default 上，需兼容访问
            const mod = await import('@marp-team/marpit');
            const Marpit = mod.Marpit ?? mod.default?.Marpit;
            if (!Marpit)
                throw new Error('Marpit constructor not found in @marp-team/marpit');
            // inlineSVG: 每页渲染为 SVG（1280x720），支持矢量缩放，与 marp-core 渲染效果一致
            // markdown.html: 允许幻灯片 Markdown 中嵌入原生 HTML 标签（Marpit 的 html 选项需挂在 markdown 下传给 markdown-it）
            marpInstance = new Marpit({ markdown: { html: true }, inlineSVG: true });
            marpLoaded = true;
        }
        // render 返回 { html, css }，组合后挂载到容器
        const { html, css } = marpInstance.render(markdown);
        marpContainer.value.innerHTML = `<style>${css}</style>${html}`;
        renderError.value = '';
    }
    catch (err) {
        // marp 渲染失败时显示原始 Markdown，让用户看到 LLM 输出内容
        renderError.value = err instanceof Error ? err.message : String(err);
    }
}
// marpit 实例缓存：加载后复用，避免每次渲染重建
let marpInstance = null;
// 监听 output 变化，按类型分发渲染
watch(() => props.output, async (output) => {
    if (output.type === 'mindmap') {
        // 等 DOM 更新后 mermaidContainer 才可用
        await nextTick();
        await renderMindmap(output.content);
    }
    else if (output.type === 'ppt' && output.pptMarkdown) {
        // 等 DOM 更新后 marpContainer 才可用
        await nextTick();
        await renderPpt(output.pptMarkdown);
    }
}, { immediate: true });
onBeforeUnmount(() => {
    // 清理渲染容器，避免内存泄漏
    mermaidContainer.value = null;
    marpContainer.value = null;
});
// 计算卡片标题
function cardLabel(type) {
    switch (type) {
        case 'mindmap': return '思维导图';
        case 'faq': return 'FAQ 问答对';
        case 'timeline': return '时间线';
        case 'image': return '生成图像';
        case 'ppt': return 'PPT 幻灯片';
        default: return '结构化输出';
    }
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['mermaid-output']} */ ;
/** @type {__VLS_StyleScopedClasses['image-link']} */ ;
/** @type {__VLS_StyleScopedClasses['marp-output']} */ ;
/** @type {__VLS_StyleScopedClasses['marp-output']} */ ;
/** @type {__VLS_StyleScopedClasses['mermaid-output']} */ ;
/** @type {__VLS_StyleScopedClasses['mermaid-output']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "multimodal-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-header" },
});
const __VLS_0 = {}.ElIcon;
/** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    ...{ class: "card-icon" },
}));
const __VLS_2 = __VLS_1({
    ...{ class: "card-icon" },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
if (props.output.type === 'image') {
    const __VLS_4 = {}.Picture;
    /** @type {[typeof __VLS_components.Picture, ]} */ ;
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
    const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
}
else if (props.output.type === 'ppt') {
    const __VLS_8 = {}.Document;
    /** @type {[typeof __VLS_components.Document, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({}));
    const __VLS_10 = __VLS_9({}, ...__VLS_functionalComponentArgsRest(__VLS_9));
}
else {
    const __VLS_12 = {}.DataAnalysis;
    /** @type {[typeof __VLS_components.DataAnalysis, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({}));
    const __VLS_14 = __VLS_13({}, ...__VLS_functionalComponentArgsRest(__VLS_13));
}
var __VLS_3;
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "card-title" },
});
(__VLS_ctx.cardLabel(props.output.type));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-body" },
});
if (props.output.type === 'mindmap') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mindmap-container" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ref: "mermaidContainer",
        ...{ class: "mermaid-output" },
    });
    /** @type {typeof __VLS_ctx.mermaidContainer} */ ;
    if (__VLS_ctx.renderError) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "render-error" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "error-title" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({
            ...{ class: "raw-content" },
        });
        (props.output.content);
    }
}
else if (props.output.type === 'image') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "image-container" },
    });
    if (props.output.imageUrl) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.img)({
            src: (props.output.imageUrl),
            alt: (props.output.content),
            ...{ class: "generated-image" },
        });
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "image-meta" },
    });
    if (props.output.imageUrl) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
            href: (props.output.imageUrl),
            target: "_blank",
            rel: "noopener",
            ...{ class: "image-link" },
        });
    }
}
else if (props.output.type === 'ppt') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "ppt-container" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ref: "marpContainer",
        ...{ class: "marp-output" },
    });
    /** @type {typeof __VLS_ctx.marpContainer} */ ;
    if (__VLS_ctx.renderError) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "render-error" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "error-title" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({
            ...{ class: "raw-content" },
        });
        (props.output.pptMarkdown || props.output.content);
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "markdown-body" },
    });
    __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderMarkdown(props.output.content)) }, null, null);
}
/** @type {__VLS_StyleScopedClasses['multimodal-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-header']} */ ;
/** @type {__VLS_StyleScopedClasses['card-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['card-title']} */ ;
/** @type {__VLS_StyleScopedClasses['card-body']} */ ;
/** @type {__VLS_StyleScopedClasses['mindmap-container']} */ ;
/** @type {__VLS_StyleScopedClasses['mermaid-output']} */ ;
/** @type {__VLS_StyleScopedClasses['render-error']} */ ;
/** @type {__VLS_StyleScopedClasses['error-title']} */ ;
/** @type {__VLS_StyleScopedClasses['raw-content']} */ ;
/** @type {__VLS_StyleScopedClasses['image-container']} */ ;
/** @type {__VLS_StyleScopedClasses['generated-image']} */ ;
/** @type {__VLS_StyleScopedClasses['image-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['image-link']} */ ;
/** @type {__VLS_StyleScopedClasses['ppt-container']} */ ;
/** @type {__VLS_StyleScopedClasses['marp-output']} */ ;
/** @type {__VLS_StyleScopedClasses['render-error']} */ ;
/** @type {__VLS_StyleScopedClasses['error-title']} */ ;
/** @type {__VLS_StyleScopedClasses['raw-content']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            DataAnalysis: DataAnalysis,
            Picture: Picture,
            Document: Document,
            renderMarkdown: renderMarkdown,
            mermaidContainer: mermaidContainer,
            marpContainer: marpContainer,
            renderError: renderError,
            cardLabel: cardLabel,
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
