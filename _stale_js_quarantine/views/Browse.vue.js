/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { ref, computed, onMounted, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search, Check, Close, CircleClose } from '@element-plus/icons-vue';
import { consumeSSE } from '../utils/sse';
import { useCompileStore } from '../stores/compile';
// §草稿发布状态提升到 compile store：App.vue 用 v-if 切换视图，
//   Browse.vue 卸载会丢失局部 ref，切换走 SSE 流仍能继续运行；
//   store 状态跨组件生命周期保留，切回页面后能继续看到进度信息
const compileStore = useCompileStore();
const mode = ref('knowledge');
const KNOWLEDGE_VIEW_STORAGE_KEY = 'karpathy:browseView';
const knowledgeView = ref(localStorage.getItem(KNOWLEDGE_VIEW_STORAGE_KEY) || 'tree');
watch(knowledgeView, (v) => {
    localStorage.setItem(KNOWLEDGE_VIEW_STORAGE_KEY, v);
    // 切到看板/日历时按需拉取页面列表，避免目录树模式下多余请求
    if ((v === 'kanban' || v === 'calendar') && allPages.value.length === 0) {
        loadAllPages();
    }
});
// FR-11 扁平化页面列表（看板/日历视图数据源）
const allPages = ref([]);
const pagesLoading = ref(false);
// 看板分列：4 个核心类型 + 其他
// 为什么用 type 而非 dir：dir 受 LLM 输出目录影响，type 是 frontmatter 字段更稳定
const KANBAN_COLUMNS = [
    { key: 'entity', label: '实体', icon: '◆' },
    { key: 'concept', label: '概念', icon: '◇' },
    { key: 'comparison', label: '对比', icon: '◈' },
    { key: 'query', label: '问答', icon: '◐' },
    { key: 'qa', label: '业务问答', icon: '◑' },
    { key: 'solution', label: '方案沉淀', icon: '◒' },
    { key: 'other', label: '未分类', icon: '◓' },
];
// 看板分组计算：按 frontmatter.type 分列，缺失则按 dir 推断，再不行归 'other'
const kanbanGroups = computed(() => {
    const groups = {};
    for (const col of KANBAN_COLUMNS)
        groups[col.key] = [];
    for (const p of allPages.value) {
        const t = String(p.frontmatter.type ?? '').toLowerCase();
        if (groups[t]) {
            groups[t].push(p);
        }
        else if (groups[p.dir]) {
            // frontmatter 缺 type 时回退到目录名（entities→entity 等单复数映射）
            const dirMap = {
                entities: 'entity',
                concepts: 'concept',
                comparisons: 'comparison',
                queries: 'query',
                qa: 'qa',
                solutions: 'solution',
            };
            const mapped = dirMap[p.dir];
            if (mapped && groups[mapped])
                groups[mapped].push(p);
            else
                groups.other.push(p);
        }
        else {
            groups.other.push(p);
        }
    }
    return groups;
});
// 日历视图：按 created 字段分组
// 为什么按日期而非月份：知识库页面密度低，按日期聚合后点击日期跳转更直观
const calendarGroups = computed(() => {
    const groups = {};
    for (const p of allPages.value) {
        const created = p.frontmatter.created;
        if (!created || typeof created !== 'string')
            continue;
        // 取 YYYY-MM-DD 部分（兼容 ISO 字符串与日期对象 toString）
        const dateMatch = created.match(/^\d{4}-\d{2}-\d{2}/);
        if (!dateMatch)
            continue;
        const date = dateMatch[0];
        if (!groups[date])
            groups[date] = [];
        groups[date].push(p);
    }
    // 按日期降序排序（最新在前）
    return Object.entries(groups)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([date, pages]) => ({ date, pages }));
});
async function loadAllPages() {
    pagesLoading.value = true;
    try {
        const res = await fetch(`${API_BASE}/files/pages`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        allPages.value = data.pages ?? [];
    }
    catch (err) {
        ElMessage.error('加载页面列表失败：' + err.message);
        allPages.value = [];
    }
    finally {
        pagesLoading.value = false;
    }
}
const treeData = ref([]);
const currentNode = ref('');
const fileContent = ref(null);
const loading = ref(false);
const editing = ref(false);
const editBuffer = ref('');
const searchQuery = ref('');
const searchHits = ref([]);
const searching = ref(false);
const showSearchResults = ref(false);
// AC-10: source/status 过滤 + FR-15-3: type 过滤
// 按 frontmatter.source 过滤（如 "qq-chat", "web", "manual"），空串 = 全部
const sourceFilter = ref('');
// 按 frontmatter.status 过滤（如 "draft", "published"），空串 = 全部
const statusFilter = ref('');
// FR-15-3：按 frontmatter.type 过滤（entity/concept/comparison/query/qa/solution），空串 = 全部
const typeFilter = ref('');
// 过滤选项预设值
const sourceOptions = [
    { label: '全部来源', value: '' },
    { label: 'QQ 聊天', value: 'qq-chat' },
    { label: '网页', value: 'web' },
    { label: '手工录入', value: 'manual' },
];
const statusOptions = [
    { label: '全部状态', value: '' },
    { label: '草稿', value: 'draft' },
    { label: '已发布', value: 'published' },
];
// FR-15-3：type 选项复用 KANBAN_COLUMNS 派生，避免重复维护枚举
// 为什么排除 other：other 是前端兜底分类，不是 SCHEMA.md 合法 type 值，不能作为过滤条件
const typeOptions = [
    { label: '全部类型', value: '' },
    ...KANBAN_COLUMNS.filter((c) => c.key !== 'other').map((c) => ({
        label: c.label,
        value: c.key,
    })),
];
const treeProps = {
    label: 'name',
    children: 'children',
};
// ===== 草稿审核状态 =====
// draft 列表与当前选中 draft 复用 fileContent（结构一致：frontmatter+body）
const drafts = ref([]);
const currentDraftPath = ref('');
// 批量编译进度：每项对应一个 draft 的编译状态
// §全部走 store：batchItems/compiling/progressMessage 从 compileStore 读取，
//   切页面时 Browse.vue 卸载但 store 状态保留，SSE 仍在后台运行
const batchItems = computed(() => compileStore.draftBatchItems);
const compiling = computed(() => compileStore.draftIsPublishing);
const progressMessage = computed(() => compileStore.draftProgressMessage);
let clearPanelTimer = null;
let searchDebounceTimer = null;
// ===== FR-10-1 AI 标签审核状态 =====
// 待审核 tag 页面列表（GET /api/tags/pending 返回）
const pendingTagPages = ref([]);
const currentTagPagePath = ref('');
// 单页面 tag 操作进行中标志（禁用按钮防重复点击）
const tagOperating = ref(false);
// 重新生成 tag 建议进行中标志
const tagRegenerating = ref(false);
async function loadTree() {
    try {
        const res = await fetch(`${API_BASE}/files/tree`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        treeData.value = data.tree ?? [];
    }
    catch (err) {
        ElMessage.error('加载目录树失败：' + err.message);
    }
}
async function loadDrafts() {
    try {
        const res = await fetch(`${API_BASE}/qq-ingest/drafts`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        drafts.value = data.drafts ?? [];
    }
    catch (err) {
        ElMessage.error('加载草稿列表失败：' + err.message);
        drafts.value = [];
    }
}
// FR-10-1: 加载待审核 tag 页面列表
// 为什么独立函数：与 loadDrafts 解耦，tags 模式切换时单独触发
async function loadPendingTags() {
    try {
        const res = await fetch(`${API_BASE}/tags/pending`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        pendingTagPages.value = data.pages ?? [];
    }
    catch (err) {
        ElMessage.error('加载待审核标签失败：' + err.message);
        pendingTagPages.value = [];
    }
}
// FR-10-1: 选中待审核 tag 页面，加载文件内容到右侧
// 为什么复用 fileContent：与 knowledge/draft 模式共享右侧内容渲染逻辑
async function handleTagPageClick(p) {
    if (hasUnsavedChanges()) {
        try {
            await ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
        }
        catch {
            return;
        }
    }
    currentTagPagePath.value = p.path;
    editing.value = false;
    loading.value = true;
    try {
        const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(p.path)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        fileContent.value = await res.json();
        editBuffer.value = fileContent.value?.content ?? '';
    }
    catch (err) {
        ElMessage.error('读取页面失败：' + err.message);
        fileContent.value = null;
    }
    finally {
        loading.value = false;
    }
}
// FR-10-1: 确认单个 tag（从 ai_tags 移到 tags）
// 为什么逐个确认：用户可挑选合适的 tag，拒绝不合适的（不点击即可）
async function confirmTag(pagePath, tag) {
    if (tagOperating.value)
        return;
    tagOperating.value = true;
    try {
        const res = await fetch(`${API_BASE}/tags/confirm`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: pagePath, tag }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        // 就地更新 pendingTagPages 中的对应项
        const idx = pendingTagPages.value.findIndex((p) => p.path === pagePath);
        if (idx >= 0) {
            // 若 ai_tags 已空，从列表移除；否则更新字段
            if (data.aiTags && data.aiTags.length === 0) {
                pendingTagPages.value.splice(idx, 1);
                // 当前选中的页面被移除时清空内容区
                if (currentTagPagePath.value === pagePath) {
                    fileContent.value = null;
                    currentTagPagePath.value = '';
                }
            }
            else {
                pendingTagPages.value[idx] = {
                    ...pendingTagPages.value[idx],
                    aiTags: data.aiTags ?? [],
                    existingTags: data.tags ?? pendingTagPages.value[idx].existingTags,
                };
            }
        }
        ElMessage.success(`已确认标签：${tag}`);
    }
    catch (err) {
        ElMessage.error('确认标签失败：' + err.message);
    }
    finally {
        tagOperating.value = false;
    }
}
// FR-10-1: 重新生成 tag 建议（POST /api/tags/suggest）
// 为什么独立按钮：LLM 可能首次生成质量不佳，用户可重试
async function regenerateTags(pagePath) {
    if (tagRegenerating.value)
        return;
    try {
        await ElMessageBox.confirm('重新生成将覆盖当前 AI 标签建议，且会调用 LLM 产生费用。继续？', '重新生成确认', { type: 'warning' });
    }
    catch {
        return;
    }
    tagRegenerating.value = true;
    try {
        const res = await fetch(`${API_BASE}/tags/suggest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: pagePath }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        // 就地更新 aiTags
        const idx = pendingTagPages.value.findIndex((p) => p.path === pagePath);
        if (idx >= 0) {
            pendingTagPages.value[idx] = {
                ...pendingTagPages.value[idx],
                aiTags: data.aiTags ?? [],
            };
        }
        ElMessage.success(`已重新生成 ${data.aiTags?.length ?? 0} 个标签建议`);
    }
    catch (err) {
        ElMessage.error('重新生成失败：' + err.message);
    }
    finally {
        tagRegenerating.value = false;
    }
}
// 构建搜索 URL，附加 source/status/type 过滤参数（AC-10 + FR-15-3）
function buildSearchUrl() {
    const q = searchQuery.value.trim();
    const src = sourceFilter.value;
    const st = statusFilter.value;
    const tp = typeFilter.value;
    // 无关键词且无过滤条件时返回 null（不搜索）
    if (!q && !src && !st && !tp)
        return null;
    const params = new URLSearchParams();
    if (q)
        params.set('q', q);
    if (src)
        params.set('source', src);
    if (st)
        params.set('status', st);
    if (tp)
        params.set('type', tp);
    return `${API_BASE}/search?${params.toString()}`;
}
async function doSearch() {
    const url = buildSearchUrl();
    if (!url) {
        showSearchResults.value = false;
        searchHits.value = [];
        return;
    }
    searching.value = true;
    showSearchResults.value = true;
    try {
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        searchHits.value = data.hits ?? [];
    }
    catch (err) {
        ElMessage.error('搜索失败：' + err.message);
        searchHits.value = [];
    }
    finally {
        searching.value = false;
    }
}
function clearSearch() {
    searchQuery.value = '';
    searchHits.value = [];
    showSearchResults.value = false;
    // 同时清除过滤条件（AC-10）
    sourceFilter.value = '';
    statusFilter.value = '';
}
// 过滤条件变更时立即触发搜索（无防抖，因为是下拉选择）
function handleFilterChange() {
    doSearch();
}
async function handleSearchHit(hit) {
    if (hasUnsavedChanges()) {
        try {
            await ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
        }
        catch {
            return;
        }
    }
    currentNode.value = hit.path;
    editing.value = false;
    loading.value = true;
    try {
        const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(hit.path)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        fileContent.value = await res.json();
        editBuffer.value = fileContent.value?.content ?? '';
    }
    catch (err) {
        ElMessage.error('读取文件失败：' + err.message);
        fileContent.value = null;
    }
    finally {
        loading.value = false;
    }
}
async function handleNodeClick(node) {
    if (node.type !== 'file')
        return;
    if (hasUnsavedChanges()) {
        try {
            await ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
        }
        catch {
            return;
        }
    }
    currentNode.value = node.path;
    editing.value = false;
    loading.value = true;
    try {
        const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(node.path)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        fileContent.value = await res.json();
        editBuffer.value = fileContent.value?.content ?? '';
    }
    catch (err) {
        ElMessage.error('读取文件失败：' + err.message);
        fileContent.value = null;
    }
    finally {
        loading.value = false;
    }
}
// FR-11 看板/日历视图点击页面：复用 /api/files 加载内容
// 为什么独立函数：与 handleNodeClick 入参类型不同（PageItem vs TreeNode），但内部逻辑等价
async function handlePageClick(p) {
    if (hasUnsavedChanges()) {
        try {
            await ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
        }
        catch {
            return;
        }
    }
    currentNode.value = p.path;
    editing.value = false;
    loading.value = true;
    try {
        const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(p.path)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        fileContent.value = await res.json();
        editBuffer.value = fileContent.value?.content ?? '';
    }
    catch (err) {
        ElMessage.error('读取文件失败：' + err.message);
        fileContent.value = null;
    }
    finally {
        loading.value = false;
    }
}
// 选中 draft：复用 /api/files 读取内容（draft 是 vault 内 .md 文件）
async function handleDraftClick(d) {
    if (hasUnsavedChanges()) {
        try {
            await ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
        }
        catch {
            return;
        }
    }
    currentDraftPath.value = d.path;
    editing.value = false;
    loading.value = true;
    try {
        const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(d.path)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        fileContent.value = await res.json();
        editBuffer.value = fileContent.value?.content ?? '';
    }
    catch (err) {
        ElMessage.error('读取草稿失败：' + err.message);
        fileContent.value = null;
    }
    finally {
        loading.value = false;
    }
}
function startEdit() {
    if (!fileContent.value)
        return;
    editBuffer.value = fileContent.value.content;
    editing.value = true;
}
function cancelEdit() {
    editing.value = false;
    editBuffer.value = '';
}
async function saveEdit() {
    const target = mode.value === 'draft' ? currentDraftPath.value : currentNode.value;
    if (!target)
        return;
    try {
        const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(target)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: editBuffer.value }),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        ElMessage.success('保存成功');
        editing.value = false;
        // 重新读取保留模式上下文：draft 模式回拉 draft，knowledge 模式回拉文件
        if (mode.value === 'draft') {
            await handleDraftClick({ path: target, name: '' });
        }
        else {
            await handleNodeClick({ path: target, name: '', type: 'file' });
        }
    }
    catch (err) {
        ElMessage.error('保存失败：' + err.message);
    }
}
// 发布单个 draft：调用 POST /api/qq-ingest/compile/:draftPath（SSE）
async function publishDraft(d) {
    if (compiling.value) {
        ElMessage.warning('正在编译中，请稍候');
        return;
    }
    // 二次确认：发布会调用 LLM 产生费用且写入正式页面
    try {
        await ElMessageBox.confirm(`确认发布草稿「${d.name}」到知识库？发布后将生成正式页面。`, '发布确认', { type: 'warning' });
    }
    catch {
        return; // 用户取消
    }
    // §走 store：初始化 batchItems 列表 + publishing 状态，便于切回后恢复
    compileStore.startSingleDraftPublish({
        path: d.path,
        name: d.name,
        status: 'running',
        pages: [],
    });
    const controller = new AbortController();
    compileStore.setDraftAbortController(controller);
    try {
        const res = await fetch(`${API_BASE}/qq-ingest/compile/${encodeURIComponent(d.path)}`, { method: 'POST', signal: controller.signal });
        if (!res.ok || !res.body) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        await consumeSSE(res, handleCompileEvent, controller.signal);
    }
    catch (err) {
        if (err.name === 'AbortError')
            return;
        ElMessage.error('发布失败：' + err.message);
        compileStore.updateDraftItem(0, { status: 'error', message: err.message });
    }
    finally {
        // §store 状态保留：SSE 流结束后保持 batchItems 可见
        //   compiling=false 标记已完成但不清空列表，由用户点击关闭按钮触发 clearDraftPublish
        compileStore.finalizeDraftPublish();
        compileStore.setDraftAbortController(null);
        // 编译完成后自动刷新草稿列表
        loadDrafts();
        loadTree();
    }
}
// 批量发布：调用 POST /api/qq-ingest/compile/batch（SSE）
async function publishAllDrafts() {
    if (compiling.value) {
        ElMessage.warning('正在编译中，请稍候');
        return;
    }
    if (drafts.value.length === 0) {
        ElMessage.info('没有可发布的草稿');
        return;
    }
    try {
        await ElMessageBox.confirm(`确认批量发布 ${drafts.value.length} 个草稿？此操作将逐个调用 LLM 编译并写入正式页面。`, '批量发布确认', { type: 'warning' });
    }
    catch {
        return;
    }
    // §走 store：初始化 batchItems 列表为 drafts 全部状态 pending，publishing=true
    compileStore.startDraftPublish(drafts.value.map((d) => ({
        path: d.path,
        name: d.name,
        status: 'pending',
        pages: [],
    })));
    const controller = new AbortController();
    compileStore.setDraftAbortController(controller);
    try {
        const res = await fetch(`${API_BASE}/qq-ingest/compile/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // 不传 drafts 字段：后端扫描 drafts/ 目录全部文件
            body: JSON.stringify({}),
            signal: controller.signal,
        });
        if (!res.ok || !res.body) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        await consumeSSE(res, handleCompileEvent, controller.signal);
        ElMessage.success('批量发布完成');
    }
    catch (err) {
        if (err.name === 'AbortError')
            return;
        ElMessage.error('批量发布失败：' + err.message);
    }
    finally {
        // §store 状态保留：SSE 流结束后保持 batchItems 可见
        compileStore.finalizeDraftPublish();
        compileStore.setDraftAbortController(null);
    }
}
// SSE 事件统一处理：单/批量编译共用
// §所有变更通过 store：保证切页面切回时 store 状态能完整恢复
function handleCompileEvent(eventType, data) {
    // 进度事件：更新顶部文案
    if (eventType === 'progress') {
        compileStore.setDraftProgress(data.message ?? '');
        // 批量模式下按 fileIndex 定位更新对应项状态
        if (typeof data.data?.fileIndex === 'number') {
            const idx = data.data.fileIndex;
            if (batchItems.value[idx]) {
                // batch_start/fileCount 等事件不切换状态，仅显示进度
                if (data.status === 'running' && data.step === 'compile') {
                    compileStore.updateDraftItem(idx, { status: 'running' });
                }
                compileStore.updateDraftItem(idx, { message: data.message });
            }
        }
        return;
    }
    // 页面生成事件：收集生成的正式页面路径
    if (eventType === 'page' && data.data?.path && data.data?.title) {
        const idx = typeof data.data.fileIndex === 'number' ? data.data.fileIndex : 0;
        if (batchItems.value[idx]) {
            compileStore.appendDraftItemPage(idx, {
                path: data.data.path,
                title: data.data.title,
            });
        }
        return;
    }
    // 单个 draft 完成（批量模式）或整体完成（单 draft 模式）
    if (eventType === 'done') {
        if (data.step === 'batch_done') {
            // 批量结束：根据 success/fail 计数已在后端完成，这里刷新整体状态
            compileStore.setDraftProgress(data.message ?? '批量编译完成');
            // 编译完成后自动刷新草稿列表和目录树
            loadDrafts();
            loadTree();
            return;
        }
        // 单 draft done 或批量中某个 draft 的 done
        const idx = typeof data.data?.fileIndex === 'number' ? data.data.fileIndex : 0;
        if (batchItems.value[idx]) {
            compileStore.updateDraftItem(idx, {
                status: data.status === 'done' ? 'done' : 'error',
                message: data.message,
            });
        }
        if (data.status === 'done' && batchItems.value.length === 1) {
            ElMessage.success('发布成功');
            compileStore.setDraftProgress(data.message ?? '编译完成');
        }
        return;
    }
    if (eventType === 'error') {
        const idx = typeof data.data?.fileIndex === 'number' ? data.data.fileIndex : 0;
        if (batchItems.value[idx]) {
            compileStore.updateDraftItem(idx, {
                status: 'error',
                message: data.message,
            });
        }
        else {
            ElMessage.error(data.message ?? '编译失败');
        }
    }
}
function abortCompile() {
    // §走 store：触发 AbortController + 标记 batchItems 中非终态项为 cancelled
    compileStore.abortDraftPublish();
    // 将所有非 done/error/cancelled 的项标记为 cancelled，避免状态混乱
    for (let i = 0; i < batchItems.value.length; i++) {
        const item = batchItems.value[i];
        if (item.status !== 'done' && item.status !== 'error' && item.status !== 'cancelled') {
            compileStore.updateDraftItem(i, { status: 'cancelled' });
        }
    }
    // 5 秒后自动清理编译面板（通过 store 调用，跨页面也生效）
    if (clearPanelTimer)
        clearTimeout(clearPanelTimer);
    clearPanelTimer = setTimeout(() => {
        compileStore.clearDraftPublish();
        clearPanelTimer = null;
    }, 5000);
}
// 切换模式时重置内容区状态，避免上一模式文件残留
async function switchMode(m) {
    if (mode.value === m)
        return;
    if (hasUnsavedChanges()) {
        try {
            await import('element-plus').then(({ ElMessageBox }) => {
                return ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
            });
        }
        catch {
            return; // 用户取消切换
        }
    }
    mode.value = m;
    fileContent.value = null;
    editing.value = false;
    currentDraftPath.value = '';
    currentNode.value = '';
    currentTagPagePath.value = '';
    if (m === 'draft') {
        loadDrafts();
    }
    else if (m === 'tags') {
        // FR-10-1: 进入 tags 模式时加载待审核页面列表
        loadPendingTags();
    }
}
// 批量编译统计
const batchSuccessCount = computed(() => batchItems.value.filter((b) => b.status === 'done').length);
const batchErrorCount = computed(() => batchItems.value.filter((b) => b.status === 'error').length);
const batchCancelledCount = computed(() => batchItems.value.filter((b) => b.status === 'cancelled').length);
// 编译进度百分比：基于 done/cancelled/error 的总数计算
const progressPercentage = computed(() => {
    if (batchItems.value.length === 0)
        return 0;
    const finished = batchSuccessCount.value + batchErrorCount.value + batchCancelledCount.value;
    return Math.round((finished / batchItems.value.length) * 100);
});
// 是否有未保存的编辑更改
function hasUnsavedChanges() {
    return editing.value && editBuffer.value !== (fileContent.value?.content ?? '');
}
function renderMarkdown(md) {
    if (!md)
        return '';
    let html = md
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>'); // NOSONAR 需要正则捕获组提取代码块
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>') // NOSONAR 需要多行锚点
        .replace(/^## (.+)$/gm, '<h2>$1</h2>') // NOSONAR 需要多行锚点
        .replace(/^# (.+)$/gm, '<h1>$1</h1>'); // NOSONAR 需要多行锚点
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') // NOSONAR 需要正则捕获组
        .replace(/\*(.+?)\*/g, '<em>$1</em>'); // NOSONAR 需要正则捕获组
    html = html.replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">[[$1]]</span>'); // NOSONAR 需要正则捕获组
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>'); // NOSONAR 需要正则捕获组
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>'); // NOSONAR 需要多行锚点
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`); // NOSONAR 需要正则分组匹配
    html = html.split(/\n\n+/).map((block) => {
        if (/^<(h\d|ul|pre|li)/.test(block.trim()))
            return block;
        if (!block.trim())
            return '';
        return `<p>${block.replaceAll('\n', '<br>')}</p>`;
    }).join('\n');
    return html;
}
let lastSavedContent = '';
// 搜索防抖：输入停止 400ms 后自动触发搜索
// 为什么 400ms：中文字输入法可能较慢，400ms 比英文用户习惯略长但不会让用户等待太久
watch(searchQuery, (newVal) => {
    if (searchDebounceTimer)
        clearTimeout(searchDebounceTimer);
    if (!newVal.trim()) {
        showSearchResults.value = false;
        searchHits.value = [];
        return;
    }
    searchDebounceTimer = setTimeout(() => {
        doSearch();
    }, 400);
});
// 编辑未保存保护：记录了编辑开始时的原始内容，用于切换前对比
// 为什么不在 startEdit 中设置：cancelEdit/saveEdit 等路径可能不经过 startEdit
watch(editing, (val) => {
    if (val && fileContent.value) {
        lastSavedContent = fileContent.value.content ?? '';
    }
});
onMounted(async () => {
    // §从 localStorage 恢复草稿发布状态：刷新页面或长时间切走后能继续看到之前的工作
    // 必须在 loadDrafts/loadTree 之前调用，确保 batchItems 已填充到模板
    compileStore.loadDraftPublishState();
    // Ingest.vue 抽取完成后跳转过来时，通过 sessionStorage 传递目标模式
    // 为什么用 sessionStorage 而非 props：跨组件通信，避免 App.vue 中间层传递
    const jumpMode = sessionStorage.getItem('karpathy:jumpMode');
    if (jumpMode === 'draft') {
        sessionStorage.removeItem('karpathy:jumpMode');
        switchMode('draft');
    }
    else {
        await loadTree();
    }
    // FR-11: 刷新后 knowledgeView 已从 localStorage 恢复为 kanban/calendar，
    // 但 watch 默认不立即触发，需在此主动加载页面列表避免视图空白
    if ((knowledgeView.value === 'kanban' || knowledgeView.value === 'calendar') &&
        allPages.value.length === 0 &&
        jumpMode !== 'draft') {
        await loadAllPages();
    }
    // RefsList 派发的 jump-vault 事件：App.vue 切到 browse 后
    // 从 sessionStorage 读取目标 path 并自动打开该文件
    const jumpPath = sessionStorage.getItem('karpathy:jumpPath');
    if (jumpPath) {
        sessionStorage.removeItem('karpathy:jumpPath');
        await handleNodeClick({ path: jumpPath, name: '', type: 'file' });
    }
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['tree-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['view-switcher']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-card']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-card']} */ ;
/** @type {__VLS_StyleScopedClasses['calendar-card']} */ ;
/** @type {__VLS_StyleScopedClasses['calendar-card']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['filter-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['search-hit-item']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-node']} */ ;
/** @type {__VLS_StyleScopedClasses['fm-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['editor-area']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-item']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-item']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-row']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-row']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-row']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-row']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-suggest-list']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-existing-list']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-chip']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "browse-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card browse-card fade-up" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "browse-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "head-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "head-title grad-text" },
});
(__VLS_ctx.mode === 'draft' ? '草稿审核' : __VLS_ctx.mode === 'tags' ? 'AI 标签审核' : '知识浏览');
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "head-tip" },
});
(__VLS_ctx.mode === 'draft'
    ? '审核 LLM 抽取的草稿，编辑后发布为正式页面'
    : __VLS_ctx.mode === 'tags'
        ? '审核 AI 生成的标签建议，确认后合并到正式 tags 字段'
        : '点击左侧文件查看内容，支持编辑保存');
const __VLS_0 = {}.ElRadioGroup;
/** @type {[typeof __VLS_components.ElRadioGroup, typeof __VLS_components.elRadioGroup, typeof __VLS_components.ElRadioGroup, typeof __VLS_components.elRadioGroup, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    ...{ 'onChange': {} },
    modelValue: (__VLS_ctx.mode),
    size: "small",
}));
const __VLS_2 = __VLS_1({
    ...{ 'onChange': {} },
    modelValue: (__VLS_ctx.mode),
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_4;
let __VLS_5;
let __VLS_6;
const __VLS_7 = {
    onChange: (__VLS_ctx.switchMode)
};
__VLS_3.slots.default;
const __VLS_8 = {}.ElRadioButton;
/** @type {[typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, ]} */ ;
// @ts-ignore
const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
    value: "knowledge",
}));
const __VLS_10 = __VLS_9({
    value: "knowledge",
}, ...__VLS_functionalComponentArgsRest(__VLS_9));
__VLS_11.slots.default;
var __VLS_11;
const __VLS_12 = {}.ElRadioButton;
/** @type {[typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, ]} */ ;
// @ts-ignore
const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
    value: "draft",
}));
const __VLS_14 = __VLS_13({
    value: "draft",
}, ...__VLS_functionalComponentArgsRest(__VLS_13));
__VLS_15.slots.default;
var __VLS_15;
const __VLS_16 = {}.ElRadioButton;
/** @type {[typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, ]} */ ;
// @ts-ignore
const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
    value: "tags",
}));
const __VLS_18 = __VLS_17({
    value: "tags",
}, ...__VLS_functionalComponentArgsRest(__VLS_17));
__VLS_19.slots.default;
var __VLS_19;
var __VLS_3;
if (__VLS_ctx.mode === 'knowledge') {
    const __VLS_20 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
        ...{ 'onClick': {} },
        size: "small",
    }));
    const __VLS_22 = __VLS_21({
        ...{ 'onClick': {} },
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_21));
    let __VLS_24;
    let __VLS_25;
    let __VLS_26;
    const __VLS_27 = {
        onClick: (__VLS_ctx.loadTree)
    };
    __VLS_23.slots.default;
    var __VLS_23;
}
else if (__VLS_ctx.mode === 'draft') {
    const __VLS_28 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
        ...{ 'onClick': {} },
        size: "small",
    }));
    const __VLS_30 = __VLS_29({
        ...{ 'onClick': {} },
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_29));
    let __VLS_32;
    let __VLS_33;
    let __VLS_34;
    const __VLS_35 = {
        onClick: (__VLS_ctx.loadDrafts)
    };
    __VLS_31.slots.default;
    var __VLS_31;
}
else {
    const __VLS_36 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
        ...{ 'onClick': {} },
        size: "small",
    }));
    const __VLS_38 = __VLS_37({
        ...{ 'onClick': {} },
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_37));
    let __VLS_40;
    let __VLS_41;
    let __VLS_42;
    const __VLS_43 = {
        onClick: (__VLS_ctx.loadPendingTags)
    };
    __VLS_39.slots.default;
    var __VLS_39;
}
if (__VLS_ctx.mode === 'draft') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "browse-body" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "tree-panel draft-panel" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "panel-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "draft-toolbar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "draft-count" },
    });
    (__VLS_ctx.drafts.length);
    const __VLS_44 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
        ...{ 'onClick': {} },
        size: "small",
        type: "primary",
        disabled: (__VLS_ctx.compiling || __VLS_ctx.drafts.length === 0),
    }));
    const __VLS_46 = __VLS_45({
        ...{ 'onClick': {} },
        size: "small",
        type: "primary",
        disabled: (__VLS_ctx.compiling || __VLS_ctx.drafts.length === 0),
    }, ...__VLS_functionalComponentArgsRest(__VLS_45));
    let __VLS_48;
    let __VLS_49;
    let __VLS_50;
    const __VLS_51 = {
        onClick: (__VLS_ctx.publishAllDrafts)
    };
    __VLS_47.slots.default;
    var __VLS_47;
    if (__VLS_ctx.drafts.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "tree-empty" },
        });
    }
    for (const [d] of __VLS_getVForSourceType((__VLS_ctx.drafts))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.mode === 'draft'))
                        return;
                    __VLS_ctx.handleDraftClick(d);
                } },
            key: (d.path),
            ...{ class: "draft-item hover-glow" },
            ...{ class: ({ active: __VLS_ctx.currentDraftPath === d.path }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "draft-name" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "file-icon" },
        });
        (d.name);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "draft-path" },
        });
        (d.path);
        const __VLS_52 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
            text: true,
            disabled: (__VLS_ctx.compiling),
        }));
        const __VLS_54 = __VLS_53({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
            text: true,
            disabled: (__VLS_ctx.compiling),
        }, ...__VLS_functionalComponentArgsRest(__VLS_53));
        let __VLS_56;
        let __VLS_57;
        let __VLS_58;
        const __VLS_59 = {
            onClick: (...[$event]) => {
                if (!(__VLS_ctx.mode === 'draft'))
                    return;
                __VLS_ctx.publishDraft(d);
            }
        };
        __VLS_55.slots.default;
        var __VLS_55;
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "content-panel" },
    });
    if (__VLS_ctx.compiling || __VLS_ctx.batchItems.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "compile-progress" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "progress-header" },
        });
        const __VLS_60 = {}.ElTooltip;
        /** @type {[typeof __VLS_components.ElTooltip, typeof __VLS_components.elTooltip, typeof __VLS_components.ElTooltip, typeof __VLS_components.elTooltip, ]} */ ;
        // @ts-ignore
        const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({
            content: (__VLS_ctx.progressMessage),
            placement: "top",
            showAfter: (500),
        }));
        const __VLS_62 = __VLS_61({
            content: (__VLS_ctx.progressMessage),
            placement: "top",
            showAfter: (500),
        }, ...__VLS_functionalComponentArgsRest(__VLS_61));
        __VLS_63.slots.default;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "progress-msg" },
        });
        (__VLS_ctx.progressMessage);
        var __VLS_63;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "progress-stats" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "stat-success" },
        });
        const __VLS_64 = {}.ElIcon;
        /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
        // @ts-ignore
        const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({}));
        const __VLS_66 = __VLS_65({}, ...__VLS_functionalComponentArgsRest(__VLS_65));
        __VLS_67.slots.default;
        const __VLS_68 = {}.Check;
        /** @type {[typeof __VLS_components.Check, ]} */ ;
        // @ts-ignore
        const __VLS_69 = __VLS_asFunctionalComponent(__VLS_68, new __VLS_68({}));
        const __VLS_70 = __VLS_69({}, ...__VLS_functionalComponentArgsRest(__VLS_69));
        var __VLS_67;
        (__VLS_ctx.batchSuccessCount);
        if (__VLS_ctx.batchCancelledCount > 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "stat-cancelled" },
            });
            const __VLS_72 = {}.ElIcon;
            /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
            // @ts-ignore
            const __VLS_73 = __VLS_asFunctionalComponent(__VLS_72, new __VLS_72({}));
            const __VLS_74 = __VLS_73({}, ...__VLS_functionalComponentArgsRest(__VLS_73));
            __VLS_75.slots.default;
            const __VLS_76 = {}.CircleClose;
            /** @type {[typeof __VLS_components.CircleClose, ]} */ ;
            // @ts-ignore
            const __VLS_77 = __VLS_asFunctionalComponent(__VLS_76, new __VLS_76({}));
            const __VLS_78 = __VLS_77({}, ...__VLS_functionalComponentArgsRest(__VLS_77));
            var __VLS_75;
            (__VLS_ctx.batchCancelledCount);
        }
        if (__VLS_ctx.batchErrorCount > 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "stat-error" },
            });
            const __VLS_80 = {}.ElIcon;
            /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
            // @ts-ignore
            const __VLS_81 = __VLS_asFunctionalComponent(__VLS_80, new __VLS_80({}));
            const __VLS_82 = __VLS_81({}, ...__VLS_functionalComponentArgsRest(__VLS_81));
            __VLS_83.slots.default;
            const __VLS_84 = {}.Close;
            /** @type {[typeof __VLS_components.Close, ]} */ ;
            // @ts-ignore
            const __VLS_85 = __VLS_asFunctionalComponent(__VLS_84, new __VLS_84({}));
            const __VLS_86 = __VLS_85({}, ...__VLS_functionalComponentArgsRest(__VLS_85));
            var __VLS_83;
            (__VLS_ctx.batchErrorCount);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "stat-total" },
        });
        (__VLS_ctx.batchItems.length);
        if (__VLS_ctx.compiling) {
            const __VLS_88 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_89 = __VLS_asFunctionalComponent(__VLS_88, new __VLS_88({
                ...{ 'onClick': {} },
                size: "small",
                text: true,
                type: "danger",
            }));
            const __VLS_90 = __VLS_89({
                ...{ 'onClick': {} },
                size: "small",
                text: true,
                type: "danger",
            }, ...__VLS_functionalComponentArgsRest(__VLS_89));
            let __VLS_92;
            let __VLS_93;
            let __VLS_94;
            const __VLS_95 = {
                onClick: (__VLS_ctx.abortCompile)
            };
            __VLS_91.slots.default;
            var __VLS_91;
        }
        if (!__VLS_ctx.compiling && __VLS_ctx.batchItems.length > 0) {
            const __VLS_96 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_97 = __VLS_asFunctionalComponent(__VLS_96, new __VLS_96({
                ...{ 'onClick': {} },
                size: "small",
                text: true,
            }));
            const __VLS_98 = __VLS_97({
                ...{ 'onClick': {} },
                size: "small",
                text: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_97));
            let __VLS_100;
            let __VLS_101;
            let __VLS_102;
            const __VLS_103 = {
                onClick: (...[$event]) => {
                    if (!(__VLS_ctx.mode === 'draft'))
                        return;
                    if (!(__VLS_ctx.compiling || __VLS_ctx.batchItems.length > 0))
                        return;
                    if (!(!__VLS_ctx.compiling && __VLS_ctx.batchItems.length > 0))
                        return;
                    __VLS_ctx.compileStore.clearDraftPublish();
                }
            };
            __VLS_99.slots.default;
            var __VLS_99;
        }
        const __VLS_104 = {}.ElProgress;
        /** @type {[typeof __VLS_components.ElProgress, typeof __VLS_components.elProgress, ]} */ ;
        // @ts-ignore
        const __VLS_105 = __VLS_asFunctionalComponent(__VLS_104, new __VLS_104({
            percentage: (__VLS_ctx.progressPercentage),
            strokeWidth: (6),
            status: (__VLS_ctx.batchErrorCount > 0 && !__VLS_ctx.compiling ? 'exception' : __VLS_ctx.progressPercentage === 100 ? 'success' : ''),
            striped: (__VLS_ctx.compiling),
            stripedFlow: (__VLS_ctx.compiling),
            ...{ class: "compile-progress-bar" },
        }));
        const __VLS_106 = __VLS_105({
            percentage: (__VLS_ctx.progressPercentage),
            strokeWidth: (6),
            status: (__VLS_ctx.batchErrorCount > 0 && !__VLS_ctx.compiling ? 'exception' : __VLS_ctx.progressPercentage === 100 ? 'success' : ''),
            striped: (__VLS_ctx.compiling),
            stripedFlow: (__VLS_ctx.compiling),
            ...{ class: "compile-progress-bar" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_105));
        if (__VLS_ctx.batchItems.length > 1) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "batch-list" },
            });
            for (const [item, idx] of __VLS_getVForSourceType((__VLS_ctx.batchItems))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (item.path),
                    ...{ class: "batch-row" },
                    ...{ class: (`status-${item.status}`) },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "batch-index" },
                });
                (idx + 1);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "batch-name" },
                });
                (item.name);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "batch-status" },
                });
                (item.status === 'cancelled' ? '已取消' : item.status === 'done' ? '已完成' : item.status === 'running' ? '进行中' : item.status === 'error' ? '失败' : '待处理');
                if (item.pages.length > 0) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                        ...{ class: "batch-pages" },
                    });
                    (item.pages.map((p) => p.title).join(', '));
                }
                if (item.message) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                        ...{ class: "batch-msg" },
                    });
                    (item.message);
                }
            }
        }
    }
    if (__VLS_ctx.loading) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "content-loading" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
    }
    else if (!__VLS_ctx.fileContent) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "content-empty" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "empty-tip" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "content-show" },
        });
        if (__VLS_ctx.fileContent.frontmatter && Object.keys(__VLS_ctx.fileContent.frontmatter).length > 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "frontmatter-bar" },
            });
            for (const [val, key] of __VLS_getVForSourceType((__VLS_ctx.fileContent.frontmatter))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    key: (key),
                    ...{ class: "fm-chip" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
                (key);
                (String(val));
            }
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "action-bar" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "current-path" },
        });
        (__VLS_ctx.currentDraftPath);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "actions" },
        });
        if (!__VLS_ctx.editing) {
            const __VLS_108 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_109 = __VLS_asFunctionalComponent(__VLS_108, new __VLS_108({
                ...{ 'onClick': {} },
                size: "small",
                type: "primary",
                disabled: (__VLS_ctx.compiling),
            }));
            const __VLS_110 = __VLS_109({
                ...{ 'onClick': {} },
                size: "small",
                type: "primary",
                disabled: (__VLS_ctx.compiling),
            }, ...__VLS_functionalComponentArgsRest(__VLS_109));
            let __VLS_112;
            let __VLS_113;
            let __VLS_114;
            const __VLS_115 = {
                onClick: (...[$event]) => {
                    if (!(__VLS_ctx.mode === 'draft'))
                        return;
                    if (!!(__VLS_ctx.loading))
                        return;
                    if (!!(!__VLS_ctx.fileContent))
                        return;
                    if (!(!__VLS_ctx.editing))
                        return;
                    __VLS_ctx.publishDraft({ path: __VLS_ctx.currentDraftPath, name: __VLS_ctx.currentDraftPath.split('/').pop() || '' });
                }
            };
            __VLS_111.slots.default;
            var __VLS_111;
        }
        if (!__VLS_ctx.editing) {
            const __VLS_116 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_117 = __VLS_asFunctionalComponent(__VLS_116, new __VLS_116({
                ...{ 'onClick': {} },
                size: "small",
            }));
            const __VLS_118 = __VLS_117({
                ...{ 'onClick': {} },
                size: "small",
            }, ...__VLS_functionalComponentArgsRest(__VLS_117));
            let __VLS_120;
            let __VLS_121;
            let __VLS_122;
            const __VLS_123 = {
                onClick: (__VLS_ctx.startEdit)
            };
            __VLS_119.slots.default;
            var __VLS_119;
        }
        else {
            const __VLS_124 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_125 = __VLS_asFunctionalComponent(__VLS_124, new __VLS_124({
                ...{ 'onClick': {} },
                size: "small",
                type: "primary",
            }));
            const __VLS_126 = __VLS_125({
                ...{ 'onClick': {} },
                size: "small",
                type: "primary",
            }, ...__VLS_functionalComponentArgsRest(__VLS_125));
            let __VLS_128;
            let __VLS_129;
            let __VLS_130;
            const __VLS_131 = {
                onClick: (__VLS_ctx.saveEdit)
            };
            __VLS_127.slots.default;
            var __VLS_127;
            const __VLS_132 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_133 = __VLS_asFunctionalComponent(__VLS_132, new __VLS_132({
                ...{ 'onClick': {} },
                size: "small",
            }));
            const __VLS_134 = __VLS_133({
                ...{ 'onClick': {} },
                size: "small",
            }, ...__VLS_functionalComponentArgsRest(__VLS_133));
            let __VLS_136;
            let __VLS_137;
            let __VLS_138;
            const __VLS_139 = {
                onClick: (__VLS_ctx.cancelEdit)
            };
            __VLS_135.slots.default;
            var __VLS_135;
        }
        if (__VLS_ctx.editing) {
            const __VLS_140 = {}.ElInput;
            /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
            // @ts-ignore
            const __VLS_141 = __VLS_asFunctionalComponent(__VLS_140, new __VLS_140({
                modelValue: (__VLS_ctx.editBuffer),
                type: "textarea",
                rows: (20),
                resize: "none",
                ...{ class: "editor-area" },
            }));
            const __VLS_142 = __VLS_141({
                modelValue: (__VLS_ctx.editBuffer),
                type: "textarea",
                rows: (20),
                resize: "none",
                ...{ class: "editor-area" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_141));
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "markdown-body" },
            });
            __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderMarkdown(__VLS_ctx.fileContent.body)) }, null, null);
        }
    }
}
else if (__VLS_ctx.mode === 'tags') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "browse-body" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "tree-panel tag-panel" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "panel-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "draft-toolbar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "draft-count" },
    });
    (__VLS_ctx.pendingTagPages.length);
    if (__VLS_ctx.pendingTagPages.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "tree-empty" },
        });
    }
    for (const [p] of __VLS_getVForSourceType((__VLS_ctx.pendingTagPages))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.mode === 'draft'))
                        return;
                    if (!(__VLS_ctx.mode === 'tags'))
                        return;
                    __VLS_ctx.handleTagPageClick(p);
                } },
            key: (p.path),
            ...{ class: "draft-item hover-glow" },
            ...{ class: ({ active: __VLS_ctx.currentTagPagePath === p.path }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "draft-name" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "file-icon" },
        });
        (p.title);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "draft-path" },
        });
        (p.path);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "tag-count-badge" },
        });
        (p.aiTags.length);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "content-panel" },
    });
    if (__VLS_ctx.loading) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "content-loading" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
    }
    else if (!__VLS_ctx.fileContent) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "content-empty" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "empty-tip" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "content-show" },
        });
        if (__VLS_ctx.fileContent.frontmatter && Object.keys(__VLS_ctx.fileContent.frontmatter).length > 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "frontmatter-bar" },
            });
            for (const [val, key] of __VLS_getVForSourceType((__VLS_ctx.fileContent.frontmatter))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    key: (key),
                    ...{ class: "fm-chip" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
                (key);
                (String(val));
            }
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "tag-action-bar" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "current-path" },
        });
        (__VLS_ctx.currentTagPagePath);
        const __VLS_144 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_145 = __VLS_asFunctionalComponent(__VLS_144, new __VLS_144({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
            loading: (__VLS_ctx.tagRegenerating),
            disabled: (!__VLS_ctx.currentTagPagePath),
        }));
        const __VLS_146 = __VLS_145({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
            loading: (__VLS_ctx.tagRegenerating),
            disabled: (!__VLS_ctx.currentTagPagePath),
        }, ...__VLS_functionalComponentArgsRest(__VLS_145));
        let __VLS_148;
        let __VLS_149;
        let __VLS_150;
        const __VLS_151 = {
            onClick: (...[$event]) => {
                if (!!(__VLS_ctx.mode === 'draft'))
                    return;
                if (!(__VLS_ctx.mode === 'tags'))
                    return;
                if (!!(__VLS_ctx.loading))
                    return;
                if (!!(!__VLS_ctx.fileContent))
                    return;
                __VLS_ctx.regenerateTags(__VLS_ctx.currentTagPagePath);
            }
        };
        __VLS_147.slots.default;
        var __VLS_147;
        if (__VLS_ctx.currentTagPagePath && (__VLS_ctx.pendingTagPages.find(p => p.path === __VLS_ctx.currentTagPagePath)?.aiTags.length ?? 0) > 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tag-suggest-list" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tag-suggest-title" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tag-chips" },
            });
            for (const [tag] of __VLS_getVForSourceType((__VLS_ctx.pendingTagPages.find(p => p.path === __VLS_ctx.currentTagPagePath)?.aiTags ?? []))) {
                const __VLS_152 = {}.ElTag;
                /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
                // @ts-ignore
                const __VLS_153 = __VLS_asFunctionalComponent(__VLS_152, new __VLS_152({
                    ...{ 'onClick': {} },
                    key: (tag),
                    ...{ class: "tag-chip hover-glow" },
                    type: ('info'),
                    effect: "plain",
                    disableTransitions: (false),
                }));
                const __VLS_154 = __VLS_153({
                    ...{ 'onClick': {} },
                    key: (tag),
                    ...{ class: "tag-chip hover-glow" },
                    type: ('info'),
                    effect: "plain",
                    disableTransitions: (false),
                }, ...__VLS_functionalComponentArgsRest(__VLS_153));
                let __VLS_156;
                let __VLS_157;
                let __VLS_158;
                const __VLS_159 = {
                    onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.mode === 'draft'))
                            return;
                        if (!(__VLS_ctx.mode === 'tags'))
                            return;
                        if (!!(__VLS_ctx.loading))
                            return;
                        if (!!(!__VLS_ctx.fileContent))
                            return;
                        if (!(__VLS_ctx.currentTagPagePath && (__VLS_ctx.pendingTagPages.find(p => p.path === __VLS_ctx.currentTagPagePath)?.aiTags.length ?? 0) > 0))
                            return;
                        __VLS_ctx.confirmTag(__VLS_ctx.currentTagPagePath, tag);
                    }
                };
                __VLS_155.slots.default;
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "tag-add-icon" },
                });
                (tag);
                var __VLS_155;
            }
        }
        if (__VLS_ctx.currentTagPagePath && (__VLS_ctx.pendingTagPages.find(p => p.path === __VLS_ctx.currentTagPagePath)?.existingTags.length ?? 0) > 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tag-existing-list" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tag-suggest-title" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tag-chips" },
            });
            for (const [tag] of __VLS_getVForSourceType((__VLS_ctx.pendingTagPages.find(p => p.path === __VLS_ctx.currentTagPagePath)?.existingTags ?? []))) {
                const __VLS_160 = {}.ElTag;
                /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
                // @ts-ignore
                const __VLS_161 = __VLS_asFunctionalComponent(__VLS_160, new __VLS_160({
                    key: (tag),
                    ...{ class: "tag-chip" },
                    type: ('success'),
                    effect: "dark",
                }));
                const __VLS_162 = __VLS_161({
                    key: (tag),
                    ...{ class: "tag-chip" },
                    type: ('success'),
                    effect: "dark",
                }, ...__VLS_functionalComponentArgsRest(__VLS_161));
                __VLS_163.slots.default;
                (tag);
                var __VLS_163;
            }
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "action-bar" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "current-path" },
        });
        (__VLS_ctx.currentTagPagePath);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "actions" },
        });
        if (!__VLS_ctx.editing) {
            const __VLS_164 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_165 = __VLS_asFunctionalComponent(__VLS_164, new __VLS_164({
                ...{ 'onClick': {} },
                size: "small",
            }));
            const __VLS_166 = __VLS_165({
                ...{ 'onClick': {} },
                size: "small",
            }, ...__VLS_functionalComponentArgsRest(__VLS_165));
            let __VLS_168;
            let __VLS_169;
            let __VLS_170;
            const __VLS_171 = {
                onClick: (__VLS_ctx.startEdit)
            };
            __VLS_167.slots.default;
            var __VLS_167;
        }
        else {
            const __VLS_172 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_173 = __VLS_asFunctionalComponent(__VLS_172, new __VLS_172({
                ...{ 'onClick': {} },
                size: "small",
                type: "primary",
            }));
            const __VLS_174 = __VLS_173({
                ...{ 'onClick': {} },
                size: "small",
                type: "primary",
            }, ...__VLS_functionalComponentArgsRest(__VLS_173));
            let __VLS_176;
            let __VLS_177;
            let __VLS_178;
            const __VLS_179 = {
                onClick: (__VLS_ctx.saveEdit)
            };
            __VLS_175.slots.default;
            var __VLS_175;
            const __VLS_180 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_181 = __VLS_asFunctionalComponent(__VLS_180, new __VLS_180({
                ...{ 'onClick': {} },
                size: "small",
            }));
            const __VLS_182 = __VLS_181({
                ...{ 'onClick': {} },
                size: "small",
            }, ...__VLS_functionalComponentArgsRest(__VLS_181));
            let __VLS_184;
            let __VLS_185;
            let __VLS_186;
            const __VLS_187 = {
                onClick: (__VLS_ctx.cancelEdit)
            };
            __VLS_183.slots.default;
            var __VLS_183;
        }
        if (__VLS_ctx.editing) {
            const __VLS_188 = {}.ElInput;
            /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
            // @ts-ignore
            const __VLS_189 = __VLS_asFunctionalComponent(__VLS_188, new __VLS_188({
                modelValue: (__VLS_ctx.editBuffer),
                type: "textarea",
                rows: (20),
                resize: "none",
                ...{ class: "editor-area" },
            }));
            const __VLS_190 = __VLS_189({
                modelValue: (__VLS_ctx.editBuffer),
                type: "textarea",
                rows: (20),
                resize: "none",
                ...{ class: "editor-area" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_189));
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "markdown-body" },
            });
            __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderMarkdown(__VLS_ctx.fileContent.body)) }, null, null);
        }
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "browse-body" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "tree-panel" },
        ...{ class: ({ 'view-expanded': __VLS_ctx.knowledgeView !== 'tree' }) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "search-box" },
    });
    const __VLS_192 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_193 = __VLS_asFunctionalComponent(__VLS_192, new __VLS_192({
        ...{ 'onKeyup': {} },
        ...{ 'onClear': {} },
        modelValue: (__VLS_ctx.searchQuery),
        placeholder: "搜索知识库…",
        size: "small",
        prefixIcon: (__VLS_ctx.Search),
        clearable: true,
    }));
    const __VLS_194 = __VLS_193({
        ...{ 'onKeyup': {} },
        ...{ 'onClear': {} },
        modelValue: (__VLS_ctx.searchQuery),
        placeholder: "搜索知识库…",
        size: "small",
        prefixIcon: (__VLS_ctx.Search),
        clearable: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_193));
    let __VLS_196;
    let __VLS_197;
    let __VLS_198;
    const __VLS_199 = {
        onKeyup: (__VLS_ctx.doSearch)
    };
    const __VLS_200 = {
        onClear: (__VLS_ctx.clearSearch)
    };
    var __VLS_195;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "filter-bar" },
    });
    const __VLS_201 = {}.ElSelect;
    /** @type {[typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, ]} */ ;
    // @ts-ignore
    const __VLS_202 = __VLS_asFunctionalComponent(__VLS_201, new __VLS_201({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.sourceFilter),
        placeholder: "来源筛选",
        size: "small",
        clearable: true,
    }));
    const __VLS_203 = __VLS_202({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.sourceFilter),
        placeholder: "来源筛选",
        size: "small",
        clearable: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_202));
    let __VLS_205;
    let __VLS_206;
    let __VLS_207;
    const __VLS_208 = {
        onChange: (__VLS_ctx.handleFilterChange)
    };
    __VLS_204.slots.default;
    for (const [opt] of __VLS_getVForSourceType((__VLS_ctx.sourceOptions))) {
        const __VLS_209 = {}.ElOption;
        /** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
        // @ts-ignore
        const __VLS_210 = __VLS_asFunctionalComponent(__VLS_209, new __VLS_209({
            key: (opt.value),
            label: (opt.label),
            value: (opt.value),
        }));
        const __VLS_211 = __VLS_210({
            key: (opt.value),
            label: (opt.label),
            value: (opt.value),
        }, ...__VLS_functionalComponentArgsRest(__VLS_210));
    }
    var __VLS_204;
    const __VLS_213 = {}.ElSelect;
    /** @type {[typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, ]} */ ;
    // @ts-ignore
    const __VLS_214 = __VLS_asFunctionalComponent(__VLS_213, new __VLS_213({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.statusFilter),
        placeholder: "状态筛选",
        size: "small",
        clearable: true,
    }));
    const __VLS_215 = __VLS_214({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.statusFilter),
        placeholder: "状态筛选",
        size: "small",
        clearable: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_214));
    let __VLS_217;
    let __VLS_218;
    let __VLS_219;
    const __VLS_220 = {
        onChange: (__VLS_ctx.handleFilterChange)
    };
    __VLS_216.slots.default;
    for (const [opt] of __VLS_getVForSourceType((__VLS_ctx.statusOptions))) {
        const __VLS_221 = {}.ElOption;
        /** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
        // @ts-ignore
        const __VLS_222 = __VLS_asFunctionalComponent(__VLS_221, new __VLS_221({
            key: (opt.value),
            label: (opt.label),
            value: (opt.value),
        }));
        const __VLS_223 = __VLS_222({
            key: (opt.value),
            label: (opt.label),
            value: (opt.value),
        }, ...__VLS_functionalComponentArgsRest(__VLS_222));
    }
    var __VLS_216;
    const __VLS_225 = {}.ElSelect;
    /** @type {[typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, ]} */ ;
    // @ts-ignore
    const __VLS_226 = __VLS_asFunctionalComponent(__VLS_225, new __VLS_225({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.typeFilter),
        placeholder: "类型筛选",
        size: "small",
        clearable: true,
    }));
    const __VLS_227 = __VLS_226({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.typeFilter),
        placeholder: "类型筛选",
        size: "small",
        clearable: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_226));
    let __VLS_229;
    let __VLS_230;
    let __VLS_231;
    const __VLS_232 = {
        onChange: (__VLS_ctx.handleFilterChange)
    };
    __VLS_228.slots.default;
    for (const [opt] of __VLS_getVForSourceType((__VLS_ctx.typeOptions))) {
        const __VLS_233 = {}.ElOption;
        /** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
        // @ts-ignore
        const __VLS_234 = __VLS_asFunctionalComponent(__VLS_233, new __VLS_233({
            key: (opt.value),
            label: (opt.label),
            value: (opt.value),
        }));
        const __VLS_235 = __VLS_234({
            key: (opt.value),
            label: (opt.label),
            value: (opt.value),
        }, ...__VLS_functionalComponentArgsRest(__VLS_234));
    }
    var __VLS_228;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "view-switcher" },
    });
    const __VLS_237 = {}.ElRadioGroup;
    /** @type {[typeof __VLS_components.ElRadioGroup, typeof __VLS_components.elRadioGroup, typeof __VLS_components.ElRadioGroup, typeof __VLS_components.elRadioGroup, ]} */ ;
    // @ts-ignore
    const __VLS_238 = __VLS_asFunctionalComponent(__VLS_237, new __VLS_237({
        modelValue: (__VLS_ctx.knowledgeView),
        size: "small",
    }));
    const __VLS_239 = __VLS_238({
        modelValue: (__VLS_ctx.knowledgeView),
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_238));
    __VLS_240.slots.default;
    const __VLS_241 = {}.ElRadioButton;
    /** @type {[typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, ]} */ ;
    // @ts-ignore
    const __VLS_242 = __VLS_asFunctionalComponent(__VLS_241, new __VLS_241({
        value: "tree",
    }));
    const __VLS_243 = __VLS_242({
        value: "tree",
    }, ...__VLS_functionalComponentArgsRest(__VLS_242));
    __VLS_244.slots.default;
    var __VLS_244;
    const __VLS_245 = {}.ElRadioButton;
    /** @type {[typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, ]} */ ;
    // @ts-ignore
    const __VLS_246 = __VLS_asFunctionalComponent(__VLS_245, new __VLS_245({
        value: "kanban",
    }));
    const __VLS_247 = __VLS_246({
        value: "kanban",
    }, ...__VLS_functionalComponentArgsRest(__VLS_246));
    __VLS_248.slots.default;
    var __VLS_248;
    const __VLS_249 = {}.ElRadioButton;
    /** @type {[typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, ]} */ ;
    // @ts-ignore
    const __VLS_250 = __VLS_asFunctionalComponent(__VLS_249, new __VLS_249({
        value: "calendar",
    }));
    const __VLS_251 = __VLS_250({
        value: "calendar",
    }, ...__VLS_functionalComponentArgsRest(__VLS_250));
    __VLS_252.slots.default;
    var __VLS_252;
    var __VLS_240;
    if (__VLS_ctx.showSearchResults) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "search-results" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "search-header" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "search-count" },
        });
        (__VLS_ctx.searchHits.length);
        const __VLS_253 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_254 = __VLS_asFunctionalComponent(__VLS_253, new __VLS_253({
            ...{ 'onClick': {} },
            size: "small",
            text: true,
        }));
        const __VLS_255 = __VLS_254({
            ...{ 'onClick': {} },
            size: "small",
            text: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_254));
        let __VLS_257;
        let __VLS_258;
        let __VLS_259;
        const __VLS_260 = {
            onClick: (__VLS_ctx.clearSearch)
        };
        __VLS_256.slots.default;
        var __VLS_256;
        if (__VLS_ctx.searching) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "search-loading" },
            });
        }
        else if (__VLS_ctx.searchHits.length === 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "search-empty" },
            });
        }
        for (const [hit] of __VLS_getVForSourceType((__VLS_ctx.searchHits))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.mode === 'draft'))
                            return;
                        if (!!(__VLS_ctx.mode === 'tags'))
                            return;
                        if (!(__VLS_ctx.showSearchResults))
                            return;
                        __VLS_ctx.handleSearchHit(hit);
                    } },
                key: (hit.path),
                ...{ class: "search-hit-item hover-glow" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "hit-title" },
            });
            (hit.title);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "hit-path" },
            });
            (hit.path);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "hit-snippet" },
            });
            (hit.snippet);
        }
    }
    else if (__VLS_ctx.knowledgeView === 'tree') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "panel-title" },
        });
        const __VLS_261 = {}.ElTree;
        /** @type {[typeof __VLS_components.ElTree, typeof __VLS_components.elTree, typeof __VLS_components.ElTree, typeof __VLS_components.elTree, ]} */ ;
        // @ts-ignore
        const __VLS_262 = __VLS_asFunctionalComponent(__VLS_261, new __VLS_261({
            ...{ 'onNodeClick': {} },
            data: (__VLS_ctx.treeData),
            props: (__VLS_ctx.treeProps),
            nodeKey: "path",
            defaultExpandAll: (false),
            expandOnClickNode: (true),
            highlightCurrent: (true),
        }));
        const __VLS_263 = __VLS_262({
            ...{ 'onNodeClick': {} },
            data: (__VLS_ctx.treeData),
            props: (__VLS_ctx.treeProps),
            nodeKey: "path",
            defaultExpandAll: (false),
            expandOnClickNode: (true),
            highlightCurrent: (true),
        }, ...__VLS_functionalComponentArgsRest(__VLS_262));
        let __VLS_265;
        let __VLS_266;
        let __VLS_267;
        const __VLS_268 = {
            onNodeClick: (__VLS_ctx.handleNodeClick)
        };
        __VLS_264.slots.default;
        {
            const { default: __VLS_thisSlot } = __VLS_264.slots;
            const [{ data }] = __VLS_getSlotParams(__VLS_thisSlot);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "tree-node" },
                ...{ class: ({ 'is-file': data.type === 'file' }) },
            });
            if (data.type === 'dir') {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            }
            else {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "file-icon" },
                });
            }
            (data.name);
        }
        var __VLS_264;
        if (__VLS_ctx.treeData.length === 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tree-empty" },
            });
        }
    }
    else if (__VLS_ctx.knowledgeView === 'kanban') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "panel-title" },
        });
        if (__VLS_ctx.pagesLoading) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tree-empty" },
            });
        }
        else if (__VLS_ctx.allPages.length === 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tree-empty" },
            });
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "kanban-scroll" },
            });
            for (const [col] of __VLS_getVForSourceType((__VLS_ctx.KANBAN_COLUMNS))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (col.key),
                    ...{ class: "kanban-col" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "kanban-col-head" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "kanban-icon" },
                });
                (col.icon);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "kanban-label" },
                });
                (col.label);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "kanban-count" },
                });
                (__VLS_ctx.kanbanGroups[col.key]?.length ?? 0);
                for (const [p] of __VLS_getVForSourceType((__VLS_ctx.kanbanGroups[col.key] ?? []))) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                        ...{ onClick: (...[$event]) => {
                                if (!!(__VLS_ctx.mode === 'draft'))
                                    return;
                                if (!!(__VLS_ctx.mode === 'tags'))
                                    return;
                                if (!!(__VLS_ctx.showSearchResults))
                                    return;
                                if (!!(__VLS_ctx.knowledgeView === 'tree'))
                                    return;
                                if (!(__VLS_ctx.knowledgeView === 'kanban'))
                                    return;
                                if (!!(__VLS_ctx.pagesLoading))
                                    return;
                                if (!!(__VLS_ctx.allPages.length === 0))
                                    return;
                                __VLS_ctx.handlePageClick(p);
                            } },
                        key: (p.path),
                        ...{ class: "kanban-card hover-glow" },
                        ...{ class: ({ active: __VLS_ctx.currentNode === p.path }) },
                    });
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                        ...{ class: "kanban-card-title" },
                    });
                    (p.frontmatter.title || p.name);
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                        ...{ class: "kanban-card-path" },
                    });
                    (p.path);
                    if (p.frontmatter.tags) {
                        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                            ...{ class: "kanban-card-tags" },
                        });
                        for (const [t] of __VLS_getVForSourceType(((Array.isArray(p.frontmatter.tags) ? p.frontmatter.tags : [p.frontmatter.tags]).slice(0, 3)))) {
                            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                                key: (String(t)),
                                ...{ class: "kanban-tag" },
                            });
                            (t);
                        }
                    }
                }
            }
        }
    }
    else if (__VLS_ctx.knowledgeView === 'calendar') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "panel-title" },
        });
        if (__VLS_ctx.pagesLoading) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tree-empty" },
            });
        }
        else if (__VLS_ctx.calendarGroups.length === 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "tree-empty" },
            });
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "calendar-list" },
            });
            for (const [group] of __VLS_getVForSourceType((__VLS_ctx.calendarGroups))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (group.date),
                    ...{ class: "calendar-group" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "calendar-date" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "date-icon" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "date-text" },
                });
                (group.date);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "date-count" },
                });
                (group.pages.length);
                for (const [p] of __VLS_getVForSourceType((group.pages))) {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                        ...{ onClick: (...[$event]) => {
                                if (!!(__VLS_ctx.mode === 'draft'))
                                    return;
                                if (!!(__VLS_ctx.mode === 'tags'))
                                    return;
                                if (!!(__VLS_ctx.showSearchResults))
                                    return;
                                if (!!(__VLS_ctx.knowledgeView === 'tree'))
                                    return;
                                if (!!(__VLS_ctx.knowledgeView === 'kanban'))
                                    return;
                                if (!(__VLS_ctx.knowledgeView === 'calendar'))
                                    return;
                                if (!!(__VLS_ctx.pagesLoading))
                                    return;
                                if (!!(__VLS_ctx.calendarGroups.length === 0))
                                    return;
                                __VLS_ctx.handlePageClick(p);
                            } },
                        key: (p.path),
                        ...{ class: "calendar-card hover-glow" },
                        ...{ class: ({ active: __VLS_ctx.currentNode === p.path }) },
                    });
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                        ...{ class: "calendar-card-title" },
                    });
                    (p.frontmatter.title || p.name);
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                        ...{ class: "calendar-card-path" },
                    });
                    (p.path);
                }
            }
        }
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "content-panel" },
    });
    if (__VLS_ctx.loading) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "content-loading" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
    }
    else if (!__VLS_ctx.fileContent) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "content-empty" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "empty-tip" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "content-show" },
        });
        if (__VLS_ctx.fileContent.frontmatter && Object.keys(__VLS_ctx.fileContent.frontmatter).length > 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "frontmatter-bar" },
            });
            for (const [val, key] of __VLS_getVForSourceType((__VLS_ctx.fileContent.frontmatter))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    key: (key),
                    ...{ class: "fm-chip" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
                (key);
                (String(val));
            }
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "action-bar" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "current-path" },
        });
        (__VLS_ctx.currentNode);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "actions" },
        });
        if (!__VLS_ctx.editing) {
            const __VLS_269 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_270 = __VLS_asFunctionalComponent(__VLS_269, new __VLS_269({
                ...{ 'onClick': {} },
                size: "small",
            }));
            const __VLS_271 = __VLS_270({
                ...{ 'onClick': {} },
                size: "small",
            }, ...__VLS_functionalComponentArgsRest(__VLS_270));
            let __VLS_273;
            let __VLS_274;
            let __VLS_275;
            const __VLS_276 = {
                onClick: (__VLS_ctx.startEdit)
            };
            __VLS_272.slots.default;
            var __VLS_272;
        }
        else {
            const __VLS_277 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_278 = __VLS_asFunctionalComponent(__VLS_277, new __VLS_277({
                ...{ 'onClick': {} },
                size: "small",
                type: "primary",
            }));
            const __VLS_279 = __VLS_278({
                ...{ 'onClick': {} },
                size: "small",
                type: "primary",
            }, ...__VLS_functionalComponentArgsRest(__VLS_278));
            let __VLS_281;
            let __VLS_282;
            let __VLS_283;
            const __VLS_284 = {
                onClick: (__VLS_ctx.saveEdit)
            };
            __VLS_280.slots.default;
            var __VLS_280;
            const __VLS_285 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_286 = __VLS_asFunctionalComponent(__VLS_285, new __VLS_285({
                ...{ 'onClick': {} },
                size: "small",
            }));
            const __VLS_287 = __VLS_286({
                ...{ 'onClick': {} },
                size: "small",
            }, ...__VLS_functionalComponentArgsRest(__VLS_286));
            let __VLS_289;
            let __VLS_290;
            let __VLS_291;
            const __VLS_292 = {
                onClick: (__VLS_ctx.cancelEdit)
            };
            __VLS_288.slots.default;
            var __VLS_288;
        }
        if (__VLS_ctx.editing) {
            const __VLS_293 = {}.ElInput;
            /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
            // @ts-ignore
            const __VLS_294 = __VLS_asFunctionalComponent(__VLS_293, new __VLS_293({
                modelValue: (__VLS_ctx.editBuffer),
                type: "textarea",
                rows: (20),
                resize: "none",
                ...{ class: "editor-area" },
            }));
            const __VLS_295 = __VLS_294({
                modelValue: (__VLS_ctx.editBuffer),
                type: "textarea",
                rows: (20),
                resize: "none",
                ...{ class: "editor-area" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_294));
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "markdown-body" },
            });
            __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderMarkdown(__VLS_ctx.fileContent.body)) }, null, null);
        }
    }
}
/** @type {__VLS_StyleScopedClasses['browse-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['browse-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['browse-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['browse-body']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-count']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-item']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-name']} */ ;
/** @type {__VLS_StyleScopedClasses['file-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-path']} */ ;
/** @type {__VLS_StyleScopedClasses['content-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['compile-progress']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-header']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-msg']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-stats']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-success']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-cancelled']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-error']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-total']} */ ;
/** @type {__VLS_StyleScopedClasses['compile-progress-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-list']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-row']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-index']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-name']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-status']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-pages']} */ ;
/** @type {__VLS_StyleScopedClasses['batch-msg']} */ ;
/** @type {__VLS_StyleScopedClasses['content-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['content-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['content-show']} */ ;
/** @type {__VLS_StyleScopedClasses['frontmatter-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['fm-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['action-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['current-path']} */ ;
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
/** @type {__VLS_StyleScopedClasses['editor-area']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['browse-body']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-count']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-item']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-name']} */ ;
/** @type {__VLS_StyleScopedClasses['file-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['draft-path']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-count-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['content-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['content-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['content-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['content-show']} */ ;
/** @type {__VLS_StyleScopedClasses['frontmatter-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['fm-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-action-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['current-path']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-suggest-list']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-suggest-title']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-chips']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-add-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-existing-list']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-suggest-title']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-chips']} */ ;
/** @type {__VLS_StyleScopedClasses['tag-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['action-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['current-path']} */ ;
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
/** @type {__VLS_StyleScopedClasses['editor-area']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['browse-body']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['search-box']} */ ;
/** @type {__VLS_StyleScopedClasses['filter-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['view-switcher']} */ ;
/** @type {__VLS_StyleScopedClasses['search-results']} */ ;
/** @type {__VLS_StyleScopedClasses['search-header']} */ ;
/** @type {__VLS_StyleScopedClasses['search-count']} */ ;
/** @type {__VLS_StyleScopedClasses['search-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['search-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['search-hit-item']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['hit-title']} */ ;
/** @type {__VLS_StyleScopedClasses['hit-path']} */ ;
/** @type {__VLS_StyleScopedClasses['hit-snippet']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-node']} */ ;
/** @type {__VLS_StyleScopedClasses['file-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-scroll']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-col']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-col-head']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-label']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-count']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-card']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-card-title']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-card-path']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-card-tags']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['tree-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['calendar-list']} */ ;
/** @type {__VLS_StyleScopedClasses['calendar-group']} */ ;
/** @type {__VLS_StyleScopedClasses['calendar-date']} */ ;
/** @type {__VLS_StyleScopedClasses['date-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['date-text']} */ ;
/** @type {__VLS_StyleScopedClasses['date-count']} */ ;
/** @type {__VLS_StyleScopedClasses['calendar-card']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['calendar-card-title']} */ ;
/** @type {__VLS_StyleScopedClasses['calendar-card-path']} */ ;
/** @type {__VLS_StyleScopedClasses['content-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['content-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['content-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['content-show']} */ ;
/** @type {__VLS_StyleScopedClasses['frontmatter-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['fm-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['action-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['current-path']} */ ;
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
/** @type {__VLS_StyleScopedClasses['editor-area']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Search: Search,
            Check: Check,
            Close: Close,
            CircleClose: CircleClose,
            compileStore: compileStore,
            mode: mode,
            knowledgeView: knowledgeView,
            allPages: allPages,
            pagesLoading: pagesLoading,
            KANBAN_COLUMNS: KANBAN_COLUMNS,
            kanbanGroups: kanbanGroups,
            calendarGroups: calendarGroups,
            treeData: treeData,
            currentNode: currentNode,
            fileContent: fileContent,
            loading: loading,
            editing: editing,
            editBuffer: editBuffer,
            searchQuery: searchQuery,
            searchHits: searchHits,
            searching: searching,
            showSearchResults: showSearchResults,
            sourceFilter: sourceFilter,
            statusFilter: statusFilter,
            typeFilter: typeFilter,
            sourceOptions: sourceOptions,
            statusOptions: statusOptions,
            typeOptions: typeOptions,
            treeProps: treeProps,
            drafts: drafts,
            currentDraftPath: currentDraftPath,
            batchItems: batchItems,
            compiling: compiling,
            progressMessage: progressMessage,
            pendingTagPages: pendingTagPages,
            currentTagPagePath: currentTagPagePath,
            tagRegenerating: tagRegenerating,
            loadTree: loadTree,
            loadDrafts: loadDrafts,
            loadPendingTags: loadPendingTags,
            handleTagPageClick: handleTagPageClick,
            confirmTag: confirmTag,
            regenerateTags: regenerateTags,
            doSearch: doSearch,
            clearSearch: clearSearch,
            handleFilterChange: handleFilterChange,
            handleSearchHit: handleSearchHit,
            handleNodeClick: handleNodeClick,
            handlePageClick: handlePageClick,
            handleDraftClick: handleDraftClick,
            startEdit: startEdit,
            cancelEdit: cancelEdit,
            saveEdit: saveEdit,
            publishDraft: publishDraft,
            publishAllDrafts: publishAllDrafts,
            abortCompile: abortCompile,
            switchMode: switchMode,
            batchSuccessCount: batchSuccessCount,
            batchErrorCount: batchErrorCount,
            batchCancelledCount: batchCancelledCount,
            progressPercentage: progressPercentage,
            renderMarkdown: renderMarkdown,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
