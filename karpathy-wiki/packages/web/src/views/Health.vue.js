/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { Warning, CircleCheck, Tools } from '@element-plus/icons-vue';
import RobotAvatar from '../components/RobotAvatar.vue';
const report = ref(null);
const loading = ref(false);
// 修复状态：fixing 标记当前正在修复的问题 key（格式：orphan:path 或 broken:idx）
const fixingKey = ref('');
// 修复进度日志（时间线展示）
const fixLogs = ref([]);
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
    try {
        const res = await fetch('/api/health-check', { method: 'POST' });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        report.value = await res.json();
    }
    catch (err) {
        ElMessage.error('体检失败：' + err.message);
    }
    finally {
        loading.value = false;
    }
}
// 一键修复单个问题。SSE 流式接收修复进度。
// issueType 区分断链/孤立，target 为 {from,to} 或字符串路径。
async function fixIssue(issueType, target, key) {
    fixingKey.value = key;
    fixLogs.value = [];
    const payload = { issueType, target };
    try {
        const res = await fetch('/api/health-check/fix', {
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
                const lines = evt.split('\n');
                let eventType = '';
                let data = '';
                for (const line of lines) {
                    if (line.startsWith('event: '))
                        eventType = line.slice(7);
                    if (line.startsWith('data: '))
                        data = line.slice(6);
                }
                if (!eventType || !data)
                    continue;
                try {
                    const parsed = JSON.parse(data);
                    if (eventType === 'progress' || eventType === 'fixed') {
                        fixLogs.value.push(parsed);
                    }
                    else if (eventType === 'done') {
                        fixLogs.value.push(parsed);
                        if (parsed.status === 'done') {
                            ElMessage.success('修复完成');
                            // 修复后重新体检刷新报告
                            await runCheck();
                        }
                        else {
                            ElMessage.error(parsed.message || '修复失败');
                        }
                    }
                    else if (eventType === 'error') {
                        ElMessage.error(parsed.message || '修复出错');
                    }
                }
                catch {
                    // 非 JSON 数据跳过
                }
            }
        }
    }
    catch (err) {
        ElMessage.error('修复请求失败：' + err.message);
    }
    finally {
        fixingKey.value = '';
    }
}
onMounted(() => {
    runCheck();
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-item']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-item']} */ ;
/** @type {__VLS_StyleScopedClasses['section-count']} */ ;
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
const __VLS_3 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_4 = __VLS_asFunctionalComponent(__VLS_3, new __VLS_3({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.loading),
}));
const __VLS_5 = __VLS_4({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.loading),
}, ...__VLS_functionalComponentArgsRest(__VLS_4));
let __VLS_7;
let __VLS_8;
let __VLS_9;
const __VLS_10 = {
    onClick: (__VLS_ctx.runCheck)
};
__VLS_6.slots.default;
var __VLS_6;
if (__VLS_ctx.report) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "summary-bar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "summary-item" },
        ...{ class: (__VLS_ctx.healthStatus) },
    });
    if (__VLS_ctx.healthStatus === 'healthy') {
        const __VLS_11 = {}.ElIcon;
        /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
        // @ts-ignore
        const __VLS_12 = __VLS_asFunctionalComponent(__VLS_11, new __VLS_11({}));
        const __VLS_13 = __VLS_12({}, ...__VLS_functionalComponentArgsRest(__VLS_12));
        __VLS_14.slots.default;
        const __VLS_15 = {}.CircleCheck;
        /** @type {[typeof __VLS_components.CircleCheck, ]} */ ;
        // @ts-ignore
        const __VLS_16 = __VLS_asFunctionalComponent(__VLS_15, new __VLS_15({}));
        const __VLS_17 = __VLS_16({}, ...__VLS_functionalComponentArgsRest(__VLS_16));
        var __VLS_14;
    }
    else {
        const __VLS_19 = {}.ElIcon;
        /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
        // @ts-ignore
        const __VLS_20 = __VLS_asFunctionalComponent(__VLS_19, new __VLS_19({}));
        const __VLS_21 = __VLS_20({}, ...__VLS_functionalComponentArgsRest(__VLS_20));
        __VLS_22.slots.default;
        const __VLS_23 = {}.Warning;
        /** @type {[typeof __VLS_components.Warning, ]} */ ;
        // @ts-ignore
        const __VLS_24 = __VLS_asFunctionalComponent(__VLS_23, new __VLS_23({}));
        const __VLS_25 = __VLS_24({}, ...__VLS_functionalComponentArgsRest(__VLS_24));
        var __VLS_22;
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "summary-text" },
    });
    (__VLS_ctx.healthStatus === 'healthy' ? '系统状态良好 · ALL CLEAR' : `发现 ${__VLS_ctx.totalIssues} 个问题 · NEEDS ATTENTION`);
}
if (__VLS_ctx.loading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "health-loading" },
    });
    /** @type {[typeof RobotAvatar, ]} */ ;
    // @ts-ignore
    const __VLS_27 = __VLS_asFunctionalComponent(RobotAvatar, new RobotAvatar({
        size: (100),
        floating: (true),
    }));
    const __VLS_28 = __VLS_27({
        size: (100),
        floating: (true),
    }, ...__VLS_functionalComponentArgsRest(__VLS_27));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "loading-text" },
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
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
            (p);
            const __VLS_30 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_31 = __VLS_asFunctionalComponent(__VLS_30, new __VLS_30({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn" },
                loading: (__VLS_ctx.fixingKey === `orphan:${p}`),
                disabled: (__VLS_ctx.fixingKey !== ''),
                icon: (__VLS_ctx.Tools),
            }));
            const __VLS_32 = __VLS_31({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn" },
                loading: (__VLS_ctx.fixingKey === `orphan:${p}`),
                disabled: (__VLS_ctx.fixingKey !== ''),
                icon: (__VLS_ctx.Tools),
            }, ...__VLS_functionalComponentArgsRest(__VLS_31));
            let __VLS_34;
            let __VLS_35;
            let __VLS_36;
            const __VLS_37 = {
                onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loading))
                        return;
                    if (!(__VLS_ctx.report))
                        return;
                    if (!(__VLS_ctx.orphanCount > 0))
                        return;
                    __VLS_ctx.fixIssue('orphan', p, `orphan:${p}`);
                }
            };
            __VLS_33.slots.default;
            var __VLS_33;
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
            const __VLS_38 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_39 = __VLS_asFunctionalComponent(__VLS_38, new __VLS_38({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn" },
                loading: (__VLS_ctx.fixingKey === `broken:${idx}`),
                disabled: (__VLS_ctx.fixingKey !== ''),
                icon: (__VLS_ctx.Tools),
            }));
            const __VLS_40 = __VLS_39({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn" },
                loading: (__VLS_ctx.fixingKey === `broken:${idx}`),
                disabled: (__VLS_ctx.fixingKey !== ''),
                icon: (__VLS_ctx.Tools),
            }, ...__VLS_functionalComponentArgsRest(__VLS_39));
            let __VLS_42;
            let __VLS_43;
            let __VLS_44;
            const __VLS_45 = {
                onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loading))
                        return;
                    if (!(__VLS_ctx.report))
                        return;
                    if (!(__VLS_ctx.brokenCount > 0))
                        return;
                    __VLS_ctx.fixIssue('broken_link', b, `broken:${idx}`);
                }
            };
            __VLS_41.slots.default;
            var __VLS_41;
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
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "section-icon icon-fix" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "section-title" },
        });
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
/** @type {__VLS_StyleScopedClasses['head-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-item']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-text']} */ ;
/** @type {__VLS_StyleScopedClasses['health-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-text']} */ ;
/** @type {__VLS_StyleScopedClasses['health-body']} */ ;
/** @type {__VLS_StyleScopedClasses['issue-section']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['section-head']} */ ;
/** @type {__VLS_StyleScopedClasses['section-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-orphan']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['section-count']} */ ;
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
            RobotAvatar: RobotAvatar,
            report: report,
            loading: loading,
            fixingKey: fixingKey,
            fixLogs: fixLogs,
            orphanCount: orphanCount,
            brokenCount: brokenCount,
            staleCount: staleCount,
            totalIssues: totalIssues,
            healthStatus: healthStatus,
            runCheck: runCheck,
            fixIssue: fixIssue,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
