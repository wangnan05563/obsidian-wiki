/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { ref, onMounted, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Warning, CircleCheck, Tools, MagicStick, Check, Lightning } from '@element-plus/icons-vue';
import { apiErrorMessage } from '../utils/apiError';
import { useHealthStore } from '../stores/health';
const healthStore = useHealthStore();
// 修复状态从 store 获取：组件卸载后 store 保留状态，切回页面可恢复进度条与日志
const { fixingKey, fixLogs, batchFixing, batchTotal, batchCurrent, batchDoneKeys, batchProgress, anyFixing, } = storeToRefs(healthStore);
// report 与 loading 为组件本地状态：体检报告每次进入页面需刷新，无需跨视图保留
const report = ref(null);
// 批量修复结果汇总：修复完成后持久展示，重新体检时自动清除
// 为什么用组件本地 ref 而非 store：汇总仅 UI 展示用，无需跨视图持久化
const batchSummary = ref(null);
const loading = ref(false);
// 三类问题的计数
const orphanCount = computed(() => report.value?.orphans.length ?? 0);
const brokenCount = computed(() => report.value?.brokenLinks.length ?? 0);
const staleCount = computed(() => report.value?.stale.length ?? 0);
const totalIssues = computed(() => orphanCount.value + brokenCount.value + staleCount.value);
// 体检结果状态：无问题为健康，有问题为需关注
const healthStatus = computed(() => totalIssues.value === 0 ? 'healthy' : 'warning');
// 执行体检
async function runCheck() {
    loading.value = true;
    report.value = null;
    batchSummary.value = null; // 重新体检时清除旧汇总
    try {
        const res = await fetch(`${API_BASE}/health-check`, { method: 'POST' });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        report.value = await res.json();
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('体检失败', err));
    }
    finally {
        loading.value = false;
    }
}
// 从 SSE 事件块解析 event/data 字段，返回 null 表示无效事件
function parseSSEEvent(evt) {
    let eventType = '';
    let data = '';
    for (const line of evt.split('\n')) {
        if (line.startsWith('event: '))
            eventType = line.slice(7);
        if (line.startsWith('data: '))
            data = line.slice(6);
    }
    if (!eventType || !data)
        return null;
    return { eventType, data };
}
// 处理修复进度事件，提取出来以降低 fixIssue 的认知复杂度
async function handleFixEvent(eventType, data) {
    let parsed;
    try {
        parsed = JSON.parse(data);
    }
    catch {
        return;
    }
    if (eventType === 'progress' || eventType === 'fixed') {
        healthStore.pushFixLog(parsed);
        return;
    }
    if (eventType === 'done') {
        healthStore.pushFixLog(parsed);
        if (parsed.status === 'done') {
            ElMessage.success('修复完成');
            // 修复后重新体检刷新报告
            await runCheck();
        }
        else {
            ElMessage.error(parsed.message || '修复失败');
        }
        return;
    }
    if (eventType === 'error') {
        ElMessage.error(parsed.message || '修复出错');
    }
}
// 一键修复单个问题。SSE 流式接收修复进度。
// issueType 区分断链/孤立，target 为 {from,to} 或字符串路径。
async function fixIssue(issueType, target, key) {
    healthStore.startSingleFix(key);
    const payload = { issueType, target };
    try {
        const res = await fetch(`${API_BASE}/health-check/fix`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok || !res.body)
            throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';
            for (const evt of events) {
                const parsed = parseSSEEvent(evt);
                if (!parsed)
                    continue;
                await handleFixEvent(parsed.eventType, parsed.data);
            }
        }
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('修复请求失败', err));
    }
    finally {
        healthStore.endSingleFix();
    }
}
// 构造批量修复请求体：把 orphan/broken 问题列表转为 FixRequest[] + issueKeys[]
// 为什么前端生成 issueKey：列表项 key 已用 `${issueType}:${target}` 格式，复用保持一致
function buildBatchItems(issueType, targets) {
    const items = [];
    const issueKeys = [];
    for (const target of targets) {
        items.push({ issueType, target });
        // orphan 的 target 是字符串路径，broken 的 target 是 {from,to}
        if (issueType === 'orphan') {
            issueKeys.push(`orphan:${target}`);
        }
        else {
            const ft = target;
            issueKeys.push(`broken:${ft.from}->${ft.to}`);
        }
    }
    return { items, issueKeys };
}
// 按范围收集待修复问题，返回 { items, issueKeys } 或 null（无可修复项）
// 为什么独立函数：降低 batchFix 主函数认知复杂度（S3776）
function collectBatchItems(scope, report) {
    const allItems = [];
    const allKeys = [];
    if (scope === 'all' || scope === 'orphan') {
        const { items, issueKeys } = buildBatchItems('orphan', report.orphans);
        allItems.push(...items);
        allKeys.push(...issueKeys);
    }
    if (scope === 'all' || scope === 'broken') {
        const { items, issueKeys } = buildBatchItems('broken_link', report.brokenLinks);
        allItems.push(...items);
        allKeys.push(...issueKeys);
    }
    if (allItems.length === 0)
        return null;
    return { items: allItems, issueKeys: allKeys };
}
// 范围文案映射：S3358 避免嵌套三元，独立函数返回
function scopeLabel(scope) {
    if (scope === 'all')
        return '全部';
    if (scope === 'orphan')
        return '孤立页面';
    return '断开链接';
}
// 消费批量修复 SSE 流，解析事件并委托 store action 处理
// 为什么独立函数：降低 batchFix 主函数认知复杂度（S3776）
async function streamBatchFixEvents(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const evt of events) {
            const parsed = parseSSEEvent(evt);
            if (!parsed)
                continue;
            let data = null;
            try {
                data = JSON.parse(parsed.data);
            }
            catch {
                continue;
            }
            // 事件状态更新委托给 store action，组件不直接操作 store 状态
            healthStore.handleBatchEvent(parsed.eventType, data);
        }
    }
}
// 批量修复入口：支持 'all'（全部）/ 'orphan'（仅孤立）/ 'broken'（仅断链）
// 为什么需要二次确认：批量修复会调用 LLM 多次，耗时较长且消耗 token，需用户明确确认
async function batchFix(scope) {
    if (!report.value || anyFixing.value)
        return;
    const collected = collectBatchItems(scope, report.value);
    if (!collected) {
        ElMessage.info('当前范围无可修复的问题');
        return;
    }
    // 二次确认
    const scopeText = scopeLabel(scope);
    try {
        await ElMessageBox.confirm(`将串行修复 ${collected.items.length} 个${scopeText}问题，可能耗时较长（每个问题调用一次 LLM）。是否继续？`, '批量修复确认', { confirmButtonText: '开始修复', cancelButtonText: '取消', type: 'warning' });
    }
    catch {
        // 用户取消
        return;
    }
    // 初始化批量修复状态到 store：切走页面后 store 保留状态，切回可恢复进度条
    healthStore.startBatchFix(collected.items.length);
    const payload = { items: collected.items, issueKeys: collected.issueKeys };
    try {
        const res = await fetch(`${API_BASE}/health-check/fix/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok || !res.body)
            throw new Error(`HTTP ${res.status}`);
        await streamBatchFixEvents(res.body);
        ElMessage.success(`批量修复完成：${batchDoneKeys.value.size}/${batchTotal.value} 个问题已处理`);
        // 记录修复汇总：在重新体检前保存，避免 report 刷新后丢失统计
        const ok = batchDoneKeys.value.size;
        const fail = batchTotal.value - ok;
        batchSummary.value = { ok, fail, total: batchTotal.value };
        // 批量修复后重新体检刷新报告（后端缓存已在 healthCheckFix finally 中失效）
        await runCheck();
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('批量修复失败', err));
    }
    finally {
        healthStore.endBatchFix();
    }
}
// 清除修复日志：两次修复会话之间可能需要清理旧日志
function clearLogs() {
    healthStore.clearLogs();
}
onMounted(() => {
    // 批量修复进行中时不重新体检：避免 loading 状态干扰进度条显示
    // SSE fetch 在组件卸载后仍后台执行并更新 store，切回时进度条从 store 恢复
    if (healthStore.batchFixing)
        return;
    runCheck();
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['batch-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-item']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-done']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['is-disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-item']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-item']} */ ;
/** @type {__VLS_StyleScopedClasses['section-count']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-item']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-item']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-item']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-item']} */ ;
/** @type {__VLS_StyleScopedClasses['fix-log-item']} */ ;
/** @type {__VLS_StyleScopedClasses['fix-log-item']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "health-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card health-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "health-head" },
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
    ...{ class: "head-actions" },
});
if (__VLS_ctx.report && (__VLS_ctx.orphanCount + __VLS_ctx.brokenCount) > 0 && !__VLS_ctx.batchFixing) {
    const __VLS_0 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn batch-btn" },
        icon: (__VLS_ctx.MagicStick),
        disabled: (__VLS_ctx.anyFixing),
    }));
    const __VLS_2 = __VLS_1({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn batch-btn" },
        icon: (__VLS_ctx.MagicStick),
        disabled: (__VLS_ctx.anyFixing),
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    let __VLS_4;
    let __VLS_5;
    let __VLS_6;
    const __VLS_7 = {
        onClick: (...[$event]) => {
            if (!(__VLS_ctx.report && (__VLS_ctx.orphanCount + __VLS_ctx.brokenCount) > 0 && !__VLS_ctx.batchFixing))
                return;
            __VLS_ctx.batchFix('all');
        }
    };
    __VLS_3.slots.default;
    var __VLS_3;
}
const __VLS_8 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.loading),
    disabled: (__VLS_ctx.anyFixing),
}));
const __VLS_10 = __VLS_9({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.loading),
    disabled: (__VLS_ctx.anyFixing),
}, ...__VLS_functionalComponentArgsRest(__VLS_9));
let __VLS_12;
let __VLS_13;
let __VLS_14;
const __VLS_15 = {
    onClick: (__VLS_ctx.runCheck)
};
__VLS_11.slots.default;
var __VLS_11;
if (__VLS_ctx.report) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "summary-bar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "summary-item" },
        ...{ class: (__VLS_ctx.healthStatus) },
    });
    if (__VLS_ctx.healthStatus === 'healthy') {
        const __VLS_16 = {}.ElIcon;
        /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
        // @ts-ignore
        const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({}));
        const __VLS_18 = __VLS_17({}, ...__VLS_functionalComponentArgsRest(__VLS_17));
        __VLS_19.slots.default;
        const __VLS_20 = {}.CircleCheck;
        /** @type {[typeof __VLS_components.CircleCheck, ]} */ ;
        // @ts-ignore
        const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({}));
        const __VLS_22 = __VLS_21({}, ...__VLS_functionalComponentArgsRest(__VLS_21));
        var __VLS_19;
    }
    else {
        const __VLS_24 = {}.ElIcon;
        /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
        // @ts-ignore
        const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({}));
        const __VLS_26 = __VLS_25({}, ...__VLS_functionalComponentArgsRest(__VLS_25));
        __VLS_27.slots.default;
        const __VLS_28 = {}.Warning;
        /** @type {[typeof __VLS_components.Warning, ]} */ ;
        // @ts-ignore
        const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({}));
        const __VLS_30 = __VLS_29({}, ...__VLS_functionalComponentArgsRest(__VLS_29));
        var __VLS_27;
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "summary-text" },
    });
    (__VLS_ctx.healthStatus === 'healthy' ? '系统状态良好 · ALL CLEAR' : `发现 ${__VLS_ctx.totalIssues} 个问题 · NEEDS ATTENTION`);
}
if (__VLS_ctx.batchFixing) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "batch-progress-bar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "batch-progress-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "batch-progress-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "batch-progress-count" },
    });
    (__VLS_ctx.batchDoneKeys.size);
    (__VLS_ctx.batchTotal);
    const __VLS_32 = {}.ElProgress;
    /** @type {[typeof __VLS_components.ElProgress, typeof __VLS_components.elProgress, ]} */ ;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
        percentage: (__VLS_ctx.batchProgress),
        strokeWidth: (10),
        format: (() => `当前第 ${__VLS_ctx.batchCurrent} / ${__VLS_ctx.batchTotal} 个`),
        striped: true,
        stripedFlow: true,
    }));
    const __VLS_34 = __VLS_33({
        percentage: (__VLS_ctx.batchProgress),
        strokeWidth: (10),
        format: (() => `当前第 ${__VLS_ctx.batchCurrent} / ${__VLS_ctx.batchTotal} 个`),
        striped: true,
        stripedFlow: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_33));
}
if (__VLS_ctx.loading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "health-loading" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "loading-text" },
    });
    const __VLS_36 = {}.ElSkeleton;
    /** @type {[typeof __VLS_components.ElSkeleton, typeof __VLS_components.elSkeleton, ]} */ ;
    // @ts-ignore
    const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
        rows: (1),
        animated: true,
        ...{ class: "health-skeleton-summary" },
    }));
    const __VLS_38 = __VLS_37({
        rows: (1),
        animated: true,
        ...{ class: "health-skeleton-summary" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_37));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "health-skeleton-body" },
    });
    const __VLS_40 = {}.ElSkeleton;
    /** @type {[typeof __VLS_components.ElSkeleton, typeof __VLS_components.elSkeleton, ]} */ ;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
        rows: (2),
        animated: true,
        ...{ class: "health-skeleton-section" },
    }));
    const __VLS_42 = __VLS_41({
        rows: (2),
        animated: true,
        ...{ class: "health-skeleton-section" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_41));
    const __VLS_44 = {}.ElSkeleton;
    /** @type {[typeof __VLS_components.ElSkeleton, typeof __VLS_components.elSkeleton, ]} */ ;
    // @ts-ignore
    const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
        rows: (2),
        animated: true,
        ...{ class: "health-skeleton-section" },
    }));
    const __VLS_46 = __VLS_45({
        rows: (2),
        animated: true,
        ...{ class: "health-skeleton-section" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_45));
    const __VLS_48 = {}.ElSkeleton;
    /** @type {[typeof __VLS_components.ElSkeleton, typeof __VLS_components.elSkeleton, ]} */ ;
    // @ts-ignore
    const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
        rows: (2),
        animated: true,
        ...{ class: "health-skeleton-section" },
    }));
    const __VLS_50 = __VLS_49({
        rows: (2),
        animated: true,
        ...{ class: "health-skeleton-section" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_49));
}
if (__VLS_ctx.batchSummary) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "batch-summary" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "batch-summary-head" },
    });
    const __VLS_52 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({
        ...{ class: "batch-summary-icon" },
    }));
    const __VLS_54 = __VLS_53({
        ...{ class: "batch-summary-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_53));
    __VLS_55.slots.default;
    const __VLS_56 = {}.Check;
    /** @type {[typeof __VLS_components.Check, ]} */ ;
    // @ts-ignore
    const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({}));
    const __VLS_58 = __VLS_57({}, ...__VLS_functionalComponentArgsRest(__VLS_57));
    var __VLS_55;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "batch-summary-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "batch-summary-body" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "summary-stat" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "stat-num ok" },
    });
    (__VLS_ctx.batchSummary.ok);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "stat-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "summary-stat" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "stat-num fail" },
    });
    (__VLS_ctx.batchSummary.fail);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "stat-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "summary-stat" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "stat-num total" },
    });
    (__VLS_ctx.batchSummary.total);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "stat-label" },
    });
}
else if (__VLS_ctx.report) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "health-body" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "issue-section hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "section-icon icon-orphan" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "section-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "section-count" },
        ...{ class: ({ 'has-issue': __VLS_ctx.orphanCount > 0 }) },
    });
    (__VLS_ctx.orphanCount);
    if (__VLS_ctx.orphanCount > 0 && !__VLS_ctx.batchFixing) {
        const __VLS_60 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "neon-btn batch-section-btn" },
            icon: (__VLS_ctx.MagicStick),
            disabled: (__VLS_ctx.anyFixing),
        }));
        const __VLS_62 = __VLS_61({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "neon-btn batch-section-btn" },
            icon: (__VLS_ctx.MagicStick),
            disabled: (__VLS_ctx.anyFixing),
        }, ...__VLS_functionalComponentArgsRest(__VLS_61));
        let __VLS_64;
        let __VLS_65;
        let __VLS_66;
        const __VLS_67 = {
            onClick: (...[$event]) => {
                if (!!(__VLS_ctx.batchSummary))
                    return;
                if (!(__VLS_ctx.report))
                    return;
                if (!(__VLS_ctx.orphanCount > 0 && !__VLS_ctx.batchFixing))
                    return;
                __VLS_ctx.batchFix('orphan');
            }
        };
        __VLS_63.slots.default;
        var __VLS_63;
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-desc" },
    });
    if (__VLS_ctx.orphanCount > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "issue-list" },
        });
        for (const [p] of __VLS_getVForSourceType((__VLS_ctx.report.orphans))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (p),
                ...{ class: "issue-item" },
                ...{ class: ({ 'issue-done': __VLS_ctx.batchDoneKeys.has(`orphan:${p}`) }) },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
            (p);
            const __VLS_68 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_69 = __VLS_asFunctionalComponent(__VLS_68, new __VLS_68({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn" },
                loading: (__VLS_ctx.fixingKey === `orphan:${p}`),
                disabled: (__VLS_ctx.anyFixing),
                icon: (__VLS_ctx.Tools),
            }));
            const __VLS_70 = __VLS_69({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn" },
                loading: (__VLS_ctx.fixingKey === `orphan:${p}`),
                disabled: (__VLS_ctx.anyFixing),
                icon: (__VLS_ctx.Tools),
            }, ...__VLS_functionalComponentArgsRest(__VLS_69));
            let __VLS_72;
            let __VLS_73;
            let __VLS_74;
            const __VLS_75 = {
                onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.batchSummary))
                        return;
                    if (!(__VLS_ctx.report))
                        return;
                    if (!(__VLS_ctx.orphanCount > 0))
                        return;
                    __VLS_ctx.fixIssue('orphan', p, `orphan:${p}`);
                }
            };
            __VLS_71.slots.default;
            var __VLS_71;
        }
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "no-issue" },
        });
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "issue-section hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "section-icon icon-broken" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "section-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "section-count" },
        ...{ class: ({ 'has-issue': __VLS_ctx.brokenCount > 0 }) },
    });
    (__VLS_ctx.brokenCount);
    if (__VLS_ctx.brokenCount > 0 && !__VLS_ctx.batchFixing) {
        const __VLS_76 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_77 = __VLS_asFunctionalComponent(__VLS_76, new __VLS_76({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "neon-btn batch-section-btn" },
            icon: (__VLS_ctx.MagicStick),
            disabled: (__VLS_ctx.anyFixing),
        }));
        const __VLS_78 = __VLS_77({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "neon-btn batch-section-btn" },
            icon: (__VLS_ctx.MagicStick),
            disabled: (__VLS_ctx.anyFixing),
        }, ...__VLS_functionalComponentArgsRest(__VLS_77));
        let __VLS_80;
        let __VLS_81;
        let __VLS_82;
        const __VLS_83 = {
            onClick: (...[$event]) => {
                if (!!(__VLS_ctx.batchSummary))
                    return;
                if (!(__VLS_ctx.report))
                    return;
                if (!(__VLS_ctx.brokenCount > 0 && !__VLS_ctx.batchFixing))
                    return;
                __VLS_ctx.batchFix('broken');
            }
        };
        __VLS_79.slots.default;
        var __VLS_79;
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-desc" },
    });
    if (__VLS_ctx.brokenCount > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "issue-list" },
        });
        for (const [b, idx] of __VLS_getVForSourceType((__VLS_ctx.report.brokenLinks))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (idx),
                ...{ class: "issue-item broken" },
                ...{ class: ({ 'issue-done': __VLS_ctx.batchDoneKeys.has(`broken:${b.from}->${b.to}`) }) },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
            (b.from);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "arrow" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
                ...{ class: "broken-target" },
            });
            (b.to);
            const __VLS_84 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_85 = __VLS_asFunctionalComponent(__VLS_84, new __VLS_84({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn" },
                loading: (__VLS_ctx.fixingKey === `broken:${idx}`),
                disabled: (__VLS_ctx.anyFixing),
                icon: (__VLS_ctx.Tools),
            }));
            const __VLS_86 = __VLS_85({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn" },
                loading: (__VLS_ctx.fixingKey === `broken:${idx}`),
                disabled: (__VLS_ctx.anyFixing),
                icon: (__VLS_ctx.Tools),
            }, ...__VLS_functionalComponentArgsRest(__VLS_85));
            let __VLS_88;
            let __VLS_89;
            let __VLS_90;
            const __VLS_91 = {
                onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.batchSummary))
                        return;
                    if (!(__VLS_ctx.report))
                        return;
                    if (!(__VLS_ctx.brokenCount > 0))
                        return;
                    __VLS_ctx.fixIssue('broken_link', b, `broken:${idx}`);
                }
            };
            __VLS_87.slots.default;
            var __VLS_87;
        }
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "no-issue" },
        });
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "issue-section hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "section-icon icon-stale" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "section-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "section-count" },
        ...{ class: ({ 'has-issue': __VLS_ctx.staleCount > 0 }) },
    });
    (__VLS_ctx.staleCount);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-desc" },
    });
    if (__VLS_ctx.staleCount > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "issue-list" },
        });
        for (const [p] of __VLS_getVForSourceType((__VLS_ctx.report.stale))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (p),
                ...{ class: "issue-item" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
            (p);
        }
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "no-issue" },
        });
    }
    if (__VLS_ctx.fixLogs.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "fix-log-section" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "section-head" },
        });
        const __VLS_92 = {}.ElIcon;
        /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
        // @ts-ignore
        const __VLS_93 = __VLS_asFunctionalComponent(__VLS_92, new __VLS_92({
            ...{ class: "section-icon icon-fix" },
        }));
        const __VLS_94 = __VLS_93({
            ...{ class: "section-icon icon-fix" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_93));
        __VLS_95.slots.default;
        const __VLS_96 = {}.Lightning;
        /** @type {[typeof __VLS_components.Lightning, ]} */ ;
        // @ts-ignore
        const __VLS_97 = __VLS_asFunctionalComponent(__VLS_96, new __VLS_96({}));
        const __VLS_98 = __VLS_97({}, ...__VLS_functionalComponentArgsRest(__VLS_97));
        var __VLS_95;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "section-title" },
        });
        const __VLS_100 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_101 = __VLS_asFunctionalComponent(__VLS_100, new __VLS_100({
            ...{ 'onClick': {} },
            size: "small",
            text: true,
            ...{ class: "clear-logs-btn" },
        }));
        const __VLS_102 = __VLS_101({
            ...{ 'onClick': {} },
            size: "small",
            text: true,
            ...{ class: "clear-logs-btn" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_101));
        let __VLS_104;
        let __VLS_105;
        let __VLS_106;
        const __VLS_107 = {
            onClick: (__VLS_ctx.clearLogs)
        };
        __VLS_103.slots.default;
        var __VLS_103;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "fix-log-list" },
        });
        for (const [log, idx] of __VLS_getVForSourceType((__VLS_ctx.fixLogs))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (idx),
                ...{ class: "fix-log-item" },
                ...{ class: (log.status) },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "log-step" },
            });
            (log.step);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "log-message" },
            });
            (log.message);
            if (log.tool) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "log-tool" },
                });
                (log.tool);
            }
        }
    }
}
/** @type {__VLS_StyleScopedClasses['health-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['health-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['health-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['head-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-item']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-text']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-progress-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-progress-head']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-progress-label']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-progress-count']} */ ;
/** @type {__VLS_StyleScopedClasses['health-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-text']} */ ;
/** @type {__VLS_StyleScopedClasses['health-skeleton-summary']} */ ;
/** @type {__VLS_StyleScopedClasses['health-skeleton-body']} */ ;
/** @type {__VLS_StyleScopedClasses['health-skeleton-section']} */ ;
/** @type {__VLS_StyleScopedClasses['health-skeleton-section']} */ ;
/** @type {__VLS_StyleScopedClasses['health-skeleton-section']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-summary']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-summary-head']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-summary-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-summary-title']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-summary-body']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-num']} */ ;
/** @type {__VLS_StyleScopedClasses['ok']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-num']} */ ;
/** @type {__VLS_StyleScopedClasses['fail']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-stat']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-num']} */ ;
/** @type {__VLS_StyleScopedClasses['total']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['health-body']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-section']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['section-head']} */ ;
/** @type {__VLS_StyleScopedClasses['section-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-orphan']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['section-count']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-section-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-list']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-item']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['no-issue']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-section']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['section-head']} */ ;
/** @type {__VLS_StyleScopedClasses['section-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-broken']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['section-count']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-section-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-list']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-item']} */ ;
/** @type {__VLS_StyleScopedClasses['broken']} */ ;
/** @type {__VLS_StyleScopedClasses['arrow']} */ ;
/** @type {__VLS_StyleScopedClasses['broken-target']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['no-issue']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-section']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['section-head']} */ ;
/** @type {__VLS_StyleScopedClasses['section-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-stale']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['section-count']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-list']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-item']} */ ;
/** @type {__VLS_StyleScopedClasses['no-issue']} */ ;
/** @type {__VLS_StyleScopedClasses['fix-log-section']} */ ;
/** @type {__VLS_StyleScopedClasses['section-head']} */ ;
/** @type {__VLS_StyleScopedClasses['section-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-fix']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['clear-logs-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['fix-log-list']} */ ;
/** @type {__VLS_StyleScopedClasses['fix-log-item']} */ ;
/** @type {__VLS_StyleScopedClasses['log-step']} */ ;
/** @type {__VLS_StyleScopedClasses['log-message']} */ ;
/** @type {__VLS_StyleScopedClasses['log-tool']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Warning: Warning,
            CircleCheck: CircleCheck,
            Tools: Tools,
            MagicStick: MagicStick,
            Check: Check,
            Lightning: Lightning,
            fixingKey: fixingKey,
            fixLogs: fixLogs,
            batchFixing: batchFixing,
            batchTotal: batchTotal,
            batchCurrent: batchCurrent,
            batchDoneKeys: batchDoneKeys,
            batchProgress: batchProgress,
            anyFixing: anyFixing,
            report: report,
            batchSummary: batchSummary,
            loading: loading,
            orphanCount: orphanCount,
            brokenCount: brokenCount,
            staleCount: staleCount,
            totalIssues: totalIssues,
            healthStatus: healthStatus,
            runCheck: runCheck,
            fixIssue: fixIssue,
            batchFix: batchFix,
            clearLogs: clearLogs,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
