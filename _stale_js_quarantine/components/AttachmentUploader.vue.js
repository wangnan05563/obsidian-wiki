import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useAttachmentsStore } from '../stores/attachments';
import { useModelStore } from '../stores/model';
const props = defineProps();
const emit = defineEmits();
const store = useAttachmentsStore();
const modelStore = useModelStore();
const dragOver = ref(false);
const fileInputRef = ref(null);
// 组件根元素引用：用于绑定 paste 事件，替代全局监听
const rootRef = ref(null);
// F-3.5 当前模型 vision 能力（响应式，切换模型时自动更新）
const visionSupported = computed(() => modelStore.currentPresetVision);
const uploadTitle = computed(() => visionSupported.value ? '上传附件' : '当前模型不支持图片理解');
// 缩略图 URL 缓存：id -> objectURL
// 为什么用 Map 而非 reactive 对象：避免频繁增删 key 触发多次响应式更新
const thumbUrls = ref(new Map());
// 允许的图片 MIME 白名单
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
async function handleFile(file) {
    // F-3.5 vision 能力缺失时拒绝上传，提示用户切换模型
    if (!visionSupported.value) {
        ElMessage.warning('当前模型不支持图片理解，请切换到带 vision 能力的模型');
        return;
    }
    if (!ALLOWED_MIME.has(file.type)) {
        ElMessage.error('仅支持 jpg/png/webp/gif');
        return;
    }
    if (file.size > MAX_SIZE) {
        ElMessage.error('图片大小不能超过 10MB');
        return;
    }
    try {
        const id = await store.addImage(file);
        emit('add', id);
        // 立即加载缩略图
        const blob = await store.getThumbnail(id);
        if (blob) {
            thumbUrls.value.set(id, URL.createObjectURL(blob));
        }
    }
    catch (err) {
        ElMessage.error('图片处理失败');
        console.error(err);
    }
}
function handleDrop(e) {
    dragOver.value = false;
    const files = e.dataTransfer?.files;
    if (files) {
        for (const file of files) {
            handleFile(file);
        }
    }
}
function handlePaste(e) {
    const items = e.clipboardData?.items;
    if (items) {
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file)
                    handleFile(file);
            }
        }
    }
}
// 组件根元素监听 paste 事件，避免全局监听影响其他组件
onMounted(() => {
    rootRef.value?.addEventListener('paste', handlePaste);
});
onBeforeUnmount(() => {
    rootRef.value?.removeEventListener('paste', handlePaste);
    // 释放所有 objectURL 避免内存泄漏
    thumbUrls.value.forEach(url => URL.revokeObjectURL(url));
});
// 监听 attachments 变化，为新 id 加载缩略图
watch(() => props.attachments, async (ids) => {
    for (const id of ids) {
        if (!thumbUrls.value.has(id)) {
            const blob = await store.getThumbnail(id);
            if (blob) {
                thumbUrls.value.set(id, URL.createObjectURL(blob));
            }
        }
    }
}, { deep: true });
function triggerFileInput() {
    fileInputRef.value?.click();
}
function onFileChange(e) {
    const input = e.target;
    const files = input.files;
    if (files) {
        for (const file of files) {
            handleFile(file);
        }
    }
    // 清空 input value 以支持重复选择同一文件
    input.value = '';
}
function handleRemove(id) {
    // 释放被移除附件的 objectURL
    const url = thumbUrls.value.get(id);
    if (url) {
        URL.revokeObjectURL(url);
        thumbUrls.value.delete(id);
    }
    emit('remove', id);
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['attachment-uploader']} */ ;
/** @type {__VLS_StyleScopedClasses['attachment-uploader']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-only']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-only']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['attachment-list']} */ ;
/** @type {__VLS_StyleScopedClasses['attachment-list']} */ ;
/** @type {__VLS_StyleScopedClasses['remove-btn']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ref: "rootRef",
    ...{ class: "attachment-uploader" },
    ...{ class: ({ 'icon-only': props.iconOnly }) },
});
/** @type {typeof __VLS_ctx.rootRef} */ ;
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    ...{ onChange: (__VLS_ctx.onFileChange) },
    ref: "fileInputRef",
    type: "file",
    accept: "image/jpeg,image/png,image/webp,image/gif",
    multiple: true,
    ...{ style: {} },
});
/** @type {typeof __VLS_ctx.fileInputRef} */ ;
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.triggerFileInput) },
    ...{ class: "upload-btn" },
    ...{ class: ({ 'icon-only': props.iconOnly, disabled: !__VLS_ctx.visionSupported }) },
    disabled: (!__VLS_ctx.visionSupported),
    title: (props.iconOnly ? __VLS_ctx.uploadTitle : (__VLS_ctx.visionSupported ? undefined : __VLS_ctx.uploadTitle)),
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
    width: "18",
    height: "18",
    viewBox: "0 0 24 24",
    fill: "none",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
    d: "M21 11.5l-8.5 8.5a5 5 0 01-7-7l8-8a3.5 3.5 0 015 5l-8 8a2 2 0 01-3-3l7-7",
    stroke: "currentColor",
    'stroke-width': "1.6",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
if (props.attachments.length > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onDragover: (...[$event]) => {
                if (!(props.attachments.length > 0))
                    return;
                __VLS_ctx.dragOver = true;
            } },
        ...{ onDragleave: (...[$event]) => {
                if (!(props.attachments.length > 0))
                    return;
                __VLS_ctx.dragOver = false;
            } },
        ...{ onDrop: (__VLS_ctx.handleDrop) },
        ...{ class: "attachment-list" },
        ...{ class: ({ 'drag-over': __VLS_ctx.dragOver }) },
    });
    for (const [id] of __VLS_getVForSourceType((props.attachments))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (id),
            ...{ class: "attachment-item" },
        });
        if (__VLS_ctx.thumbUrls.get(id)) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.img)({
                src: (__VLS_ctx.thumbUrls.get(id)),
                ...{ class: "thumb-img" },
                alt: "附件缩略图",
            });
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "thumb-placeholder" },
            });
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(props.attachments.length > 0))
                        return;
                    __VLS_ctx.handleRemove(id);
                } },
            ...{ class: "remove-btn" },
        });
    }
}
/** @type {__VLS_StyleScopedClasses['attachment-uploader']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['attachment-list']} */ ;
/** @type {__VLS_StyleScopedClasses['attachment-item']} */ ;
/** @type {__VLS_StyleScopedClasses['thumb-img']} */ ;
/** @type {__VLS_StyleScopedClasses['thumb-placeholder']} */ ;
/** @type {__VLS_StyleScopedClasses['remove-btn']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            dragOver: dragOver,
            fileInputRef: fileInputRef,
            rootRef: rootRef,
            visionSupported: visionSupported,
            uploadTitle: uploadTitle,
            thumbUrls: thumbUrls,
            handleDrop: handleDrop,
            triggerFileInput: triggerFileInput,
            onFileChange: onFileChange,
            handleRemove: handleRemove,
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
