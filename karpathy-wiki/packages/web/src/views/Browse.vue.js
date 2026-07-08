/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, onMounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import RobotAvatar from '../components/RobotAvatar.vue';
const treeData = ref([]);
const currentNode = ref('');
const fileContent = ref(null);
const loading = ref(false);
const editing = ref(false);
const editBuffer = ref('');
const searchQuery = ref('');
const searchHits = ref([]);
const searching = ref(false);
const showSearchResults = ref(false);
const treeProps = {
    label: 'name',
    children: 'children',
};
async function loadTree() {
    try {
        const res = await fetch('/api/files/tree');
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        treeData.value = data.tree ?? [];
    }
    catch (err) {
        ElMessage.error('加载目录树失败：' + err.message);
    }
}
async function doSearch() {
    const q = searchQuery.value.trim();
    if (!q) {
        showSearchResults.value = false;
        searchHits.value = [];
        return;
    }
    searching.value = true;
    showSearchResults.value = true;
    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        searchHits.value = data.hits ?? [];
    }
    catch (err) {
        ElMessage.error('搜索失败：' + err.message);
        searchHits.value = [];
    }
    finally {
        searching.value = false;
    }
}
function clearSearch() {
    searchQuery.value = '';
    searchHits.value = [];
    showSearchResults.value = false;
}
async function handleSearchHit(hit) {
    currentNode.value = hit.path;
    editing.value = false;
    loading.value = true;
    try {
        const res = await fetch(`/api/files?path=${encodeURIComponent(hit.path)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        fileContent.value = await res.json();
        editBuffer.value = fileContent.value?.content ?? '';
    }
    catch (err) {
        ElMessage.error('读取文件失败：' + err.message);
        fileContent.value = null;
    }
    finally {
        loading.value = false;
    }
}
async function handleNodeClick(node) {
    if (node.type !== 'file')
        return;
    currentNode.value = node.path;
    editing.value = false;
    loading.value = true;
    try {
        const res = await fetch(`/api/files?path=${encodeURIComponent(node.path)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        fileContent.value = await res.json();
        editBuffer.value = fileContent.value?.content ?? '';
    }
    catch (err) {
        ElMessage.error('读取文件失败：' + err.message);
        fileContent.value = null;
    }
    finally {
        loading.value = false;
    }
}
function startEdit() {
    if (!fileContent.value)
        return;
    editBuffer.value = fileContent.value.content;
    editing.value = true;
}
function cancelEdit() {
    editing.value = false;
    editBuffer.value = '';
}
async function saveEdit() {
    if (!currentNode.value)
        return;
    try {
        const res = await fetch(`/api/files?path=${encodeURIComponent(currentNode.value)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: editBuffer.value }),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        ElMessage.success('保存成功');
        editing.value = false;
        await handleNodeClick({ path: currentNode.value, name: '', type: 'file' });
    }
    catch (err) {
        ElMessage.error('保存失败：' + err.message);
    }
}
function renderMarkdown(md) {
    if (!md)
        return '';
    let html = md
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">[[$1]]</span>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
    html = html.split(/\n\n+/).map((block) => {
        if (/^<(h\d|ul|pre|li)/.test(block.trim()))
            return block;
        if (!block.trim())
            return '';
        return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');
    return html;
}
onMounted(() => {
    loadTree();
});
watch(fileContent, () => {
    // 触发响应式更新
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['search-hit-item']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-node']} */ ;
/** @type {__VLS_StyleScopedClasses['fm-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['editor-area']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "browse-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card browse-card fade-up" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "browse-head" },
});
/** @type {[typeof RobotAvatar, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
    size: (52),
}));
const __VLS_1 = __VLS_0({
    size: (52),
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
    onClick: (__VLS_ctx.loadTree)
};
__VLS_6.slots.default;
var __VLS_6;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "browse-body" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "tree-panel" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "search-box" },
});
const __VLS_11 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_12 = __VLS_asFunctionalComponent(__VLS_11, new __VLS_11({
    ...{ 'onKeyup': {} },
    ...{ 'onClear': {} },
    modelValue: (__VLS_ctx.searchQuery),
    placeholder: "搜索知识库…",
    size: "small",
    prefixIcon: (__VLS_ctx.Search),
    clearable: true,
}));
const __VLS_13 = __VLS_12({
    ...{ 'onKeyup': {} },
    ...{ 'onClear': {} },
    modelValue: (__VLS_ctx.searchQuery),
    placeholder: "搜索知识库…",
    size: "small",
    prefixIcon: (__VLS_ctx.Search),
    clearable: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_12));
let __VLS_15;
let __VLS_16;
let __VLS_17;
const __VLS_18 = {
    onKeyup: (__VLS_ctx.doSearch)
};
const __VLS_19 = {
    onClear: (__VLS_ctx.clearSearch)
};
var __VLS_14;
if (__VLS_ctx.showSearchResults) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "search-results" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "search-header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "search-count" },
    });
    (__VLS_ctx.searchHits.length);
    const __VLS_20 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
        ...{ 'onClick': {} },
        size: "small",
        text: true,
    }));
    const __VLS_22 = __VLS_21({
        ...{ 'onClick': {} },
        size: "small",
        text: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_21));
    let __VLS_24;
    let __VLS_25;
    let __VLS_26;
    const __VLS_27 = {
        onClick: (__VLS_ctx.clearSearch)
    };
    __VLS_23.slots.default;
    var __VLS_23;
    if (__VLS_ctx.searching) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "search-loading" },
        });
    }
    else if (__VLS_ctx.searchHits.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "search-empty" },
        });
    }
    for (const [hit] of __VLS_getVForSourceType((__VLS_ctx.searchHits))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.showSearchResults))
                        return;
                    __VLS_ctx.handleSearchHit(hit);
                } },
            key: (hit.path),
            ...{ class: "search-hit-item hover-glow" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "hit-title" },
        });
        (hit.title);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "hit-path" },
        });
        (hit.path);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "hit-snippet" },
        });
        (hit.snippet);
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "panel-title" },
    });
    const __VLS_28 = {}.ElTree;
    /** @type {[typeof __VLS_components.ElTree, typeof __VLS_components.elTree, typeof __VLS_components.ElTree, typeof __VLS_components.elTree, ]} */ ;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
        ...{ 'onNodeClick': {} },
        data: (__VLS_ctx.treeData),
        props: (__VLS_ctx.treeProps),
        nodeKey: "path",
        defaultExpandAll: (false),
        expandOnClickNode: (true),
        highlightCurrent: (true),
    }));
    const __VLS_30 = __VLS_29({
        ...{ 'onNodeClick': {} },
        data: (__VLS_ctx.treeData),
        props: (__VLS_ctx.treeProps),
        nodeKey: "path",
        defaultExpandAll: (false),
        expandOnClickNode: (true),
        highlightCurrent: (true),
    }, ...__VLS_functionalComponentArgsRest(__VLS_29));
    let __VLS_32;
    let __VLS_33;
    let __VLS_34;
    const __VLS_35 = {
        onNodeClick: (__VLS_ctx.handleNodeClick)
    };
    __VLS_31.slots.default;
    {
        const { default: __VLS_thisSlot } = __VLS_31.slots;
        const [{ data }] = __VLS_getSlotParams(__VLS_thisSlot);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "tree-node" },
            ...{ class: ({ 'is-file': data.type === 'file' }) },
        });
        if (data.type === 'dir') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "file-icon" },
            });
        }
        (data.name);
    }
    var __VLS_31;
    if (__VLS_ctx.treeData.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "tree-empty" },
        });
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "content-panel" },
});
if (__VLS_ctx.loading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "content-loading" },
    });
    /** @type {[typeof RobotAvatar, ]} */ ;
    // @ts-ignore
    const __VLS_36 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
        size: (80),
        floating: (true),
    }));
    const __VLS_37 = __VLS_36({
        size: (80),
        floating: (true),
    }, ...__VLS_functionalComponentArgsRest(__VLS_36));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
}
else if (!__VLS_ctx.fileContent) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "content-empty" },
    });
    /** @type {[typeof RobotAvatar, ]} */ ;
    // @ts-ignore
    const __VLS_39 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
        size: (120),
        floating: (true),
    }));
    const __VLS_40 = __VLS_39({
        size: (120),
        floating: (true),
    }, ...__VLS_functionalComponentArgsRest(__VLS_39));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "empty-tip" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "content-show" },
    });
    if (__VLS_ctx.fileContent.frontmatter && Object.keys(__VLS_ctx.fileContent.frontmatter).length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "frontmatter-bar" },
        });
        for (const [val, key] of __VLS_getVForSourceType((__VLS_ctx.fileContent.frontmatter))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                key: (key),
                ...{ class: "fm-chip" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
            (key);
            (String(val));
        }
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "action-bar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "current-path" },
    });
    (__VLS_ctx.currentNode);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "actions" },
    });
    if (!__VLS_ctx.editing) {
        const __VLS_42 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_43 = __VLS_asFunctionalComponent(__VLS_42, new __VLS_42({
            ...{ 'onClick': {} },
            size: "small",
        }));
        const __VLS_44 = __VLS_43({
            ...{ 'onClick': {} },
            size: "small",
        }, ...__VLS_functionalComponentArgsRest(__VLS_43));
        let __VLS_46;
        let __VLS_47;
        let __VLS_48;
        const __VLS_49 = {
            onClick: (__VLS_ctx.startEdit)
        };
        __VLS_45.slots.default;
        var __VLS_45;
    }
    else {
        const __VLS_50 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_51 = __VLS_asFunctionalComponent(__VLS_50, new __VLS_50({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
        }));
        const __VLS_52 = __VLS_51({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
        }, ...__VLS_functionalComponentArgsRest(__VLS_51));
        let __VLS_54;
        let __VLS_55;
        let __VLS_56;
        const __VLS_57 = {
            onClick: (__VLS_ctx.saveEdit)
        };
        __VLS_53.slots.default;
        var __VLS_53;
        const __VLS_58 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_59 = __VLS_asFunctionalComponent(__VLS_58, new __VLS_58({
            ...{ 'onClick': {} },
            size: "small",
        }));
        const __VLS_60 = __VLS_59({
            ...{ 'onClick': {} },
            size: "small",
        }, ...__VLS_functionalComponentArgsRest(__VLS_59));
        let __VLS_62;
        let __VLS_63;
        let __VLS_64;
        const __VLS_65 = {
            onClick: (__VLS_ctx.cancelEdit)
        };
        __VLS_61.slots.default;
        var __VLS_61;
    }
    if (__VLS_ctx.editing) {
        const __VLS_66 = {}.ElInput;
        /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
        // @ts-ignore
        const __VLS_67 = __VLS_asFunctionalComponent(__VLS_66, new __VLS_66({
            modelValue: (__VLS_ctx.editBuffer),
            type: "textarea",
            rows: (20),
            resize: "none",
            ...{ class: "editor-area" },
        }));
        const __VLS_68 = __VLS_67({
            modelValue: (__VLS_ctx.editBuffer),
            type: "textarea",
            rows: (20),
            resize: "none",
            ...{ class: "editor-area" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_67));
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "markdown-body" },
        });
        __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderMarkdown(__VLS_ctx.fileContent.body)) }, null, null);
    }
}
/** @type {__VLS_StyleScopedClasses['browse-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['browse-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['browse-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['browse-body']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['search-box']} */ ;
/** @type {__VLS_StyleScopedClasses['search-results']} */ ;
/** @type {__VLS_StyleScopedClasses['search-header']} */ ;
/** @type {__VLS_StyleScopedClasses['search-count']} */ ;
/** @type {__VLS_StyleScopedClasses['search-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['search-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['search-hit-item']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['hit-title']} */ ;
/** @type {__VLS_StyleScopedClasses['hit-path']} */ ;
/** @type {__VLS_StyleScopedClasses['hit-snippet']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-node']} */ ;
/** @type {__VLS_StyleScopedClasses['file-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['content-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['content-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['content-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['content-show']} */ ;
/** @type {__VLS_StyleScopedClasses['frontmatter-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['fm-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['action-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['current-path']} */ ;
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
/** @type {__VLS_StyleScopedClasses['editor-area']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Search: Search,
            RobotAvatar: RobotAvatar,
            treeData: treeData,
            currentNode: currentNode,
            fileContent: fileContent,
            loading: loading,
            editing: editing,
            editBuffer: editBuffer,
            searchQuery: searchQuery,
            searchHits: searchHits,
            searching: searching,
            showSearchResults: showSearchResults,
            treeProps: treeProps,
            loadTree: loadTree,
            doSearch: doSearch,
            clearSearch: clearSearch,
            handleSearchHit: handleSearchHit,
            handleNodeClick: handleNodeClick,
            startEdit: startEdit,
            cancelEdit: cancelEdit,
            saveEdit: saveEdit,
            renderMarkdown: renderMarkdown,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
