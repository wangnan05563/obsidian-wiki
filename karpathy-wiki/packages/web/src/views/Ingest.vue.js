/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import RobotAvatar from '../components/RobotAvatar.vue';
import { useCompileStore } from '../stores/compile';
const emit = defineEmits();
const store = useCompileStore();
const activeTab = ref('file');
const urlInput = ref('');
const textInput = ref('');
const selectedFile = ref(null);
const canSubmit = computed(() => {
    if (activeTab.value === 'file')
        return !!selectedFile.value;
    if (activeTab.value === 'url')
        return urlInput.value.trim().length > 0;
    return textInput.value.trim().length > 0;
});
function handleFileChange(file) {
    selectedFile.value = file.raw ?? null;
}
function handleFileRemove() {
    selectedFile.value = null;
}
function disableAutoUpload() {
    return false;
}
function buildPayload() {
    if (activeTab.value === 'file') {
        if (!selectedFile.value)
            return null;
        const fd = new FormData();
        fd.append('file', selectedFile.value);
        return fd;
    }
    if (activeTab.value === 'url') {
        const content = urlInput.value.trim();
        if (!content)
            return null;
        return { type: 'url', content };
    }
    const content = textInput.value.trim();
    if (!content)
        return null;
    return { type: 'text', content };
}
function handleSubmit() {
    const payload = buildPayload();
    if (!payload) {
        ElMessage.warning('请先准备好要投递的资料');
        return;
    }
    store.prepareCompile(payload);
    emit('start');
}
function resetInputs() {
    selectedFile.value = null;
    urlInput.value = '';
    textInput.value = '';
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "ingest-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "hero-section fade-up" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "hero-orb" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "hero-left" },
});
/** @type {[typeof RobotAvatar, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
    size: (150),
    floating: (true),
}));
const __VLS_1 = __VLS_0({
    size: (150),
    floating: (true),
}, ...__VLS_functionalComponentArgsRest(__VLS_0));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "hero-right" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "hero-tag" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "hero-title grad-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "hero-tip" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card ingest-card fade-up" },
    ...{ style: {} },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
const __VLS_3 = {}.ElTabs;
/** @type {[typeof __VLS_components.ElTabs, typeof __VLS_components.elTabs, typeof __VLS_components.ElTabs, typeof __VLS_components.elTabs, ]} */ ;
// @ts-ignore
const __VLS_4 = __VLS_asFunctionalComponent(__VLS_3, new __VLS_3({
    modelValue: (__VLS_ctx.activeTab),
    ...{ class: "ingest-tabs" },
}));
const __VLS_5 = __VLS_4({
    modelValue: (__VLS_ctx.activeTab),
    ...{ class: "ingest-tabs" },
}, ...__VLS_functionalComponentArgsRest(__VLS_4));
__VLS_6.slots.default;
const __VLS_7 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_8 = __VLS_asFunctionalComponent(__VLS_7, new __VLS_7({
    label: "文件上传",
    name: "file",
}));
const __VLS_9 = __VLS_8({
    label: "文件上传",
    name: "file",
}, ...__VLS_functionalComponentArgsRest(__VLS_8));
__VLS_10.slots.default;
const __VLS_11 = {}.ElUpload;
/** @type {[typeof __VLS_components.ElUpload, typeof __VLS_components.elUpload, typeof __VLS_components.ElUpload, typeof __VLS_components.elUpload, ]} */ ;
// @ts-ignore
const __VLS_12 = __VLS_asFunctionalComponent(__VLS_11, new __VLS_11({
    drag: true,
    autoUpload: (false),
    limit: (1),
    onChange: (__VLS_ctx.handleFileChange),
    onRemove: (__VLS_ctx.handleFileRemove),
    beforeUpload: (__VLS_ctx.disableAutoUpload),
    accept: ".md,.txt,.pdf,.html,.json",
}));
const __VLS_13 = __VLS_12({
    drag: true,
    autoUpload: (false),
    limit: (1),
    onChange: (__VLS_ctx.handleFileChange),
    onRemove: (__VLS_ctx.handleFileRemove),
    beforeUpload: (__VLS_ctx.disableAutoUpload),
    accept: ".md,.txt,.pdf,.html,.json",
}, ...__VLS_functionalComponentArgsRest(__VLS_12));
__VLS_14.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-inner" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-icon" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-hint" },
});
var __VLS_14;
var __VLS_10;
const __VLS_15 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_16 = __VLS_asFunctionalComponent(__VLS_15, new __VLS_15({
    label: "URL 粘贴",
    name: "url",
}));
const __VLS_17 = __VLS_16({
    label: "URL 粘贴",
    name: "url",
}, ...__VLS_functionalComponentArgsRest(__VLS_16));
__VLS_18.slots.default;
const __VLS_19 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_20 = __VLS_asFunctionalComponent(__VLS_19, new __VLS_19({
    modelValue: (__VLS_ctx.urlInput),
    placeholder: "https://example.com/article",
    clearable: true,
    size: "large",
}));
const __VLS_21 = __VLS_20({
    modelValue: (__VLS_ctx.urlInput),
    placeholder: "https://example.com/article",
    clearable: true,
    size: "large",
}, ...__VLS_functionalComponentArgsRest(__VLS_20));
__VLS_22.slots.default;
{
    const { prepend: __VLS_thisSlot } = __VLS_22.slots;
}
var __VLS_22;
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "input-hint" },
});
var __VLS_18;
const __VLS_23 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_24 = __VLS_asFunctionalComponent(__VLS_23, new __VLS_23({
    label: "文本粘贴",
    name: "text",
}));
const __VLS_25 = __VLS_24({
    label: "文本粘贴",
    name: "text",
}, ...__VLS_functionalComponentArgsRest(__VLS_24));
__VLS_26.slots.default;
const __VLS_27 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_28 = __VLS_asFunctionalComponent(__VLS_27, new __VLS_27({
    modelValue: (__VLS_ctx.textInput),
    type: "textarea",
    rows: (8),
    placeholder: "在此粘贴要编译为知识库页面的文本内容…",
    resize: "none",
}));
const __VLS_29 = __VLS_28({
    modelValue: (__VLS_ctx.textInput),
    type: "textarea",
    rows: (8),
    placeholder: "在此粘贴要编译为知识库页面的文本内容…",
    resize: "none",
}, ...__VLS_functionalComponentArgsRest(__VLS_28));
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "input-hint" },
});
var __VLS_26;
var __VLS_6;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "submit-bar" },
});
const __VLS_31 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_32 = __VLS_asFunctionalComponent(__VLS_31, new __VLS_31({
    ...{ 'onClick': {} },
    type: "primary",
    size: "large",
    disabled: (!__VLS_ctx.canSubmit),
}));
const __VLS_33 = __VLS_32({
    ...{ 'onClick': {} },
    type: "primary",
    size: "large",
    disabled: (!__VLS_ctx.canSubmit),
}, ...__VLS_functionalComponentArgsRest(__VLS_32));
let __VLS_35;
let __VLS_36;
let __VLS_37;
const __VLS_38 = {
    onClick: (__VLS_ctx.handleSubmit)
};
__VLS_34.slots.default;
var __VLS_34;
const __VLS_39 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_40 = __VLS_asFunctionalComponent(__VLS_39, new __VLS_39({
    ...{ 'onClick': {} },
    size: "large",
}));
const __VLS_41 = __VLS_40({
    ...{ 'onClick': {} },
    size: "large",
}, ...__VLS_functionalComponentArgsRest(__VLS_40));
let __VLS_43;
let __VLS_44;
let __VLS_45;
const __VLS_46 = {
    onClick: (__VLS_ctx.resetInputs)
};
__VLS_42.slots.default;
var __VLS_42;
/** @type {__VLS_StyleScopedClasses['ingest-page']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-section']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-orb']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-left']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-right']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['ingest-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['ingest-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-inner']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-text']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['input-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['input-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['submit-bar']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            RobotAvatar: RobotAvatar,
            activeTab: activeTab,
            urlInput: urlInput,
            textInput: textInput,
            canSubmit: canSubmit,
            handleFileChange: handleFileChange,
            handleFileRemove: handleFileRemove,
            disableAutoUpload: disableAutoUpload,
            handleSubmit: handleSubmit,
            resetInputs: resetInputs,
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
