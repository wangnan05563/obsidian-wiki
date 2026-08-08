/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiErrorMessage } from '../utils/apiError';
// 存储状态
const status = ref(null);
const loadingStatus = ref(false);
const forms = reactive({
    compileCache: { target: 'compile_cache', days: 30, dry_run: true },
    runState: { target: 'run_state', days: 30, dry_run: true },
    runLogs: { target: 'run_logs', days: 7, dry_run: true },
    rawArchive: { target: 'raw_archive', days: 30, dry_run: true },
});
// 4 类独立 loading + result
const loadings = reactive({
    compileCache: false,
    runState: false,
    runLogs: false,
    rawArchive: false,
});
const results = ref({
    compileCache: null,
    runState: null,
    runLogs: null,
    rawArchive: null,
});
// 卡片元数据：标题/描述/图标
const cards = [
    {
        key: 'compileCache',
        title: '编译缓存',
        desc: '.harness/compile-cache.json',
        detail: '增量编译的 SHA-256 内容哈希缓存，清理后下次编译全部重新生成',
        showDays: false,
    },
    {
        key: 'runState',
        title: '运行状态',
        desc: '.harness/state/*.json',
        detail: '断点续传的历史任务状态文件，清理后无法 resume 历史任务',
        showDays: false,
    },
    {
        key: 'runLogs',
        title: '运行日志',
        desc: '.harness/logs/*.log',
        detail: 'harness 运行的 JSONL 技术日志，按保留天数清理旧文件',
        showDays: true,
    },
    {
        key: 'rawArchive',
        title: '原始资料',
        desc: 'vault/raw/input-*.md',
        detail: '投递资料的原始存档，按保留天数清理（保留已生成的页面）',
        showDays: true,
    },
];
// 二次确认话术（数据库类风险最高，提示备份）
function confirmText(title) {
    return `确认清理${title}？此操作不可撤销，建议先确认无活跃编译/问答任务。`;
}
async function loadStatus() {
    loadingStatus.value = true;
    try {
        const res = await fetch(`${API_BASE}/cleanup/status`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        status.value = await res.json();
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('加载存储状态失败', err));
    }
    finally {
        loadingStatus.value = false;
    }
}
async function handleCleanup(key) {
    const form = forms[key];
    const card = cards.find((c) => c.key === key);
    // 非预览模式必须二次确认，避免误删（与闲鱼 globalThis.confirm 等价）
    if (!form.dry_run) { // NOSONAR — guard clause，无 else 分支，S7735 不适用
        try {
            await ElMessageBox.confirm(confirmText(card.title), '危险操作确认', {
                confirmButtonText: '确认清理',
                cancelButtonText: '取消',
                type: 'warning',
            });
        }
        catch {
            // 用户取消
            return;
        }
    }
    loadings[key] = true;
    results.value[key] = null;
    try {
        const body = {
            target: form.target,
            dry_run: form.dry_run,
            // 仅 run_logs/raw_archive 按 days 清理，其他两类与时间无关
            ...(card.showDays ? { days: form.days } : {}),
        };
        const res = await fetch(`${API_BASE}/cleanup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        results.value[key] = data;
        if (form.dry_run) {
            const n = data.cleaned.length;
            ElMessage.info(n > 0 ? `预览完成：将处理 ${n} 项` : '预览完成：无需要清理的内容');
        }
        else {
            // 实际执行后刷新状态以反映最新存储情况
            await loadStatus();
            const freed = data.total_freed_mb !== undefined ? `，释放 ${data.total_freed_mb} MB` : ''; // NOSONAR: S7735 - 误报，此处 !== undefined 是必要的存在性检查
            ElMessage.success(`清理完成：处理 ${data.count} 项${freed}`);
        }
    }
    catch (err) {
        const message = apiErrorMessage('清理失败', err);
        results.value[key] = { errors: [message] };
        ElMessage.error(message);
    }
    finally {
        loadings[key] = false;
    }
}
onMounted(() => {
    loadStatus();
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['cleanup-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['cleanup-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['cleanup-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['danger']} */ ;
/** @type {__VLS_StyleScopedClasses['is-disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['status-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['cleanup-grid']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "cleanup-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card cleanup-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "cleanup-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "head-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "head-title grad-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "head-tip" },
});
const __VLS_0 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.loadingStatus),
}));
const __VLS_2 = __VLS_1({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.loadingStatus),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_4;
let __VLS_5;
let __VLS_6;
const __VLS_7 = {
    onClick: (__VLS_ctx.loadStatus)
};
__VLS_3.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ style: {} },
});
var __VLS_3;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-grid" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-block hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-value" },
});
(__VLS_ctx.status?.compileCache.sizeMb.toFixed(2) ?? '0.00');
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "unit" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-meta" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: (['dot', __VLS_ctx.status?.compileCache.exists ? 'set' : 'unset']) },
});
(__VLS_ctx.status?.compileCache.exists ? `${__VLS_ctx.status.compileCache.entryCount} 条缓存` : '未创建');
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-block hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-value" },
});
(__VLS_ctx.status?.runState.sizeMb.toFixed(2) ?? '0.00');
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "unit" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-meta" },
});
(__VLS_ctx.status?.runState.fileCount ?? 0);
if (__VLS_ctx.status?.runState.oldest) {
    (__VLS_ctx.status.runState.oldest);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-block hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-value" },
});
(__VLS_ctx.status?.runLogs.sizeMb.toFixed(2) ?? '0.00');
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "unit" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-meta" },
});
(__VLS_ctx.status?.runLogs.fileCount ?? 0);
if (__VLS_ctx.status?.runLogs.oldest) {
    (__VLS_ctx.status.runLogs.oldest);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-block hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-value" },
});
(__VLS_ctx.status?.rawArchive.sizeMb.toFixed(2) ?? '0.00');
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "unit" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "status-meta" },
});
(__VLS_ctx.status?.rawArchive.fileCount ?? 0);
if (__VLS_ctx.status?.rawArchive.oldest) {
    (__VLS_ctx.status.rawArchive.oldest);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "cleanup-grid" },
});
for (const [card] of __VLS_getVForSourceType((__VLS_ctx.cards))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: (card.key),
        ...{ class: "cleanup-block hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    (card.title);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "block-desc" },
    });
    (card.desc);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "block-detail" },
    });
    (card.detail);
    if (card.showDays) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "form-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "form-label" },
            for: ('cleanup-days-' + card.key),
        });
        const __VLS_8 = {}.ElInputNumber;
        /** @type {[typeof __VLS_components.ElInputNumber, typeof __VLS_components.elInputNumber, ]} */ ;
        // @ts-ignore
        const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
            id: ('cleanup-days-' + card.key),
            modelValue: (__VLS_ctx.forms[card.key].days),
            min: (1),
            max: (365),
            size: "small",
            ...{ class: "form-input" },
        }));
        const __VLS_10 = __VLS_9({
            id: ('cleanup-days-' + card.key),
            modelValue: (__VLS_ctx.forms[card.key].days),
            min: (1),
            max: (365),
            size: "small",
            ...{ class: "form-input" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_9));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "form-suffix" },
        });
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-row switch-row" },
    });
    const __VLS_12 = {}.ElSwitch;
    /** @type {[typeof __VLS_components.ElSwitch, typeof __VLS_components.elSwitch, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
        modelValue: (__VLS_ctx.forms[card.key].dry_run),
    }));
    const __VLS_14 = __VLS_13({
        modelValue: (__VLS_ctx.forms[card.key].dry_run),
    }, ...__VLS_functionalComponentArgsRest(__VLS_13));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "switch-label" },
    });
    if (!__VLS_ctx.forms[card.key].dry_run) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "danger-tag" },
        });
    }
    const __VLS_16 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
        ...{ 'onClick': {} },
        ...{ class: "cleanup-btn" },
        ...{ class: ({ danger: !__VLS_ctx.forms[card.key].dry_run }) },
        loading: (__VLS_ctx.loadings[card.key]),
    }));
    const __VLS_18 = __VLS_17({
        ...{ 'onClick': {} },
        ...{ class: "cleanup-btn" },
        ...{ class: ({ danger: !__VLS_ctx.forms[card.key].dry_run }) },
        loading: (__VLS_ctx.loadings[card.key]),
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
    let __VLS_20;
    let __VLS_21;
    let __VLS_22;
    const __VLS_23 = {
        onClick: (...[$event]) => {
            __VLS_ctx.handleCleanup(card.key);
        }
    };
    __VLS_19.slots.default;
    (card.title);
    var __VLS_19;
    if (__VLS_ctx.results[card.key]) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "result-area" },
        });
        if (__VLS_ctx.results[card.key].cleaned.length > 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "result-success" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "result-summary" },
            });
            if (__VLS_ctx.results[card.key].dry_run) {
                (__VLS_ctx.results[card.key].count);
            }
            else {
                (__VLS_ctx.results[card.key].count);
                if (__VLS_ctx.results[card.key].total_freed_mb !== undefined) {
                    (__VLS_ctx.results[card.key].total_freed_mb);
                }
            }
            for (const [item, idx] of __VLS_getVForSourceType((__VLS_ctx.results[card.key].cleaned))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (idx),
                    ...{ class: "result-item" },
                });
                (item);
            }
        }
        if (__VLS_ctx.results[card.key].errors.length > 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "result-errors" },
            });
            for (const [err, idx] of __VLS_getVForSourceType((__VLS_ctx.results[card.key].errors))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (idx),
                    ...{ class: "error-item" },
                });
                (err);
            }
        }
        if (__VLS_ctx.results[card.key].cleaned.length === 0 && __VLS_ctx.results[card.key].errors.length === 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "result-empty" },
            });
        }
    }
}
/** @type {__VLS_StyleScopedClasses['cleanup-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['cleanup-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['cleanup-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['status-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['status-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['status-title']} */ ;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['unit']} */ ;
/** @type {__VLS_StyleScopedClasses['status-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['status-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['status-title']} */ ;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['unit']} */ ;
/** @type {__VLS_StyleScopedClasses['status-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['status-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['status-title']} */ ;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['unit']} */ ;
/** @type {__VLS_StyleScopedClasses['status-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['status-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['status-title']} */ ;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['unit']} */ ;
/** @type {__VLS_StyleScopedClasses['status-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['cleanup-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['cleanup-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['block-detail']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-suffix']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['switch-row']} */ ;
/** @type {__VLS_StyleScopedClasses['switch-label']} */ ;
/** @type {__VLS_StyleScopedClasses['danger-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['cleanup-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['result-area']} */ ;
/** @type {__VLS_StyleScopedClasses['result-success']} */ ;
/** @type {__VLS_StyleScopedClasses['result-summary']} */ ;
/** @type {__VLS_StyleScopedClasses['result-item']} */ ;
/** @type {__VLS_StyleScopedClasses['result-errors']} */ ;
/** @type {__VLS_StyleScopedClasses['error-item']} */ ;
/** @type {__VLS_StyleScopedClasses['result-empty']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            status: status,
            loadingStatus: loadingStatus,
            forms: forms,
            loadings: loadings,
            results: results,
            cards: cards,
            loadStatus: loadStatus,
            handleCleanup: handleCleanup,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
