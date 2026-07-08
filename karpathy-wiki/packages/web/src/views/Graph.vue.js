/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { Network } from 'vis-network';
import { DataSet } from 'vis-data';
import RobotAvatar from '../components/RobotAvatar.vue';
const containerRef = ref(null);
const loading = ref(false);
const nodeCount = ref(0);
const edgeCount = ref(0);
let network = null;
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
// 霓虹目录颜色映射：每个目录对应一种霓虹色，节点带发光描边
const DIR_COLORS = {
    entities: '#ff006e', // 品红
    concepts: '#00f5ff', // 青蓝
    comparisons: '#b026ff', // 电光紫
    queries: '#ff3ec9', // 粉紫
};
// 节点描边色（比填充更亮的同色系，制造发光感）
const DIR_BORDER = {
    entities: '#ff4d94',
    concepts: '#7afaff',
    comparisons: '#d366ff',
    queries: '#ff7ad9',
};
// 检测屏幕宽度，窄屏（<768px）自动切换列表视图
function checkScreenSize() {
    isNarrowScreen.value = window.innerWidth < 768;
}
// 加载图谱数据并渲染
async function loadGraph() {
    loading.value = true;
    try {
        const res = await fetch('/api/graph');
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
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
        color: DIR_COLORS[dir] ?? '#b026ff',
        pages: pages.sort((a, b) => b.links - a.links),
    }));
}
// 将后端 nodes/edges 转为 vis-network 格式
function renderGraph(data) {
    if (!containerRef.value)
        return;
    const huge = isHuge.value;
    const large = isLarge.value;
    // 节点：霓虹色 + 发光阴影；大图模式简化样式降低 GPU 开销
    const nodes = data.nodes.map((path) => {
        const parts = path.split('/');
        const dir = parts[0] ?? 'default';
        const label = parts[parts.length - 1]?.replace('.md', '') ?? path;
        const bg = DIR_COLORS[dir] ?? '#b026ff';
        const border = DIR_BORDER[dir] ?? '#d366ff';
        return {
            id: path,
            // 超大图隐藏标签，仅悬停显示，减少 DOM 开销
            label: huge ? '' : label,
            title: label,
            color: { background: bg, border: border, highlight: { background: border, border: bg } },
            shape: 'dot',
            size: huge ? 8 : large ? 12 : 16,
            font: { size: huge ? 10 : 12, color: '#f3e9ff', face: 'Rajdhani' },
            // 发光阴影：用节点同色系，营造霓虹辉光
            shadow: huge ? false : { enabled: true, size: 18, color: bg + 'aa' },
        };
    });
    // 边：半透明霓虹紫，大图模式关闭平滑曲线减少 Canvas 绘制
    const edges = data.edges.map((e, idx) => ({
        id: idx,
        from: e.from,
        to: e.to,
        arrows: 'to',
        color: { color: 'rgba(176, 38, 255, 0.45)', highlight: '#00f5ff', opacity: huge ? 0.25 : 0.5 },
        width: huge ? 1 : 1.5,
        smooth: !large && !huge,
    }));
    const nodesDS = new DataSet(nodes);
    const edgesDS = new DataSet(edges);
    // vis-network 配置：根据节点数自适应降级
    const options = {
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
            stabilization: { iterations: huge ? 50 : large ? 80 : 100 },
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
    if (network) {
        network.destroy();
    }
    network = new Network(containerRef.value, { nodes: nodesDS, edges: edgesDS }, options);
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
/** @type {[typeof RobotAvatar, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
    size: (56),
    floating: (__VLS_ctx.loading),
}));
const __VLS_1 = __VLS_0({
    size: (56),
    floating: (__VLS_ctx.loading),
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
const __VLS_3 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_4 = __VLS_asFunctionalComponent(__VLS_3, new __VLS_3({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
}));
const __VLS_5 = __VLS_4({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
}, ...__VLS_functionalComponentArgsRest(__VLS_4));
let __VLS_7;
let __VLS_8;
let __VLS_9;
const __VLS_10 = {
    onClick: (__VLS_ctx.toggleView)
};
__VLS_6.slots.default;
(__VLS_ctx.listView ? '图谱视图' : '列表视图');
var __VLS_6;
const __VLS_11 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_12 = __VLS_asFunctionalComponent(__VLS_11, new __VLS_11({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.loading),
}));
const __VLS_13 = __VLS_12({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.loading),
}, ...__VLS_functionalComponentArgsRest(__VLS_12));
let __VLS_15;
let __VLS_16;
let __VLS_17;
const __VLS_18 = {
    onClick: (__VLS_ctx.loadGraph)
};
__VLS_14.slots.default;
var __VLS_14;
if (__VLS_ctx.degraded && !__VLS_ctx.listView) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "degrade-bar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "degrade-icon" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "degrade-text" },
    });
    (__VLS_ctx.isHuge ? '节点数超过 500，已启用超大图模式（简化样式 + 快速布局）' : '节点数超过 200，已启用性能优化模式');
}
if (__VLS_ctx.isNarrowScreen && !__VLS_ctx.listView) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "degrade-bar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "degrade-icon" },
    });
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
}
if (!__VLS_ctx.listView) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "graph-canvas-wrapper" },
    });
    if (__VLS_ctx.loading) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "graph-loading" },
        });
        /** @type {[typeof RobotAvatar, ]} */ ;
        // @ts-ignore
        const __VLS_19 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
            size: (100),
            floating: (true),
        }));
        const __VLS_20 = __VLS_19({
            size: (100),
            floating: (true),
        }, ...__VLS_functionalComponentArgsRest(__VLS_19));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "loading-text" },
        });
    }
    else if (__VLS_ctx.nodeCount === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "graph-empty" },
        });
        /** @type {[typeof RobotAvatar, ]} */ ;
        // @ts-ignore
        const __VLS_22 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
            size: (120),
            floating: (true),
        }));
        const __VLS_23 = __VLS_22({
            size: (120),
            floating: (true),
        }, ...__VLS_functionalComponentArgsRest(__VLS_22));
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
        /** @type {[typeof RobotAvatar, ]} */ ;
        // @ts-ignore
        const __VLS_25 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
            size: (80),
            floating: (true),
        }));
        const __VLS_26 = __VLS_25({
            size: (80),
            floating: (true),
        }, ...__VLS_functionalComponentArgsRest(__VLS_25));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "loading-text" },
        });
    }
    else if (__VLS_ctx.listData.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "graph-empty" },
        });
        /** @type {[typeof RobotAvatar, ]} */ ;
        // @ts-ignore
        const __VLS_28 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
            size: (120),
            floating: (true),
        }));
        const __VLS_29 = __VLS_28({
            size: (120),
            floating: (true),
        }, ...__VLS_functionalComponentArgsRest(__VLS_28));
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
/** @type {__VLS_StyleScopedClasses['graph-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['graph-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tag']} */ ;
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
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            RobotAvatar: RobotAvatar,
            containerRef: containerRef,
            loading: loading,
            nodeCount: nodeCount,
            edgeCount: edgeCount,
            isHuge: isHuge,
            degraded: degraded,
            isNarrowScreen: isNarrowScreen,
            listView: listView,
            loadGraph: loadGraph,
            listData: listData,
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
