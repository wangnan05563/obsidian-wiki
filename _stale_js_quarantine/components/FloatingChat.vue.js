/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { ref, nextTick, watch, computed, onMounted, onBeforeUnmount } from 'vue';
import { Promotion, Close, Minus, VideoPause } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import RobotAvatar from './RobotAvatar.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import MessageToolbar from './MessageToolbar.vue';
import RefsList from './RefsList.vue';
import { useQueryStore } from '../stores/query';
import { apiErrorMessage } from '../utils/apiError';
import { renderMarkdown } from '../utils/markdown';
import { consumeQuerySSE } from '../utils/sse';
import { FLOATING_CHAT_CONFIG } from '../config/floatingChat';
import { STORAGE_KEYS } from '../constants/storageKeys';
// §5.2 全局悬浮问答入口：在所有页面右下角提供快速问答能力。
//   设计取舍：相比 Query.vue 完整功能，FloatingChat 是轻量级浮窗，仅保留核心问答流。
//   复用 ThinkingBlock / MessageToolbar / RefsList 以保持与主问答页一致的交互体验。
const store = useQueryStore();
const props = defineProps();
// 面板展开状态持久化：用户刷新页面后保留偏好
const isOpen = ref(localStorage.getItem(STORAGE_KEYS.FLOATING_CHAT_OPEN) === 'true');
const inputQuestion = ref('');
const chatBodyRef = ref(null);
let abortController = null;
const hasMessages = computed(() => store.messages.length > 0);
// 统一 msg.refs 为 Reference[]，兼容 v1 string[] 与 v2 Reference[]
// 为什么抽出到 computed：原模板内 (msg.refs as Array<...>) 类型断言违反 vue-tsc 严格模式
function normalizeRefs(refs) {
    if (!refs || refs.length === 0)
        return [];
    if (typeof refs[0] === 'string') {
        return refs.map((path, i) => ({
            path,
            title: (path.split('/').pop() || path).replace(/\.md$/, ''),
            snippet: '',
            source: 'vault',
            citeIndex: i + 1,
        }));
    }
    return refs;
}
// 时间戳格式化：仅显示 HH:MM，避免占用过多气泡空间
function formatTime(iso) {
    if (!iso)
        return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}
function scrollToBottom() {
    nextTick(() => {
        if (chatBodyRef.value) {
            chatBodyRef.value.scrollTop = chatBodyRef.value.scrollHeight;
        }
    });
}
watch(() => [store.messages.length, store.streamingAnswer, store.currentThinking.length], scrollToBottom);
async function sendQuestion(question) {
    abortController = new AbortController();
    // 线程隔离：已有线程时把 threadId 交给后端，由后端从本地记忆注入上下文；
    // 不再重复发送前端 history。无线程时回退旧行为发送 history。
    const activeThreadId = store.currentThreadId;
    const history = activeThreadId
        ? undefined
        : store.messages.map((m) => ({ role: m.role, content: m.content }));
    const body = { question, stream: store.streamMode };
    if (activeThreadId) {
        body.threadId = activeThreadId;
    }
    else if (history && history.length > 0) {
        body.history = history;
    }
    try {
        const response = await fetch(`${API_BASE}/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // §真流式：复用主问答的 streamMode 偏好，与 Query 页面行为一致
            body: JSON.stringify(body),
            signal: abortController.signal,
        });
        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
        }
        // SSE 流消费统一委托给 utils/sse.ts，降低本函数认知复杂度（S3776）
        await consumeQuerySSE(response, store, abortController.signal);
    }
    catch (err) {
        if (err.name === 'AbortError')
            return;
        const msg = err.message;
        store.handleError(msg);
        ElMessage.warning(apiErrorMessage('问答失败', err));
    }
    finally {
        abortController = null;
    }
}
function handleSubmit() {
    const q = inputQuestion.value.trim();
    if (!q || store.isLoading)
        return;
    store.submitQuestion(q);
    inputQuestion.value = '';
    void sendQuestion(q);
}
// 删除单条消息：用户点击工具栏删除按钮时调用
// FloatingChat 简化版无 conversationsStore 持久化，仅内存删除
function handleRemoveMessage(idx) {
    store.removeMessage(idx);
}
// 停止生成：调用 abortController 中断 SSE 流，store 会在 catch 中自然 finalize
// 为什么不调 store.stop：store 无 stop 方法，abort 触发后 SSE reader 自动抛 AbortError
function handleStop() {
    if (abortController) {
        abortController.abort();
        abortController = null;
    }
}
function handleKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
    }
}
function handleNewSession() {
    store.reset();
    inputQuestion.value = '';
}
// 统一展开/关闭入口：同时持久化到 localStorage
// 为什么合并原 handleClose：避免重复函数 + 状态分散
function setOpen(open) {
    isOpen.value = open;
    localStorage.setItem(STORAGE_KEYS.FLOATING_CHAT_OPEN, String(open));
    if (open) {
        nextTick(() => scrollToBottom());
    }
}
function toggleOpen() {
    setOpen(!isOpen.value);
}
// Esc 关闭面板：仅在面板展开时响应，避免全局拦截影响其他组件
function handleGlobalKeydown(e) {
    if (e.key === FLOATING_CHAT_CONFIG.shortcuts.close && isOpen.value) {
        // 输入框聚焦时 Esc 默认行为是失焦，需 preventDefault 才能触发关闭
        const tag = e.target?.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
            e.preventDefault();
        }
        setOpen(false);
    }
}
onMounted(() => {
    globalThis.addEventListener('keydown', handleGlobalKeydown);
});
onBeforeUnmount(() => {
    abortController?.abort();
    globalThis.removeEventListener('keydown', handleGlobalKeydown);
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['float-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['float-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['suggestion-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-row']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['followup-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-input']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-input']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-input']} */ ;
/** @type {__VLS_StyleScopedClasses['el-textarea__inner']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-input']} */ ;
/** @type {__VLS_StyleScopedClasses['el-textarea__inner']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-input']} */ ;
/** @type {__VLS_StyleScopedClasses['el-textarea__inner']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-input']} */ ;
/** @type {__VLS_StyleScopedClasses['el-button']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-messages']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-messages']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-messages']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-messages']} */ ;
/** @type {__VLS_StyleScopedClasses['floating-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['float-btn']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.transition, typeof __VLS_components.Transition, typeof __VLS_components.transition, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    name: "float-fade",
}));
const __VLS_2 = __VLS_1({
    name: "float-fade",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
if (__VLS_ctx.isOpen) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "floating-panel" },
        ...{ style: ({
                '--panel-width': __VLS_ctx.FLOATING_CHAT_CONFIG.panel.width + 'px',
                '--panel-min-height': __VLS_ctx.FLOATING_CHAT_CONFIG.panel.minHeight + 'px',
                '--panel-max-height': __VLS_ctx.FLOATING_CHAT_CONFIG.panel.maxHeight + 'px',
                '--panel-bottom': __VLS_ctx.FLOATING_CHAT_CONFIG.position.bottom + 'px',
                '--panel-right': __VLS_ctx.FLOATING_CHAT_CONFIG.position.right + 'px',
            }) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "panel-header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "panel-title" },
    });
    /** @type {[typeof RobotAvatar, ]} */ ;
    // @ts-ignore
    const __VLS_4 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
        size: (28),
    }));
    const __VLS_5 = __VLS_4({
        size: (28),
    }, ...__VLS_functionalComponentArgsRest(__VLS_4));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    (__VLS_ctx.FLOATING_CHAT_CONFIG.panelTitle);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "panel-actions" },
    });
    if (__VLS_ctx.hasMessages) {
        const __VLS_7 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_8 = __VLS_asFunctionalComponent(__VLS_7, new __VLS_7({
            ...{ 'onClick': {} },
            icon: (__VLS_ctx.Minus),
            size: "small",
            circle: true,
            text: true,
            title: "新会话",
        }));
        const __VLS_9 = __VLS_8({
            ...{ 'onClick': {} },
            icon: (__VLS_ctx.Minus),
            size: "small",
            circle: true,
            text: true,
            title: "新会话",
        }, ...__VLS_functionalComponentArgsRest(__VLS_8));
        let __VLS_11;
        let __VLS_12;
        let __VLS_13;
        const __VLS_14 = {
            onClick: (__VLS_ctx.handleNewSession)
        };
        var __VLS_10;
    }
    const __VLS_15 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_16 = __VLS_asFunctionalComponent(__VLS_15, new __VLS_15({
        ...{ 'onClick': {} },
        icon: (__VLS_ctx.Close),
        size: "small",
        circle: true,
        text: true,
        title: "关闭",
    }));
    const __VLS_17 = __VLS_16({
        ...{ 'onClick': {} },
        icon: (__VLS_ctx.Close),
        size: "small",
        circle: true,
        text: true,
        title: "关闭",
    }, ...__VLS_functionalComponentArgsRest(__VLS_16));
    let __VLS_19;
    let __VLS_20;
    let __VLS_21;
    const __VLS_22 = {
        onClick: (...[$event]) => {
            if (!(__VLS_ctx.isOpen))
                return;
            __VLS_ctx.setOpen(false);
        }
    };
    var __VLS_18;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ref: "chatBodyRef",
        ...{ class: "panel-messages" },
    });
    /** @type {typeof __VLS_ctx.chatBodyRef} */ ;
    if (__VLS_ctx.store.messages.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "messages-empty" },
        });
        /** @type {[typeof RobotAvatar, ]} */ ;
        // @ts-ignore
        const __VLS_23 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
            size: (48),
            floating: (false),
        }));
        const __VLS_24 = __VLS_23({
            size: (48),
            floating: (false),
        }, ...__VLS_functionalComponentArgsRest(__VLS_23));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "empty-hint" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "suggestion-list" },
        });
        for (const [suggestion] of __VLS_getVForSourceType((__VLS_ctx.FLOATING_CHAT_CONFIG.suggestionQuestions))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.isOpen))
                            return;
                        if (!(__VLS_ctx.store.messages.length === 0))
                            return;
                        __VLS_ctx.inputQuestion = suggestion;
                    } },
                key: (suggestion),
                ...{ class: "suggestion-chip" },
            });
            (suggestion);
        }
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "messages-list" },
        });
        for (const [msg, idx] of __VLS_getVForSourceType((__VLS_ctx.store.messages))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (msg.id || idx),
                ...{ class: "msg-row" },
                ...{ class: (msg.role) },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "msg-avatar" },
            });
            if (msg.role === 'user') {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "user-avatar" },
                });
            }
            else {
                /** @type {[typeof RobotAvatar, ]} */ ;
                // @ts-ignore
                const __VLS_26 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
                    size: (32),
                    floating: (false),
                }));
                const __VLS_27 = __VLS_26({
                    size: (32),
                    floating: (false),
                }, ...__VLS_functionalComponentArgsRest(__VLS_26));
            }
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "msg-content-wrapper" },
                ...{ class: (msg.role) },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "msg-bubble" },
                ...{ class: (msg.role) },
            });
            if (msg.thinking && msg.thinking.length > 0) {
                /** @type {[typeof ThinkingBlock, ]} */ ;
                // @ts-ignore
                const __VLS_29 = __VLS_asFunctionalComponent(ThinkingBlock, new ThinkingBlock({
                    steps: (msg.thinking),
                }));
                const __VLS_30 = __VLS_29({
                    steps: (msg.thinking),
                }, ...__VLS_functionalComponentArgsRest(__VLS_29));
            }
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "msg-content markdown-body" },
            });
            __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderMarkdown(msg.content)) }, null, null);
            if (msg.followups && msg.followups.length > 0) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "msg-followups" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "followups-label" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "followups-track" },
                });
                for (const [f, i] of __VLS_getVForSourceType((msg.followups))) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                        ...{ onClick: (...[$event]) => {
                                if (!(__VLS_ctx.isOpen))
                                    return;
                                if (!!(__VLS_ctx.store.messages.length === 0))
                                    return;
                                if (!(msg.followups && msg.followups.length > 0))
                                    return;
                                __VLS_ctx.inputQuestion = f;
                            } },
                        key: (i),
                        ...{ class: "followup-chip" },
                    });
                    (f);
                }
            }
            if (__VLS_ctx.normalizeRefs(msg.refs).length > 0) {
                /** @type {[typeof RefsList, ]} */ ;
                // @ts-ignore
                const __VLS_32 = __VLS_asFunctionalComponent(RefsList, new RefsList({
                    refs: (__VLS_ctx.normalizeRefs(msg.refs)),
                }));
                const __VLS_33 = __VLS_32({
                    refs: (__VLS_ctx.normalizeRefs(msg.refs)),
                }, ...__VLS_functionalComponentArgsRest(__VLS_32));
            }
            if (msg.createdAt) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "msg-timestamp" },
                });
                (__VLS_ctx.formatTime(msg.createdAt));
            }
            /** @type {[typeof MessageToolbar, ]} */ ;
            // @ts-ignore
            const __VLS_35 = __VLS_asFunctionalComponent(MessageToolbar, new MessageToolbar({
                ...{ 'onRemove': {} },
                role: (msg.role),
                content: (msg.content),
                msgId: (msg.id),
                createdAt: (msg.createdAt),
                canRegenerate: (!__VLS_ctx.store.isLoading),
            }));
            const __VLS_36 = __VLS_35({
                ...{ 'onRemove': {} },
                role: (msg.role),
                content: (msg.content),
                msgId: (msg.id),
                createdAt: (msg.createdAt),
                canRegenerate: (!__VLS_ctx.store.isLoading),
            }, ...__VLS_functionalComponentArgsRest(__VLS_35));
            let __VLS_38;
            let __VLS_39;
            let __VLS_40;
            const __VLS_41 = {
                onRemove: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        return;
                    if (!!(__VLS_ctx.store.messages.length === 0))
                        return;
                    __VLS_ctx.handleRemoveMessage(idx);
                }
            };
            var __VLS_37;
        }
        if (__VLS_ctx.store.isLoading || __VLS_ctx.store.streamingAnswer) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "msg-row assistant" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "msg-avatar" },
            });
            /** @type {[typeof RobotAvatar, ]} */ ;
            // @ts-ignore
            const __VLS_42 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
                size: (32),
                floating: (true),
            }));
            const __VLS_43 = __VLS_42({
                size: (32),
                floating: (true),
            }, ...__VLS_functionalComponentArgsRest(__VLS_42));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "msg-bubble assistant" },
                ...{ class: ({ streaming: !!__VLS_ctx.store.streamingAnswer }) },
            });
            if (__VLS_ctx.store.currentThinking.length > 0) {
                /** @type {[typeof ThinkingBlock, ]} */ ;
                // @ts-ignore
                const __VLS_45 = __VLS_asFunctionalComponent(ThinkingBlock, new ThinkingBlock({
                    steps: (__VLS_ctx.store.currentThinking),
                }));
                const __VLS_46 = __VLS_45({
                    steps: (__VLS_ctx.store.currentThinking),
                }, ...__VLS_functionalComponentArgsRest(__VLS_45));
            }
            if (__VLS_ctx.store.isLoading && !__VLS_ctx.store.streamingAnswer && __VLS_ctx.store.currentThinking.length === 0) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "loading-dots" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "dot" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "dot" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "dot" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "loading-text" },
                });
            }
            else {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "msg-content markdown-body streaming-content" },
                });
                __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderMarkdown(__VLS_ctx.store.streamingAnswer || '')) }, null, null);
            }
        }
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "panel-input" },
    });
    const __VLS_48 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
        ...{ 'onKeydown': {} },
        modelValue: (__VLS_ctx.inputQuestion),
        type: "textarea",
        rows: (__VLS_ctx.FLOATING_CHAT_CONFIG.textarea.minRows),
        autosize: ({ minRows: __VLS_ctx.FLOATING_CHAT_CONFIG.textarea.minRows, maxRows: __VLS_ctx.FLOATING_CHAT_CONFIG.textarea.maxRows }),
        placeholder: "输入你的问题…",
        resize: "none",
        disabled: (__VLS_ctx.store.isLoading),
    }));
    const __VLS_50 = __VLS_49({
        ...{ 'onKeydown': {} },
        modelValue: (__VLS_ctx.inputQuestion),
        type: "textarea",
        rows: (__VLS_ctx.FLOATING_CHAT_CONFIG.textarea.minRows),
        autosize: ({ minRows: __VLS_ctx.FLOATING_CHAT_CONFIG.textarea.minRows, maxRows: __VLS_ctx.FLOATING_CHAT_CONFIG.textarea.maxRows }),
        placeholder: "输入你的问题…",
        resize: "none",
        disabled: (__VLS_ctx.store.isLoading),
    }, ...__VLS_functionalComponentArgsRest(__VLS_49));
    let __VLS_52;
    let __VLS_53;
    let __VLS_54;
    const __VLS_55 = {
        onKeydown: (__VLS_ctx.handleKeydown)
    };
    var __VLS_51;
    if (__VLS_ctx.store.isLoading) {
        const __VLS_56 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({
            ...{ 'onClick': {} },
            type: "danger",
            icon: (__VLS_ctx.VideoPause),
            circle: true,
            title: "停止生成",
        }));
        const __VLS_58 = __VLS_57({
            ...{ 'onClick': {} },
            type: "danger",
            icon: (__VLS_ctx.VideoPause),
            circle: true,
            title: "停止生成",
        }, ...__VLS_functionalComponentArgsRest(__VLS_57));
        let __VLS_60;
        let __VLS_61;
        let __VLS_62;
        const __VLS_63 = {
            onClick: (__VLS_ctx.handleStop)
        };
        var __VLS_59;
    }
    else {
        const __VLS_64 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({
            ...{ 'onClick': {} },
            type: "primary",
            icon: (__VLS_ctx.Promotion),
            disabled: (!__VLS_ctx.inputQuestion.trim()),
            circle: true,
            title: "发送",
        }));
        const __VLS_66 = __VLS_65({
            ...{ 'onClick': {} },
            type: "primary",
            icon: (__VLS_ctx.Promotion),
            disabled: (!__VLS_ctx.inputQuestion.trim()),
            circle: true,
            title: "发送",
        }, ...__VLS_functionalComponentArgsRest(__VLS_65));
        let __VLS_68;
        let __VLS_69;
        let __VLS_70;
        const __VLS_71 = {
            onClick: (__VLS_ctx.handleSubmit)
        };
        var __VLS_67;
    }
}
var __VLS_3;
const __VLS_72 = {}.transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.transition, typeof __VLS_components.Transition, typeof __VLS_components.transition, ]} */ ;
// @ts-ignore
const __VLS_73 = __VLS_asFunctionalComponent(__VLS_72, new __VLS_72({
    name: "float-btn",
}));
const __VLS_74 = __VLS_73({
    name: "float-btn",
}, ...__VLS_functionalComponentArgsRest(__VLS_73));
__VLS_75.slots.default;
if (!__VLS_ctx.isOpen) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.toggleOpen) },
        ...{ class: "float-btn" },
        ...{ class: ({ 'in-query': props.inQueryPage }) },
        ...{ style: ({
                width: __VLS_ctx.FLOATING_CHAT_CONFIG.floatButtonSize + 'px',
                height: __VLS_ctx.FLOATING_CHAT_CONFIG.floatButtonSize + 'px',
                '--panel-bottom': __VLS_ctx.FLOATING_CHAT_CONFIG.position.bottom + 'px',
                '--panel-right': __VLS_ctx.FLOATING_CHAT_CONFIG.position.right + 'px',
            }) },
        title: "点击展开问答面板",
    });
    /** @type {[typeof RobotAvatar, ]} */ ;
    // @ts-ignore
    const __VLS_76 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
        size: (40),
        floating: (false),
    }));
    const __VLS_77 = __VLS_76({
        size: (40),
        floating: (false),
    }, ...__VLS_functionalComponentArgsRest(__VLS_76));
}
var __VLS_75;
/** @type {__VLS_StyleScopedClasses['floating-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-header']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-messages']} */ ;
/** @type {__VLS_StyleScopedClasses['messages-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['suggestion-list']} */ ;
/** @type {__VLS_StyleScopedClasses['suggestion-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['messages-list']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-row']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
/** @type {__VLS_StyleScopedClasses['user-avatar']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-followups']} */ ;
/** @type {__VLS_StyleScopedClasses['followups-label']} */ ;
/** @type {__VLS_StyleScopedClasses['followups-track']} */ ;
/** @type {__VLS_StyleScopedClasses['followup-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-timestamp']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-row']} */ ;
/** @type {__VLS_StyleScopedClasses['assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-text']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['streaming-content']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-input']} */ ;
/** @type {__VLS_StyleScopedClasses['float-btn']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Promotion: Promotion,
            Close: Close,
            Minus: Minus,
            VideoPause: VideoPause,
            RobotAvatar: RobotAvatar,
            ThinkingBlock: ThinkingBlock,
            MessageToolbar: MessageToolbar,
            RefsList: RefsList,
            renderMarkdown: renderMarkdown,
            FLOATING_CHAT_CONFIG: FLOATING_CHAT_CONFIG,
            store: store,
            isOpen: isOpen,
            inputQuestion: inputQuestion,
            chatBodyRef: chatBodyRef,
            hasMessages: hasMessages,
            normalizeRefs: normalizeRefs,
            formatTime: formatTime,
            handleSubmit: handleSubmit,
            handleRemoveMessage: handleRemoveMessage,
            handleStop: handleStop,
            handleKeydown: handleKeydown,
            handleNewSession: handleNewSession,
            setOpen: setOpen,
            toggleOpen: toggleOpen,
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
