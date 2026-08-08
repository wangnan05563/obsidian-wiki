/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useSkillStore } from '../stores/skill';
import { apiErrorMessage } from '../utils/apiError';
const store = useSkillStore();
// 视图模式：list 列表 / detail 详情
const viewMode = ref('list');
// 文件上传相关
const fileInput = ref(null);
const dragOver = ref(false);
// 搜索关键字
const searchKeyword = ref('');
// 格式筛选
const formatFilter = ref('all');
// 格式化文件大小
function formatSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
// 格式化时间
function formatDate(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }
    catch {
        return iso;
    }
}
// 过滤后的技能列表
const filteredSkills = computed(() => {
    let list = store.skills;
    if (formatFilter.value !== 'all') {
        list = list.filter((s) => s.format === formatFilter.value);
    }
    if (searchKeyword.value.trim()) {
        const kw = searchKeyword.value.trim().toLowerCase();
        list = list.filter((s) => s.name.toLowerCase().includes(kw) ||
            s.id.toLowerCase().includes(kw) ||
            s.description.toLowerCase().includes(kw));
    }
    return list;
});
// 触发文件选择
function triggerFileSelect() {
    fileInput.value?.click();
}
// 校验文件扩展名
function isValidSkillFile(file) {
    const name = file.name.toLowerCase();
    return name.endsWith('.skill') || name.endsWith('.md');
}
// 处理文件选择
async function handleFileSelect(e) {
    const target = e.target;
    if (!target.files || target.files.length === 0)
        return;
    const file = target.files[0];
    await uploadFile(file);
    // 清空 input 的 value 允许重复上传同名文件
    target.value = '';
}
// 处理拖拽放下
async function handleDrop(e) {
    dragOver.value = false;
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0)
        return;
    const file = e.dataTransfer.files[0];
    await uploadFile(file);
}
// 上传文件
async function uploadFile(file) {
    if (!isValidSkillFile(file)) {
        ElMessage.warning('仅支持 .skill（ZIP 归档）或 .md（Markdown）文件');
        return;
    }
    if (file.size > 10 * 1024 * 1024) {
        ElMessage.warning('文件大小不能超过 10MB');
        return;
    }
    const result = await store.uploadSkill(file);
    if (result) {
        ElMessage.success(`技能 "${result.skill.name}" 导入成功`);
        if (result.warnings.length > 0) {
            // 有警告时用 MessageBox 展示详情
            await ElMessageBox.alert(result.warnings.map((w) => `• ${w}`).join('\n'), '导入完成（含警告）', { type: 'warning', confirmButtonText: '知道了' }).catch(() => { });
        }
    }
    else if (store.error) {
        ElMessage.error(apiErrorMessage('技能导入失败', store.error));
    }
}
// 查看详情
async function viewDetail(skill) {
    viewMode.value = 'detail';
    await store.fetchSkillDetail(skill.id);
    if (store.error) {
        ElMessage.error(apiErrorMessage('加载详情失败', store.error));
    }
}
// 返回列表
function backToList() {
    viewMode.value = 'list';
    store.clearDetail();
}
// 删除技能
async function handleDelete(skill) {
    try {
        await ElMessageBox.confirm(`确定要删除技能 "${skill.name}" 吗？此操作不可撤销。`, '删除确认', {
            type: 'warning',
            confirmButtonText: '删除',
            cancelButtonText: '取消',
            confirmButtonClass: 'el-button--danger',
        });
    }
    catch {
        return; // 用户取消
    }
    const ok = await store.deleteSkill(skill.id);
    if (ok) {
        ElMessage.success(`技能 "${skill.name}" 已删除`);
    }
    else {
        ElMessage.error(apiErrorMessage('删除失败', store.error));
    }
}
// 刷新列表
async function refreshList() {
    await store.fetchSkills();
    if (store.error) {
        ElMessage.error(apiErrorMessage('刷新列表失败', store.error));
    }
}
onMounted(() => {
    // 首次进入页面加载列表
    if (store.skills.length === 0) {
        void store.fetchSkills();
    }
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['upload-zone']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-zone']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-zone']} */ ;
/** @type {__VLS_StyleScopedClasses['search-input']} */ ;
/** @type {__VLS_StyleScopedClasses['filter-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['refresh-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['refresh-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-item']} */ ;
/** @type {__VLS_StyleScopedClasses['format-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['format-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['action-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['back-btn']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "skill-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card skill-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "skill-head" },
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
    ...{ class: "head-stats" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "stat-item" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "stat-value" },
});
(__VLS_ctx.store.totalCount);
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "stat-label" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "stat-item" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "stat-value" },
});
(__VLS_ctx.formatSize(__VLS_ctx.store.totalSize));
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "stat-label" },
});
if (__VLS_ctx.viewMode === 'list') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "list-view" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onClick: (__VLS_ctx.triggerFileSelect) },
        ...{ onDragover: (...[$event]) => {
                if (!(__VLS_ctx.viewMode === 'list'))
                    return;
                __VLS_ctx.dragOver = true;
            } },
        ...{ onDragleave: (...[$event]) => {
                if (!(__VLS_ctx.viewMode === 'list'))
                    return;
                __VLS_ctx.dragOver = false;
            } },
        ...{ onDrop: (__VLS_ctx.handleDrop) },
        ...{ class: "upload-zone" },
        ...{ class: ({ 'drag-over': __VLS_ctx.dragOver, 'uploading': __VLS_ctx.store.uploading }) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        ...{ onChange: (__VLS_ctx.handleFileSelect) },
        ref: "fileInput",
        type: "file",
        accept: ".skill,.md",
        ...{ class: "file-input" },
    });
    /** @type {typeof __VLS_ctx.fileInput} */ ;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "upload-icon" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
        width: "40",
        height: "40",
        viewBox: "0 0 24 24",
        fill: "none",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M12 16V4M12 4l-4 4M12 4l4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
        stroke: "currentColor",
        'stroke-width': "1.5",
        'stroke-linecap': "round",
        'stroke-linejoin': "round",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "upload-text" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "upload-title" },
    });
    (__VLS_ctx.store.uploading ? '正在上传...' : '点击或拖拽文件到此处');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "upload-hint" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "toolbar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "toolbar-left" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        value: (__VLS_ctx.searchKeyword),
        type: "text",
        ...{ class: "search-input" },
        placeholder: "搜索技能名称、ID 或描述...",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "format-filter" },
    });
    for (const [opt] of __VLS_getVForSourceType(([{ v: 'all', l: '全部' }, { v: 'zip', l: 'ZIP' }, { v: 'md', l: 'MD' }]))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.viewMode === 'list'))
                        return;
                    __VLS_ctx.formatFilter = opt.v;
                } },
            key: (opt.v),
            ...{ class: "filter-btn" },
            ...{ class: ({ active: __VLS_ctx.formatFilter === opt.v }) },
        });
        (opt.l);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.refreshList) },
        ...{ class: "refresh-btn" },
        disabled: (__VLS_ctx.store.loading),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
        width: "14",
        height: "14",
        viewBox: "0 0 24 24",
        fill: "none",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5",
        stroke: "currentColor",
        'stroke-width': "2",
        'stroke-linecap': "round",
        'stroke-linejoin': "round",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    (__VLS_ctx.store.loading ? '加载中' : '刷新');
    if (__VLS_ctx.store.error) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "error-banner" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.store.error);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.viewMode === 'list'))
                        return;
                    if (!(__VLS_ctx.store.error))
                        return;
                    __VLS_ctx.store.clearError();
                } },
            ...{ class: "close-btn" },
        });
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "skills-list" },
    });
    if (__VLS_ctx.store.loading && __VLS_ctx.store.skills.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "empty-state" },
        });
    }
    else if (__VLS_ctx.filteredSkills.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "empty-state" },
        });
        if (__VLS_ctx.store.skills.length === 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        }
    }
    for (const [skill] of __VLS_getVForSourceType((__VLS_ctx.filteredSkills))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (skill.id),
            ...{ class: "skill-item hover-glow" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "skill-icon" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "format-badge" },
            ...{ class: (`format-${skill.format}`) },
        });
        (skill.format.toUpperCase());
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.viewMode === 'list'))
                        return;
                    __VLS_ctx.viewDetail(skill);
                } },
            ...{ class: "skill-main" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "skill-name-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "skill-name" },
        });
        (skill.name);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "skill-id" },
        });
        (skill.id);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "skill-desc" },
        });
        (skill.description || '（无描述）');
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "skill-meta" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.formatDate(skill.importedAt));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "dot" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.formatSize(skill.size));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "dot" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (skill.entryFile);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "skill-actions" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.viewMode === 'list'))
                        return;
                    __VLS_ctx.viewDetail(skill);
                } },
            ...{ class: "action-btn view-btn" },
            title: "查看详情",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
            d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z",
            stroke: "currentColor",
            'stroke-width': "2",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
            cx: "12",
            cy: "12",
            r: "3",
            stroke: "currentColor",
            'stroke-width': "2",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.viewMode === 'list'))
                        return;
                    __VLS_ctx.handleDelete(skill);
                } },
            ...{ class: "action-btn delete-btn" },
            title: "删除",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
            d: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
            stroke: "currentColor",
            'stroke-width': "2",
            'stroke-linecap': "round",
            'stroke-linejoin': "round",
        });
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "detail-view" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "detail-header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.backToList) },
        ...{ class: "back-btn" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
        d: "M19 12H5M12 19l-7-7 7-7",
        stroke: "currentColor",
        'stroke-width': "2",
        'stroke-linecap': "round",
        'stroke-linejoin': "round",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    if (!__VLS_ctx.store.currentDetail) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "empty-state" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "detail-content" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "detail-title-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
            ...{ class: "detail-title" },
        });
        (__VLS_ctx.store.currentDetail.name);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "format-badge" },
            ...{ class: (`format-${__VLS_ctx.store.currentDetail.format}`) },
        });
        (__VLS_ctx.store.currentDetail.format.toUpperCase());
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "detail-meta" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.store.currentDetail.id);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "dot" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.formatDate(__VLS_ctx.store.currentDetail.importedAt));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "dot" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.formatSize(__VLS_ctx.store.currentDetail.size));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "dot" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.store.currentDetail.entryFile);
        if (__VLS_ctx.store.currentDetail.description) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "detail-desc" },
            });
            (__VLS_ctx.store.currentDetail.description);
        }
        if (__VLS_ctx.store.currentDetail.files.length > 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "files-section" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({
                ...{ class: "section-title" },
            });
            (__VLS_ctx.store.currentDetail.files.length);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "files-tree" },
            });
            for (const [file] of __VLS_getVForSourceType((__VLS_ctx.store.currentDetail.files))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (file),
                    ...{ class: "file-item" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
                    width: "14",
                    height: "14",
                    viewBox: "0 0 24 24",
                    fill: "none",
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
                    d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
                    stroke: "currentColor",
                    'stroke-width': "2",
                    'stroke-linejoin': "round",
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
                    d: "M14 2v6h6",
                    stroke: "currentColor",
                    'stroke-width': "2",
                    'stroke-linejoin': "round",
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (file);
            }
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "content-section" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({
            ...{ class: "section-title" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({
            ...{ class: "skill-content" },
        });
        (__VLS_ctx.store.currentDetail.content);
    }
}
/** @type {__VLS_StyleScopedClasses['skill-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['head-stats']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-item']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-value']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-item']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-value']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['list-view']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-zone']} */ ;
/** @type {__VLS_StyleScopedClasses['file-input']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-text']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-title']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-left']} */ ;
/** @type {__VLS_StyleScopedClasses['search-input']} */ ;
/** @type {__VLS_StyleScopedClasses['format-filter']} */ ;
/** @type {__VLS_StyleScopedClasses['filter-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['refresh-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['error-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['close-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['skills-list']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-item']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['format-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-main']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-name-row']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-name']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-id']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['action-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['view-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['action-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['delete-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['detail-view']} */ ;
/** @type {__VLS_StyleScopedClasses['detail-header']} */ ;
/** @type {__VLS_StyleScopedClasses['back-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['detail-content']} */ ;
/** @type {__VLS_StyleScopedClasses['detail-title-row']} */ ;
/** @type {__VLS_StyleScopedClasses['detail-title']} */ ;
/** @type {__VLS_StyleScopedClasses['format-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['detail-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['detail-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['files-section']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['files-tree']} */ ;
/** @type {__VLS_StyleScopedClasses['file-item']} */ ;
/** @type {__VLS_StyleScopedClasses['content-section']} */ ;
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
/** @type {__VLS_StyleScopedClasses['skill-content']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            store: store,
            viewMode: viewMode,
            fileInput: fileInput,
            dragOver: dragOver,
            searchKeyword: searchKeyword,
            formatFilter: formatFilter,
            formatSize: formatSize,
            formatDate: formatDate,
            filteredSkills: filteredSkills,
            triggerFileSelect: triggerFileSelect,
            handleFileSelect: handleFileSelect,
            handleDrop: handleDrop,
            viewDetail: viewDetail,
            backToList: backToList,
            handleDelete: handleDelete,
            refreshList: refreshList,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
