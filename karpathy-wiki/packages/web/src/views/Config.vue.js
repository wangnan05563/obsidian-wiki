/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import RobotAvatar from '../components/RobotAvatar.vue';
const activeTab = ref('schema');
const config = ref(null);
const schemaContent = ref('');
const schemaBuffer = ref('');
const editingSchema = ref(false);
const loadingSchema = ref(false);
const loadingConfig = ref(false);
const savingSchema = ref(false);
// §12.3-7 热加载状态
const reloading = ref(false);
const reloadResult = ref(null);
// §6.X SCHEMA 版本历史
const commits = ref([]);
const gitEnabled = ref(false);
const loadingHistory = ref(false);
// 选中的对比基线 commit hash
const selectedFrom = ref('');
// diff 结果
const diffLines = ref([]);
const loadingDiff = ref(false);
const showDiff = ref(false);
// 加载 SCHEMA.md
async function loadSchema() {
    loadingSchema.value = true;
    try {
        const res = await fetch('/api/schema');
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        schemaContent.value = data.content;
        schemaBuffer.value = data.content;
    }
    catch (err) {
        ElMessage.error('加载 SCHEMA 失败：' + err.message);
    }
    finally {
        loadingSchema.value = false;
    }
}
// §6.X 加载 SCHEMA 版本历史（git log）
async function loadHistory() {
    loadingHistory.value = true;
    try {
        const res = await fetch('/api/schema/history');
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        commits.value = data.commits ?? [];
        gitEnabled.value = data.gitEnabled ?? false;
    }
    catch (err) {
        ElMessage.error('加载版本历史失败：' + err.message);
    }
    finally {
        loadingHistory.value = false;
    }
}
// §6.X 加载版本对比（git diff）
async function loadDiff() {
    if (!selectedFrom.value)
        return;
    loadingDiff.value = true;
    showDiff.value = true;
    try {
        const res = await fetch(`/api/schema/diff?from=${encodeURIComponent(selectedFrom.value)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        diffLines.value = data.lines ?? [];
    }
    catch (err) {
        ElMessage.error('加载版本对比失败：' + err.message);
        diffLines.value = [];
    }
    finally {
        loadingDiff.value = false;
    }
}
// 保存 SCHEMA.md
async function saveSchema() {
    savingSchema.value = true;
    try {
        const res = await fetch('/api/schema', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: schemaBuffer.value }),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        ElMessage.success('SCHEMA 保存成功，下次编译/问答将使用新规范');
        schemaContent.value = schemaBuffer.value;
        editingSchema.value = false;
        // 保存后刷新版本历史
        await loadHistory();
    }
    catch (err) {
        ElMessage.error('保存失败：' + err.message);
    }
    finally {
        savingSchema.value = false;
    }
}
// 取消编辑
function cancelEdit() {
    schemaBuffer.value = schemaContent.value;
    editingSchema.value = false;
}
// 加载配置
async function loadConfig() {
    loadingConfig.value = true;
    try {
        const res = await fetch('/api/config');
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        config.value = await res.json();
    }
    catch (err) {
        ElMessage.error('加载配置失败：' + err.message);
    }
    finally {
        loadingConfig.value = false;
    }
}
// provider 中文名
const PROVIDER_LABELS = {
    glm: '智谱 GLM',
    qwen: '通义千问',
    deepseek: 'DeepSeek',
};
// §12.3-7 热加载：重读 config.json 并即时应用到运行中的 adapter。
// 仅 model/budget/staleDays 即时生效，adapter/vaultPath/server 需重启进程。
async function reloadConfig() {
    reloading.value = true;
    try {
        const res = await fetch('/api/config/reload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        reloadResult.value = await res.json();
        ElMessage.success('配置已热加载');
        // 刷新展示，让用户看到应用后的值
        await loadConfig();
    }
    catch (err) {
        ElMessage.error('热加载失败：' + err.message);
    }
    finally {
        reloading.value = false;
    }
}
onMounted(() => {
    loadSchema();
    loadConfig();
    loadHistory();
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['config-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['config-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['el-tabs__item']} */ ;
/** @type {__VLS_StyleScopedClasses['config-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['config-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['is-disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['schema-editor']} */ ;
/** @type {__VLS_StyleScopedClasses['el-textarea__inner']} */ ;
/** @type {__VLS_StyleScopedClasses['key-status']} */ ;
/** @type {__VLS_StyleScopedClasses['key-status']} */ ;
/** @type {__VLS_StyleScopedClasses['warning-text']} */ ;
/** @type {__VLS_StyleScopedClasses['warning-text']} */ ;
/** @type {__VLS_StyleScopedClasses['reload-applied']} */ ;
/** @type {__VLS_StyleScopedClasses['history-disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-item']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-item']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line']} */ ;
/** @type {__VLS_StyleScopedClasses['add']} */ ;
/** @type {__VLS_StyleScopedClasses['line-prefix']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line']} */ ;
/** @type {__VLS_StyleScopedClasses['del']} */ ;
/** @type {__VLS_StyleScopedClasses['line-prefix']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card config-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-head" },
});
/** @type {[typeof RobotAvatar, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
    size: (56),
}));
const __VLS_1 = __VLS_0({
    size: (56),
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
const __VLS_3 = {}.ElTabs;
/** @type {[typeof __VLS_components.ElTabs, typeof __VLS_components.elTabs, typeof __VLS_components.ElTabs, typeof __VLS_components.elTabs, ]} */ ;
// @ts-ignore
const __VLS_4 = __VLS_asFunctionalComponent(__VLS_3, new __VLS_3({
    modelValue: (__VLS_ctx.activeTab),
    ...{ class: "config-tabs" },
}));
const __VLS_5 = __VLS_4({
    modelValue: (__VLS_ctx.activeTab),
    ...{ class: "config-tabs" },
}, ...__VLS_functionalComponentArgsRest(__VLS_4));
__VLS_6.slots.default;
const __VLS_7 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_8 = __VLS_asFunctionalComponent(__VLS_7, new __VLS_7({
    label: "SCHEMA 规范",
    name: "schema",
}));
const __VLS_9 = __VLS_8({
    label: "SCHEMA 规范",
    name: "schema",
}, ...__VLS_functionalComponentArgsRest(__VLS_8));
__VLS_10.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "schema-section" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "action-bar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "actions" },
});
if (!__VLS_ctx.editingSchema) {
    const __VLS_11 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_12 = __VLS_asFunctionalComponent(__VLS_11, new __VLS_11({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn" },
    }));
    const __VLS_13 = __VLS_12({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_12));
    let __VLS_15;
    let __VLS_16;
    let __VLS_17;
    const __VLS_18 = {
        onClick: (...[$event]) => {
            if (!(!__VLS_ctx.editingSchema))
                return;
            __VLS_ctx.editingSchema = true;
        }
    };
    __VLS_14.slots.default;
    var __VLS_14;
}
else {
    const __VLS_19 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_20 = __VLS_asFunctionalComponent(__VLS_19, new __VLS_19({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn-primary" },
        loading: (__VLS_ctx.savingSchema),
    }));
    const __VLS_21 = __VLS_20({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn-primary" },
        loading: (__VLS_ctx.savingSchema),
    }, ...__VLS_functionalComponentArgsRest(__VLS_20));
    let __VLS_23;
    let __VLS_24;
    let __VLS_25;
    const __VLS_26 = {
        onClick: (__VLS_ctx.saveSchema)
    };
    __VLS_22.slots.default;
    var __VLS_22;
    const __VLS_27 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_28 = __VLS_asFunctionalComponent(__VLS_27, new __VLS_27({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn" },
    }));
    const __VLS_29 = __VLS_28({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_28));
    let __VLS_31;
    let __VLS_32;
    let __VLS_33;
    const __VLS_34 = {
        onClick: (__VLS_ctx.cancelEdit)
    };
    __VLS_30.slots.default;
    var __VLS_30;
}
if (__VLS_ctx.loadingSchema) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-loading" },
    });
}
else if (__VLS_ctx.editingSchema) {
    const __VLS_35 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_36 = __VLS_asFunctionalComponent(__VLS_35, new __VLS_35({
        modelValue: (__VLS_ctx.schemaBuffer),
        type: "textarea",
        rows: (24),
        resize: "none",
        ...{ class: "schema-editor" },
    }));
    const __VLS_37 = __VLS_36({
        modelValue: (__VLS_ctx.schemaBuffer),
        type: "textarea",
        rows: (24),
        resize: "none",
        ...{ class: "schema-editor" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_36));
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({
        ...{ class: "schema-view" },
    });
    (__VLS_ctx.schemaContent);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "history-section" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "history-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
const __VLS_39 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_40 = __VLS_asFunctionalComponent(__VLS_39, new __VLS_39({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    text: true,
    loading: (__VLS_ctx.loadingHistory),
}));
const __VLS_41 = __VLS_40({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    text: true,
    loading: (__VLS_ctx.loadingHistory),
}, ...__VLS_functionalComponentArgsRest(__VLS_40));
let __VLS_43;
let __VLS_44;
let __VLS_45;
const __VLS_46 = {
    onClick: (__VLS_ctx.loadHistory)
};
__VLS_42.slots.default;
var __VLS_42;
if (!__VLS_ctx.gitEnabled) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "history-disabled" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
}
else if (__VLS_ctx.commits.length === 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "history-empty" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "commit-list" },
    });
    for (const [c] of __VLS_getVForSourceType((__VLS_ctx.commits))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onClick: (...[$event]) => {
                    if (!!(!__VLS_ctx.gitEnabled))
                        return;
                    if (!!(__VLS_ctx.commits.length === 0))
                        return;
                    __VLS_ctx.selectedFrom = c.hash;
                } },
            key: (c.hash),
            ...{ class: "commit-item" },
            ...{ class: ({ selected: __VLS_ctx.selectedFrom === c.hash }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "commit-hash" },
        });
        (c.hash.slice(0, 8));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "commit-info" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "commit-message" },
        });
        (c.message);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "commit-meta" },
        });
        (c.author);
        (c.date);
    }
}
if (__VLS_ctx.gitEnabled && __VLS_ctx.commits.length > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "diff-section" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "diff-bar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "section-desc" },
    });
    (__VLS_ctx.selectedFrom ? __VLS_ctx.selectedFrom.slice(0, 8) : '选择基线');
    const __VLS_47 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_48 = __VLS_asFunctionalComponent(__VLS_47, new __VLS_47({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn-primary" },
        disabled: (!__VLS_ctx.selectedFrom),
        loading: (__VLS_ctx.loadingDiff),
    }));
    const __VLS_49 = __VLS_48({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn-primary" },
        disabled: (!__VLS_ctx.selectedFrom),
        loading: (__VLS_ctx.loadingDiff),
    }, ...__VLS_functionalComponentArgsRest(__VLS_48));
    let __VLS_51;
    let __VLS_52;
    let __VLS_53;
    const __VLS_54 = {
        onClick: (__VLS_ctx.loadDiff)
    };
    __VLS_50.slots.default;
    var __VLS_50;
    if (__VLS_ctx.showDiff && !__VLS_ctx.loadingDiff) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "diff-result" },
        });
        if (__VLS_ctx.diffLines.length === 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "diff-empty" },
            });
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "diff-lines" },
            });
            for (const [line, idx] of __VLS_getVForSourceType((__VLS_ctx.diffLines))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (idx),
                    ...{ class: "diff-line" },
                    ...{ class: (line.type) },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "line-prefix" },
                });
                (line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ');
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "line-content" },
                });
                (line.content);
            }
        }
    }
}
var __VLS_10;
const __VLS_55 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_56 = __VLS_asFunctionalComponent(__VLS_55, new __VLS_55({
    label: "系统配置",
    name: "config",
}));
const __VLS_57 = __VLS_56({
    label: "系统配置",
    name: "config",
}, ...__VLS_functionalComponentArgsRest(__VLS_56));
__VLS_58.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-section" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "reload-bar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
const __VLS_59 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_60 = __VLS_asFunctionalComponent(__VLS_59, new __VLS_59({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.reloading),
}));
const __VLS_61 = __VLS_60({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.reloading),
}, ...__VLS_functionalComponentArgsRest(__VLS_60));
let __VLS_63;
let __VLS_64;
let __VLS_65;
const __VLS_66 = {
    onClick: (__VLS_ctx.reloadConfig)
};
__VLS_62.slots.default;
var __VLS_62;
if (__VLS_ctx.reloadResult) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "reload-result" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "reload-applied" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "applied-tag" },
    });
    (__VLS_ctx.reloadResult.applied.model);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "applied-tag" },
    });
    (__VLS_ctx.reloadResult.applied.maxSteps);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "applied-tag" },
    });
    (__VLS_ctx.reloadResult.applied.tokenBudget);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "applied-tag" },
    });
    (__VLS_ctx.reloadResult.applied.staleDays);
    if (__VLS_ctx.reloadResult.requireRestart.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "reload-warn" },
        });
        (__VLS_ctx.reloadResult.requireRestart.join(', '));
    }
}
if (__VLS_ctx.loadingConfig) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-loading" },
    });
}
else if (__VLS_ctx.config) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-block hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.PROVIDER_LABELS[__VLS_ctx.config.llm.provider] || __VLS_ctx.config.llm.provider);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.llm.model);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.llm.baseUrl);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: (['key-status', __VLS_ctx.config.llm.apiKeySet ? 'set' : 'unset']) },
    });
    (__VLS_ctx.config.llm.apiKeySet ? '已设置' : '未设置');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
        ...{ class: "env-name" },
    });
    (__VLS_ctx.config.llm.apiKeyRef);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-block hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.adapter);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.budget.maxSteps);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.budget.tokenBudget);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.localOnly ? '开启' : '关闭');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-block hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.server.host);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.server.port);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.vaultPath);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.healthCheck.staleDays);
    if (!__VLS_ctx.config.llm.apiKeySet) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "key-warning" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "warning-icon" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "warning-text" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
        (__VLS_ctx.config.llm.apiKeyRef);
    }
}
var __VLS_58;
var __VLS_6;
/** @type {__VLS_StyleScopedClasses['config-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['config-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['config-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['config-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['schema-section']} */ ;
/** @type {__VLS_StyleScopedClasses['action-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['section-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['schema-editor']} */ ;
/** @type {__VLS_StyleScopedClasses['schema-view']} */ ;
/** @type {__VLS_StyleScopedClasses['history-section']} */ ;
/** @type {__VLS_StyleScopedClasses['history-head']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['history-disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['history-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-list']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-item']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-hash']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-info']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-message']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-section']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-result']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-lines']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line']} */ ;
/** @type {__VLS_StyleScopedClasses['line-prefix']} */ ;
/** @type {__VLS_StyleScopedClasses['line-content']} */ ;
/** @type {__VLS_StyleScopedClasses['config-section']} */ ;
/** @type {__VLS_StyleScopedClasses['reload-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['reload-result']} */ ;
/** @type {__VLS_StyleScopedClasses['reload-applied']} */ ;
/** @type {__VLS_StyleScopedClasses['applied-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['applied-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['applied-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['applied-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['reload-warn']} */ ;
/** @type {__VLS_StyleScopedClasses['section-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['config-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['env-name']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['key-warning']} */ ;
/** @type {__VLS_StyleScopedClasses['warning-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['warning-text']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            RobotAvatar: RobotAvatar,
            activeTab: activeTab,
            config: config,
            schemaContent: schemaContent,
            schemaBuffer: schemaBuffer,
            editingSchema: editingSchema,
            loadingSchema: loadingSchema,
            loadingConfig: loadingConfig,
            savingSchema: savingSchema,
            reloading: reloading,
            reloadResult: reloadResult,
            commits: commits,
            gitEnabled: gitEnabled,
            loadingHistory: loadingHistory,
            selectedFrom: selectedFrom,
            diffLines: diffLines,
            loadingDiff: loadingDiff,
            showDiff: showDiff,
            loadHistory: loadHistory,
            loadDiff: loadDiff,
            saveSchema: saveSchema,
            cancelEdit: cancelEdit,
            PROVIDER_LABELS: PROVIDER_LABELS,
            reloadConfig: reloadConfig,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
