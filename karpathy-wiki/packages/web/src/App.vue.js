/// <reference types="../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, onMounted, onBeforeUnmount } from 'vue';
import RobotAvatar from './components/RobotAvatar.vue';
import FloatingChat from './components/FloatingChat.vue';
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
// 悬浮窗口模式：Rust 端在 webview 创建后通过 webview.eval() 注入
// window.__FLOATING_MODE__ = true 标记悬浮窗口。
// 为什么用 window 属性而非 URL query/hash 或 localStorage：
//   - Tauri 2.x WebView2 在 Windows 上同源 webview 共享 localStorage，会污染主窗口。
//   - URL query/hash 在某些 WebView2 版本下未保留到 window.location。
//   - window 属性是 webview JS context 内的局部变量，完全隔离。
function detectFloatingMode() {
    if (typeof window === 'undefined')
        return false;
    // 1. 优先检测 webview.eval() 注入的标志（最可靠）
    if (window.__FLOATING_MODE__ === true)
        return true;
    // 2. 兜底检测 query 参数
    if (window.location.search.includes('floating=1'))
        return true;
    // 3. 最后兜底检测 hash
    if (window.location.hash === '#floating')
        return true;
    return false;
}
const isFloatingMode = ref(detectFloatingMode());
// 悬浮模式下给 html 和 body 同时加 class，让全局 CSS 覆盖两者的背景为透明
// 为什么同时覆盖 html：body 透明后，html 元素的默认背景在 WebView2 下可能显示为深色，
// 仅覆盖 body 不够，必须显式覆盖 html 才能完全透明。
function applyFloatingMode(floating) {
    const root = document.documentElement;
    const body = document.body;
    if (floating) {
        root.classList.add('floating-active');
        body.classList.add('floating-active');
    }
    else {
        root.classList.remove('floating-active');
        body.classList.remove('floating-active');
    }
}
function handleHashChange() {
    isFloatingMode.value = detectFloatingMode();
    applyFloatingMode(isFloatingMode.value);
}
// 导航栏折叠状态：折叠后隐藏 tabs，释放垂直空间放大问答框
// 持久化到 localStorage，刷新页面后保留用户偏好
const navCollapsed = ref(localStorage.getItem('navCollapsed') === 'true');
function toggleNav() {
    navCollapsed.value = !navCollapsed.value;
    localStorage.setItem('navCollapsed', String(navCollapsed.value));
}
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
    window.addEventListener('hashchange', handleHashChange);
    // 初始化时应用一次悬浮模式
    applyFloatingMode(isFloatingMode.value);
    // 兜底：webview.eval() 是异步的，__FLOATING_MODE__ 可能晚于 setup 注入
    // 延迟一帧后再次检测，确保悬浮模式正确识别
    requestAnimationFrame(() => {
        const recheck = detectFloatingMode();
        if (recheck !== isFloatingMode.value) {
            isFloatingMode.value = recheck;
            applyFloatingMode(recheck);
        }
    });
});
onBeforeUnmount(() => {
    window.removeEventListener('scroll', handleScroll);
    window.removeEventListener('hashchange', handleHashChange);
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['nav']} */ ;
/** @type {__VLS_StyleScopedClasses['nav']} */ ;
/** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['nav']} */ ;
/** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-left']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-title-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['nav']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['floating-active']} */ ;
/** @type {__VLS_StyleScopedClasses['floating-mode']} */ ;
/** @type {__VLS_StyleScopedClasses['floating-mode']} */ ;
// CSS variable injection 
// CSS variable injection end 
if (__VLS_ctx.isFloatingMode) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "floating-mode" },
    });
    /** @type {[typeof FloatingChat, ]} */ ;
    // @ts-ignore
    const __VLS_0 = __VLS_asFunctionalComponent(FloatingChat, new FloatingChat({
        inQueryPage: (true),
    }));
    const __VLS_1 = __VLS_0({
        inQueryPage: (true),
    }, ...__VLS_functionalComponentArgsRest(__VLS_0));
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "app-root" },
    });
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
        ...{ class: ({ collapsed: __VLS_ctx.navCollapsed }) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "nav-deco" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.isFloatingMode))
                    return;
                __VLS_ctx.go('dashboard');
            } },
        ...{ class: "nav-left" },
    });
    /** @type {[typeof RobotAvatar, ]} */ ;
    // @ts-ignore
    const __VLS_3 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
        size: (46),
    }));
    const __VLS_4 = __VLS_3({
        size: (46),
    }, ...__VLS_functionalComponentArgsRest(__VLS_3));
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
    __VLS_asFunctionalDirective(__VLS_directives.vShow)(null, { ...__VLS_directiveBindingRestFields, value: (!__VLS_ctx.navCollapsed) }, null, null);
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
                    if (!!(__VLS_ctx.isFloatingMode))
                        return;
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
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.toggleNav) },
        ...{ class: "nav-toggle" },
        title: (__VLS_ctx.navCollapsed ? '展开菜单' : '收起菜单'),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M6 9l6 6 6-6",
        stroke: "currentColor",
        'stroke-width': "2",
        'stroke-linecap': "round",
        'stroke-linejoin': "round",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.main, __VLS_intrinsicElements.main)({
        ...{ class: "content" },
    });
    if (__VLS_ctx.currentView === 'dashboard') {
        /** @type {[typeof Dashboard, ]} */ ;
        // @ts-ignore
        const __VLS_6 = __VLS_asFunctionalComponent(Dashboard, new Dashboard({
            ...{ 'onNavigate': {} },
        }));
        const __VLS_7 = __VLS_6({
            ...{ 'onNavigate': {} },
        }, ...__VLS_functionalComponentArgsRest(__VLS_6));
        let __VLS_9;
        let __VLS_10;
        let __VLS_11;
        const __VLS_12 = {
            onNavigate: (__VLS_ctx.handleNavigate)
        };
        var __VLS_8;
    }
    else if (__VLS_ctx.currentView === 'ingest') {
        /** @type {[typeof Ingest, ]} */ ;
        // @ts-ignore
        const __VLS_13 = __VLS_asFunctionalComponent(Ingest, new Ingest({
            ...{ 'onStart': {} },
        }));
        const __VLS_14 = __VLS_13({
            ...{ 'onStart': {} },
        }, ...__VLS_functionalComponentArgsRest(__VLS_13));
        let __VLS_16;
        let __VLS_17;
        let __VLS_18;
        const __VLS_19 = {
            onStart: (...[$event]) => {
                if (!!(__VLS_ctx.isFloatingMode))
                    return;
                if (!!(__VLS_ctx.currentView === 'dashboard'))
                    return;
                if (!(__VLS_ctx.currentView === 'ingest'))
                    return;
                __VLS_ctx.go('progress');
            }
        };
        var __VLS_15;
    }
    else if (__VLS_ctx.currentView === 'progress') {
        /** @type {[typeof Progress, ]} */ ;
        // @ts-ignore
        const __VLS_20 = __VLS_asFunctionalComponent(Progress, new Progress({
            ...{ 'onRestart': {} },
        }));
        const __VLS_21 = __VLS_20({
            ...{ 'onRestart': {} },
        }, ...__VLS_functionalComponentArgsRest(__VLS_20));
        let __VLS_23;
        let __VLS_24;
        let __VLS_25;
        const __VLS_26 = {
            onRestart: (...[$event]) => {
                if (!!(__VLS_ctx.isFloatingMode))
                    return;
                if (!!(__VLS_ctx.currentView === 'dashboard'))
                    return;
                if (!!(__VLS_ctx.currentView === 'ingest'))
                    return;
                if (!(__VLS_ctx.currentView === 'progress'))
                    return;
                __VLS_ctx.go('ingest');
            }
        };
        var __VLS_22;
    }
    else if (__VLS_ctx.currentView === 'browse') {
        /** @type {[typeof Browse, ]} */ ;
        // @ts-ignore
        const __VLS_27 = __VLS_asFunctionalComponent(Browse, new Browse({}));
        const __VLS_28 = __VLS_27({}, ...__VLS_functionalComponentArgsRest(__VLS_27));
    }
    else if (__VLS_ctx.currentView === 'query') {
        /** @type {[typeof Query, ]} */ ;
        // @ts-ignore
        const __VLS_30 = __VLS_asFunctionalComponent(Query, new Query({}));
        const __VLS_31 = __VLS_30({}, ...__VLS_functionalComponentArgsRest(__VLS_30));
    }
    else if (__VLS_ctx.currentView === 'graph') {
        /** @type {[typeof Graph, ]} */ ;
        // @ts-ignore
        const __VLS_33 = __VLS_asFunctionalComponent(Graph, new Graph({}));
        const __VLS_34 = __VLS_33({}, ...__VLS_functionalComponentArgsRest(__VLS_33));
    }
    else if (__VLS_ctx.currentView === 'health') {
        /** @type {[typeof Health, ]} */ ;
        // @ts-ignore
        const __VLS_36 = __VLS_asFunctionalComponent(Health, new Health({}));
        const __VLS_37 = __VLS_36({}, ...__VLS_functionalComponentArgsRest(__VLS_36));
    }
    else if (__VLS_ctx.currentView === 'config') {
        /** @type {[typeof Config, ]} */ ;
        // @ts-ignore
        const __VLS_39 = __VLS_asFunctionalComponent(Config, new Config({}));
        const __VLS_40 = __VLS_39({}, ...__VLS_functionalComponentArgsRest(__VLS_39));
    }
    else if (__VLS_ctx.currentView === 'tunnel') {
        /** @type {[typeof Tunnel, ]} */ ;
        // @ts-ignore
        const __VLS_42 = __VLS_asFunctionalComponent(Tunnel, new Tunnel({}));
        const __VLS_43 = __VLS_42({}, ...__VLS_functionalComponentArgsRest(__VLS_42));
    }
    else if (__VLS_ctx.currentView === 'cleanup') {
        /** @type {[typeof Cleanup, ]} */ ;
        // @ts-ignore
        const __VLS_45 = __VLS_asFunctionalComponent(Cleanup, new Cleanup({}));
        const __VLS_46 = __VLS_45({}, ...__VLS_functionalComponentArgsRest(__VLS_45));
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
    /** @type {[typeof FloatingChat, ]} */ ;
    // @ts-ignore
    const __VLS_48 = __VLS_asFunctionalComponent(FloatingChat, new FloatingChat({
        inQueryPage: (__VLS_ctx.currentView === 'query'),
    }));
    const __VLS_49 = __VLS_48({
        inQueryPage: (__VLS_ctx.currentView === 'query'),
    }, ...__VLS_functionalComponentArgsRest(__VLS_48));
}
/** @type {__VLS_StyleScopedClasses['floating-mode']} */ ;
/** @type {__VLS_StyleScopedClasses['app-root']} */ ;
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
/** @type {__VLS_StyleScopedClasses['nav-toggle']} */ ;
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
            FloatingChat: FloatingChat,
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
            isFloatingMode: isFloatingMode,
            navCollapsed: navCollapsed,
            toggleNav: toggleNav,
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
