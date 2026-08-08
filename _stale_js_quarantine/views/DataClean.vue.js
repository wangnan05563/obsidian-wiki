/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Sort } from '@element-plus/icons-vue';
const pages = ref([]);
// 重复对：从 any 收敛为 DuplicatePair，避免运行时访问 undefined 字段
const duplicates = ref([]);
// 重复分组：deduplicate 接口同时返回，便于按"组"视角查看
const duplicateGroups = ref([]);
// 视图模式：'pairs' 两两配对（默认）/ 'groups' 按等价类聚合
const dedupViewMode = ref('pairs');
const loading = ref(false);
const scanProgress = ref('');
const selectedPages = ref([]);
const precheckResult = ref(null);
// 差异对比抽屉状态
const diffDrawerVisible = ref(false);
const diffLoading = ref(false);
const diffResult = ref(null);
const diffPairLabel = ref('');
// Mock data example for B-2 requirement
const MOCK_PAGES_EXAMPLE = {
    path: 'concepts/transformers.md',
    title: 'Transformers',
    qualityScore: 85,
    category: { length: 80, links: 75, frontmatter: 90, citations: 60, duplicate: 100, freshness: 70 },
    metadata: {
        wordCount: 3420, lineCount: 120, internalLinks: 12, inboundLinks: 5,
        lastModified: '2026-07-20T10:00:00Z', hasFrontmatter: true, isDraft: false,
        fileSizeBytes: 18500, hasBom: false, encoding: 'utf-8', directory: 'concepts'
    },
    issues: [],
    suggestions: [{ type: 'citation', detail: 'Add more citations', actionable: true }]
};
const MOCK_DUPLICATE_EXAMPLE = {
    pageA: MOCK_PAGES_EXAMPLE,
    pageB: { ...MOCK_PAGES_EXAMPLE, path: 'entities/transformer-model.md', title: 'Transformer Model', qualityScore: 42 },
    similarity: 0.92,
    matchType: 'near-duplicate',
    reason: 'Similar page name'
};
// Quality stats
const qualityStats = computed(() => {
    const scores = pages.value.map(p => p.qualityScore);
    if (scores.length === 0)
        return null;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return {
        total: scores.length,
        avg: avg.toFixed(1),
        excellent: scores.filter(s => s >= 80).length,
        good: scores.filter(s => s >= 60 && s < 80).length,
        needsWork: scores.filter(s => s < 40).length
    };
});
function scoreClass(score) {
    if (score >= 80)
        return 'score-excellent';
    if (score >= 60)
        return 'score-good';
    if (score >= 40)
        return 'score-needs-work';
    return 'score-critical';
}
// 重复类型 → 标签颜色：exact 红、near-duplicate 橙、semantic-similar 蓝
function matchTypeTag(type) {
    if (type === 'exact')
        return 'danger';
    if (type === 'near-duplicate')
        return 'warning';
    return 'info';
}
function matchTypeLabel(type) {
    if (type === 'exact')
        return '完全相同';
    if (type === 'near-duplicate')
        return '高度相似';
    return '语义相似';
}
async function loadPages() {
    loading.value = true;
    scanProgress.value = '正在加载页面数据...';
    try {
        const res = await fetch(`${API_BASE}/data-clean/pages`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        pages.value = await res.json();
        scanProgress.value = `已加载 ${pages.value.length} 个页面，平均质量 ${qualityStats.value?.avg || 0}/100`;
        ElMessage.success('页面数据加载成功');
    }
    catch (err) {
        scanProgress.value = '加载失败 — 将自动重试';
        ElMessage.error(err instanceof Error ? err.message : '加载页面失败');
        // 自动重试一次：网络抖动等瞬时错误可恢复
        try {
            await new Promise(r => setTimeout(r, 1000));
            const res = await fetch(`${API_BASE}/data-clean/pages`);
            if (res.ok) {
                pages.value = await res.json();
                scanProgress.value = '重试成功';
                ElMessage.success('重试成功');
            }
        }
        catch {
            ElMessage.warning('重试也失败 — 请检查服务状态');
        }
    }
    finally {
        loading.value = false;
    }
}
async function runDeduplication() {
    scanProgress.value = '正在检测重复页面（基于内容哈希 + Jaccard 相似度）...';
    try {
        const res = await fetch(`${API_BASE}/data-clean/deduplicate`, { method: 'POST' });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        duplicates.value = data.matches;
        duplicateGroups.value = data.duplicateGroups;
        scanProgress.value = `扫描 ${data.scannedPages} 页 · 唯一 ${data.uniquePages} · 重复对 ${data.matches.length} · 重复组 ${data.duplicateGroups.length}`;
        ElMessage.success(`去重完成：发现 ${data.matches.length} 对重复，聚合为 ${data.duplicateGroups.length} 组`);
    }
    catch (err) {
        scanProgress.value = '去重失败';
        ElMessage.error(err instanceof Error ? err.message : '去重失败');
    }
}
async function runPrecheck() {
    scanProgress.value = '正在执行 Vault 预检...';
    try {
        const res = await fetch(`${API_BASE}/data-clean/precheck`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        precheckResult.value = await res.json();
        // 非空断言：fetch 成功返回 json 后 precheckResult.value 一定非 null
        // 局部变量避免后续重复访问 .value，同时让 TS 在 if 分支内窄化
        const result = precheckResult.value;
        if (result.passed) {
            ElMessage.success(`预检通过：扫描 ${result.scannedFiles} 个文件，${result.warnings.length} 个警告`);
        }
        else {
            ElMessage.warning(`预检发现 ${result.errors.length} 个错误，${result.warnings.length} 个警告`);
        }
    }
    catch (err) {
        scanProgress.value = '预检失败';
        ElMessage.error(err instanceof Error ? err.message : '预检失败');
    }
}
async function archiveSelected() {
    if (selectedPages.value.length === 0) {
        ElMessage.warning('请选择要归档的页面');
        return;
    }
    try {
        await ElMessageBox.confirm(`归档 ${selectedPages.value.length} 个文件？将移动到 archive/YYYY-MM-DD/`, '确认归档', { confirmButtonText: '归档', cancelButtonText: '取消', type: 'warning' });
    }
    catch {
        return;
    }
    scanProgress.value = '正在归档文件...';
    try {
        const res = await fetch(`${API_BASE}/data-clean/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: selectedPages.value, dry_run: false }) });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const result = await res.json();
        ElMessage.success(`已归档 ${result.archived.length} 个文件`);
        selectedPages.value = [];
        await loadPages();
    }
    catch (err) {
        scanProgress.value = '归档失败';
        ElMessage.error(err instanceof Error ? err.message : '归档操作失败');
    }
}
async function fixFrontmatterFor(paths) {
    if (paths.length === 0)
        return;
    scanProgress.value = '正在修复 frontmatter...';
    try {
        const res = await fetch(`${API_BASE}/data-clean/fix-frontmatter`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths, dry_run: false }) });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const result = await res.json();
        ElMessage.success(`已为 ${result.fixed.length} 个文件修复 frontmatter`);
        selectedPages.value = [];
        await loadPages();
    }
    catch (err) {
        scanProgress.value = '修复失败';
        ElMessage.error(err instanceof Error ? err.message : 'Frontmatter 修复失败');
    }
}
async function mergeDuplicatePair(match) {
    try {
        await ElMessageBox.confirm(`将"${match.pageB.title}"合并到"${match.pageA.title}"？质量较低的页面将被合并。`, '确认合并', { confirmButtonText: '合并', cancelButtonText: '跳过', type: 'info' });
    }
    catch {
        return;
    }
    scanProgress.value = `正在合并 ${match.pageB.title} → ${match.pageA.title}...`;
    try {
        const res = await fetch(`${API_BASE}/data-clean/merge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageA: match.pageA, pageB: match.pageB, archive_kept: true, dry_run: false }) });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const result = await res.json();
        if (result.errors.length > 0) {
            ElMessage.warning(`合并完成但有错误：${result.errors.join(', ')}`);
        }
        else {
            ElMessage.success(`合并完成：更新了 ${result.linkReplacements || 0} 个链接`);
        }
        duplicates.value = duplicates.value.filter(d => d !== match);
        // 合并后重新扫描，避免"去重后仍看到重复文档"的体感
        await runDeduplication();
    }
    catch (err) {
        ElMessage.error(err instanceof Error ? err.message : '合并失败');
    }
}
// 查看差异：调用 /api/data-clean/diff 拉取行级 diff，弹出抽屉展示
async function viewDiff(pair) {
    diffPairLabel.value = `${pair.pageA.title} ↔ ${pair.pageB.title}`;
    diffDrawerVisible.value = true;
    diffLoading.value = true;
    diffResult.value = null;
    try {
        const url = `${API_BASE}/data-clean/diff?pathA=${encodeURIComponent(pair.pageA.path)}&pathB=${encodeURIComponent(pair.pageB.path)}`;
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        diffResult.value = await res.json();
    }
    catch (err) {
        ElMessage.error(err instanceof Error ? err.message : '加载差异失败');
        diffDrawerVisible.value = false;
    }
    finally {
        diffLoading.value = false;
    }
}
// 分组视图：根据 duplicateGroups 中保留的 representativePath，
// 在 pages 中查找组内每个文件的标题，便于展示
function findPageTitle(pagePath) {
    return pages.value.find(p => p.path === pagePath)?.title ?? pagePath;
}
function onRowChange(selection) {
    selectedPages.value = selection.map(s => s.path);
}
onMounted(() => loadPages());
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['group-pages']} */ ;
/** @type {__VLS_StyleScopedClasses['group-pages']} */ ;
/** @type {__VLS_StyleScopedClasses['group-pages']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line-add']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line-marker']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line-add']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line-content']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line-del']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line-marker']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line-del']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line-content']} */ ;
/** @type {__VLS_StyleScopedClasses['mock-section']} */ ;
/** @type {__VLS_StyleScopedClasses['stats-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['stats-grid']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "dataclean-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card dataclean-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "dataclean-header" },
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
const __VLS_0 = {}.ElButtonGroup;
/** @type {[typeof __VLS_components.ElButtonGroup, typeof __VLS_components.elButtonGroup, typeof __VLS_components.ElButtonGroup, typeof __VLS_components.elButtonGroup, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    ...{ style: {} },
}));
const __VLS_2 = __VLS_1({
    ...{ style: {} },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
const __VLS_4 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.loading),
}));
const __VLS_6 = __VLS_5({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.loading),
}, ...__VLS_functionalComponentArgsRest(__VLS_5));
let __VLS_8;
let __VLS_9;
let __VLS_10;
const __VLS_11 = {
    onClick: (__VLS_ctx.loadPages)
};
__VLS_7.slots.default;
var __VLS_7;
const __VLS_12 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn secondary" },
}));
const __VLS_14 = __VLS_13({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn secondary" },
}, ...__VLS_functionalComponentArgsRest(__VLS_13));
let __VLS_16;
let __VLS_17;
let __VLS_18;
const __VLS_19 = {
    onClick: (__VLS_ctx.runPrecheck)
};
__VLS_15.slots.default;
var __VLS_15;
const __VLS_20 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn secondary" },
}));
const __VLS_22 = __VLS_21({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn secondary" },
}, ...__VLS_functionalComponentArgsRest(__VLS_21));
let __VLS_24;
let __VLS_25;
let __VLS_26;
const __VLS_27 = {
    onClick: (__VLS_ctx.runDeduplication)
};
__VLS_23.slots.default;
var __VLS_23;
var __VLS_3;
if (false) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mock-section" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({});
    (JSON.stringify(__VLS_ctx.MOCK_PAGES_EXAMPLE, null, 2));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({});
    (JSON.stringify(__VLS_ctx.MOCK_DUPLICATE_EXAMPLE, null, 2));
}
if (__VLS_ctx.qualityStats) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stats-grid" },
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
    (__VLS_ctx.qualityStats.total);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "status-meta" },
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
    (__VLS_ctx.qualityStats.avg);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "unit" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "status-meta" },
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
    (__VLS_ctx.qualityStats.excellent);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "status-meta" },
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
    (__VLS_ctx.qualityStats.good);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "status-meta" },
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
    (__VLS_ctx.qualityStats.needsWork);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "status-meta" },
    });
}
if (__VLS_ctx.precheckResult) {
    const __VLS_28 = {}.ElAlert;
    /** @type {[typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, ]} */ ;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
        title: (__VLS_ctx.precheckResult.passed ? 'Vault 预检：通过' : 'Vault 预检：发现问题'),
        type: (__VLS_ctx.precheckResult.passed ? 'success' : 'warning'),
        description: (`扫描 ${__VLS_ctx.precheckResult.scannedFiles} 个文件 · ${__VLS_ctx.precheckResult.errors.length} 个错误 · ${__VLS_ctx.precheckResult.warnings.length} 个警告`),
        showIcon: true,
        closable: true,
        ...{ style: {} },
    }));
    const __VLS_30 = __VLS_29({
        title: (__VLS_ctx.precheckResult.passed ? 'Vault 预检：通过' : 'Vault 预检：发现问题'),
        type: (__VLS_ctx.precheckResult.passed ? 'success' : 'warning'),
        description: (`扫描 ${__VLS_ctx.precheckResult.scannedFiles} 个文件 · ${__VLS_ctx.precheckResult.errors.length} 个错误 · ${__VLS_ctx.precheckResult.warnings.length} 个警告`),
        showIcon: true,
        closable: true,
        ...{ style: {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_29));
}
if (__VLS_ctx.scanProgress) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "progress-bar" },
        ...{ class: ({ success: !__VLS_ctx.loading && !__VLS_ctx.scanProgress.includes('failed') && !__VLS_ctx.scanProgress.includes('Failed') }) },
    });
    (__VLS_ctx.scanProgress);
}
if (__VLS_ctx.selectedPages.length > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "toolbar" },
    });
    const __VLS_32 = {}.ElButtonGroup;
    /** @type {[typeof __VLS_components.ElButtonGroup, typeof __VLS_components.elButtonGroup, typeof __VLS_components.ElButtonGroup, typeof __VLS_components.elButtonGroup, ]} */ ;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({}));
    const __VLS_34 = __VLS_33({}, ...__VLS_functionalComponentArgsRest(__VLS_33));
    __VLS_35.slots.default;
    const __VLS_36 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
        ...{ 'onClick': {} },
        type: "danger",
        size: "small",
    }));
    const __VLS_38 = __VLS_37({
        ...{ 'onClick': {} },
        type: "danger",
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_37));
    let __VLS_40;
    let __VLS_41;
    let __VLS_42;
    const __VLS_43 = {
        onClick: (__VLS_ctx.archiveSelected)
    };
    __VLS_39.slots.default;
    (__VLS_ctx.selectedPages.length);
    var __VLS_39;
    const __VLS_44 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
        ...{ 'onClick': {} },
        type: "warning",
        size: "small",
    }));
    const __VLS_46 = __VLS_45({
        ...{ 'onClick': {} },
        type: "warning",
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_45));
    let __VLS_48;
    let __VLS_49;
    let __VLS_50;
    const __VLS_51 = {
        onClick: (...[$event]) => {
            if (!(__VLS_ctx.selectedPages.length > 0))
                return;
            __VLS_ctx.fixFrontmatterFor(__VLS_ctx.selectedPages);
        }
    };
    __VLS_47.slots.default;
    var __VLS_47;
    const __VLS_52 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({
        ...{ 'onClick': {} },
        size: "small",
    }));
    const __VLS_54 = __VLS_53({
        ...{ 'onClick': {} },
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_53));
    let __VLS_56;
    let __VLS_57;
    let __VLS_58;
    const __VLS_59 = {
        onClick: (...[$event]) => {
            if (!(__VLS_ctx.selectedPages.length > 0))
                return;
            __VLS_ctx.selectedPages = [];
        }
    };
    __VLS_55.slots.default;
    var __VLS_55;
    var __VLS_35;
}
const __VLS_60 = {}.ElTable;
/** @type {[typeof __VLS_components.ElTable, typeof __VLS_components.elTable, typeof __VLS_components.ElTable, typeof __VLS_components.elTable, ]} */ ;
// @ts-ignore
const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({
    ...{ 'onSelectionChange': {} },
    data: (__VLS_ctx.pages),
    ...{ style: {} },
    stripe: true,
    height: "600",
}));
const __VLS_62 = __VLS_61({
    ...{ 'onSelectionChange': {} },
    data: (__VLS_ctx.pages),
    ...{ style: {} },
    stripe: true,
    height: "600",
}, ...__VLS_functionalComponentArgsRest(__VLS_61));
let __VLS_64;
let __VLS_65;
let __VLS_66;
const __VLS_67 = {
    onSelectionChange: (__VLS_ctx.onRowChange)
};
__VLS_63.slots.default;
const __VLS_68 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_69 = __VLS_asFunctionalComponent(__VLS_68, new __VLS_68({
    type: "selection",
    width: "55",
    align: "center",
}));
const __VLS_70 = __VLS_69({
    type: "selection",
    width: "55",
    align: "center",
}, ...__VLS_functionalComponentArgsRest(__VLS_69));
const __VLS_72 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_73 = __VLS_asFunctionalComponent(__VLS_72, new __VLS_72({
    prop: "path",
    label: "文件路径",
    minWidth: "200",
    showOverflowTooltip: true,
}));
const __VLS_74 = __VLS_73({
    prop: "path",
    label: "文件路径",
    minWidth: "200",
    showOverflowTooltip: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_73));
const __VLS_76 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_77 = __VLS_asFunctionalComponent(__VLS_76, new __VLS_76({
    prop: "title",
    label: "标题",
    minWidth: "150",
    showOverflowTooltip: true,
}));
const __VLS_78 = __VLS_77({
    prop: "title",
    label: "标题",
    minWidth: "150",
    showOverflowTooltip: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_77));
const __VLS_80 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_81 = __VLS_asFunctionalComponent(__VLS_80, new __VLS_80({
    prop: "qualityScore",
    label: "评分",
    width: "100",
    align: "center",
}));
const __VLS_82 = __VLS_81({
    prop: "qualityScore",
    label: "评分",
    width: "100",
    align: "center",
}, ...__VLS_functionalComponentArgsRest(__VLS_81));
__VLS_83.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_83.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    const __VLS_84 = {}.ElTag;
    /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
    // @ts-ignore
    const __VLS_85 = __VLS_asFunctionalComponent(__VLS_84, new __VLS_84({
        type: (row.qualityScore >= 80 ? 'success' : row.qualityScore >= 60 ? '' : row.qualityScore >= 40 ? 'warning' : 'danger'),
        size: "small",
    }));
    const __VLS_86 = __VLS_85({
        type: (row.qualityScore >= 80 ? 'success' : row.qualityScore >= 60 ? '' : row.qualityScore >= 40 ? 'warning' : 'danger'),
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_85));
    __VLS_87.slots.default;
    (row.qualityScore);
    var __VLS_87;
}
var __VLS_83;
const __VLS_88 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_89 = __VLS_asFunctionalComponent(__VLS_88, new __VLS_88({
    label: "字数",
    width: "80",
    align: "right",
}));
const __VLS_90 = __VLS_89({
    label: "字数",
    width: "80",
    align: "right",
}, ...__VLS_functionalComponentArgsRest(__VLS_89));
__VLS_91.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_91.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    (row.metadata.wordCount);
}
var __VLS_91;
const __VLS_92 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_93 = __VLS_asFunctionalComponent(__VLS_92, new __VLS_92({
    label: "链接",
    width: "80",
    align: "right",
}));
const __VLS_94 = __VLS_93({
    label: "链接",
    width: "80",
    align: "right",
}, ...__VLS_functionalComponentArgsRest(__VLS_93));
__VLS_95.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_95.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    (row.metadata.internalLinks);
}
var __VLS_95;
const __VLS_96 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_97 = __VLS_asFunctionalComponent(__VLS_96, new __VLS_96({
    label: "目录",
    width: "100",
}));
const __VLS_98 = __VLS_97({
    label: "目录",
    width: "100",
}, ...__VLS_functionalComponentArgsRest(__VLS_97));
__VLS_99.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_99.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    (row.metadata.directory);
}
var __VLS_99;
const __VLS_100 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_101 = __VLS_asFunctionalComponent(__VLS_100, new __VLS_100({
    label: "状态",
    width: "110",
}));
const __VLS_102 = __VLS_101({
    label: "状态",
    width: "110",
}, ...__VLS_functionalComponentArgsRest(__VLS_101));
__VLS_103.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_103.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    if (row.metadata.hasFrontmatter) {
        const __VLS_104 = {}.ElTag;
        /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
        // @ts-ignore
        const __VLS_105 = __VLS_asFunctionalComponent(__VLS_104, new __VLS_104({
            type: "success",
            size: "small",
            effect: "plain",
        }));
        const __VLS_106 = __VLS_105({
            type: "success",
            size: "small",
            effect: "plain",
        }, ...__VLS_functionalComponentArgsRest(__VLS_105));
        __VLS_107.slots.default;
        var __VLS_107;
    }
    else {
        const __VLS_108 = {}.ElTag;
        /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
        // @ts-ignore
        const __VLS_109 = __VLS_asFunctionalComponent(__VLS_108, new __VLS_108({
            type: "danger",
            size: "small",
            effect: "plain",
        }));
        const __VLS_110 = __VLS_109({
            type: "danger",
            size: "small",
            effect: "plain",
        }, ...__VLS_functionalComponentArgsRest(__VLS_109));
        __VLS_111.slots.default;
        var __VLS_111;
    }
}
var __VLS_103;
const __VLS_112 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_113 = __VLS_asFunctionalComponent(__VLS_112, new __VLS_112({
    label: "问题",
    width: "200",
}));
const __VLS_114 = __VLS_113({
    label: "问题",
    width: "200",
}, ...__VLS_functionalComponentArgsRest(__VLS_113));
__VLS_115.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_115.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    if (row.issues) {
        for (const [issue, idx] of __VLS_getVForSourceType((row.issues))) {
            const __VLS_116 = {}.ElTag;
            /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
            // @ts-ignore
            const __VLS_117 = __VLS_asFunctionalComponent(__VLS_116, new __VLS_116({
                key: (idx),
                type: "warning",
                size: "small",
                ...{ style: {} },
            }));
            const __VLS_118 = __VLS_117({
                key: (idx),
                type: "warning",
                size: "small",
                ...{ style: {} },
            }, ...__VLS_functionalComponentArgsRest(__VLS_117));
            __VLS_119.slots.default;
            (issue);
            var __VLS_119;
        }
    }
}
var __VLS_115;
var __VLS_63;
if (__VLS_ctx.duplicates.length > 0 || __VLS_ctx.duplicateGroups.length > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "duplicates-section" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "dup-header" },
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
    const __VLS_120 = {}.ElRadioGroup;
    /** @type {[typeof __VLS_components.ElRadioGroup, typeof __VLS_components.elRadioGroup, typeof __VLS_components.ElRadioGroup, typeof __VLS_components.elRadioGroup, ]} */ ;
    // @ts-ignore
    const __VLS_121 = __VLS_asFunctionalComponent(__VLS_120, new __VLS_120({
        modelValue: (__VLS_ctx.dedupViewMode),
        size: "small",
    }));
    const __VLS_122 = __VLS_121({
        modelValue: (__VLS_ctx.dedupViewMode),
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_121));
    __VLS_123.slots.default;
    const __VLS_124 = {}.ElRadioButton;
    /** @type {[typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, ]} */ ;
    // @ts-ignore
    const __VLS_125 = __VLS_asFunctionalComponent(__VLS_124, new __VLS_124({
        value: "pairs",
    }));
    const __VLS_126 = __VLS_125({
        value: "pairs",
    }, ...__VLS_functionalComponentArgsRest(__VLS_125));
    __VLS_127.slots.default;
    (__VLS_ctx.duplicates.length);
    var __VLS_127;
    const __VLS_128 = {}.ElRadioButton;
    /** @type {[typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, ]} */ ;
    // @ts-ignore
    const __VLS_129 = __VLS_asFunctionalComponent(__VLS_128, new __VLS_128({
        value: "groups",
    }));
    const __VLS_130 = __VLS_129({
        value: "groups",
    }, ...__VLS_functionalComponentArgsRest(__VLS_129));
    __VLS_131.slots.default;
    (__VLS_ctx.duplicateGroups.length);
    var __VLS_131;
    var __VLS_123;
    if (__VLS_ctx.dedupViewMode === 'pairs') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        for (const [dup, idx] of __VLS_getVForSourceType((__VLS_ctx.duplicates))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (idx),
                ...{ class: "dup-item" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "dup-info" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "dup-titles" },
            });
            const __VLS_132 = {}.ElTag;
            /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
            // @ts-ignore
            const __VLS_133 = __VLS_asFunctionalComponent(__VLS_132, new __VLS_132({
                type: (__VLS_ctx.matchTypeTag(dup.matchType)),
                size: "small",
                effect: "dark",
            }));
            const __VLS_134 = __VLS_133({
                type: (__VLS_ctx.matchTypeTag(dup.matchType)),
                size: "small",
                effect: "dark",
            }, ...__VLS_functionalComponentArgsRest(__VLS_133));
            __VLS_135.slots.default;
            (__VLS_ctx.matchTypeLabel(dup.matchType));
            var __VLS_135;
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "dup-title-a" },
            });
            (dup.pageA.title);
            const __VLS_136 = {}.ElIcon;
            /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
            // @ts-ignore
            const __VLS_137 = __VLS_asFunctionalComponent(__VLS_136, new __VLS_136({
                ...{ class: "dup-vs" },
            }));
            const __VLS_138 = __VLS_137({
                ...{ class: "dup-vs" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_137));
            __VLS_139.slots.default;
            const __VLS_140 = {}.Sort;
            /** @type {[typeof __VLS_components.Sort, ]} */ ;
            // @ts-ignore
            const __VLS_141 = __VLS_asFunctionalComponent(__VLS_140, new __VLS_140({}));
            const __VLS_142 = __VLS_141({}, ...__VLS_functionalComponentArgsRest(__VLS_141));
            var __VLS_139;
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "dup-title-b" },
            });
            (dup.pageB.title);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "dup-meta" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "dup-similarity" },
            });
            ((dup.similarity * 100).toFixed(0));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "dup-reason" },
            });
            (dup.reason);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "dup-score" },
            });
            (dup.pageA.qualityScore);
            (dup.pageB.qualityScore);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "dup-actions" },
            });
            const __VLS_144 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_145 = __VLS_asFunctionalComponent(__VLS_144, new __VLS_144({
                ...{ 'onClick': {} },
                size: "small",
                type: "primary",
                plain: true,
            }));
            const __VLS_146 = __VLS_145({
                ...{ 'onClick': {} },
                size: "small",
                type: "primary",
                plain: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_145));
            let __VLS_148;
            let __VLS_149;
            let __VLS_150;
            const __VLS_151 = {
                onClick: (...[$event]) => {
                    if (!(__VLS_ctx.duplicates.length > 0 || __VLS_ctx.duplicateGroups.length > 0))
                        return;
                    if (!(__VLS_ctx.dedupViewMode === 'pairs'))
                        return;
                    __VLS_ctx.viewDiff(dup);
                }
            };
            __VLS_147.slots.default;
            var __VLS_147;
            const __VLS_152 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_153 = __VLS_asFunctionalComponent(__VLS_152, new __VLS_152({
                ...{ 'onClick': {} },
                size: "small",
                type: "success",
            }));
            const __VLS_154 = __VLS_153({
                ...{ 'onClick': {} },
                size: "small",
                type: "success",
            }, ...__VLS_functionalComponentArgsRest(__VLS_153));
            let __VLS_156;
            let __VLS_157;
            let __VLS_158;
            const __VLS_159 = {
                onClick: (...[$event]) => {
                    if (!(__VLS_ctx.duplicates.length > 0 || __VLS_ctx.duplicateGroups.length > 0))
                        return;
                    if (!(__VLS_ctx.dedupViewMode === 'pairs'))
                        return;
                    __VLS_ctx.mergeDuplicatePair(dup);
                }
            };
            __VLS_155.slots.default;
            (dup.pageA.title);
            var __VLS_155;
            const __VLS_160 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_161 = __VLS_asFunctionalComponent(__VLS_160, new __VLS_160({
                ...{ 'onClick': {} },
                size: "small",
                text: true,
            }));
            const __VLS_162 = __VLS_161({
                ...{ 'onClick': {} },
                size: "small",
                text: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_161));
            let __VLS_164;
            let __VLS_165;
            let __VLS_166;
            const __VLS_167 = {
                onClick: (...[$event]) => {
                    if (!(__VLS_ctx.duplicates.length > 0 || __VLS_ctx.duplicateGroups.length > 0))
                        return;
                    if (!(__VLS_ctx.dedupViewMode === 'pairs'))
                        return;
                    __VLS_ctx.duplicates.splice(idx, 1);
                }
            };
            __VLS_163.slots.default;
            var __VLS_163;
        }
        if (__VLS_ctx.duplicates.length === 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "empty-state" },
            });
        }
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
        for (const [group, idx] of __VLS_getVForSourceType((__VLS_ctx.duplicateGroups))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (idx),
                ...{ class: "group-item" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "group-head" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "group-index" },
            });
            (idx + 1);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "group-size" },
            });
            (group.pages.length);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "group-words" },
            });
            (group.totalWordsInGroup);
            const __VLS_168 = {}.ElTag;
            /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
            // @ts-ignore
            const __VLS_169 = __VLS_asFunctionalComponent(__VLS_168, new __VLS_168({
                type: "success",
                size: "small",
                effect: "plain",
            }));
            const __VLS_170 = __VLS_169({
                type: "success",
                size: "small",
                effect: "plain",
            }, ...__VLS_functionalComponentArgsRest(__VLS_169));
            __VLS_171.slots.default;
            (__VLS_ctx.findPageTitle(group.representativePath));
            var __VLS_171;
            __VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
                ...{ class: "group-pages" },
            });
            for (const [p] of __VLS_getVForSourceType((group.pages))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
                    key: (p),
                    ...{ class: ({ representative: p === group.representativePath }) },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "page-path" },
                });
                (p);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "page-title" },
                });
                (__VLS_ctx.findPageTitle(p));
                if (p === group.representativePath) {
                    const __VLS_172 = {}.ElTag;
                    /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
                    // @ts-ignore
                    const __VLS_173 = __VLS_asFunctionalComponent(__VLS_172, new __VLS_172({
                        type: "success",
                        size: "small",
                    }));
                    const __VLS_174 = __VLS_173({
                        type: "success",
                        size: "small",
                    }, ...__VLS_functionalComponentArgsRest(__VLS_173));
                    __VLS_175.slots.default;
                    var __VLS_175;
                }
            }
        }
        if (__VLS_ctx.duplicateGroups.length === 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "empty-state" },
            });
        }
    }
}
const __VLS_176 = {}.ElDrawer;
/** @type {[typeof __VLS_components.ElDrawer, typeof __VLS_components.elDrawer, typeof __VLS_components.ElDrawer, typeof __VLS_components.elDrawer, ]} */ ;
// @ts-ignore
const __VLS_177 = __VLS_asFunctionalComponent(__VLS_176, new __VLS_176({
    modelValue: (__VLS_ctx.diffDrawerVisible),
    title: (`差异对比：${__VLS_ctx.diffPairLabel}`),
    size: "60%",
    direction: "rtl",
}));
const __VLS_178 = __VLS_177({
    modelValue: (__VLS_ctx.diffDrawerVisible),
    title: (`差异对比：${__VLS_ctx.diffPairLabel}`),
    size: "60%",
    direction: "rtl",
}, ...__VLS_functionalComponentArgsRest(__VLS_177));
__VLS_179.slots.default;
if (__VLS_ctx.diffLoading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "diff-loading" },
    });
}
else if (__VLS_ctx.diffResult) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "diff-content" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "diff-summary" },
    });
    const __VLS_180 = {}.ElTag;
    /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
    // @ts-ignore
    const __VLS_181 = __VLS_asFunctionalComponent(__VLS_180, new __VLS_180({
        type: "success",
        size: "small",
    }));
    const __VLS_182 = __VLS_181({
        type: "success",
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_181));
    __VLS_183.slots.default;
    (__VLS_ctx.diffResult.summary.unchanged);
    var __VLS_183;
    const __VLS_184 = {}.ElTag;
    /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
    // @ts-ignore
    const __VLS_185 = __VLS_asFunctionalComponent(__VLS_184, new __VLS_184({
        type: "danger",
        size: "small",
    }));
    const __VLS_186 = __VLS_185({
        type: "danger",
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_185));
    __VLS_187.slots.default;
    (__VLS_ctx.diffResult.summary.removed);
    var __VLS_187;
    const __VLS_188 = {}.ElTag;
    /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
    // @ts-ignore
    const __VLS_189 = __VLS_asFunctionalComponent(__VLS_188, new __VLS_188({
        type: "warning",
        size: "small",
    }));
    const __VLS_190 = __VLS_189({
        type: "warning",
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_189));
    __VLS_191.slots.default;
    (__VLS_ctx.diffResult.summary.added);
    var __VLS_191;
    const __VLS_192 = {}.ElTag;
    /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
    // @ts-ignore
    const __VLS_193 = __VLS_asFunctionalComponent(__VLS_192, new __VLS_192({
        type: "info",
        size: "small",
    }));
    const __VLS_194 = __VLS_193({
        type: "info",
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_193));
    __VLS_195.slots.default;
    ((__VLS_ctx.diffResult.summary.similarity * 100).toFixed(0));
    var __VLS_195;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "diff-paths" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "diff-path-a" },
    });
    (__VLS_ctx.diffResult.pathA);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "diff-path-b" },
    });
    (__VLS_ctx.diffResult.pathB);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "diff-lines" },
    });
    for (const [line, i] of __VLS_getVForSourceType((__VLS_ctx.diffResult.lines))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (i),
            ...{ class: (['diff-line', `diff-line-${line.type}`]) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "diff-line-no" },
        });
        (line.oldLine ?? '');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "diff-line-no" },
        });
        (line.newLine ?? '');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "diff-line-marker" },
        });
        (line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "diff-line-content" },
        });
        (line.content || ' ');
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
}
var __VLS_179;
if (!__VLS_ctx.loading && __VLS_ctx.pages.length === 0 && !__VLS_ctx.scanProgress.includes('Failed')) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
}
/** @type {__VLS_StyleScopedClasses['dataclean-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['dataclean-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['dataclean-header']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['mock-section']} */ ;
/** @type {__VLS_StyleScopedClasses['stats-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['status-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['status-title']} */ ;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
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
/** @type {__VLS_StyleScopedClasses['status-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['status-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['status-title']} */ ;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['status-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['status-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['status-title']} */ ;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['status-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['duplicates-section']} */ ;
/** @type {__VLS_StyleScopedClasses['dup-header']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['dup-item']} */ ;
/** @type {__VLS_StyleScopedClasses['dup-info']} */ ;
/** @type {__VLS_StyleScopedClasses['dup-titles']} */ ;
/** @type {__VLS_StyleScopedClasses['dup-title-a']} */ ;
/** @type {__VLS_StyleScopedClasses['dup-vs']} */ ;
/** @type {__VLS_StyleScopedClasses['dup-title-b']} */ ;
/** @type {__VLS_StyleScopedClasses['dup-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['dup-similarity']} */ ;
/** @type {__VLS_StyleScopedClasses['dup-reason']} */ ;
/** @type {__VLS_StyleScopedClasses['dup-score']} */ ;
/** @type {__VLS_StyleScopedClasses['dup-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['group-item']} */ ;
/** @type {__VLS_StyleScopedClasses['group-head']} */ ;
/** @type {__VLS_StyleScopedClasses['group-index']} */ ;
/** @type {__VLS_StyleScopedClasses['group-size']} */ ;
/** @type {__VLS_StyleScopedClasses['group-words']} */ ;
/** @type {__VLS_StyleScopedClasses['group-pages']} */ ;
/** @type {__VLS_StyleScopedClasses['page-path']} */ ;
/** @type {__VLS_StyleScopedClasses['page-title']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-content']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-summary']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-paths']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-path-a']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-path-b']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-lines']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line-no']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line-no']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line-marker']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line-content']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Sort: Sort,
            pages: pages,
            duplicates: duplicates,
            duplicateGroups: duplicateGroups,
            dedupViewMode: dedupViewMode,
            loading: loading,
            scanProgress: scanProgress,
            selectedPages: selectedPages,
            precheckResult: precheckResult,
            diffDrawerVisible: diffDrawerVisible,
            diffLoading: diffLoading,
            diffResult: diffResult,
            diffPairLabel: diffPairLabel,
            MOCK_PAGES_EXAMPLE: MOCK_PAGES_EXAMPLE,
            MOCK_DUPLICATE_EXAMPLE: MOCK_DUPLICATE_EXAMPLE,
            qualityStats: qualityStats,
            matchTypeTag: matchTypeTag,
            matchTypeLabel: matchTypeLabel,
            loadPages: loadPages,
            runDeduplication: runDeduplication,
            runPrecheck: runPrecheck,
            archiveSelected: archiveSelected,
            fixFrontmatterFor: fixFrontmatterFor,
            mergeDuplicatePair: mergeDuplicatePair,
            viewDiff: viewDiff,
            findPageTitle: findPageTitle,
            onRowChange: onRowChange,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
