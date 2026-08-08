/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { CopyDocument, Refresh, Check, Top, Warning, Search } from '@element-plus/icons-vue';
// ===== 文案集中 =====
const TEXTS = {
    pageTitle: '关于',
    productName: 'Karpathy Wiki',
    h1Title: '关于 Karpathy Wiki',
    versionLabel: '版本',
    releasedOn: '发布于',
    copyHint: '复制完整版本号',
    copyAriaLabel: '复制版本号',
    copied: '已复制',
    copyFailed: '复制失败，请手动选择',
    updateIdle: '检查更新',
    updateLoading: '检查中…',
    updateLatest: '已是最新',
    updateNewer: '有新版本',
    updateErrorNetwork: '网络异常',
    updateErrorServer: '服务异常',
    updateRetry: '重试',
    updateAutoCheckHint: '每 5 分钟自动检查一次',
    footerCopyright: 'Karpathy Wiki',
    riskDisclaimer: '本工具仅供个人学习研究使用，详见 README 中的"风险免责"',
    menu: {
        terms: '用户协议',
        privacy: '隐私条款',
        licenses: '开源软件声明',
        help: '帮助文档',
        api: 'API 文档',
        contact: '联系我们',
        community: '官方社区',
        report: '报告问题',
    },
    licensesSearchPlaceholder: '搜索依赖名 / 许可证…',
    licensesTitle: '开源软件声明',
    licensesFooter: '以运行时实际安装为准',
    emptySearch: '未找到匹配的依赖',
};
// ===== 兜底值 =====
const FALLBACK_INFO = {
    version: '--',
    buildDate: '--',
    gitSha: 'unknown',
    node: '--',
    platform: '--',
};
// ===== 8 项菜单（参考闲鱼 §5.1）=====
const MENU_ITEMS = [
    // GitHub 仓库主页作为用户协议入口（暂用占位，部署时改）
    { key: 'terms', label: TEXTS.menu.terms, href: 'https://github.com/karpathy/karpathy.github.io', external: true },
    { key: 'privacy', label: TEXTS.menu.privacy, href: 'https://github.com/karpathy/karpathy.github.io', external: true },
    // licenses 触发 Modal，不走链接
    { key: 'licenses', label: TEXTS.menu.licenses, href: '#licenses', external: false },
    // help 为 SPA 内链，由父组件 App.vue 监听 custom event 切换视图
    { key: 'help', label: TEXTS.menu.help, href: '#help', external: false, internal: true },
    // 本项目无 OpenAPI Swagger，API 文档链接到 GitHub README
    { key: 'api', label: TEXTS.menu.api, href: 'https://github.com/karpathy/karpathy.github.io', external: true },
    { key: 'contact', label: TEXTS.menu.contact, href: 'mailto:noreply@karpathy.wiki', external: true },
    { key: 'community', label: TEXTS.menu.community, href: 'https://github.com/karpathy/karpathy.github.io/discussions', external: true },
    { key: 'report', label: TEXTS.menu.report, href: 'https://github.com/karpathy/karpathy.github.io/issues/new', external: true },
];
// ===== 静态依赖清单（首版手动维护，P2 接入 license-checker 自动生成）=====
// 数据来源：frontend/package.json + api/package.json
const FRONTEND_DEPS = [
    { name: '@element-plus/icons-vue', version: '^2.3.0', license: 'MIT', repo: 'https://github.com/element-plus/element-plus-icons' },
    { name: 'element-plus', version: '^2.6.0', license: 'MIT', repo: 'https://github.com/element-plus/element-plus' },
    { name: 'markdown-it', version: '^14.1.0', license: 'MIT', repo: 'https://github.com/markdown-it/markdown-it' },
    { name: 'pinia', version: '^2.1.0', license: 'MIT', repo: 'https://github.com/vuejs/pinia' },
    { name: 'vis-data', version: '^8.0.4', license: 'Apache-2.0', repo: 'https://github.com/visjs/vis-network' },
    { name: 'vis-network', version: '^10.1.0', license: 'Apache-2.0/MIT', repo: 'https://github.com/visjs/vis-network' },
    { name: 'vue', version: '^3.4.0', license: 'MIT', repo: 'https://github.com/vuejs/core' },
    { name: '@vitejs/plugin-vue', version: '^5.0.0', license: 'MIT', repo: 'https://github.com/vitejs/vite-plugin-vue' },
    { name: 'typescript', version: '^5.4.0', license: 'Apache-2.0', repo: 'https://github.com/microsoft/TypeScript' },
    { name: 'vite', version: '^5.1.0', license: 'MIT', repo: 'https://github.com/vitejs/vite' },
    { name: 'vue-tsc', version: '^2.0.0', license: 'MIT', repo: 'https://github.com/vuejs/language-tools' },
];
const BACKEND_DEPS = [
    { name: 'fastify', version: '^4.26.0', license: 'MIT', repo: 'https://github.com/fastify/fastify' },
    { name: '@fastify/multipart', version: '^8.1.0', license: 'MIT', repo: 'https://github.com/fastify/fastify-multipart' },
    { name: '@fastify/static', version: '^7.0.0', license: 'MIT', repo: 'https://github.com/fastify/fastify-static' },
    { name: '@fastify/cors', version: '^9.0.0', license: 'MIT', repo: 'https://github.com/fastify/fastify-cors' },
    { name: '@fastify/helmet', version: '^11.0.0', license: 'MIT', repo: 'https://github.com/fastify/fastify-helmet' },
    { name: '@fastify/rate-limit', version: '^9.0.0', license: 'MIT', repo: 'https://github.com/fastify/fastify-rate-limit' },
    { name: 'gray-matter', version: '^4.0.3', license: 'MIT', repo: 'https://github.com/jonschlinkert/gray-matter' },
    { name: 'tsx', version: '^4.7.0', license: 'MIT', repo: 'https://github.com/privatenumber/tsx' },
];
// 全部依赖按字母序排序
const ALL_DEPS = [...FRONTEND_DEPS, ...BACKEND_DEPS].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
// ===== 状态 =====
const info = ref(FALLBACK_INFO);
const licensesOpen = ref(false);
const search = ref('');
const updateState = ref({ kind: 'idle' });
// 自动检查与 idle 回退的 timer 句柄
let idleTimer = null;
let autoCheckTimer = null;
let mountDelayTimer = null;
let isChecking = false;
// 搜索过滤依赖列表
const filteredDeps = computed(() => {
    const kw = search.value.trim().toLowerCase();
    if (!kw)
        return ALL_DEPS;
    return ALL_DEPS.filter((d) => d.name.toLowerCase().includes(kw) || d.license.toLowerCase().includes(kw));
});
// ===== API 调用 =====
async function loadInfo() {
    try {
        const res = await fetch(`${API_BASE}/about`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        info.value = {
            version: data.version || '--',
            buildDate: data.build_date || '--',
            gitSha: data.git_sha || 'unknown',
            node: data.node || '--',
            platform: data.platform || '--',
        };
    }
    catch {
        // 失败用 FALLBACK 兜底，不阻塞列表渲染
    }
}
// 网络错误判定：fetch 抛 TypeError 通常为网络中断
function isNetworkError(e) {
    if (e instanceof TypeError)
        return true;
    return false;
}
// 检查更新：自动/手动共用，避免重复代码
async function performCheck() {
    if (isChecking)
        return; // 防止自动+手动并发
    isChecking = true;
    updateState.value = { kind: 'loading' };
    try {
        const res = await fetch(`${API_BASE}/about/check-update`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.has_update) {
            updateState.value = {
                kind: 'newer',
                url: data.release_url || '',
                latest: data.latest || '',
            };
        }
        else {
            updateState.value = { kind: 'latest' };
            // 3s 后自动回 idle，让按钮恢复可点击
            if (idleTimer)
                clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                idleTimer = null;
                // 仅在当前为 latest 时回退，避免覆盖 newer/error 终态
                if (updateState.value.kind === 'latest') {
                    updateState.value = { kind: 'idle' };
                }
            }, 3000);
        }
    }
    catch (e) {
        updateState.value = { kind: 'error', reason: isNetworkError(e) ? 'network' : 'server' };
    }
    finally {
        isChecking = false;
    }
}
// 手动检查：用户点击「检查更新」按钮
async function handleCheck() {
    await performCheck();
}
// 复制版本号到剪贴板
async function handleCopy() {
    try {
        await navigator.clipboard.writeText(info.value.version);
        ElMessage.success(TEXTS.copied);
    }
    catch {
        ElMessage.warning(TEXTS.copyFailed);
    }
}
// 菜单项点击：licenses 触发 Modal，help 触发 SPA 内跳转
function handleMenuClick(item, e) {
    if (item.key === 'licenses') {
        e.preventDefault();
        licensesOpen.value = true;
    }
    else if (item.internal && item.key === 'help') {
        e.preventDefault();
        // 派发自定义事件，由 App.vue 监听切换到 Help 视图
        globalThis.dispatchEvent(new CustomEvent('karpathy:navigate', { detail: 'help' }));
    }
}
// 打开新版本 release 页面（newer 状态按钮点击）
function openReleaseUrl(url) {
    if (url) {
        globalThis.open(url, '_blank', 'noopener,noreferrer');
    }
}
onMounted(() => {
    loadInfo();
    // 5s 后发起首次自动检查
    mountDelayTimer = setTimeout(() => {
        performCheck();
    }, 5000);
    // 启动 5 分钟定期检查（与后端缓存对齐）
    autoCheckTimer = setInterval(() => {
        performCheck();
    }, 5 * 60 * 1000);
});
onBeforeUnmount(() => {
    // 卸载时清理所有 timer，避免内存泄漏与对已卸载组件调用 setState
    if (mountDelayTimer)
        clearTimeout(mountDelayTimer);
    if (autoCheckTimer)
        clearInterval(autoCheckTimer);
    if (idleTimer)
        clearTimeout(idleTimer);
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['menu-item']} */ ;
/** @type {__VLS_StyleScopedClasses['menu-item']} */ ;
/** @type {__VLS_StyleScopedClasses['menu-item']} */ ;
/** @type {__VLS_StyleScopedClasses['menu-arrow']} */ ;
/** @type {__VLS_StyleScopedClasses['license-item']} */ ;
/** @type {__VLS_StyleScopedClasses['license-name']} */ ;
/** @type {__VLS_StyleScopedClasses['brand-card']} */ ;
/** @type {__VLS_StyleScopedClasses['update-btn-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['update-btn-wrap']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "about-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card about-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "about-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "head-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "head-title grad-text" },
});
(__VLS_ctx.TEXTS.h1Title);
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "head-tip" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "brand-card hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "brand-left" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "brand-logo" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "brand-info" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "version-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "version-label" },
});
(__VLS_ctx.TEXTS.versionLabel);
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "version-value" },
});
(__VLS_ctx.info.version);
const __VLS_0 = {}.ElTooltip;
/** @type {[typeof __VLS_components.ElTooltip, typeof __VLS_components.elTooltip, typeof __VLS_components.ElTooltip, typeof __VLS_components.elTooltip, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    content: (__VLS_ctx.TEXTS.copyHint),
    placement: "top",
}));
const __VLS_2 = __VLS_1({
    content: (__VLS_ctx.TEXTS.copyHint),
    placement: "top",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.handleCopy) },
    ...{ class: "icon-btn" },
    'aria-label': (__VLS_ctx.TEXTS.copyAriaLabel),
});
const __VLS_4 = {}.ElIcon;
/** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
__VLS_7.slots.default;
const __VLS_8 = {}.CopyDocument;
/** @type {[typeof __VLS_components.CopyDocument, ]} */ ;
// @ts-ignore
const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({}));
const __VLS_10 = __VLS_9({}, ...__VLS_functionalComponentArgsRest(__VLS_9));
var __VLS_7;
var __VLS_3;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "meta-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "meta-text" },
});
(__VLS_ctx.TEXTS.releasedOn);
(__VLS_ctx.info.buildDate);
if (__VLS_ctx.info.gitSha && __VLS_ctx.info.gitSha !== 'unknown') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "meta-sha" },
    });
    (__VLS_ctx.info.gitSha);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "meta-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "meta-dim" },
});
(__VLS_ctx.info.node);
(__VLS_ctx.info.platform);
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "update-btn-wrap" },
});
if (__VLS_ctx.updateState.kind === 'idle') {
    const __VLS_12 = {}.ElTooltip;
    /** @type {[typeof __VLS_components.ElTooltip, typeof __VLS_components.elTooltip, typeof __VLS_components.ElTooltip, typeof __VLS_components.elTooltip, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
        content: (__VLS_ctx.TEXTS.updateAutoCheckHint),
        placement: "top",
    }));
    const __VLS_14 = __VLS_13({
        content: (__VLS_ctx.TEXTS.updateAutoCheckHint),
        placement: "top",
    }, ...__VLS_functionalComponentArgsRest(__VLS_13));
    __VLS_15.slots.default;
    const __VLS_16 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
        ...{ 'onClick': {} },
        type: "primary",
        icon: (__VLS_ctx.Refresh),
    }));
    const __VLS_18 = __VLS_17({
        ...{ 'onClick': {} },
        type: "primary",
        icon: (__VLS_ctx.Refresh),
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
    let __VLS_20;
    let __VLS_21;
    let __VLS_22;
    const __VLS_23 = {
        onClick: (__VLS_ctx.handleCheck)
    };
    __VLS_19.slots.default;
    (__VLS_ctx.TEXTS.updateIdle);
    var __VLS_19;
    var __VLS_15;
}
else if (__VLS_ctx.updateState.kind === 'loading') {
    const __VLS_24 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
        loading: true,
    }));
    const __VLS_26 = __VLS_25({
        loading: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_25));
    __VLS_27.slots.default;
    (__VLS_ctx.TEXTS.updateLoading);
    var __VLS_27;
}
else if (__VLS_ctx.updateState.kind === 'latest') {
    const __VLS_28 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
        type: "success",
        icon: (__VLS_ctx.Check),
        disabled: true,
    }));
    const __VLS_30 = __VLS_29({
        type: "success",
        icon: (__VLS_ctx.Check),
        disabled: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_29));
    __VLS_31.slots.default;
    (__VLS_ctx.TEXTS.updateLatest);
    var __VLS_31;
}
else if (__VLS_ctx.updateState.kind === 'newer') {
    const __VLS_32 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
        ...{ 'onClick': {} },
        type: "primary",
        icon: (__VLS_ctx.Top),
    }));
    const __VLS_34 = __VLS_33({
        ...{ 'onClick': {} },
        type: "primary",
        icon: (__VLS_ctx.Top),
    }, ...__VLS_functionalComponentArgsRest(__VLS_33));
    let __VLS_36;
    let __VLS_37;
    let __VLS_38;
    const __VLS_39 = {
        onClick: (...[$event]) => {
            if (!!(__VLS_ctx.updateState.kind === 'idle'))
                return;
            if (!!(__VLS_ctx.updateState.kind === 'loading'))
                return;
            if (!!(__VLS_ctx.updateState.kind === 'latest'))
                return;
            if (!(__VLS_ctx.updateState.kind === 'newer'))
                return;
            __VLS_ctx.openReleaseUrl(__VLS_ctx.updateState.url);
        }
    };
    __VLS_35.slots.default;
    (__VLS_ctx.TEXTS.updateNewer);
    (__VLS_ctx.updateState.latest);
    var __VLS_35;
}
else {
    const __VLS_40 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
        ...{ 'onClick': {} },
        type: "danger",
        icon: (__VLS_ctx.Warning),
    }));
    const __VLS_42 = __VLS_41({
        ...{ 'onClick': {} },
        type: "danger",
        icon: (__VLS_ctx.Warning),
    }, ...__VLS_functionalComponentArgsRest(__VLS_41));
    let __VLS_44;
    let __VLS_45;
    let __VLS_46;
    const __VLS_47 = {
        onClick: (__VLS_ctx.handleCheck)
    };
    __VLS_43.slots.default;
    (__VLS_ctx.updateState.reason === 'network' ? __VLS_ctx.TEXTS.updateErrorNetwork : __VLS_ctx.TEXTS.updateErrorServer);
    (__VLS_ctx.TEXTS.updateRetry);
    var __VLS_43;
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "menu-list" },
});
for (const [item, idx] of __VLS_getVForSourceType((__VLS_ctx.MENU_ITEMS))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
        ...{ onClick: (...[$event]) => {
                __VLS_ctx.handleMenuClick(item, $event);
            } },
        key: (item.key),
        href: (item.href),
        target: (item.external ? '_blank' : undefined),
        rel: (item.external ? 'noopener noreferrer' : undefined),
        ...{ class: "menu-item hover-glow" },
        ...{ class: ({ 'last-item': idx === __VLS_ctx.MENU_ITEMS.length - 1 }) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "menu-label" },
    });
    (item.label);
    const __VLS_48 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
        ...{ class: "menu-arrow" },
        'aria-hidden': "true",
    }));
    const __VLS_50 = __VLS_49({
        ...{ class: "menu-arrow" },
        'aria-hidden': "true",
    }, ...__VLS_functionalComponentArgsRest(__VLS_49));
    __VLS_51.slots.default;
    const __VLS_52 = {}.Top;
    /** @type {[typeof __VLS_components.Top, ]} */ ;
    // @ts-ignore
    const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({}));
    const __VLS_54 = __VLS_53({}, ...__VLS_functionalComponentArgsRest(__VLS_53));
    var __VLS_51;
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "about-footer" },
});
const __VLS_56 = {}.ElTooltip;
/** @type {[typeof __VLS_components.ElTooltip, typeof __VLS_components.elTooltip, typeof __VLS_components.ElTooltip, typeof __VLS_components.elTooltip, ]} */ ;
// @ts-ignore
const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({
    content: (__VLS_ctx.TEXTS.riskDisclaimer),
    placement: "top",
}));
const __VLS_58 = __VLS_57({
    content: (__VLS_ctx.TEXTS.riskDisclaimer),
    placement: "top",
}, ...__VLS_functionalComponentArgsRest(__VLS_57));
__VLS_59.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "footer-text" },
});
(new Date().getFullYear());
(__VLS_ctx.TEXTS.footerCopyright);
var __VLS_59;
const __VLS_60 = {}.ElDialog;
/** @type {[typeof __VLS_components.ElDialog, typeof __VLS_components.elDialog, typeof __VLS_components.ElDialog, typeof __VLS_components.elDialog, ]} */ ;
// @ts-ignore
const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({
    modelValue: (__VLS_ctx.licensesOpen),
    title: (__VLS_ctx.TEXTS.licensesTitle),
    width: "720",
    destroyOnClose: true,
}));
const __VLS_62 = __VLS_61({
    modelValue: (__VLS_ctx.licensesOpen),
    title: (__VLS_ctx.TEXTS.licensesTitle),
    width: "720",
    destroyOnClose: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_61));
__VLS_63.slots.default;
const __VLS_64 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({
    modelValue: (__VLS_ctx.search),
    placeholder: (__VLS_ctx.TEXTS.licensesSearchPlaceholder),
    prefixIcon: (__VLS_ctx.Search),
    clearable: true,
    ...{ style: {} },
}));
const __VLS_66 = __VLS_65({
    modelValue: (__VLS_ctx.search),
    placeholder: (__VLS_ctx.TEXTS.licensesSearchPlaceholder),
    prefixIcon: (__VLS_ctx.Search),
    clearable: true,
    ...{ style: {} },
}, ...__VLS_functionalComponentArgsRest(__VLS_65));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "licenses-list" },
});
if (__VLS_ctx.filteredDeps.length === 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-hint" },
    });
    (__VLS_ctx.TEXTS.emptySearch);
}
for (const [d] of __VLS_getVForSourceType((__VLS_ctx.filteredDeps))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: (d.name),
        ...{ class: "license-item" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
        href: (d.repo),
        target: "_blank",
        rel: "noopener noreferrer",
        ...{ class: "license-name" },
    });
    (d.name);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "license-version" },
    });
    (d.version);
    const __VLS_68 = {}.ElTag;
    /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
    // @ts-ignore
    const __VLS_69 = __VLS_asFunctionalComponent(__VLS_68, new __VLS_68({
        size: "small",
        type: "info",
        ...{ class: "license-tag" },
    }));
    const __VLS_70 = __VLS_69({
        size: "small",
        type: "info",
        ...{ class: "license-tag" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_69));
    __VLS_71.slots.default;
    (d.license);
    var __VLS_71;
}
{
    const { footer: __VLS_thisSlot } = __VLS_63.slots;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "dialog-footer-hint" },
    });
    (__VLS_ctx.TEXTS.licensesFooter);
}
var __VLS_63;
/** @type {__VLS_StyleScopedClasses['about-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['about-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['about-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['brand-card']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['brand-left']} */ ;
/** @type {__VLS_StyleScopedClasses['brand-logo']} */ ;
/** @type {__VLS_StyleScopedClasses['brand-info']} */ ;
/** @type {__VLS_StyleScopedClasses['version-row']} */ ;
/** @type {__VLS_StyleScopedClasses['version-label']} */ ;
/** @type {__VLS_StyleScopedClasses['version-value']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-text']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-sha']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-dim']} */ ;
/** @type {__VLS_StyleScopedClasses['update-btn-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['menu-list']} */ ;
/** @type {__VLS_StyleScopedClasses['menu-item']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['menu-label']} */ ;
/** @type {__VLS_StyleScopedClasses['menu-arrow']} */ ;
/** @type {__VLS_StyleScopedClasses['about-footer']} */ ;
/** @type {__VLS_StyleScopedClasses['footer-text']} */ ;
/** @type {__VLS_StyleScopedClasses['licenses-list']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['license-item']} */ ;
/** @type {__VLS_StyleScopedClasses['license-name']} */ ;
/** @type {__VLS_StyleScopedClasses['license-version']} */ ;
/** @type {__VLS_StyleScopedClasses['license-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['dialog-footer-hint']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            CopyDocument: CopyDocument,
            Refresh: Refresh,
            Check: Check,
            Top: Top,
            Warning: Warning,
            Search: Search,
            TEXTS: TEXTS,
            MENU_ITEMS: MENU_ITEMS,
            info: info,
            licensesOpen: licensesOpen,
            search: search,
            updateState: updateState,
            filteredDeps: filteredDeps,
            handleCheck: handleCheck,
            handleCopy: handleCopy,
            handleMenuClick: handleMenuClick,
            openReleaseUrl: openReleaseUrl,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
