/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import RobotAvatar from '../components/RobotAvatar.vue';
const emit = defineEmits();
const stats = ref(null);
const loading = ref(false);
const initializing = ref(false);
const DIR_LABELS = {
    entities: '实体',
    concepts: '概念',
    comparisons: '对比',
    queries: '问答',
};
const hasContent = computed(() => (stats.value?.totalPages ?? 0) > 0);
async function loadStats() {
    loading.value = true;
    try {
        const res = await fetch('/api/stats');
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
async function initVault() {
    initializing.value = true;
    try {
        const res = await fetch('/api/vault/init', { method: 'POST' });
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
onMounted(() => {
    loadStats();
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
/** @type {__VLS_StyleScopedClasses['stats-row']} */ ;
/** @type {__VLS_StyleScopedClasses['bottom-row']} */ ;
/** @type {__VLS_StyleScopedClasses['welcome-left']} */ ;
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
    ...{ class: "welcome-bg" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "welcome-left" },
});
/** @type {[typeof RobotAvatar, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
    size: (110),
    floating: (true),
}));
const __VLS_1 = __VLS_0({
    size: (110),
    floating: (true),
}, ...__VLS_functionalComponentArgsRest(__VLS_0));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "welcome-right" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "welcome-tag" },
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
    { icon: '◈', num: __VLS_ctx.stats?.totalPages ?? 0, label: '总页面数', grad: 'grad-fire' },
    { icon: '⬡', num: __VLS_ctx.stats?.totalLinks ?? 0, label: '双向链接', grad: 'grad-cool' },
    { icon: '▲', num: __VLS_ctx.stats?.dirCounts?.entities ?? 0, label: '实体页', grad: 'grad-neon' },
    { icon: '✦', num: __VLS_ctx.stats?.dirCounts?.concepts ?? 0, label: '概念页', grad: 'grad-aurora' },
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
    (card.icon);
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
    { icon: '↓', label: '投递资料', view: 'ingest' },
    { icon: '◎', label: '浏览知识库', view: 'browse' },
    { icon: '✧', label: '智能问答', view: 'query' },
    { icon: '◎', label: '知识库体检', view: 'health' },
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
    (sc.icon);
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
if (!__VLS_ctx.hasContent && !__VLS_ctx.loading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "glass-card empty-guide fade-up" },
    });
    /** @type {[typeof RobotAvatar, ]} */ ;
    // @ts-ignore
    const __VLS_3 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
        size: (90),
    }));
    const __VLS_4 = __VLS_3({
        size: (90),
    }, ...__VLS_functionalComponentArgsRest(__VLS_3));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "guide-text" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "guide-actions" },
    });
    const __VLS_6 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_7 = __VLS_asFunctionalComponent(__VLS_6, new __VLS_6({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.initializing),
    }));
    const __VLS_8 = __VLS_7({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.initializing),
    }, ...__VLS_functionalComponentArgsRest(__VLS_7));
    let __VLS_10;
    let __VLS_11;
    let __VLS_12;
    const __VLS_13 = {
        onClick: (__VLS_ctx.initVault)
    };
    __VLS_9.slots.default;
    var __VLS_9;
    const __VLS_14 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_15 = __VLS_asFunctionalComponent(__VLS_14, new __VLS_14({
        ...{ 'onClick': {} },
    }));
    const __VLS_16 = __VLS_15({
        ...{ 'onClick': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_15));
    let __VLS_18;
    let __VLS_19;
    let __VLS_20;
    const __VLS_21 = {
        onClick: (...[$event]) => {
            if (!(!__VLS_ctx.hasContent && !__VLS_ctx.loading))
                return;
            __VLS_ctx.emit('navigate', 'ingest');
        }
    };
    __VLS_17.slots.default;
    var __VLS_17;
}
/** @type {__VLS_StyleScopedClasses['dashboard-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['welcome-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['welcome-bg']} */ ;
/** @type {__VLS_StyleScopedClasses['welcome-left']} */ ;
/** @type {__VLS_StyleScopedClasses['welcome-right']} */ ;
/** @type {__VLS_StyleScopedClasses['welcome-tag']} */ ;
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
/** @type {__VLS_StyleScopedClasses['empty-guide']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['guide-text']} */ ;
/** @type {__VLS_StyleScopedClasses['guide-actions']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            RobotAvatar: RobotAvatar,
            emit: emit,
            stats: stats,
            loading: loading,
            initializing: initializing,
            DIR_LABELS: DIR_LABELS,
            hasContent: hasContent,
            initVault: initVault,
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
