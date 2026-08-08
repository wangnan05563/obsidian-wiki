/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { Lightning, Iphone, Link, Close, StarFilled, Document } from '@element-plus/icons-vue';
import { Network } from 'vis-network';
import { DataSet } from 'vis-data';
const containerRef = ref(null);
const loading = ref(false);
const nodeCount = ref(0);
const edgeCount = ref(0);
let network = null;
// FR-16-1 Discover Sources 状态
// 右键菜单：contextMenu.visible 控制显示，contextMenu.x/y 是相对画布坐标
// 为什么用画布坐标：菜单是 graph-card 子元素，position absolute 相对父容器定位
const contextMenu = ref({
    visible: false,
    x: 0,
    y: 0,
    pagePath: '',
});
// 推荐侧边栏：selectedPage 为空时侧边栏隐藏
const selectedPage = ref('');
const recommendations = ref([]);
const recommendLoading = ref(false);
// 链接建立中的目标 path，用于按钮 loading 状态
const linkingPath = ref('');
// §12.3-2 大节点降级：节点数超过阈值时切换为高性能模式
// 200 节点以下：完整渲染（平滑曲线 + 阴影 + 悬停）
// 200-500 节点：关闭平滑曲线与阴影，保留物理引擎
// 500+ 节点：关闭物理引擎稳定（直接布局），简化节点样式
const LARGE_THRESHOLD = 200;
const HUGE_THRESHOLD = 500;
const isLarge = computed(() => nodeCount.value >= LARGE_THRESHOLD && nodeCount.value < HUGE_THRESHOLD);
const isHuge = computed(() => nodeCount.value >= HUGE_THRESHOLD);
const degraded = computed(() => isLarge.value || isHuge.value);
// §12.3-3 响应式小屏降级：窄屏切换为列表视图
const isNarrowScreen = ref(false);
const listView = ref(false);
// FR-15-5：类型过滤 + 实体子图视图模式
// typeFilter: 空字符串=全部，否则按目录首段过滤（与 SCHEMA.md type 枚举对齐）
// entityOnly: 实体子图模式，只显示 entities/ 节点及其一阶邻居（入链+出链）
const typeFilter = ref('');
const entityOnly = ref(false);
// 6 目录与中文标签映射（复用图例标签，避免重复维护）
const DIR_OPTIONS = [
    { label: '全部类型', value: '' },
    { label: '实体', value: 'entities' },
    { label: '概念', value: 'concepts' },
    { label: '对比', value: 'comparisons' },
    { label: '问答', value: 'queries' },
    { label: '业务问答', value: 'qa' },
    { label: '方案沉淀', value: 'solutions' },
];
// Read theme color from CSS variable (theme-aware)
function getThemeVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#b026ff';
}
// Directory color mapping: read from CSS vars so nodes follow the active theme
// FR-15-5：补全 6 目录颜色，与 SCHEMA.md type 枚举对齐
function getDirColors() {
    return {
        entities: getThemeVar('--graph-entities'),
        concepts: getThemeVar('--graph-concepts'),
        comparisons: getThemeVar('--graph-comparisons'),
        queries: getThemeVar('--graph-queries'),
        qa: getThemeVar('--graph-qa'),
        solutions: getThemeVar('--graph-solutions'),
    };
}
function getDirBorders() {
    return {
        entities: getThemeVar('--graph-entities-border'),
        concepts: getThemeVar('--graph-concepts-border'),
        comparisons: getThemeVar('--graph-comparisons-border'),
        queries: getThemeVar('--graph-queries-border'),
        qa: getThemeVar('--graph-qa-border'),
        solutions: getThemeVar('--graph-solutions-border'),
    };
}
// 检测屏幕宽度，窄屏（<768px）自动切换列表视图
function checkScreenSize() {
    isNarrowScreen.value = window.innerWidth < 768;
}
// FR-15-5：过滤图谱数据
// - typeFilter: 按目录首段过滤节点（仅保留该目录的节点 + 相连的边）
// - entityOnly: 实体子图模式，只显示 entities/ 节点及其一阶邻居（入链+出链）
// 为什么 entityOnly 优先于 typeFilter：实体子图是更严格的过滤模式，两者同时开启时以实体子图为准
function filterGraphData(data) {
    if (!typeFilter.value && !entityOnly.value)
        return data;
    let keptNodes;
    if (entityOnly.value) {
        // 实体子图：entities 节点 + 一阶邻居（入链+出链目标）
        // 为什么包含一阶邻居：实体图谱需展示实体与其他页面的关联关系
        const entityNodes = new Set(data.nodes.filter((n) => n.startsWith('entities/')));
        keptNodes = new Set(entityNodes);
        for (const edge of data.edges) {
            if (entityNodes.has(edge.from))
                keptNodes.add(edge.to);
            if (entityNodes.has(edge.to))
                keptNodes.add(edge.from);
        }
    }
    else {
        // 类型过滤：只保留该目录的节点
        keptNodes = new Set(data.nodes.filter((n) => {
            const dir = n.split('/')[0] ?? '';
            return dir === typeFilter.value;
        }));
    }
    const nodes = data.nodes.filter((n) => keptNodes.has(n));
    const edges = data.edges.filter((e) => keptNodes.has(e.from) && keptNodes.has(e.to));
    return { nodes, edges };
}
// FR-15-5：切换实体子图模式
// 为什么切换时清空 typeFilter：避免两个过滤模式冲突
function toggleEntityOnly() {
    entityOnly.value = !entityOnly.value;
    if (entityOnly.value)
        typeFilter.value = '';
    loadGraph();
}
// 加载图谱数据并渲染
async function loadGraph() {
    loading.value = true;
    try {
        const res = await fetch(`${API_BASE}/graph`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        // FR-15-5：按类型过滤 + 实体子图模式
        const data = filterGraphData(raw);
        nodeCount.value = data.nodes.length;
        edgeCount.value = data.edges.length;
        // 窄屏或用户手动切换时用列表视图，否则用图谱
        if (isNarrowScreen.value || listView.value) {
            renderList(data);
        }
        else {
            renderGraph(data);
        }
    }
    catch (err) {
        ElMessage.error('加载图谱失败：' + err.message);
    }
    finally {
        loading.value = false;
    }
}
// §12.3-3 小屏降级：列表视图，按目录分组展示页面与链接
// 保留原始数据，避免 vis-network 在小屏的渲染开销
function renderList(data) {
    if (network) {
        network.destroy();
        network = null;
    }
    // 列表数据存到 listData，template 中渲染
    listData.value = buildListData(data);
}
const listData = ref([]);
function buildListData(data) {
    // 统计每个页面的出链数
    const linkCounts = new Map();
    for (const e of data.edges) {
        linkCounts.set(e.from, (linkCounts.get(e.from) ?? 0) + 1);
    }
    // 按目录分组
    const groups = new Map();
    for (const path of data.nodes) {
        const parts = path.split('/');
        const dir = parts[0] ?? 'default';
        const name = parts[parts.length - 1]?.replace('.md', '') ?? path;
        if (!groups.has(dir))
            groups.set(dir, []);
        groups.get(dir).push({ path, name, links: linkCounts.get(path) ?? 0 });
    }
    // 转为数组
    return Array.from(groups.entries()).map(([dir, pages]) => ({
        dir,
        color: getDirColors()[dir] ?? getThemeVar('--graph-comparisons'),
        pages: pages.sort((a, b) => b.links - a.links),
    }));
}
// 构建节点：根据降级级别调整样式，霓虹色 + 发光阴影；大图模式简化样式降低 GPU 开销
function buildNodes(data, huge, large) {
    // 提前计算节点尺寸，避免嵌套三元运算符
    let nodeSize = 16;
    if (large)
        nodeSize = 12;
    if (huge)
        nodeSize = 8;
    return data.nodes.map((path) => {
        const parts = path.split('/');
        const dir = parts[0] ?? 'default';
        const label = parts[parts.length - 1]?.replace('.md', '') ?? path;
        const bg = getDirColors()[dir] ?? getThemeVar('--graph-comparisons');
        const border = getDirBorders()[dir] ?? getThemeVar('--graph-comparisons-border');
        return {
            id: path,
            // 超大图隐藏标签，仅悬停显示，减少 DOM 开销
            label: huge ? '' : label,
            title: label,
            color: { background: bg, border: border, highlight: { background: border, border: bg } },
            shape: 'dot',
            size: nodeSize,
            font: { size: huge ? 10 : 12, color: getThemeVar('--graph-label'), face: 'Rajdhani' },
            // 发光阴影：用节点同色系，营造霓虹辉光
            shadow: huge ? false : { enabled: true, size: 18, color: bg + 'aa' },
        };
    });
}
// 构建边：半透明霓虹紫，大图模式关闭平滑曲线减少 Canvas 绘制
function buildEdges(data, huge, large) {
    return data.edges.map((e, idx) => ({
        id: idx,
        from: e.from,
        to: e.to,
        arrows: 'to',
        color: { color: getThemeVar('--graph-edge'), highlight: getThemeVar('--graph-edge-highlight'), opacity: huge ? 0.25 : 0.5 },
        width: huge ? 1 : 1.5,
        smooth: !large && !huge,
    }));
}
// vis-network 配置：根据节点数自适应降级
function buildGraphOptions(huge, large) {
    // 提前计算迭代次数，避免嵌套三元运算符
    let stabilizationIterations = 100;
    if (large)
        stabilizationIterations = 80;
    if (huge)
        stabilizationIterations = 50;
    return {
        nodes: {
            borderWidth: huge ? 1 : 2,
        },
        edges: {
            // §12.3-2 大图降级：关闭 smooth 减少 GPU 开销
            smooth: large || huge ? false : { enabled: true, type: 'continuous', roundness: 0.5 },
        },
        physics: {
            enabled: true,
            // 超大图减少稳定迭代次数，快速进入静态布局
            stabilization: { iterations: stabilizationIterations },
            barnesHut: {
                gravitationalConstant: huge ? -5000 : -3000,
                springLength: huge ? 80 : 120,
                springConstant: 0.04,
            },
        },
        interaction: {
            hover: !huge,
            tooltipDelay: 200,
            zoomView: true,
        },
    };
}
// 将后端 nodes/edges 转为 vis-network 格式
function renderGraph(data) {
    if (!containerRef.value)
        return;
    const huge = isHuge.value;
    const large = isLarge.value;
    const nodes = buildNodes(data, huge, large);
    const edges = buildEdges(data, huge, large);
    const nodesDS = new DataSet(nodes);
    const edgesDS = new DataSet(edges);
    const options = buildGraphOptions(huge, large);
    if (network) {
        network.destroy();
    }
    network = new Network(containerRef.value, { nodes: nodesDS, edges: edgesDS }, options);
    // FR-16-1 右键节点弹出上下文菜单
    // 为什么用 oncontext 而非 oncontext({node})：vis-network 的 oncontext 回调签名无 node 参数，
    // 需用 getNodeAt(pointer.DOM) 显式查询，否则拿到 undefined
    network.on('oncontext', (params) => {
        // 阻止默认浏览器右键菜单
        if (params.event) {
            params.event.preventDefault();
        }
        if (!network)
            return;
        // pointer.DOM 是相对画布的坐标，用于菜单定位
        const nodeId = network.getNodeAt(params.pointer.DOM);
        if (typeof nodeId === 'string' && nodeId) {
            // 转换为相对 graph-card 的坐标（菜单的定位父元素）
            const canvasRect = containerRef.value?.getBoundingClientRect();
            const cardRect = containerRef.value?.parentElement?.getBoundingClientRect();
            if (canvasRect && cardRect) {
                contextMenu.value = {
                    visible: true,
                    x: canvasRect.left - cardRect.left + params.pointer.DOM.x,
                    y: canvasRect.top - cardRect.top + params.pointer.DOM.y,
                    pagePath: nodeId,
                };
            }
        }
        else {
            // 点空白处隐藏菜单
            contextMenu.value.visible = false;
        }
    });
    // 左键点击节点也加载推荐（提升发现性，右键作为高级入口）
    network.on('click', (params) => {
        if (params.nodes.length > 0) {
            const nodeId = params.nodes[0];
            // 不弹菜单，直接打开侧边栏加载推荐
            openRecommendations(nodeId);
        }
    });
}
// FR-16-1 加载推荐页面列表
async function openRecommendations(pagePath) {
    selectedPage.value = pagePath;
    contextMenu.value.visible = false;
    recommendLoading.value = true;
    recommendations.value = [];
    try {
        const url = `${API_BASE}/discover/recommend?pagePath=${encodeURIComponent(pagePath)}`;
        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        const data = (await res.json());
        recommendations.value = data.recommendations;
        if (data.recommendations.length === 0) {
            ElMessage.info('未找到相关但未连接的笔记');
        }
    }
    catch (err) {
        ElMessage.error('加载推荐失败：' + err.message);
    }
    finally {
        recommendLoading.value = false;
    }
}
// FR-16-1 一键建立双链
async function createLink(targetPath) {
    if (!selectedPage.value)
        return;
    linkingPath.value = targetPath;
    try {
        const res = await fetch(`${API_BASE}/discover/link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourcePath: selectedPage.value, targetPath }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        ElMessage.success('已建立双链：' + targetPath);
        // 从推荐列表移除已链接的项
        recommendations.value = recommendations.value.filter((r) => r.path !== targetPath);
        // 刷新图谱以显示新边
        await loadGraph();
    }
    catch (err) {
        ElMessage.error('建立双链失败：' + err.message);
    }
    finally {
        linkingPath.value = '';
    }
}
// 关闭推荐侧边栏
function closeRecommendations() {
    selectedPage.value = '';
    recommendations.value = [];
}
// 关闭右键菜单（点击菜单外区域时触发）
function closeContextMenu() {
    contextMenu.value.visible = false;
}
// FR-15-5（AC-15-7）：打开笔记到 Browse 视图
// 复用 RefsList.vue 的 karpathy:jump-vault 事件机制，App.vue 监听后切换到 browse 视图，
// Browse.vue onMounted 读取 sessionStorage.karpathy:jumpPath 自动定位到对应文件
function openPageInBrowse(pagePath) {
    sessionStorage.setItem('karpathy:jumpPath', pagePath);
    globalThis.dispatchEvent(new CustomEvent('karpathy:jump-vault', { detail: { path: pagePath } }));
    contextMenu.value.visible = false;
}
onMounted(() => {
    checkScreenSize();
    window.addEventListener('resize', handleResize);
    loadGraph();
});
onBeforeUnmount(() => {
    // 清理 vis-network 实例与事件监听，避免内存泄漏
    if (network) {
        network.destroy();
        network = null;
    }
    window.removeEventListener('resize', handleResize);
});
// 窗口大小变化时：窄屏切换列表，宽屏重绘图谱
function handleResize() {
    checkScreenSize();
    if (network && !isNarrowScreen.value && !listView.value) {
        network.redraw();
    }
}
// 切换视图模式
function toggleView() {
    listView.value = !listView.value;
    loadGraph();
}
// 窗口大小变化时重新绘制
watch(loading, () => {
    if (network && !loading.value) {
        network.redraw();
    }
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-canvas-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['page-item']} */ ;
/** @type {__VLS_StyleScopedClasses['ctx-item']} */ ;
/** @type {__VLS_StyleScopedClasses['ctx-item']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-close']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-card']} */ ;
/** @type {__VLS_StyleScopedClasses['rec-path']} */ ;
/** @type {__VLS_StyleScopedClasses['rec-link-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-panel']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "graph-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card graph-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "graph-head" },
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
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "graph-stats" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "stat-chip grad-cool-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "chip-num" },
});
(__VLS_ctx.nodeCount);
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "chip-label" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "stat-chip grad-fire-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "chip-num" },
});
(__VLS_ctx.edgeCount);
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "chip-label" },
});
const __VLS_0 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
}));
const __VLS_2 = __VLS_1({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_4;
let __VLS_5;
let __VLS_6;
const __VLS_7 = {
    onClick: (__VLS_ctx.toggleView)
};
__VLS_3.slots.default;
(__VLS_ctx.listView ? '图谱视图' : '列表视图');
var __VLS_3;
const __VLS_8 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.loading),
}));
const __VLS_10 = __VLS_9({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.loading),
}, ...__VLS_functionalComponentArgsRest(__VLS_9));
let __VLS_12;
let __VLS_13;
let __VLS_14;
const __VLS_15 = {
    onClick: (__VLS_ctx.loadGraph)
};
__VLS_11.slots.default;
var __VLS_11;
if (!__VLS_ctx.listView) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "graph-filter-bar" },
    });
    const __VLS_16 = {}.ElSelect;
    /** @type {[typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.typeFilter),
        placeholder: "类型筛选",
        size: "small",
        clearable: true,
        ...{ class: "graph-type-select" },
    }));
    const __VLS_18 = __VLS_17({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.typeFilter),
        placeholder: "类型筛选",
        size: "small",
        clearable: true,
        ...{ class: "graph-type-select" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
    let __VLS_20;
    let __VLS_21;
    let __VLS_22;
    const __VLS_23 = {
        onChange: (__VLS_ctx.loadGraph)
    };
    __VLS_19.slots.default;
    for (const [opt] of __VLS_getVForSourceType((__VLS_ctx.DIR_OPTIONS))) {
        const __VLS_24 = {}.ElOption;
        /** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
        // @ts-ignore
        const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
            key: (opt.value),
            label: (opt.label),
            value: (opt.value),
        }));
        const __VLS_26 = __VLS_25({
            key: (opt.value),
            label: (opt.label),
            value: (opt.value),
        }, ...__VLS_functionalComponentArgsRest(__VLS_25));
    }
    var __VLS_19;
    const __VLS_28 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: (['neon-btn', { 'entity-active': __VLS_ctx.entityOnly }]) },
    }));
    const __VLS_30 = __VLS_29({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: (['neon-btn', { 'entity-active': __VLS_ctx.entityOnly }]) },
    }, ...__VLS_functionalComponentArgsRest(__VLS_29));
    let __VLS_32;
    let __VLS_33;
    let __VLS_34;
    const __VLS_35 = {
        onClick: (__VLS_ctx.toggleEntityOnly)
    };
    __VLS_31.slots.default;
    (__VLS_ctx.entityOnly ? '退出实体子图' : '实体子图');
    var __VLS_31;
}
if (__VLS_ctx.degraded && !__VLS_ctx.listView) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "degrade-bar" },
    });
    const __VLS_36 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
        ...{ class: "degrade-icon" },
    }));
    const __VLS_38 = __VLS_37({
        ...{ class: "degrade-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_37));
    __VLS_39.slots.default;
    const __VLS_40 = {}.Lightning;
    /** @type {[typeof __VLS_components.Lightning, ]} */ ;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({}));
    const __VLS_42 = __VLS_41({}, ...__VLS_functionalComponentArgsRest(__VLS_41));
    var __VLS_39;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "degrade-text" },
    });
    (__VLS_ctx.isHuge ? '节点数超过 500，已启用超大图模式（简化样式 + 快速布局）' : '节点数超过 200，已启用性能优化模式');
}
if (__VLS_ctx.isNarrowScreen && !__VLS_ctx.listView) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "degrade-bar" },
    });
    const __VLS_44 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
        ...{ class: "degrade-icon" },
    }));
    const __VLS_46 = __VLS_45({
        ...{ class: "degrade-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_45));
    __VLS_47.slots.default;
    const __VLS_48 = {}.Iphone;
    /** @type {[typeof __VLS_components.Iphone, ]} */ ;
    // @ts-ignore
    const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({}));
    const __VLS_50 = __VLS_49({}, ...__VLS_functionalComponentArgsRest(__VLS_49));
    var __VLS_47;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "degrade-text" },
    });
}
if (!__VLS_ctx.listView) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "legend-bar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "legend-item" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "legend-dot" },
        ...{ style: {} },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "legend-item" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "legend-dot" },
        ...{ style: {} },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "legend-item" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "legend-dot" },
        ...{ style: {} },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "legend-item" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "legend-dot" },
        ...{ style: {} },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "legend-item" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "legend-dot" },
        ...{ style: {} },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "legend-item" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "legend-dot" },
        ...{ style: {} },
    });
}
if (!__VLS_ctx.listView) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "graph-canvas-wrapper" },
    });
    if (__VLS_ctx.loading) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "graph-loading" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "loading-text" },
        });
    }
    else if (__VLS_ctx.nodeCount === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "graph-empty" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "empty-tip" },
        });
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ref: "containerRef",
        ...{ class: "graph-canvas" },
    });
    __VLS_asFunctionalDirective(__VLS_directives.vShow)(null, { ...__VLS_directiveBindingRestFields, value: (!__VLS_ctx.loading && __VLS_ctx.nodeCount > 0) }, null, null);
    /** @type {typeof __VLS_ctx.containerRef} */ ;
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "list-view-wrapper" },
    });
    if (__VLS_ctx.loading) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "graph-loading" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "loading-text" },
        });
    }
    else if (__VLS_ctx.listData.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "graph-empty" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "empty-tip" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "list-groups" },
        });
        for (const [group] of __VLS_getVForSourceType((__VLS_ctx.listData))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (group.dir),
                ...{ class: "list-group hover-glow" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "group-head" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "group-dot" },
                ...{ style: ({ background: group.color, boxShadow: `0 0 12px ${group.color}` }) },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "group-name" },
            });
            (group.dir);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "group-count" },
            });
            (group.pages.length);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "group-pages" },
            });
            for (const [page] of __VLS_getVForSourceType((group.pages))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ onClick: (...[$event]) => {
                            if (!!(!__VLS_ctx.listView))
                                return;
                            if (!!(__VLS_ctx.loading))
                                return;
                            if (!!(__VLS_ctx.listData.length === 0))
                                return;
                            __VLS_ctx.openRecommendations(page.path);
                        } },
                    key: (page.path),
                    ...{ class: "page-item" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "page-name" },
                });
                (page.name);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "page-links" },
                });
                (page.links);
            }
        }
    }
}
if (__VLS_ctx.contextMenu.visible && !__VLS_ctx.listView) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: () => { } },
        ...{ class: "ctx-menu" },
        ...{ style: ({ left: __VLS_ctx.contextMenu.x + 'px', top: __VLS_ctx.contextMenu.y + 'px' }) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.contextMenu.visible && !__VLS_ctx.listView))
                    return;
                __VLS_ctx.openPageInBrowse(__VLS_ctx.contextMenu.pagePath);
            } },
        ...{ class: "ctx-item" },
    });
    const __VLS_52 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({
        ...{ class: "ctx-icon" },
    }));
    const __VLS_54 = __VLS_53({
        ...{ class: "ctx-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_53));
    __VLS_55.slots.default;
    const __VLS_56 = {}.Document;
    /** @type {[typeof __VLS_components.Document, ]} */ ;
    // @ts-ignore
    const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({}));
    const __VLS_58 = __VLS_57({}, ...__VLS_functionalComponentArgsRest(__VLS_57));
    var __VLS_55;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.contextMenu.visible && !__VLS_ctx.listView))
                    return;
                __VLS_ctx.openRecommendations(__VLS_ctx.contextMenu.pagePath);
            } },
        ...{ class: "ctx-item" },
    });
    const __VLS_60 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({
        ...{ class: "ctx-icon" },
    }));
    const __VLS_62 = __VLS_61({
        ...{ class: "ctx-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_61));
    __VLS_63.slots.default;
    const __VLS_64 = {}.Link;
    /** @type {[typeof __VLS_components.Link, ]} */ ;
    // @ts-ignore
    const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({}));
    const __VLS_66 = __VLS_65({}, ...__VLS_functionalComponentArgsRest(__VLS_65));
    var __VLS_63;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (__VLS_ctx.closeContextMenu) },
        ...{ class: "ctx-item ctx-close" },
    });
    const __VLS_68 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_69 = __VLS_asFunctionalComponent(__VLS_68, new __VLS_68({
        ...{ class: "ctx-icon" },
    }));
    const __VLS_70 = __VLS_69({
        ...{ class: "ctx-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_69));
    __VLS_71.slots.default;
    const __VLS_72 = {}.Close;
    /** @type {[typeof __VLS_components.Close, ]} */ ;
    // @ts-ignore
    const __VLS_73 = __VLS_asFunctionalComponent(__VLS_72, new __VLS_72({}));
    const __VLS_74 = __VLS_73({}, ...__VLS_functionalComponentArgsRest(__VLS_73));
    var __VLS_71;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
}
if (__VLS_ctx.selectedPage) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "recommend-panel" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "recommend-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "recommend-title" },
    });
    const __VLS_76 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_77 = __VLS_asFunctionalComponent(__VLS_76, new __VLS_76({
        ...{ class: "recommend-icon" },
    }));
    const __VLS_78 = __VLS_77({
        ...{ class: "recommend-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_77));
    __VLS_79.slots.default;
    const __VLS_80 = {}.Lightning;
    /** @type {[typeof __VLS_components.Lightning, ]} */ ;
    // @ts-ignore
    const __VLS_81 = __VLS_asFunctionalComponent(__VLS_80, new __VLS_80({}));
    const __VLS_82 = __VLS_81({}, ...__VLS_functionalComponentArgsRest(__VLS_81));
    var __VLS_79;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.closeRecommendations) },
        ...{ class: "recommend-close" },
        'aria-label': "关闭",
    });
    const __VLS_84 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_85 = __VLS_asFunctionalComponent(__VLS_84, new __VLS_84({}));
    const __VLS_86 = __VLS_85({}, ...__VLS_functionalComponentArgsRest(__VLS_85));
    __VLS_87.slots.default;
    const __VLS_88 = {}.Close;
    /** @type {[typeof __VLS_components.Close, ]} */ ;
    // @ts-ignore
    const __VLS_89 = __VLS_asFunctionalComponent(__VLS_88, new __VLS_88({}));
    const __VLS_90 = __VLS_89({}, ...__VLS_functionalComponentArgsRest(__VLS_89));
    var __VLS_87;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "recommend-source" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "source-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
        ...{ class: "source-path" },
    });
    (__VLS_ctx.selectedPage);
    if (__VLS_ctx.recommendLoading) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "recommend-loading" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
    }
    else if (__VLS_ctx.recommendations.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "recommend-empty" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "recommend-list" },
        });
        for (const [rec] of __VLS_getVForSourceType((__VLS_ctx.recommendations))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (rec.path),
                ...{ class: "recommend-card" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "rec-head" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "rec-title" },
            });
            (rec.title);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "rec-score" },
                title: (`匹配 ${rec.score} 个维度`),
            });
            const __VLS_92 = {}.ElIcon;
            /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
            // @ts-ignore
            const __VLS_93 = __VLS_asFunctionalComponent(__VLS_92, new __VLS_92({}));
            const __VLS_94 = __VLS_93({}, ...__VLS_functionalComponentArgsRest(__VLS_93));
            __VLS_95.slots.default;
            const __VLS_96 = {}.StarFilled;
            /** @type {[typeof __VLS_components.StarFilled, ]} */ ;
            // @ts-ignore
            const __VLS_97 = __VLS_asFunctionalComponent(__VLS_96, new __VLS_96({}));
            const __VLS_98 = __VLS_97({}, ...__VLS_functionalComponentArgsRest(__VLS_97));
            var __VLS_95;
            (rec.score);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "rec-path" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
            (rec.path);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "rec-reasons" },
            });
            for (const [reason, idx] of __VLS_getVForSourceType((rec.reasons))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    key: (idx),
                    ...{ class: "rec-reason" },
                });
                (reason);
            }
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.selectedPage))
                            return;
                        if (!!(__VLS_ctx.recommendLoading))
                            return;
                        if (!!(__VLS_ctx.recommendations.length === 0))
                            return;
                        __VLS_ctx.createLink(rec.path);
                    } },
                ...{ class: "neon-btn rec-link-btn" },
                disabled: (__VLS_ctx.linkingPath === rec.path),
            });
            (__VLS_ctx.linkingPath === rec.path ? '建立中…' : '建立双链');
        }
    }
}
/** @type {__VLS_StyleScopedClasses['graph-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-stats']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-cool-text']} */ ;
/** @type {__VLS_StyleScopedClasses['chip-num']} */ ;
/** @type {__VLS_StyleScopedClasses['chip-label']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-fire-text']} */ ;
/** @type {__VLS_StyleScopedClasses['chip-num']} */ ;
/** @type {__VLS_StyleScopedClasses['chip-label']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-filter-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-type-select']} */ ;
/** @type {__VLS_StyleScopedClasses['degrade-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['degrade-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['degrade-text']} */ ;
/** @type {__VLS_StyleScopedClasses['degrade-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['degrade-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['degrade-text']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-item']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-item']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-item']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-item']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-item']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-item']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-canvas-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-text']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-canvas']} */ ;
/** @type {__VLS_StyleScopedClasses['list-view-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-text']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['list-groups']} */ ;
/** @type {__VLS_StyleScopedClasses['list-group']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['group-head']} */ ;
/** @type {__VLS_StyleScopedClasses['group-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['group-name']} */ ;
/** @type {__VLS_StyleScopedClasses['group-count']} */ ;
/** @type {__VLS_StyleScopedClasses['group-pages']} */ ;
/** @type {__VLS_StyleScopedClasses['page-item']} */ ;
/** @type {__VLS_StyleScopedClasses['page-name']} */ ;
/** @type {__VLS_StyleScopedClasses['page-links']} */ ;
/** @type {__VLS_StyleScopedClasses['ctx-menu']} */ ;
/** @type {__VLS_StyleScopedClasses['ctx-item']} */ ;
/** @type {__VLS_StyleScopedClasses['ctx-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['ctx-item']} */ ;
/** @type {__VLS_StyleScopedClasses['ctx-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['ctx-item']} */ ;
/** @type {__VLS_StyleScopedClasses['ctx-close']} */ ;
/** @type {__VLS_StyleScopedClasses['ctx-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-head']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-title']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-close']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-source']} */ ;
/** @type {__VLS_StyleScopedClasses['source-label']} */ ;
/** @type {__VLS_StyleScopedClasses['source-path']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-list']} */ ;
/** @type {__VLS_StyleScopedClasses['recommend-card']} */ ;
/** @type {__VLS_StyleScopedClasses['rec-head']} */ ;
/** @type {__VLS_StyleScopedClasses['rec-title']} */ ;
/** @type {__VLS_StyleScopedClasses['rec-score']} */ ;
/** @type {__VLS_StyleScopedClasses['rec-path']} */ ;
/** @type {__VLS_StyleScopedClasses['rec-reasons']} */ ;
/** @type {__VLS_StyleScopedClasses['rec-reason']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['rec-link-btn']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Lightning: Lightning,
            Iphone: Iphone,
            Link: Link,
            Close: Close,
            StarFilled: StarFilled,
            Document: Document,
            containerRef: containerRef,
            loading: loading,
            nodeCount: nodeCount,
            edgeCount: edgeCount,
            contextMenu: contextMenu,
            selectedPage: selectedPage,
            recommendations: recommendations,
            recommendLoading: recommendLoading,
            linkingPath: linkingPath,
            isHuge: isHuge,
            degraded: degraded,
            isNarrowScreen: isNarrowScreen,
            listView: listView,
            typeFilter: typeFilter,
            entityOnly: entityOnly,
            DIR_OPTIONS: DIR_OPTIONS,
            toggleEntityOnly: toggleEntityOnly,
            loadGraph: loadGraph,
            listData: listData,
            openRecommendations: openRecommendations,
            createLink: createLink,
            closeRecommendations: closeRecommendations,
            closeContextMenu: closeContextMenu,
            openPageInBrowse: openPageInBrowse,
            toggleView: toggleView,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
