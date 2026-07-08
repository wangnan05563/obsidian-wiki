/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, nextTick, watch, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { Promotion, Loading } from '@element-plus/icons-vue';
import RobotAvatar from '../components/RobotAvatar.vue';
import { useQueryStore } from '../stores/query';
const store = useQueryStore();
const inputQuestion = ref('');
const chatBodyRef = ref(null);
let abortController = null;
function scrollToBottom() {
    nextTick(() => {
        if (chatBodyRef.value) {
            chatBodyRef.value.scrollTop = chatBodyRef.value.scrollHeight;
        }
    });
}
watch(() => [store.messages.length, store.streamingAnswer], scrollToBottom);
async function sendQuestion(question) {
    abortController = new AbortController();
    const history = store.messages.map((m) => ({ role: m.role, content: m.content }));
    try {
        const response = await fetch('/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, history }),
            signal: abortController.signal,
        });
        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';
            for (const evt of events) {
                const lines = evt.split('\n');
                let eventType = '';
                let data = '';
                for (const line of lines) {
                    if (line.startsWith('event: '))
                        eventType = line.slice(7);
                    if (line.startsWith('data: '))
                        data = line.slice(6);
                }
                if (!eventType || !data)
                    continue;
                try {
                    const parsed = JSON.parse(data);
                    if (eventType === 'answer') {
                        store.appendAnswer(parsed.text || '');
                    }
                    else if (eventType === 'refs') {
                        store.setRefs(parsed.refs || []);
                    }
                    else if (eventType === 'done') {
                        store.finalizeAnswer(parsed.sessionId, parsed.messageIndex);
                    }
                    else if (eventType === 'error') {
                        store.handleError(parsed.message || '问答出错');
                        ElMessage.error(parsed.message || '问答出错');
                    }
                }
                catch {
                    // 非 JSON 数据跳过
                }
            }
        }
        if (store.isLoading && store.streamingAnswer) {
            store.finalizeAnswer();
        }
    }
    catch (err) {
        if (err.name === 'AbortError')
            return;
        const msg = err.message;
        store.handleError(msg);
        ElMessage.error('问答请求失败：' + msg);
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
async function archiveMessage(idx) {
    const msg = store.messages[idx];
    if (!msg || !msg.sessionId || msg.messageIndex === undefined || msg.archived)
        return;
    try {
        const res = await fetch('/api/query/archive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: msg.sessionId, messageIndex: msg.messageIndex }),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        ElMessage.success(`已归档到 ${data.path}`);
        store.markArchived(idx);
    }
    catch (err) {
        ElMessage.error('归档失败：' + err.message);
    }
}
onBeforeUnmount(() => {
    abortController?.abort();
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['suggestion-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-row']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['input-bar']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "query-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card query-card fade-up" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "query-head" },
});
/** @type {[typeof RobotAvatar, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
    size: (60),
    floating: (__VLS_ctx.store.isLoading),
}));
const __VLS_1 = __VLS_0({
    size: (60),
    floating: (__VLS_ctx.store.isLoading),
}, ...__VLS_functionalComponentArgsRest(__VLS_0));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "head-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "head-tag" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "head-title grad-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "head-tip" },
});
if (__VLS_ctx.store.messages.length > 0) {
    const __VLS_3 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_4 = __VLS_asFunctionalComponent(__VLS_3, new __VLS_3({
        ...{ 'onClick': {} },
        size: "small",
    }));
    const __VLS_5 = __VLS_4({
        ...{ 'onClick': {} },
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_4));
    let __VLS_7;
    let __VLS_8;
    let __VLS_9;
    const __VLS_10 = {
        onClick: (__VLS_ctx.handleNewSession)
    };
    __VLS_6.slots.default;
    var __VLS_6;
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ref: "chatBodyRef",
    ...{ class: "chat-body" },
});
/** @type {typeof __VLS_ctx.chatBodyRef} */ ;
if (__VLS_ctx.store.messages.length === 0 && !__VLS_ctx.store.streamingAnswer) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "chat-empty" },
    });
    /** @type {[typeof RobotAvatar, ]} */ ;
    // @ts-ignore
    const __VLS_11 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
        size: (120),
        floating: (true),
    }));
    const __VLS_12 = __VLS_11({
        size: (120),
        floating: (true),
    }, ...__VLS_functionalComponentArgsRest(__VLS_11));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "empty-tip" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-suggestions" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.store.messages.length === 0 && !__VLS_ctx.store.streamingAnswer))
                    return;
                __VLS_ctx.inputQuestion = '什么是 LLM Wiki？';
            } },
        ...{ class: "suggestion-chip" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.store.messages.length === 0 && !__VLS_ctx.store.streamingAnswer))
                    return;
                __VLS_ctx.inputQuestion = '知识库中有哪些页面？';
            } },
        ...{ class: "suggestion-chip" },
    });
}
for (const [msg, idx] of __VLS_getVForSourceType((__VLS_ctx.store.messages))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-row" },
        ...{ class: (msg.role) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-avatar" },
    });
    if (msg.role === 'assistant') {
        /** @type {[typeof RobotAvatar, ]} */ ;
        // @ts-ignore
        const __VLS_14 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
            size: (36),
        }));
        const __VLS_15 = __VLS_14({
            size: (36),
        }, ...__VLS_functionalComponentArgsRest(__VLS_14));
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "user-avatar" },
        });
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-bubble" },
        ...{ class: (msg.role) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-content" },
    });
    (msg.content);
    if (msg.refs && msg.refs.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "msg-refs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "refs-label" },
        });
        for (const [r] of __VLS_getVForSourceType((msg.refs))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                key: (r),
                ...{ class: "ref-chip" },
            });
            (r);
        }
    }
    if (msg.role === 'assistant' && msg.sessionId) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "msg-actions" },
        });
        const __VLS_17 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_18 = __VLS_asFunctionalComponent(__VLS_17, new __VLS_17({
            ...{ 'onClick': {} },
            size: "small",
            text: true,
            disabled: (msg.archived),
        }));
        const __VLS_19 = __VLS_18({
            ...{ 'onClick': {} },
            size: "small",
            text: true,
            disabled: (msg.archived),
        }, ...__VLS_functionalComponentArgsRest(__VLS_18));
        let __VLS_21;
        let __VLS_22;
        let __VLS_23;
        const __VLS_24 = {
            onClick: (...[$event]) => {
                if (!(msg.role === 'assistant' && msg.sessionId))
                    return;
                __VLS_ctx.archiveMessage(idx);
            }
        };
        __VLS_20.slots.default;
        (msg.archived ? '已归档' : '归档');
        var __VLS_20;
    }
}
if (__VLS_ctx.store.streamingAnswer) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-row assistant" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-avatar" },
    });
    /** @type {[typeof RobotAvatar, ]} */ ;
    // @ts-ignore
    const __VLS_25 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
        size: (36),
    }));
    const __VLS_26 = __VLS_25({
        size: (36),
    }, ...__VLS_functionalComponentArgsRest(__VLS_25));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-bubble assistant streaming" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-content" },
    });
    (__VLS_ctx.store.streamingAnswer);
    if (__VLS_ctx.store.currentRefs.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "msg-refs" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "refs-label" },
        });
        for (const [r] of __VLS_getVForSourceType((__VLS_ctx.store.currentRefs))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                key: (r),
                ...{ class: "ref-chip" },
            });
            (r);
        }
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "input-bar" },
});
const __VLS_28 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
    ...{ 'onKeydown': {} },
    modelValue: (__VLS_ctx.inputQuestion),
    type: "textarea",
    rows: (2),
    placeholder: "输入问题，Ctrl+Enter 发送…",
    resize: "none",
    disabled: (__VLS_ctx.store.isLoading),
}));
const __VLS_30 = __VLS_29({
    ...{ 'onKeydown': {} },
    modelValue: (__VLS_ctx.inputQuestion),
    type: "textarea",
    rows: (2),
    placeholder: "输入问题，Ctrl+Enter 发送…",
    resize: "none",
    disabled: (__VLS_ctx.store.isLoading),
}, ...__VLS_functionalComponentArgsRest(__VLS_29));
let __VLS_32;
let __VLS_33;
let __VLS_34;
const __VLS_35 = {
    onKeydown: (__VLS_ctx.handleKeydown)
};
var __VLS_31;
const __VLS_36 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
    ...{ 'onClick': {} },
    type: "primary",
    size: "large",
    disabled: (!__VLS_ctx.inputQuestion.trim() || __VLS_ctx.store.isLoading),
}));
const __VLS_38 = __VLS_37({
    ...{ 'onClick': {} },
    type: "primary",
    size: "large",
    disabled: (!__VLS_ctx.inputQuestion.trim() || __VLS_ctx.store.isLoading),
}, ...__VLS_functionalComponentArgsRest(__VLS_37));
let __VLS_40;
let __VLS_41;
let __VLS_42;
const __VLS_43 = {
    onClick: (__VLS_ctx.handleSubmit)
};
__VLS_39.slots.default;
if (__VLS_ctx.store.isLoading) {
    const __VLS_44 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
        ...{ class: "spin-icon" },
    }));
    const __VLS_46 = __VLS_45({
        ...{ class: "spin-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_45));
    __VLS_47.slots.default;
    const __VLS_48 = {}.Loading;
    /** @type {[typeof __VLS_components.Loading, ]} */ ;
    // @ts-ignore
    const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({}));
    const __VLS_50 = __VLS_49({}, ...__VLS_functionalComponentArgsRest(__VLS_49));
    var __VLS_47;
}
else {
    const __VLS_52 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({}));
    const __VLS_54 = __VLS_53({}, ...__VLS_functionalComponentArgsRest(__VLS_53));
    __VLS_55.slots.default;
    const __VLS_56 = {}.Promotion;
    /** @type {[typeof __VLS_components.Promotion, ]} */ ;
    // @ts-ignore
    const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({}));
    const __VLS_58 = __VLS_57({}, ...__VLS_functionalComponentArgsRest(__VLS_57));
    var __VLS_55;
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
(__VLS_ctx.store.isLoading ? '回答中' : '发送');
var __VLS_39;
/** @type {__VLS_StyleScopedClasses['query-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['query-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['query-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-body']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-suggestions']} */ ;
/** @type {__VLS_StyleScopedClasses['suggestion-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['suggestion-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-row']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
/** @type {__VLS_StyleScopedClasses['user-avatar']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-refs']} */ ;
/** @type {__VLS_StyleScopedClasses['refs-label']} */ ;
/** @type {__VLS_StyleScopedClasses['ref-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-row']} */ ;
/** @type {__VLS_StyleScopedClasses['assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['streaming']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-refs']} */ ;
/** @type {__VLS_StyleScopedClasses['refs-label']} */ ;
/** @type {__VLS_StyleScopedClasses['ref-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['input-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['spin-icon']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Promotion: Promotion,
            Loading: Loading,
            RobotAvatar: RobotAvatar,
            store: store,
            inputQuestion: inputQuestion,
            chatBodyRef: chatBodyRef,
            handleSubmit: handleSubmit,
            handleKeydown: handleKeydown,
            handleNewSession: handleNewSession,
            archiveMessage: archiveMessage,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
