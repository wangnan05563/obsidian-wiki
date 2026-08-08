/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
// 统一采用 Element Plus 开源图标库（@element-plus/icons-vue），避免使用 emoji 或 AI 预制图标
import { DocumentCopy, Document, RefreshRight, VideoPlay, VideoPause, Delete, Star, StarFilled, } from '@element-plus/icons-vue';
import { useTtsStore } from '../stores/tts';
import { msgFeedbackKey } from '../constants/storageKeys';
const props = defineProps();
const emit = defineEmits();
// F-3.13 反馈状态：'up' | 'down' | null
// 为什么用 ref + localStorage 同步：本地读取避免每次点击都查 localStorage
const feedback = ref(null);
// 时间显示：短格式 HH:mm 常态显示，完整格式 YYYY-MM-DD HH:mm:ss 在 title 中 hover 显示
// 为什么用 computed 而非方法：依赖 props.createdAt 变化时自动重算
const timeDisplay = computed(() => {
    if (!props.createdAt)
        return '';
    const d = new Date(props.createdAt);
    if (Number.isNaN(d.getTime()))
        return '';
    // 短格式：HH:mm（同日）或 MM-DD HH:mm（跨日）
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const pad = (n) => String(n).padStart(2, '0');
    if (sameDay) {
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
});
const timeFull = computed(() => {
    if (!props.createdAt)
        return '';
    const d = new Date(props.createdAt);
    if (Number.isNaN(d.getTime()))
        return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
});
// F-3.6 TTS：通过 store 协调多条消息的朗读切换，避免同时多条朗读
const ttsStore = useTtsStore();
// F-3.6 浏览器是否支持 speechSynthesis：不支持时灰显朗读按钮
// 使用 globalThis 以满足 S7764，并在 SSR 场景下避免 ReferenceError
const ttsSupported = typeof globalThis !== 'undefined' && 'speechSynthesis' in globalThis;
// F-3.6 当前消息朗读状态：仅当 currentMsgId === props.msgId 时才有意义
// 为什么用 computed：store 中 currentMsgId 变化时自动更新按钮图标
const ttsState = computed(() => {
    if (ttsStore.currentMsgId !== props.msgId)
        return 'idle';
    return ttsStore.state;
});
// F-3.6 朗读按钮图标：未朗读 → VideoPlay；朗读中 → VideoPause；已暂停 → VideoPlay
const ttsIcon = computed(() => {
    if (ttsState.value === 'playing')
        return VideoPause;
    if (ttsState.value === 'paused')
        return VideoPlay;
    return VideoPlay;
});
const ttsTitle = computed(() => {
    if (!ttsSupported)
        return '当前浏览器不支持语音朗读';
    if (ttsState.value === 'playing')
        return '暂停朗读';
    if (ttsState.value === 'paused')
        return '继续朗读';
    return '朗读';
});
// F-3.6 语速浮窗显示状态：仅当本消息正在朗读且用户点击 rate-btn 时展开
const showRatePanel = ref(false);
// F-3.6 处理语速滑块变化：转为数字后调 store.setRate
// 为什么 parseFloat 后 clamp：防御滑块原始值越界（极端浏览器行为）
function handleRateChange(raw) {
    const v = Number.parseFloat(raw);
    if (Number.isNaN(v))
        return;
    ttsStore.setRate(v);
}
onMounted(() => {
    // 恢复当前消息已记录的反馈状态
    if (props.msgId) {
        const saved = localStorage.getItem(msgFeedbackKey(props.msgId));
        if (saved === 'up' || saved === 'down') {
            feedback.value = saved;
        }
    }
});
// 复制到剪贴板：优先 navigator.clipboard（HTTPS / localhost 可用）
// 降级到 document.execCommand('copy')（兼容非 HTTPS 场景，如 HTTP 局域网访问）
async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && globalThis.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        // 降级路径：创建临时 textarea + execCommand，兼容旧浏览器 / 非 HTTPS
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    }
    catch {
        return false;
    }
}
// Markdown → 纯文本：剥离常见 markdown 语法
// 为什么不引入 marked.lexer：单文件正则足够覆盖 90% 场景，避免增加 bundle
// 为什么不复用 useTTS.ts 的 stripMarkdown：两者用途不同
//   - 这里用于「复制纯文本」：代码块需保留代码内容（用户希望粘贴可读源码）
//   - useTTS.ts 用于「语音朗读」：代码块替换为「代码块」占位（避免朗读源码）
//   - 拆分两份实现避免引入跨模块耦合，且各自职责清晰
function stripMarkdown(md) {
    return md
        // 代码块：替换为占位（保留代码内容，去除 ``` 围栏）
        .replaceAll(/```[\s\S]*?\n([\s\S]*?)```/g, (_, code) => code.trim())
        // 行内代码：去反引号
        .replaceAll(/`([^`]+)`/g, '$1')
        // 图片：替换为 alt 文本
        .replaceAll(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        // 链接：替换为文本
        .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        // 标题井号
        .replaceAll(/^#{1,6}\s+/gm, '')
        // 引用块 >
        .replaceAll(/^>\s+/gm, '')
        // 粗体/斜体
        .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
        .replaceAll(/\*([^*]+)\*/g, '$1')
        .replaceAll(/__([^_]+)__/g, '$1')
        .replaceAll(/_([^_]+)_/g, '$1')
        // 删除线
        .replaceAll(/~~([^~]+)~~/g, '$1')
        // 无序列表标记
        .replaceAll(/^[-*+]\s+/gm, '')
        // 有序列表标记
        .replaceAll(/^\d+\.\s+/gm, '')
        // 水平分割线
        .replaceAll(/^---+$/gm, '')
        // 收敛多余空行
        .replaceAll(/\n{3,}/g, '\n\n')
        .trim();
}
async function handleCopyPlain() {
    const ok = await copyToClipboard(stripMarkdown(props.content));
    ElMessage[ok ? 'success' : 'warning'](ok ? '已复制纯文本' : '复制失败，请手动选择');
}
async function handleCopyMarkdown() {
    const ok = await copyToClipboard(props.content);
    ElMessage[ok ? 'success' : 'warning'](ok ? '已复制 Markdown' : '复制失败，请手动选择');
}
// user 消息复制：直接复制原始内容（无 markdown 解析需求）
async function handleCopyUser() {
    const ok = await copyToClipboard(props.content);
    ElMessage[ok ? 'success' : 'warning'](ok ? '已复制' : '复制失败，请手动选择');
}
// 删除当前消息：直接 emit，由父组件调用 store.removeMessage(idx)
// 为什么不在组件内直接操作 store：组件应保持"无状态 UI"职责，删除由父组件统一管理索引
function handleRemove() {
    emit('remove');
}
// F-3.6 朗读切换：根据当前状态决定 speak / pause / resume / stop
// 切换到其他消息会自动停止当前（store.speak 内部已处理）
function handleTtsToggle() {
    if (!ttsSupported) {
        ElMessage.warning('当前浏览器不支持语音朗读');
        return;
    }
    if (!props.msgId) {
        ElMessage.warning('消息 ID 缺失，无法朗读');
        return;
    }
    if (ttsState.value === 'playing') {
        ttsStore.pause();
    }
    else if (ttsState.value === 'paused') {
        ttsStore.resume();
    }
    else {
        // idle 或其他消息朗读中 → 重新 speak
        // useTTS.stripMarkdown 已内置剥离，这里直接传原始 content
        ttsStore.speak(props.content, props.msgId);
    }
}
// F-3.13 重新生成：直接 emit，由父组件处理具体逻辑（删除消息、复用问题、重新触发）
function handleRegenerate() {
    if (props.canRegenerate === false) {
        ElMessage.warning('回答生成中，请稍后');
        return;
    }
    emit('regenerate');
}
// F-3.13 反馈：写 localStorage（v2.0.0 仅本地，后续可云端）
// 重复点击同一反馈 = 取消；点击相反反馈 = 切换
function handleFeedback(type) {
    if (!props.msgId) {
        ElMessage.warning('消息 ID 缺失，无法记录反馈');
        return;
    }
    if (feedback.value === type) {
        // 取消反馈
        feedback.value = null;
        localStorage.removeItem(msgFeedbackKey(props.msgId));
        ElMessage.info('已取消反馈');
    }
    else {
        feedback.value = type;
        localStorage.setItem(msgFeedbackKey(props.msgId), type);
        ElMessage.success('感谢反馈');
    }
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['rate-reset']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ onClick: () => { } },
    ...{ class: "msg-toolbar" },
});
if (__VLS_ctx.timeDisplay) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "toolbar-time" },
        title: (__VLS_ctx.timeFull),
    });
    (__VLS_ctx.timeDisplay);
}
if (__VLS_ctx.role === 'user') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handleCopyUser) },
        ...{ class: "toolbar-btn" },
        title: "复制",
    });
    const __VLS_0 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({}));
    const __VLS_2 = __VLS_1({}, ...__VLS_functionalComponentArgsRest(__VLS_1));
    __VLS_3.slots.default;
    const __VLS_4 = {}.DocumentCopy;
    /** @type {[typeof __VLS_components.DocumentCopy, ]} */ ;
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
    const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
    var __VLS_3;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handleRemove) },
        ...{ class: "toolbar-btn danger-btn" },
        title: "删除",
    });
    const __VLS_8 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({}));
    const __VLS_10 = __VLS_9({}, ...__VLS_functionalComponentArgsRest(__VLS_9));
    __VLS_11.slots.default;
    const __VLS_12 = {}.Delete;
    /** @type {[typeof __VLS_components.Delete, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({}));
    const __VLS_14 = __VLS_13({}, ...__VLS_functionalComponentArgsRest(__VLS_13));
    var __VLS_11;
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handleCopyPlain) },
        ...{ class: "toolbar-btn" },
        title: "复制纯文本",
    });
    const __VLS_16 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({}));
    const __VLS_18 = __VLS_17({}, ...__VLS_functionalComponentArgsRest(__VLS_17));
    __VLS_19.slots.default;
    const __VLS_20 = {}.Document;
    /** @type {[typeof __VLS_components.Document, ]} */ ;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({}));
    const __VLS_22 = __VLS_21({}, ...__VLS_functionalComponentArgsRest(__VLS_21));
    var __VLS_19;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handleCopyMarkdown) },
        ...{ class: "toolbar-btn" },
        title: "复制 Markdown",
    });
    const __VLS_24 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({}));
    const __VLS_26 = __VLS_25({}, ...__VLS_functionalComponentArgsRest(__VLS_25));
    __VLS_27.slots.default;
    const __VLS_28 = {}.DocumentCopy;
    /** @type {[typeof __VLS_components.DocumentCopy, ]} */ ;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({}));
    const __VLS_30 = __VLS_29({}, ...__VLS_functionalComponentArgsRest(__VLS_29));
    var __VLS_27;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handleTtsToggle) },
        ...{ class: "toolbar-btn" },
        ...{ class: ({ active: __VLS_ctx.ttsState !== 'idle', disabled: !__VLS_ctx.ttsSupported }) },
        disabled: (!__VLS_ctx.ttsSupported),
        title: (__VLS_ctx.ttsTitle),
    });
    const __VLS_32 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({}));
    const __VLS_34 = __VLS_33({}, ...__VLS_functionalComponentArgsRest(__VLS_33));
    __VLS_35.slots.default;
    const __VLS_36 = ((__VLS_ctx.ttsIcon));
    // @ts-ignore
    const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({}));
    const __VLS_38 = __VLS_37({}, ...__VLS_functionalComponentArgsRest(__VLS_37));
    var __VLS_35;
    if (__VLS_ctx.ttsState !== 'idle') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.role === 'user'))
                        return;
                    if (!(__VLS_ctx.ttsState !== 'idle'))
                        return;
                    __VLS_ctx.showRatePanel = !__VLS_ctx.showRatePanel;
                } },
            ...{ class: "toolbar-btn rate-btn" },
            ...{ class: ({ active: __VLS_ctx.showRatePanel }) },
            title: "语速",
        });
        (Math.round(__VLS_ctx.ttsStore.rate * 100) / 100);
    }
    if (__VLS_ctx.showRatePanel && __VLS_ctx.ttsState !== 'idle') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onClick: () => { } },
            ...{ class: "rate-panel" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "rate-label" },
        });
        (__VLS_ctx.ttsStore.rate.toFixed(1));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            ...{ onInput: (...[$event]) => {
                    if (!!(__VLS_ctx.role === 'user'))
                        return;
                    if (!(__VLS_ctx.showRatePanel && __VLS_ctx.ttsState !== 'idle'))
                        return;
                    __VLS_ctx.handleRateChange($event.target.value);
                } },
            type: "range",
            min: "0.5",
            max: "2.0",
            step: "0.1",
            value: (__VLS_ctx.ttsStore.rate),
            ...{ class: "rate-slider" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.role === 'user'))
                        return;
                    if (!(__VLS_ctx.showRatePanel && __VLS_ctx.ttsState !== 'idle'))
                        return;
                    __VLS_ctx.handleRateChange('1');
                } },
            ...{ class: "rate-reset" },
            title: "恢复默认 1.0x",
        });
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handleRegenerate) },
        ...{ class: "toolbar-btn" },
        ...{ class: ({ disabled: __VLS_ctx.canRegenerate === false }) },
        title: (__VLS_ctx.canRegenerate === false ? '回答生成中' : '重新生成'),
    });
    const __VLS_40 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({}));
    const __VLS_42 = __VLS_41({}, ...__VLS_functionalComponentArgsRest(__VLS_41));
    __VLS_43.slots.default;
    const __VLS_44 = {}.RefreshRight;
    /** @type {[typeof __VLS_components.RefreshRight, ]} */ ;
    // @ts-ignore
    const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({}));
    const __VLS_46 = __VLS_45({}, ...__VLS_functionalComponentArgsRest(__VLS_45));
    var __VLS_43;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.role === 'user'))
                    return;
                __VLS_ctx.handleFeedback('up');
            } },
        ...{ class: "toolbar-btn" },
        ...{ class: ({ active: __VLS_ctx.feedback === 'up' }) },
        title: "点赞",
    });
    const __VLS_48 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({}));
    const __VLS_50 = __VLS_49({}, ...__VLS_functionalComponentArgsRest(__VLS_49));
    __VLS_51.slots.default;
    if (__VLS_ctx.feedback === 'up') {
        const __VLS_52 = {}.StarFilled;
        /** @type {[typeof __VLS_components.StarFilled, ]} */ ;
        // @ts-ignore
        const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({}));
        const __VLS_54 = __VLS_53({}, ...__VLS_functionalComponentArgsRest(__VLS_53));
    }
    else {
        const __VLS_56 = {}.Star;
        /** @type {[typeof __VLS_components.Star, ]} */ ;
        // @ts-ignore
        const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({}));
        const __VLS_58 = __VLS_57({}, ...__VLS_functionalComponentArgsRest(__VLS_57));
    }
    var __VLS_51;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.role === 'user'))
                    return;
                __VLS_ctx.handleFeedback('down');
            } },
        ...{ class: "toolbar-btn" },
        ...{ class: ({ active: __VLS_ctx.feedback === 'down' }) },
        title: "点踩",
    });
    const __VLS_60 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({}));
    const __VLS_62 = __VLS_61({}, ...__VLS_functionalComponentArgsRest(__VLS_61));
    __VLS_63.slots.default;
    if (__VLS_ctx.feedback === 'down') {
        const __VLS_64 = {}.Star;
        /** @type {[typeof __VLS_components.Star, ]} */ ;
        // @ts-ignore
        const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({}));
        const __VLS_66 = __VLS_65({}, ...__VLS_functionalComponentArgsRest(__VLS_65));
    }
    else {
        const __VLS_68 = {}.StarFilled;
        /** @type {[typeof __VLS_components.StarFilled, ]} */ ;
        // @ts-ignore
        const __VLS_69 = __VLS_asFunctionalComponent(__VLS_68, new __VLS_68({}));
        const __VLS_70 = __VLS_69({}, ...__VLS_functionalComponentArgsRest(__VLS_69));
    }
    var __VLS_63;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.handleRemove) },
        ...{ class: "toolbar-btn danger-btn" },
        title: "删除",
    });
    const __VLS_72 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_73 = __VLS_asFunctionalComponent(__VLS_72, new __VLS_72({}));
    const __VLS_74 = __VLS_73({}, ...__VLS_functionalComponentArgsRest(__VLS_73));
    __VLS_75.slots.default;
    const __VLS_76 = {}.Delete;
    /** @type {[typeof __VLS_components.Delete, ]} */ ;
    // @ts-ignore
    const __VLS_77 = __VLS_asFunctionalComponent(__VLS_76, new __VLS_76({}));
    const __VLS_78 = __VLS_77({}, ...__VLS_functionalComponentArgsRest(__VLS_77));
    var __VLS_75;
}
/** @type {__VLS_StyleScopedClasses['msg-toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-time']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['danger-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['rate-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['rate-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['rate-label']} */ ;
/** @type {__VLS_StyleScopedClasses['rate-slider']} */ ;
/** @type {__VLS_StyleScopedClasses['rate-reset']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['danger-btn']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            DocumentCopy: DocumentCopy,
            Document: Document,
            RefreshRight: RefreshRight,
            Delete: Delete,
            Star: Star,
            StarFilled: StarFilled,
            feedback: feedback,
            timeDisplay: timeDisplay,
            timeFull: timeFull,
            ttsStore: ttsStore,
            ttsSupported: ttsSupported,
            ttsState: ttsState,
            ttsIcon: ttsIcon,
            ttsTitle: ttsTitle,
            showRatePanel: showRatePanel,
            handleRateChange: handleRateChange,
            handleCopyPlain: handleCopyPlain,
            handleCopyMarkdown: handleCopyMarkdown,
            handleCopyUser: handleCopyUser,
            handleRemove: handleRemove,
            handleTtsToggle: handleTtsToggle,
            handleRegenerate: handleRegenerate,
            handleFeedback: handleFeedback,
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
