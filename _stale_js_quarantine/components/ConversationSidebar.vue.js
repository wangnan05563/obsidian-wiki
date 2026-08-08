import { computed } from 'vue';
import { ElMessageBox, ElMessage } from 'element-plus';
import { Top, Edit, Delete, ArrowLeft, Plus } from '@element-plus/icons-vue';
import { useConversationsStore } from '../stores/conversations';
const props = defineProps();
const emit = defineEmits();
const store = useConversationsStore();
// 过滤 + 排序：置顶在前，然后按 updatedAt 倒序
const sortedConversations = computed(() => {
    const filtered = store.searchKeyword
        ? store.conversations.filter((conversation) => conversation.title.includes(store.searchKeyword))
        : store.conversations;
    return [...filtered].sort((a, b) => {
        if (a.isPinned !== b.isPinned)
            return a.isPinned ? -1 : 1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
});
function formatTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000)
        return '刚刚';
    if (diff < 3600000)
        return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000)
        return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 604800000)
        return `${Math.floor(diff / 86400000)} 天前`;
    return d.toLocaleDateString();
}
function handlePin(e, id) {
    e.stopPropagation();
    store.togglePin(id);
}
// F-3.3 重命名：弹出输入对话框，调用 store.renameConversation
// 为什么用 ElMessageBox.prompt 而非 inline input：重命名是低频操作，弹窗更聚焦
async function handleRename(e, conv) {
    e.stopPropagation();
    try {
        const { value } = await ElMessageBox.prompt('请输入新的对话标题', '重命名对话', {
            inputValue: conv.title,
            inputPattern: /\S+/,
            inputErrorMessage: '标题不能为空',
            confirmButtonText: '确定',
            cancelButtonText: '取消',
        });
        if (value && value !== conv.title) {
            await store.renameConversation(conv.id, value.trim());
            ElMessage.success('已重命名');
        }
    }
    catch {
        // 用户取消，不报错
    }
}
// F-3.3 删除：二次确认避免误删，调用 store.deleteConversation
async function handleDelete(e, conv) {
    e.stopPropagation();
    try {
        await ElMessageBox.confirm(`确定删除对话「${conv.title}」吗？此操作不可撤销。`, '删除对话', {
            confirmButtonText: '删除',
            cancelButtonText: '取消',
            type: 'warning',
        });
        await store.deleteConversation(conv.id);
        ElMessage.success('已删除');
    }
    catch {
        // 用户取消
    }
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['conversation-sidebar']} */ ;
/** @type {__VLS_StyleScopedClasses['conversation-sidebar']} */ ;
/** @type {__VLS_StyleScopedClasses['new-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['search-input']} */ ;
/** @type {__VLS_StyleScopedClasses['conversation-item']} */ ;
/** @type {__VLS_StyleScopedClasses['conversation-item']} */ ;
/** @type {__VLS_StyleScopedClasses['conversation-item']} */ ;
/** @type {__VLS_StyleScopedClasses['conv-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['conv-action-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['collapse-btn']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.aside, __VLS_intrinsicElements.aside)({
    ...{ class: "conversation-sidebar" },
    ...{ class: ({
            expanded: __VLS_ctx.state === 'expanded',
            hidden: __VLS_ctx.state === 'hidden'
        }) },
});
if (__VLS_ctx.state === 'expanded') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "sidebar-header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.state === 'expanded'))
                    return;
                __VLS_ctx.emit('newSession');
            } },
        ...{ class: "new-btn" },
    });
    const __VLS_0 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({}));
    const __VLS_2 = __VLS_1({}, ...__VLS_functionalComponentArgsRest(__VLS_1));
    __VLS_3.slots.default;
    const __VLS_4 = {}.Plus;
    /** @type {[typeof __VLS_components.Plus, ]} */ ;
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
    const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
    var __VLS_3;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        ...{ class: "search-input" },
        placeholder: "搜索对话...",
    });
    (__VLS_ctx.store.searchKeyword);
}
if (__VLS_ctx.state === 'expanded') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "conversation-list" },
    });
    for (const [conv] of __VLS_getVForSourceType((__VLS_ctx.sortedConversations))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.state === 'expanded'))
                        return;
                    __VLS_ctx.emit('select', conv.id);
                } },
            key: (conv.id),
            ...{ class: "conversation-item" },
            ...{ class: ({ active: conv.id === __VLS_ctx.store.currentConversationId }) },
        });
        if (conv.isPinned) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ onClick: ((e) => __VLS_ctx.handlePin(e, conv.id)) },
                ...{ class: "pin-icon" },
            });
            const __VLS_8 = {}.ElIcon;
            /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
            // @ts-ignore
            const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({}));
            const __VLS_10 = __VLS_9({}, ...__VLS_functionalComponentArgsRest(__VLS_9));
            __VLS_11.slots.default;
            const __VLS_12 = {}.Top;
            /** @type {[typeof __VLS_components.Top, ]} */ ;
            // @ts-ignore
            const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({}));
            const __VLS_14 = __VLS_13({}, ...__VLS_functionalComponentArgsRest(__VLS_13));
            var __VLS_11;
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "conv-info" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "conv-title" },
        });
        (conv.title);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "conv-time" },
        });
        (__VLS_ctx.formatTime(conv.updatedAt));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onClick: () => { } },
            ...{ class: "conv-actions" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: ((e) => __VLS_ctx.handleRename(e, conv)) },
            ...{ class: "conv-action-btn rename-btn" },
            title: "重命名",
        });
        const __VLS_16 = {}.ElIcon;
        /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
        // @ts-ignore
        const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({}));
        const __VLS_18 = __VLS_17({}, ...__VLS_functionalComponentArgsRest(__VLS_17));
        __VLS_19.slots.default;
        const __VLS_20 = {}.Edit;
        /** @type {[typeof __VLS_components.Edit, ]} */ ;
        // @ts-ignore
        const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({}));
        const __VLS_22 = __VLS_21({}, ...__VLS_functionalComponentArgsRest(__VLS_21));
        var __VLS_19;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: ((e) => __VLS_ctx.handleDelete(e, conv)) },
            ...{ class: "conv-action-btn delete-btn" },
            title: "删除",
        });
        const __VLS_24 = {}.ElIcon;
        /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
        // @ts-ignore
        const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({}));
        const __VLS_26 = __VLS_25({}, ...__VLS_functionalComponentArgsRest(__VLS_25));
        __VLS_27.slots.default;
        const __VLS_28 = {}.Delete;
        /** @type {[typeof __VLS_components.Delete, ]} */ ;
        // @ts-ignore
        const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({}));
        const __VLS_30 = __VLS_29({}, ...__VLS_functionalComponentArgsRest(__VLS_29));
        var __VLS_27;
    }
    if (__VLS_ctx.sortedConversations.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "empty-hint" },
        });
    }
}
if (__VLS_ctx.state !== 'hidden') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.state !== 'hidden'))
                    return;
                __VLS_ctx.emit('toggle');
            } },
        ...{ class: "collapse-btn" },
        title: "折叠（Ctrl+B）",
    });
    const __VLS_32 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({}));
    const __VLS_34 = __VLS_33({}, ...__VLS_functionalComponentArgsRest(__VLS_33));
    __VLS_35.slots.default;
    const __VLS_36 = {}.ArrowLeft;
    /** @type {[typeof __VLS_components.ArrowLeft, ]} */ ;
    // @ts-ignore
    const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({}));
    const __VLS_38 = __VLS_37({}, ...__VLS_functionalComponentArgsRest(__VLS_37));
    var __VLS_35;
}
/** @type {__VLS_StyleScopedClasses['conversation-sidebar']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar-header']} */ ;
/** @type {__VLS_StyleScopedClasses['new-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['search-input']} */ ;
/** @type {__VLS_StyleScopedClasses['conversation-list']} */ ;
/** @type {__VLS_StyleScopedClasses['conversation-item']} */ ;
/** @type {__VLS_StyleScopedClasses['pin-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['conv-info']} */ ;
/** @type {__VLS_StyleScopedClasses['conv-title']} */ ;
/** @type {__VLS_StyleScopedClasses['conv-time']} */ ;
/** @type {__VLS_StyleScopedClasses['conv-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['conv-action-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['rename-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['conv-action-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['delete-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['collapse-btn']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Top: Top,
            Edit: Edit,
            Delete: Delete,
            ArrowLeft: ArrowLeft,
            Plus: Plus,
            emit: emit,
            store: store,
            sortedConversations: sortedConversations,
            formatTime: formatTime,
            handlePin: handlePin,
            handleRename: handleRename,
            handleDelete: handleDelete,
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
