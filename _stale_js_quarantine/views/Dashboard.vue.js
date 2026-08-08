/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { ref, onMounted, computed, markRaw } from 'vue';
import { ElMessage } from 'element-plus';
import { Aim, Connection, CaretTop, Star, Download, Reading, ChatRound, Monitor, Clock } from '@element-plus/icons-vue';
import { useCompileStore } from '../stores/compile';
const emit = defineEmits();
const stats = ref(null);
const loading = ref(false);
const initializing = ref(false);
// FR-14-3 运行历史：复用 compile store 的 runs 数据
const compileStore = useCompileStore();
const recentRuns = computed(() => compileStore.runs.slice(0, 8));
const runsLoading = ref(false);
const DIR_LABELS = {
    entities: '实体',
    concepts: '概念',
    comparisons: '对比',
    queries: '问答',
};
const STATUS_LABELS = {
    done: '成功',
    failed: '失败',
    running: '运行中',
};
const hasContent = computed(() => (stats.value?.totalPages ?? 0) > 0);
async function loadStats() {
    loading.value = true;
    try {
        const res = await fetch(`${API_BASE}/stats`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        stats.value = await res.json();
    }
    catch (err) {
        ElMessage.error('加载统计失败：' + err.message);
    }
    finally {
        loading.value = false;
    }
}
// FR-14-3 加载运行历史（复用 compile store）
async function loadRuns() {
    runsLoading.value = true;
    try {
        await compileStore.loadRuns();
    }
    catch (err) {
        ElMessage.error('加载运行历史失败：' + err.message);
    }
    finally {
        runsLoading.value = false;
    }
}
async function initVault() {
    initializing.value = true;
    try {
        const res = await fetch(`${API_BASE}/vault/init`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        ElMessage.success('知识库已初始化，开始投递资料吧');
        await loadStats();
    }
    catch (err) {
        ElMessage.error('初始化失败：' + err.message);
    }
    finally {
        initializing.value = false;
    }
}
// 相对时间格式化：将 ISO 时间戳转为 "3 分钟前" 等友好展示
// 为什么不引入第三方库：Dashboard 是轻量级首页，零依赖原则
function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1)
        return '刚刚';
    if (mins < 60)
        return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7)
        return `${days} 天前`;
    return iso.slice(0, 10);
}
onMounted(() => {
    loadStats();
    loadRuns();
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['welcome-stats']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['shortcut-item']} */ ;
/** @type {__VLS_StyleScopedClasses['run-item']} */ ;
/** @type {__VLS_StyleScopedClasses['run-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['stats-row']} */ ;
/** @type {__VLS_StyleScopedClasses['bottom-row']} */ ;
/** @type {__VLS_StyleScopedClasses['welcome-right']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "dashboard-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card welcome-card fade-up" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "welcome-right" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "welcome-title grad-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "welcome-tip" },
});
if (__VLS_ctx.stats) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "welcome-stats" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "ws-item" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    (__VLS_ctx.stats.totalPages);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "ws-dot" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "ws-item" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    (__VLS_ctx.stats.totalLinks);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "stats-row" },
});
for (const [card, idx] of __VLS_getVForSourceType(([
    { icon: __VLS_ctx.markRaw(__VLS_ctx.Aim), num: __VLS_ctx.stats?.totalPages ?? 0, label: '总页面数', grad: 'grad-fire' },
    { icon: __VLS_ctx.markRaw(__VLS_ctx.Connection), num: __VLS_ctx.stats?.totalLinks ?? 0, label: '双向链接', grad: 'grad-cool' },
    { icon: __VLS_ctx.markRaw(__VLS_ctx.CaretTop), num: __VLS_ctx.stats?.dirCounts?.entities ?? 0, label: '实体页', grad: 'grad-neon' },
    { icon: __VLS_ctx.markRaw(__VLS_ctx.Star), num: __VLS_ctx.stats?.dirCounts?.concepts ?? 0, label: '概念页', grad: 'grad-aurora' },
]))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: (idx),
        ...{ class: "glass-card stat-card hover-3d fade-up" },
        ...{ style: ({ animationDelay: (idx * 0.1) + 's' }) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-icon" },
        ...{ class: (card.grad) },
    });
    const __VLS_0 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({}));
    const __VLS_2 = __VLS_1({}, ...__VLS_functionalComponentArgsRest(__VLS_1));
    __VLS_3.slots.default;
    const __VLS_4 = ((card.icon));
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
    const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
    var __VLS_3;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-num grad-text" },
    });
    (card.num);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-label" },
    });
    (card.label);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "bottom-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card section-card hover-glow fade-up" },
    ...{ style: {} },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "title-bracket" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "title-bracket" },
});
if (__VLS_ctx.stats) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "dir-list" },
    });
    for (const [count, dir] of __VLS_getVForSourceType((__VLS_ctx.stats.dirCounts))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (dir),
            ...{ class: "dir-item" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "dir-label" },
        });
        (__VLS_ctx.DIR_LABELS[dir] || dir);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "dir-bar-bg" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "dir-bar-fill" },
            ...{ style: ({ width: Math.min(100, count * 10) + '%' }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "dir-count" },
        });
        (count);
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-loading" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card section-card hover-glow fade-up" },
    ...{ style: {} },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "section-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "title-bracket" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "title-bracket" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "shortcut-grid" },
});
for (const [sc, idx] of __VLS_getVForSourceType(([
    { icon: __VLS_ctx.markRaw(__VLS_ctx.Download), label: '投递资料', view: 'ingest' },
    { icon: __VLS_ctx.markRaw(__VLS_ctx.Reading), label: '浏览知识库', view: 'browse' },
    { icon: __VLS_ctx.markRaw(__VLS_ctx.ChatRound), label: '智能问答', view: 'query' },
    { icon: __VLS_ctx.markRaw(__VLS_ctx.Monitor), label: '知识库体检', view: 'health' },
]))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (...[$event]) => {
                __VLS_ctx.emit('navigate', sc.view);
            } },
        key: (idx),
        ...{ class: "shortcut-item hover-3d" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "shortcut-icon" },
    });
    const __VLS_8 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({}));
    const __VLS_10 = __VLS_9({}, ...__VLS_functionalComponentArgsRest(__VLS_9));
    __VLS_11.slots.default;
    const __VLS_12 = ((sc.icon));
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({}));
    const __VLS_14 = __VLS_13({}, ...__VLS_functionalComponentArgsRest(__VLS_13));
    var __VLS_11;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "shortcut-label" },
    });
    (sc.label);
}
if (__VLS_ctx.stats?.recentLog) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "glass-card section-card fade-up" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "section-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "title-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "title-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({
        ...{ class: "recent-log" },
    });
    (__VLS_ctx.stats.recentLog);
}
if (__VLS_ctx.recentRuns.length > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "glass-card section-card fade-up" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "section-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "title-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "title-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "run-list" },
    });
    for (const [run] of __VLS_getVForSourceType((__VLS_ctx.recentRuns))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.recentRuns.length > 0))
                        return;
                    __VLS_ctx.emit('navigate', 'progress');
                } },
            key: (run.runId),
            ...{ class: "run-item" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "run-status-badge" },
            ...{ class: ('status-' + run.status) },
        });
        (__VLS_ctx.STATUS_LABELS[run.status]);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "run-id" },
            title: (run.runId),
        });
        (run.runId.slice(0, 8));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "run-stats" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "run-stat" },
        });
        const __VLS_16 = {}.ElIcon;
        /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
        // @ts-ignore
        const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({}));
        const __VLS_18 = __VLS_17({}, ...__VLS_functionalComponentArgsRest(__VLS_17));
        __VLS_19.slots.default;
        const __VLS_20 = {}.Clock;
        /** @type {[typeof __VLS_components.Clock, ]} */ ;
        // @ts-ignore
        const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({}));
        const __VLS_22 = __VLS_21({}, ...__VLS_functionalComponentArgsRest(__VLS_21));
        var __VLS_19;
        (run.step);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "run-stat" },
        });
        (run.tokenUsed);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "run-time" },
        });
        (__VLS_ctx.timeAgo(run.startedAt));
    }
    if (__VLS_ctx.compileStore.runs.length > 8) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "run-more" },
        });
        const __VLS_24 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
            ...{ 'onClick': {} },
            text: true,
            size: "small",
        }));
        const __VLS_26 = __VLS_25({
            ...{ 'onClick': {} },
            text: true,
            size: "small",
        }, ...__VLS_functionalComponentArgsRest(__VLS_25));
        let __VLS_28;
        let __VLS_29;
        let __VLS_30;
        const __VLS_31 = {
            onClick: (...[$event]) => {
                if (!(__VLS_ctx.recentRuns.length > 0))
                    return;
                if (!(__VLS_ctx.compileStore.runs.length > 8))
                    return;
                __VLS_ctx.emit('navigate', 'progress');
            }
        };
        __VLS_27.slots.default;
        (__VLS_ctx.compileStore.runs.length);
        var __VLS_27;
    }
}
else if (__VLS_ctx.hasContent && !__VLS_ctx.runsLoading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "glass-card section-card fade-up" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "section-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "title-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "title-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "run-empty" },
    });
}
if (!__VLS_ctx.hasContent && !__VLS_ctx.loading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "glass-card empty-guide fade-up" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "guide-text" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "guide-actions" },
    });
    const __VLS_32 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.initializing),
    }));
    const __VLS_34 = __VLS_33({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.initializing),
    }, ...__VLS_functionalComponentArgsRest(__VLS_33));
    let __VLS_36;
    let __VLS_37;
    let __VLS_38;
    const __VLS_39 = {
        onClick: (__VLS_ctx.initVault)
    };
    __VLS_35.slots.default;
    var __VLS_35;
    const __VLS_40 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
        ...{ 'onClick': {} },
    }));
    const __VLS_42 = __VLS_41({
        ...{ 'onClick': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_41));
    let __VLS_44;
    let __VLS_45;
    let __VLS_46;
    const __VLS_47 = {
        onClick: (...[$event]) => {
            if (!(!__VLS_ctx.hasContent && !__VLS_ctx.loading))
                return;
            __VLS_ctx.emit('navigate', 'ingest');
        }
    };
    __VLS_43.slots.default;
    var __VLS_43;
}
/** @type {__VLS_StyleScopedClasses['dashboard-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['welcome-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['welcome-right']} */ ;
/** @type {__VLS_StyleScopedClasses['welcome-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['welcome-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['welcome-stats']} */ ;
/** @type {__VLS_StyleScopedClasses['ws-item']} */ ;
/** @type {__VLS_StyleScopedClasses['ws-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['ws-item']} */ ;
/** @type {__VLS_StyleScopedClasses['stats-row']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-3d']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-num']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['bottom-row']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['section-card']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['title-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['title-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['dir-list']} */ ;
/** @type {__VLS_StyleScopedClasses['dir-item']} */ ;
/** @type {__VLS_StyleScopedClasses['dir-label']} */ ;
/** @type {__VLS_StyleScopedClasses['dir-bar-bg']} */ ;
/** @type {__VLS_StyleScopedClasses['dir-bar-fill']} */ ;
/** @type {__VLS_StyleScopedClasses['dir-count']} */ ;
/** @type {__VLS_StyleScopedClasses['section-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['section-card']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['title-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['title-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['shortcut-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['shortcut-item']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-3d']} */ ;
/** @type {__VLS_StyleScopedClasses['shortcut-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['shortcut-label']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['section-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['title-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['title-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['recent-log']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['section-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['title-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['title-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['run-list']} */ ;
/** @type {__VLS_StyleScopedClasses['run-item']} */ ;
/** @type {__VLS_StyleScopedClasses['run-status-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['run-id']} */ ;
/** @type {__VLS_StyleScopedClasses['run-stats']} */ ;
/** @type {__VLS_StyleScopedClasses['run-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['run-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['run-time']} */ ;
/** @type {__VLS_StyleScopedClasses['run-more']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['section-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['title-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['title-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['run-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-guide']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['guide-text']} */ ;
/** @type {__VLS_StyleScopedClasses['guide-actions']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            markRaw: markRaw,
            Aim: Aim,
            Connection: Connection,
            CaretTop: CaretTop,
            Star: Star,
            Download: Download,
            Reading: Reading,
            ChatRound: ChatRound,
            Monitor: Monitor,
            Clock: Clock,
            emit: emit,
            stats: stats,
            loading: loading,
            initializing: initializing,
            compileStore: compileStore,
            recentRuns: recentRuns,
            runsLoading: runsLoading,
            DIR_LABELS: DIR_LABELS,
            STATUS_LABELS: STATUS_LABELS,
            hasContent: hasContent,
            initVault: initVault,
            timeAgo: timeAgo,
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
