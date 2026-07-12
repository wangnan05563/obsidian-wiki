/// <reference types="../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, onMounted, onBeforeUnmount } from 'vue';
import RobotAvatar from './components/RobotAvatar.vue';
import Dashboard from './views/Dashboard.vue';
import Ingest from './views/Ingest.vue';
import Progress from './views/Progress.vue';
import Browse from './views/Browse.vue';
import Query from './views/Query.vue';
import Graph from './views/Graph.vue';
import Health from './views/Health.vue';
import Config from './views/Config.vue';
import Tunnel from './views/Tunnel.vue';
import Cleanup from './views/Cleanup.vue';
import { useCompileStore } from './stores/compile';
const store = useCompileStore();
const currentView = ref('dashboard');
// 监听滚动事件，更新 scrollY 变量驱动 CSS 视差效果
const scrollY = ref(0);
function handleScroll() {
    // 直接读取 scrollY，passive 模式下性能足够
    scrollY.value = window.scrollY;
}
function go(view) {
    currentView.value = view;
}
function handleNavigate(view) {
    currentView.value = view;
}
onMounted(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
});
onBeforeUnmount(() => {
    window.removeEventListener('scroll', handleScroll);
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['nav-left']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['nav']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-tabs']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "bg-layer base" },
    ...{ style: ({ transform: `translateY(${__VLS_ctx.scrollY * 0.15}px)` }) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "bg-layer grid" },
    ...{ style: ({ transform: `translateY(${__VLS_ctx.scrollY * 0.08}px)` }) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "bg-layer noise" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "bg-layer orbs parallax" },
    ...{ style: ({ transform: `translateY(${__VLS_ctx.scrollY * 0.25}px)` }) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "app-shell" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.header, __VLS_intrinsicElements.header)({
    ...{ class: "nav glass-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "nav-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.go('dashboard');
        } },
    ...{ class: "nav-left" },
});
/** @type {[typeof RobotAvatar, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
    size: (46),
}));
const __VLS_1 = __VLS_0({
    size: (46),
}, ...__VLS_functionalComponentArgsRest(__VLS_0));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "nav-title-wrap" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "title grad-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "subtitle" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.nav, __VLS_intrinsicElements.nav)({
    ...{ class: "nav-tabs" },
});
for (const [tab] of __VLS_getVForSourceType(([
    { key: 'dashboard', label: '仪表盘' },
    { key: 'ingest', label: '投递资料' },
    { key: 'progress', label: '编译进度' },
    { key: 'browse', label: '知识浏览' },
    { key: 'query', label: '知识问答' },
    { key: 'graph', label: '图谱' },
    { key: 'health', label: '体检' },
    { key: 'config', label: '配置' },
    { key: 'tunnel', label: '内网穿透' },
    { key: 'cleanup', label: '系统清理' },
]))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                __VLS_ctx.go(tab.key);
            } },
        key: (tab.key),
        ...{ class: "tab-btn hover-glow" },
        ...{ class: ({
                active: __VLS_ctx.currentView === tab.key,
                disabled: tab.key === 'progress' && !__VLS_ctx.store.isCompiling && !__VLS_ctx.store.isDone
            }) },
        disabled: (tab.key === 'progress' && !__VLS_ctx.store.isCompiling && !__VLS_ctx.store.isDone),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "tab-label" },
    });
    (tab.label);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.main, __VLS_intrinsicElements.main)({
    ...{ class: "content" },
});
if (__VLS_ctx.currentView === 'dashboard') {
    /** @type {[typeof Dashboard, ]} */ ;
    // @ts-ignore
    const __VLS_3 = __VLS_asFunctionalComponent(Dashboard, new Dashboard({
        ...{ 'onNavigate': {} },
    }));
    const __VLS_4 = __VLS_3({
        ...{ 'onNavigate': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_3));
    let __VLS_6;
    let __VLS_7;
    let __VLS_8;
    const __VLS_9 = {
        onNavigate: (__VLS_ctx.handleNavigate)
    };
    var __VLS_5;
}
else if (__VLS_ctx.currentView === 'ingest') {
    /** @type {[typeof Ingest, ]} */ ;
    // @ts-ignore
    const __VLS_10 = __VLS_asFunctionalComponent(Ingest, new Ingest({
        ...{ 'onStart': {} },
    }));
    const __VLS_11 = __VLS_10({
        ...{ 'onStart': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_10));
    let __VLS_13;
    let __VLS_14;
    let __VLS_15;
    const __VLS_16 = {
        onStart: (...[$event]) => {
            if (!!(__VLS_ctx.currentView === 'dashboard'))
                return;
            if (!(__VLS_ctx.currentView === 'ingest'))
                return;
            __VLS_ctx.go('progress');
        }
    };
    var __VLS_12;
}
else if (__VLS_ctx.currentView === 'progress') {
    /** @type {[typeof Progress, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(Progress, new Progress({
        ...{ 'onRestart': {} },
    }));
    const __VLS_18 = __VLS_17({
        ...{ 'onRestart': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
    let __VLS_20;
    let __VLS_21;
    let __VLS_22;
    const __VLS_23 = {
        onRestart: (...[$event]) => {
            if (!!(__VLS_ctx.currentView === 'dashboard'))
                return;
            if (!!(__VLS_ctx.currentView === 'ingest'))
                return;
            if (!(__VLS_ctx.currentView === 'progress'))
                return;
            __VLS_ctx.go('ingest');
        }
    };
    var __VLS_19;
}
else if (__VLS_ctx.currentView === 'browse') {
    /** @type {[typeof Browse, ]} */ ;
    // @ts-ignore
    const __VLS_24 = __VLS_asFunctionalComponent(Browse, new Browse({}));
    const __VLS_25 = __VLS_24({}, ...__VLS_functionalComponentArgsRest(__VLS_24));
}
else if (__VLS_ctx.currentView === 'query') {
    /** @type {[typeof Query, ]} */ ;
    // @ts-ignore
    const __VLS_27 = __VLS_asFunctionalComponent(Query, new Query({}));
    const __VLS_28 = __VLS_27({}, ...__VLS_functionalComponentArgsRest(__VLS_27));
}
else if (__VLS_ctx.currentView === 'graph') {
    /** @type {[typeof Graph, ]} */ ;
    // @ts-ignore
    const __VLS_30 = __VLS_asFunctionalComponent(Graph, new Graph({}));
    const __VLS_31 = __VLS_30({}, ...__VLS_functionalComponentArgsRest(__VLS_30));
}
else if (__VLS_ctx.currentView === 'health') {
    /** @type {[typeof Health, ]} */ ;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent(Health, new Health({}));
    const __VLS_34 = __VLS_33({}, ...__VLS_functionalComponentArgsRest(__VLS_33));
}
else if (__VLS_ctx.currentView === 'config') {
    /** @type {[typeof Config, ]} */ ;
    // @ts-ignore
    const __VLS_36 = __VLS_asFunctionalComponent(Config, new Config({}));
    const __VLS_37 = __VLS_36({}, ...__VLS_functionalComponentArgsRest(__VLS_36));
}
else if (__VLS_ctx.currentView === 'tunnel') {
    /** @type {[typeof Tunnel, ]} */ ;
    // @ts-ignore
    const __VLS_39 = __VLS_asFunctionalComponent(Tunnel, new Tunnel({}));
    const __VLS_40 = __VLS_39({}, ...__VLS_functionalComponentArgsRest(__VLS_39));
}
else if (__VLS_ctx.currentView === 'cleanup') {
    /** @type {[typeof Cleanup, ]} */ ;
    // @ts-ignore
    const __VLS_42 = __VLS_asFunctionalComponent(Cleanup, new Cleanup({}));
    const __VLS_43 = __VLS_42({}, ...__VLS_functionalComponentArgsRest(__VLS_42));
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.footer, __VLS_intrinsicElements.footer)({
    ...{ class: "footer" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "footer-line" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "footer-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "footer-line" },
});
/** @type {__VLS_StyleScopedClasses['bg-layer']} */ ;
/** @type {__VLS_StyleScopedClasses['base']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-layer']} */ ;
/** @type {__VLS_StyleScopedClasses['grid']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-layer']} */ ;
/** @type {__VLS_StyleScopedClasses['noise']} */ ;
/** @type {__VLS_StyleScopedClasses['bg-layer']} */ ;
/** @type {__VLS_StyleScopedClasses['orbs']} */ ;
/** @type {__VLS_StyleScopedClasses['parallax']} */ ;
/** @type {__VLS_StyleScopedClasses['app-shell']} */ ;
/** @type {__VLS_StyleScopedClasses['nav']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-left']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-title-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['subtitle']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-label']} */ ;
/** @type {__VLS_StyleScopedClasses['content']} */ ;
/** @type {__VLS_StyleScopedClasses['footer']} */ ;
/** @type {__VLS_StyleScopedClasses['footer-line']} */ ;
/** @type {__VLS_StyleScopedClasses['footer-text']} */ ;
/** @type {__VLS_StyleScopedClasses['footer-line']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            RobotAvatar: RobotAvatar,
            Dashboard: Dashboard,
            Ingest: Ingest,
            Progress: Progress,
            Browse: Browse,
            Query: Query,
            Graph: Graph,
            Health: Health,
            Config: Config,
            Tunnel: Tunnel,
            Cleanup: Cleanup,
            store: store,
            currentView: currentView,
            scrollY: scrollY,
            go: go,
            handleNavigate: handleNavigate,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
