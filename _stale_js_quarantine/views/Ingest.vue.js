/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { ArrowDown, FolderOpened, UploadFilled } from '@element-plus/icons-vue';
import { useCompileStore } from '../stores/compile';
import { consumeSSE } from '../utils/sse';
const emit = defineEmits();
const store = useCompileStore();
const activeTab = ref('file');
const urlInput = ref('');
const textInput = ref('');
const bookmarkResult = ref(null);
const bookmarkCompiling = ref(false);
const selectedFile = ref(null);
// 文件夹模式：扫描得到的有效文件列表
const folderFiles = ref([]);
// ===== QQ 上传状态 =====
// QQ 流程独立于 compile store：upload → extract 是两段 SSE，不走 /api/compile
const qqFile = ref(null);
const qqStage = ref('idle');
const qqProgress = ref('');
// 上传完成后的 rawId 与预清洗统计
const qqRawId = ref('');
const qqMeta = ref(null);
// 抽取阶段产生的 draft 列表（page 事件收集）
const qqDrafts = ref([]);
let qqAbortController = null;
// 批量编译限制：从后端 GET /api/config 动态获取，替代硬编码值
// 为什么需要动态获取：用户在配置中心调整 maxBatchSize/maxFileSizeMb/allowedExtensions 后，
//   前端校验必须同步生效，否则会出现"配置 200 但前端截断到 20"的不一致问题
// 为什么保留默认值：后端不可用时降级到本地默认值，不阻断主流程（fallback-rule）
const ALLOWED_EXTS = ref(new Set(['md', 'txt', 'pdf', 'html', 'json', 'docx', 'xlsx', 'pptx', 'doc', 'xls']));
const MAX_BATCH_SIZE = ref(50);
const MAX_FILE_SIZE_MB = ref(10);
// 从后端加载 batch 配置，更新前端校验限制
// 为什么在 Ingest 页面独立加载：Config.vue 的配置变更需即时反映到 Ingest 页面，
//   每次进入页面都重新拉取最新配置，避免使用 stale 缓存值
async function loadBatchConfig() {
    try {
        const res = await fetch(`${API_BASE}/config`);
        if (!res.ok)
            return;
        const cfg = await res.json();
        if (cfg.batch) {
            // 统一小写以匹配文件扩展名判断
            ALLOWED_EXTS.value = new Set(cfg.batch.allowedExtensions.map(e => e.toLowerCase()));
            MAX_BATCH_SIZE.value = cfg.batch.maxBatchSize;
            MAX_FILE_SIZE_MB.value = cfg.batch.maxFileSizeMb;
        }
    }
    catch {
        // 后端不可用时保留默认值，不阻断投递流程（fallback-rule）
    }
}
onMounted(() => {
    loadBatchConfig();
});
// canSubmit 仅覆盖共用 submit-bar 的 file/folder/text 三种模式
// URL 模式独立两段式流程（爬取 → 编译），由独立按钮触发，不参与 canSubmit 判断
const canSubmit = computed(() => {
    if (activeTab.value === 'file')
        return !!selectedFile.value;
    if (activeTab.value === 'folder')
        return folderFiles.value.length > 0;
    return textInput.value.trim().length > 0;
});
// 扩展名白名单的显示文本：从 Set 动态生成，避免模板中硬编码扩展名列表
const allowedExtsText = computed(() => [...ALLOWED_EXTS.value].join(' / '));
// el-upload accept 属性格式：.md,.txt,.pdf,.html,.json,.docx,.xlsx,.pptx,.doc,.xls
const allowedExtsAccept = computed(() => [...ALLOWED_EXTS.value].map(e => `.${e}`).join(','));
function handleFileChange(file) {
    selectedFile.value = file.raw ?? null;
}
function handleFileRemove() {
    selectedFile.value = null;
}
function disableAutoUpload() {
    return false;
}
// 文件夹选取：通过隐藏 input[type=file][webkitdirectory] 触发
// 浏览器把文件夹下所有文件（含子目录）平铺返回，前端按白名单过滤
const folderInputRef = ref(null);
function triggerFolderPick() {
    folderInputRef.value?.click();
}
function handleFolderChange(e) {
    const input = e.target;
    if (!input.files || input.files.length === 0)
        return;
    const valid = [];
    let rejectedCount = 0;
    let oversizedCount = 0;
    // FileList 可迭代，for-of 比 index 循环更简洁（S4138）
    for (const f of input.files) {
        // webkitRelativePath 含文件夹前缀，这里仅取 basename 作为显示与上传名
        const baseName = (f.webkitRelativePath || f.name).split('/').pop() ?? f.name;
        const ext = baseName.split('.').pop()?.toLowerCase() ?? '';
        if (!ALLOWED_EXTS.value.has(ext)) {
            rejectedCount++;
            continue;
        }
        if (f.size > MAX_FILE_SIZE_MB.value * 1024 * 1024) {
            oversizedCount++;
            continue;
        }
        valid.push({ name: baseName, file: f });
    }
    // 超过批量上限时截断并提示
    if (valid.length > MAX_BATCH_SIZE.value) {
        ElMessage.warning(`文件数超过 ${MAX_BATCH_SIZE.value} 上限，仅保留前 ${MAX_BATCH_SIZE.value} 个文件`);
        folderFiles.value = valid.slice(0, MAX_BATCH_SIZE.value);
    }
    else {
        folderFiles.value = valid;
    }
    if (valid.length === 0) {
        ElMessage.warning(`所选文件夹中没有符合白名单（${[...ALLOWED_EXTS.value].join('/')}）的文件`);
    }
    else if (rejectedCount > 0 || oversizedCount > 0) {
        const parts = [];
        if (rejectedCount > 0)
            parts.push(`${rejectedCount} 个不符白名单`);
        if (oversizedCount > 0)
            parts.push(`${oversizedCount} 个超过 ${MAX_FILE_SIZE_MB.value}MB`);
        ElMessage.info(`已跳过 ${parts.join('、')}`);
    }
    // 清空 input value 以便再次选取同一文件夹能触发 change
    input.value = '';
}
function removeFolderFile(idx) {
    folderFiles.value.splice(idx, 1);
}
function clearFolderFiles() {
    folderFiles.value = [];
}
function buildPayload() {
    if (activeTab.value === 'file') {
        if (!selectedFile.value)
            return null;
        const fd = new FormData();
        fd.append('file', selectedFile.value);
        return fd;
    }
    if (activeTab.value === 'folder') {
        if (folderFiles.value.length === 0)
            return null;
        const fd = new FormData();
        // 字段名统一为 files（复数），后端按此名收集
        for (const item of folderFiles.value) {
            fd.append('files', item.file, item.name);
        }
        return fd;
    }
    // URL 模式不走 buildPayload：两段式流程由 startUrlCrawl/startUrlCompile 独立处理
    const content = textInput.value.trim();
    if (!content)
        return null;
    return { type: 'text', content };
}
// 防重复提交：store.isCompiling 是跨组件状态，本地的 submitting 防止同 tick 内重复触发
const submitting = ref(false);
function handleSubmit() {
    if (submitting.value || store.isCompiling)
        return;
    const payload = buildPayload();
    if (!payload) {
        ElMessage.warning('请先准备好要投递的资料');
        return;
    }
    // 单文件模式：文件大小校验
    // 为什么在此校验而非 canSubmit：canSubmit 仅判断有无文件，大小校验放在提交点
    //   可以给出精确的 ElMessage.warning 提示，而非静默禁用按钮
    if (activeTab.value === 'file' && selectedFile.value) {
        if (selectedFile.value.size > MAX_FILE_SIZE_MB.value * 1024 * 1024) {
            ElMessage.warning(`文件大小超过 ${MAX_FILE_SIZE_MB.value}MB 上限`);
            return;
        }
    }
    submitting.value = true;
    try {
        if (activeTab.value === 'folder' && payload instanceof FormData) {
            store.prepareBatchCompile(payload);
        }
        else {
            store.prepareCompile(payload);
        }
        emit('start');
    }
    finally {
        // 下一 tick 释放本地锁，store.isCompiling 由 Progress.vue 的 abortCompile/reset 管理
        setTimeout(() => { submitting.value = false; }, 100);
    }
}
function resetInputs() {
    selectedFile.value = null;
    folderFiles.value = [];
    urlInput.value = '';
    textInput.value = '';
    // URL 流程状态一并重置
    resetUrlFlow();
}
// ============================================================
// QQ 聊天记录上传流程
// 两段式：upload（预清洗）→ extract（LLM 抽取写 draft）
// 为什么独立于 compile store：QQ 走 /api/qq-ingest/* 路由族，不复用 /api/compile
// ============================================================
function handleQqFileChange(file) {
    qqFile.value = file.raw ?? null;
    // 切换文件时重置流程状态，避免上一次的 rawId/drafts 残留
    qqStage.value = 'idle';
    qqMeta.value = null;
    qqDrafts.value = [];
    qqRawId.value = '';
}
function handleQqFileRemove() {
    qqFile.value = null;
    qqStage.value = 'idle';
    qqMeta.value = null;
    qqDrafts.value = [];
    qqRawId.value = '';
}
// QQ 文件上传：POST /api/qq-ingest/upload (SSE)
// 为什么上传后不自动触发抽取：抽取调用 LLM 产生费用，需用户明确确认
async function uploadQqFile() {
    if (!qqFile.value) {
        ElMessage.warning('请先选择 QQ 聊天记录文件');
        return;
    }
    // 阶段重置
    qqStage.value = 'uploading';
    qqProgress.value = '开始上传…';
    qqMeta.value = null;
    qqDrafts.value = [];
    qqRawId.value = '';
    qqAbortController = new AbortController();
    const fd = new FormData();
    fd.append('file', qqFile.value);
    try {
        const res = await fetch(`${API_BASE}/qq-ingest/upload`, {
            method: 'POST',
            body: fd,
            signal: qqAbortController.signal,
        });
        if (!res.ok || !res.body) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        await consumeSSE(res, handleUploadEvent, qqAbortController.signal);
    }
    catch (err) {
        if (err.name === 'AbortError') {
            qqStage.value = 'idle';
            qqProgress.value = '已取消';
            return;
        }
        qqStage.value = 'error';
        ElMessage.error('QQ 文件上传失败：' + err.message);
    }
    finally {
        qqAbortController = null;
    }
}
// upload SSE 事件处理：progress/done/error
function handleUploadEvent(eventType, data) {
    if (eventType === 'progress') {
        qqProgress.value = data.message ?? '';
        return;
    }
    if (eventType === 'done') {
        // done 事件携带预清洗结果：rawId + meta
        if (data.data?.rawId && data.data?.meta) {
            qqRawId.value = data.data.rawId;
            qqMeta.value = data.data.meta;
            qqStage.value = 'uploaded';
            qqProgress.value = '预清洗完成，可开始抽取';
            ElMessage.success(`预清洗完成：${data.data.meta.originalCount} → ${data.data.meta.filteredCount} 条，脱敏 ${data.data.meta.redactedCount} 条`);
        }
        else {
            qqStage.value = 'uploaded';
            qqProgress.value = data.message ?? '预清洗完成';
        }
        return;
    }
    if (eventType === 'error') {
        qqStage.value = 'error';
        qqProgress.value = data.message ?? '上传失败';
        ElMessage.error(data.message ?? '上传失败');
    }
}
// 触发 LLM 抽取：POST /api/qq-ingest/extract/:rawId (SSE)
// 为什么需要 rawId：抽取阶段通过 rawId 定位预清洗结果文件
async function extractQqDrafts() {
    if (!qqRawId.value) {
        ElMessage.warning('缺少 rawId，请先上传文件');
        return;
    }
    qqStage.value = 'extracting';
    qqProgress.value = '开始 LLM 抽取…';
    qqDrafts.value = [];
    qqAbortController = new AbortController();
    try {
        const res = await fetch(`${API_BASE}/qq-ingest/extract/${qqRawId.value}`, { method: 'POST', signal: qqAbortController.signal });
        if (!res.ok || !res.body) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        await consumeSSE(res, handleExtractEvent, qqAbortController.signal);
    }
    catch (err) {
        if (err.name === 'AbortError') {
            // 中止后回到 uploaded 状态，允许重新触发抽取
            qqStage.value = 'uploaded';
            qqProgress.value = '已取消，可重新抽取';
            return;
        }
        qqStage.value = 'error';
        ElMessage.error('LLM 抽取失败：' + err.message);
    }
    finally {
        qqAbortController = null;
    }
}
// extract SSE 事件处理：progress/page/done/error
// 复用 DraftCompileEvent 类型（字段结构与后端 ProgressEvent 对齐）
function handleExtractEvent(eventType, data) {
    if (eventType === 'progress') {
        qqProgress.value = data.message ?? '';
        return;
    }
    if (eventType === 'page' && data.data?.path && data.data?.title) {
        // 收集每个 draft 的生成信息
        qqDrafts.value.push({ path: data.data.path, title: data.data.title });
        return;
    }
    if (eventType === 'done') {
        qqStage.value = 'done';
        qqProgress.value = data.message ?? '抽取完成';
        ElMessage.success(`抽取完成，共生成 ${qqDrafts.value.length} 个草稿`);
        return;
    }
    if (eventType === 'error') {
        qqStage.value = 'error';
        qqProgress.value = data.message ?? '抽取失败';
        ElMessage.error(data.message ?? '抽取失败');
    }
}
function abortQqFlow() {
    if (qqAbortController) {
        qqAbortController.abort();
    }
}
// 跳转到 Browse 草稿审核界面：派发自定义事件
// 为什么用自定义事件而非 router：本项目 SPA 用 v-if 切视图，由 App.vue 监听
// 同时设置 sessionStorage 提示 Browse.vue 自动切换到 draft 模式
function goToDraftReview() {
    sessionStorage.setItem('karpathy:jumpMode', 'draft');
    globalThis.dispatchEvent(new CustomEvent('karpathy:navigate', { detail: 'browse' }));
}
const urlStage = ref('idle');
const urlProgress = ref('');
// 爬取完成后的摘要信息（done 事件携带）
// 5.4.4 扩展 elapsedMs：用于在结果区域展示爬取耗时
const urlCrawlResult = ref(null);
// 5.4.2 附件按类型分组展示：document/image/audio/video/other
// 为什么用 computed 而非方法：依赖 urlCrawlResult.attachments，computed 自动响应更新
const groupedAttachments = computed(() => {
    const groups = {
        document: [],
        image: [],
        audio: [],
        video: [],
        other: [],
    };
    if (!urlCrawlResult.value?.attachments)
        return groups;
    for (const att of urlCrawlResult.value.attachments) {
        const key = groups[att.type] ? att.type : 'other';
        groups[key].push(att);
    }
    return groups;
});
// 附件分组中文标签
const attachmentGroupLabels = {
    document: '文档',
    image: '图片',
    audio: '音频',
    video: '视频',
    other: '其他',
};
// 格式化耗时：ms → "X.Xs" 或 "Xm Ys"
function formatElapsed(ms) {
    if (!ms || ms <= 0)
        return '';
    if (ms < 60000)
        return `${(ms / 1000).toFixed(2)}s`;
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${s}s`;
}
// done 事件返回的合并 Markdown，编译阶段直接作为 text 输入
const urlCombinedMarkdown = ref('');
let urlAbortController = null;
// 5.4.1 爬取预览：勾选的页面 URL 集合，默认全选
// 为什么用 Set 而非数组：勾选状态查询用 Set O(1)，数组 O(n)
const selectedPageUrls = ref(new Set());
const allPageUrls = computed(() => urlCrawlResult.value?.pages.map((p) => p.url) ?? []);
const selectedPageCount = computed(() => selectedPageUrls.value.size);
const isAllPagesSelected = computed(() => allPageUrls.value.length > 0 && selectedPageUrls.value.size === allPageUrls.value.length);
function togglePageSelection(url) {
    const next = new Set(selectedPageUrls.value);
    if (next.has(url))
        next.delete(url);
    else
        next.add(url);
    selectedPageUrls.value = next;
}
function toggleAllPages() {
    if (isAllPagesSelected.value) {
        selectedPageUrls.value = new Set();
    }
    else {
        selectedPageUrls.value = new Set(allPageUrls.value);
    }
}
// 5.1.4 maxPages/maxHops 前端可配置：默认 null 表示使用后端 config 值
// 为什么用 null 而非 0：null 在 JSON.stringify 时被忽略，0 会被后端当作"覆盖为 0"
// 上限与后端 url-ingest.ts 对齐：maxPages≤500、maxHops≤10
const urlMaxPages = ref(null);
const urlMaxHops = ref(null);
// 阶段 1：触发 URL 爬取（POST /api/url-ingest/crawl SSE）
async function startUrlCrawl() {
    const entryUrl = urlInput.value.trim();
    if (!entryUrl) {
        ElMessage.warning('请先输入要爬取的入口 URL');
        return;
    }
    // 简单协议校验：与后端 URL_PATTERN 对齐，防止 javascript:/data: 等危险协议
    if (!/^https?:\/\/[^\s]+$/i.test(entryUrl)) {
        ElMessage.warning('URL 必须以 http:// 或 https:// 开头');
        return;
    }
    // 阶段重置
    urlStage.value = 'crawling';
    urlProgress.value = '开始爬取…';
    urlCrawlResult.value = null;
    urlCombinedMarkdown.value = '';
    urlAbortController = new AbortController();
    try {
        // 5.1.4 请求级覆盖：仅在用户显式输入时携带 maxPages/maxHops
        const reqBody = { url: entryUrl };
        if (urlMaxPages.value !== null && urlMaxPages.value > 0) {
            reqBody.maxPages = Math.min(Math.floor(urlMaxPages.value), 500);
        }
        if (urlMaxHops.value !== null && urlMaxHops.value > 0) {
            reqBody.maxHops = Math.min(Math.floor(urlMaxHops.value), 10);
        }
        const res = await fetch(`${API_BASE}/url-ingest/crawl`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reqBody),
            signal: urlAbortController.signal,
        });
        if (!res.ok || !res.body) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        await consumeSSE(res, handleUrlCrawlEvent, urlAbortController.signal);
    }
    catch (err) {
        if (err.name === 'AbortError') {
            urlStage.value = 'idle';
            urlProgress.value = '已取消';
            return;
        }
        urlStage.value = 'error';
        ElMessage.error('URL 爬取失败：' + err.message);
    }
    finally {
        urlAbortController = null;
    }
}
// SSE 事件分发：progress/page_start/page_done/page_error/page_skipped/attachment/done/error
function handleUrlCrawlEvent(eventType, data) {
    // progress/page_start/page_done/page_skipped/attachment 都会更新进度文本
    if (eventType === 'progress' || eventType === 'page_start' || eventType === 'page_done' || eventType === 'page_skipped' || eventType === 'attachment') {
        urlProgress.value = data.message ?? '';
        return;
    }
    if (eventType === 'page_error') {
        // 单页失败不阻断整体，仅记录到进度文本
        urlProgress.value = data.message ?? '页面抓取失败';
        return;
    }
    if (eventType === 'done') {
        // done 事件携带汇总数据：pagesCrawled/totalAttachmentCount/combinedMarkdown/pages/attachments/elapsedMs/pagesSkipped
        const d = data.data;
        if (d?.combinedMarkdown) {
            urlCombinedMarkdown.value = d.combinedMarkdown;
            urlCrawlResult.value = {
                pagesCrawled: d.pagesCrawled ?? 0,
                totalAttachmentCount: d.totalAttachmentCount ?? 0,
                pages: d.pages ?? [],
                attachments: d.attachments ?? [],
                elapsedMs: d.elapsedMs,
            };
            // 5.4.1 爬取预览：初始化勾选集合为全选
            selectedPageUrls.value = new Set((d.pages ?? []).map((p) => p.url));
            urlStage.value = 'crawled';
            // 5.4.4 耗时显示 + 5.1.3 跳过页面数
            const elapsedStr = formatElapsed(d.elapsedMs);
            const skippedStr = d.pagesSkipped && d.pagesSkipped > 0 ? `，跳过 ${d.pagesSkipped} 个未变更` : '';
            urlProgress.value = `爬取完成：${d.pagesCrawled ?? 0} 个页面，${d.totalAttachmentCount ?? 0} 个附件${skippedStr}${elapsedStr ? `，耗时 ${elapsedStr}` : ''}`;
            ElMessage.success(`爬取完成：共 ${d.pagesCrawled ?? 0} 个页面，${d.totalAttachmentCount ?? 0} 个附件${skippedStr}${elapsedStr ? `，耗时 ${elapsedStr}` : ''}`);
        }
        else {
            urlStage.value = 'crawled';
            urlProgress.value = data.message ?? '爬取完成';
        }
        return;
    }
    if (eventType === 'error') {
        urlStage.value = 'error';
        urlProgress.value = data.message ?? '爬取失败';
        ElMessage.error(data.message ?? '爬取失败');
    }
}
// 阶段 2：用合并后的 Markdown 触发编译
// 为什么用 type:'text' 而非 type:'url'：爬取阶段已获取页面正文并合并为 Markdown，
// 编译阶段直接以文本输入走 /api/compile 的 text 模式，避免后端再次抓取 URL
// 5.4.1 爬取预览：仅编译被勾选的页面，未勾选的页面不进入编译
// FR-16-2 书签文件上传处理
async function handleBookmarkFile(file) {
    bookmarkResult.value = null;
    const raw = file.raw;
    if (!raw)
        return;
    const formData = new FormData();
    formData.append('file', raw);
    try {
        const res = await fetch(`${API_BASE}/ingest/bookmarks`, {
            method: 'POST',
            body: formData,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        bookmarkResult.value = data;
        ElMessage.success(`已解析 ${data.totalBookmarks} 条书签`);
    }
    catch (err) {
        ElMessage.error('书签解析失败：' + err.message);
    }
}
async function compileBookmarks() {
    if (!bookmarkResult.value)
        return;
    if (store.isCompiling || bookmarkCompiling.value)
        return;
    bookmarkCompiling.value = true;
    try {
        // 复用 compile store 的 text 模式：将书签 Markdown 作为文本编译
        store.prepareCompile({
            type: 'text',
            content: bookmarkResult.value.combinedMarkdown,
        });
        emit('start');
    }
    finally {
        bookmarkCompiling.value = false;
    }
}
function startUrlCompile() {
    if (!urlCrawlResult.value || urlCrawlResult.value.pages.length === 0) {
        ElMessage.warning('没有可编译的内容，请先完成爬取');
        return;
    }
    if (selectedPageUrls.value.size === 0) {
        ElMessage.warning('请至少勾选一个页面进行编译');
        return;
    }
    if (store.isCompiling || submitting.value)
        return;
    // 5.4.1 基于勾选状态拼接 markdown
    // 为什么不直接用 combinedMarkdown：用户可能取消勾选部分页面，需重新拼接
    const selectedPages = urlCrawlResult.value.pages.filter((p) => selectedPageUrls.value.has(p.url));
    const markdownParts = [];
    for (const p of selectedPages) {
        if (p.markdown) {
            markdownParts.push(p.markdown);
        }
    }
    // 兜底：若 pages 未携带 markdown 字段（旧后端兼容），回退到 combinedMarkdown
    const finalMarkdown = markdownParts.length > 0 ? markdownParts.join('\n\n') : urlCombinedMarkdown.value;
    if (!finalMarkdown) {
        ElMessage.warning('没有可编译的内容，请先完成爬取');
        return;
    }
    submitting.value = true;
    try {
        store.prepareCompile({ type: 'text', content: finalMarkdown });
        emit('start');
    }
    finally {
        setTimeout(() => { submitting.value = false; }, 100);
    }
}
// 取消爬取：通过 AbortController 中断 fetch 流
function abortUrlCrawl() {
    if (urlAbortController) {
        urlAbortController.abort();
    }
}
// 重置 URL 流程状态（切换 Tab 或重新输入时调用）
function resetUrlFlow() {
    urlStage.value = 'idle';
    urlProgress.value = '';
    urlCrawlResult.value = null;
    urlCombinedMarkdown.value = '';
    // 5.4.1 爬取预览：重置勾选状态
    selectedPageUrls.value = new Set();
}
// URL 输入变更：已爬取或出错后修改 URL 时，重置流程状态以避免用旧结果编译
function handleUrlInputChange() {
    if (urlStage.value === 'crawled' || urlStage.value === 'error') {
        resetUrlFlow();
    }
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['folder-dropzone']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-value']} */ ;
/** @type {__VLS_StyleScopedClasses['drafts-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['url-page-item']} */ ;
/** @type {__VLS_StyleScopedClasses['url-att-group']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-dot']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "ingest-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "hero-section fade-up" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "hero-orb" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "hero-right" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "hero-title grad-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "hero-tip" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card ingest-card fade-up" },
    ...{ style: {} },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
const __VLS_0 = {}.ElTabs;
/** @type {[typeof __VLS_components.ElTabs, typeof __VLS_components.elTabs, typeof __VLS_components.ElTabs, typeof __VLS_components.elTabs, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    modelValue: (__VLS_ctx.activeTab),
    ...{ class: "ingest-tabs" },
}));
const __VLS_2 = __VLS_1({
    modelValue: (__VLS_ctx.activeTab),
    ...{ class: "ingest-tabs" },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
const __VLS_4 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
    label: "文件上传",
    name: "file",
}));
const __VLS_6 = __VLS_5({
    label: "文件上传",
    name: "file",
}, ...__VLS_functionalComponentArgsRest(__VLS_5));
__VLS_7.slots.default;
const __VLS_8 = {}.ElUpload;
/** @type {[typeof __VLS_components.ElUpload, typeof __VLS_components.elUpload, typeof __VLS_components.ElUpload, typeof __VLS_components.elUpload, ]} */ ;
// @ts-ignore
const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
    drag: true,
    autoUpload: (false),
    limit: (1),
    onChange: (__VLS_ctx.handleFileChange),
    onRemove: (__VLS_ctx.handleFileRemove),
    beforeUpload: (__VLS_ctx.disableAutoUpload),
    accept: (__VLS_ctx.allowedExtsAccept),
}));
const __VLS_10 = __VLS_9({
    drag: true,
    autoUpload: (false),
    limit: (1),
    onChange: (__VLS_ctx.handleFileChange),
    onRemove: (__VLS_ctx.handleFileRemove),
    beforeUpload: (__VLS_ctx.disableAutoUpload),
    accept: (__VLS_ctx.allowedExtsAccept),
}, ...__VLS_functionalComponentArgsRest(__VLS_9));
__VLS_11.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-inner" },
});
const __VLS_12 = {}.ElIcon;
/** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
// @ts-ignore
const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
    ...{ class: "upload-icon" },
}));
const __VLS_14 = __VLS_13({
    ...{ class: "upload-icon" },
}, ...__VLS_functionalComponentArgsRest(__VLS_13));
__VLS_15.slots.default;
const __VLS_16 = {}.ArrowDown;
/** @type {[typeof __VLS_components.ArrowDown, ]} */ ;
// @ts-ignore
const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({}));
const __VLS_18 = __VLS_17({}, ...__VLS_functionalComponentArgsRest(__VLS_17));
var __VLS_15;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-hint" },
});
(__VLS_ctx.allowedExtsText);
var __VLS_11;
var __VLS_7;
const __VLS_20 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
    label: "文件夹上传",
    name: "folder",
}));
const __VLS_22 = __VLS_21({
    label: "文件夹上传",
    name: "folder",
}, ...__VLS_functionalComponentArgsRest(__VLS_21));
__VLS_23.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    ...{ onChange: (__VLS_ctx.handleFolderChange) },
    ref: "folderInputRef",
    type: "file",
    webkitdirectory: true,
    directory: true,
    multiple: true,
    ...{ style: {} },
});
/** @type {typeof __VLS_ctx.folderInputRef} */ ;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ onClick: (__VLS_ctx.triggerFolderPick) },
    ...{ class: "folder-dropzone" },
});
const __VLS_24 = {}.ElIcon;
/** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
// @ts-ignore
const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
    ...{ class: "upload-icon" },
}));
const __VLS_26 = __VLS_25({
    ...{ class: "upload-icon" },
}, ...__VLS_functionalComponentArgsRest(__VLS_25));
__VLS_27.slots.default;
const __VLS_28 = {}.FolderOpened;
/** @type {[typeof __VLS_components.FolderOpened, ]} */ ;
// @ts-ignore
const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({}));
const __VLS_30 = __VLS_29({}, ...__VLS_functionalComponentArgsRest(__VLS_29));
var __VLS_27;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-hint" },
});
(__VLS_ctx.allowedExtsText);
(__VLS_ctx.MAX_BATCH_SIZE);
(__VLS_ctx.MAX_FILE_SIZE_MB);
if (__VLS_ctx.folderFiles.length > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "folder-files" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "folder-files-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "folder-files-title" },
    });
    (__VLS_ctx.folderFiles.length);
    const __VLS_32 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
        ...{ 'onClick': {} },
        size: "small",
        text: true,
    }));
    const __VLS_34 = __VLS_33({
        ...{ 'onClick': {} },
        size: "small",
        text: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_33));
    let __VLS_36;
    let __VLS_37;
    let __VLS_38;
    const __VLS_39 = {
        onClick: (__VLS_ctx.clearFolderFiles)
    };
    __VLS_35.slots.default;
    var __VLS_35;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
        ...{ class: "folder-files-list" },
    });
    for (const [item, idx] of __VLS_getVForSourceType((__VLS_ctx.folderFiles))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
            key: (idx),
            ...{ class: "folder-file-item" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
            ...{ class: "folder-file-name" },
        });
        (item.name);
        const __VLS_40 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
            ...{ 'onClick': {} },
            size: "small",
            text: true,
            type: "danger",
        }));
        const __VLS_42 = __VLS_41({
            ...{ 'onClick': {} },
            size: "small",
            text: true,
            type: "danger",
        }, ...__VLS_functionalComponentArgsRest(__VLS_41));
        let __VLS_44;
        let __VLS_45;
        let __VLS_46;
        const __VLS_47 = {
            onClick: (...[$event]) => {
                if (!(__VLS_ctx.folderFiles.length > 0))
                    return;
                __VLS_ctx.removeFolderFile(idx);
            }
        };
        __VLS_43.slots.default;
        var __VLS_43;
    }
}
var __VLS_23;
const __VLS_48 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
    label: "URL 粘贴",
    name: "url",
}));
const __VLS_50 = __VLS_49({
    label: "URL 粘贴",
    name: "url",
}, ...__VLS_functionalComponentArgsRest(__VLS_49));
__VLS_51.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "url-flow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "url-tip-banner" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "url-tip-icon" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "url-tip-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "url-step" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "url-step-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "url-step-no" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "url-step-title" },
});
const __VLS_52 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({
    ...{ 'onInput': {} },
    modelValue: (__VLS_ctx.urlInput),
    placeholder: "http://www.example.com/content/index.html",
    clearable: true,
    size: "large",
    disabled: (__VLS_ctx.urlStage === 'crawling'),
}));
const __VLS_54 = __VLS_53({
    ...{ 'onInput': {} },
    modelValue: (__VLS_ctx.urlInput),
    placeholder: "http://www.example.com/content/index.html",
    clearable: true,
    size: "large",
    disabled: (__VLS_ctx.urlStage === 'crawling'),
}, ...__VLS_functionalComponentArgsRest(__VLS_53));
let __VLS_56;
let __VLS_57;
let __VLS_58;
const __VLS_59 = {
    onInput: (__VLS_ctx.handleUrlInputChange)
};
__VLS_55.slots.default;
{
    const { prepend: __VLS_thisSlot } = __VLS_55.slots;
}
var __VLS_55;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "url-params-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "url-param-item" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "url-param-label" },
});
const __VLS_60 = {}.ElInputNumber;
/** @type {[typeof __VLS_components.ElInputNumber, typeof __VLS_components.elInputNumber, ]} */ ;
// @ts-ignore
const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({
    modelValue: (__VLS_ctx.urlMaxPages),
    min: (1),
    max: (500),
    step: (10),
    size: "small",
    controlsPosition: "right",
    placeholder: "默认 50",
    disabled: (__VLS_ctx.urlStage === 'crawling'),
}));
const __VLS_62 = __VLS_61({
    modelValue: (__VLS_ctx.urlMaxPages),
    min: (1),
    max: (500),
    step: (10),
    size: "small",
    controlsPosition: "right",
    placeholder: "默认 50",
    disabled: (__VLS_ctx.urlStage === 'crawling'),
}, ...__VLS_functionalComponentArgsRest(__VLS_61));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "url-param-item" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "url-param-label" },
});
const __VLS_64 = {}.ElInputNumber;
/** @type {[typeof __VLS_components.ElInputNumber, typeof __VLS_components.elInputNumber, ]} */ ;
// @ts-ignore
const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({
    modelValue: (__VLS_ctx.urlMaxHops),
    min: (1),
    max: (10),
    step: (1),
    size: "small",
    controlsPosition: "right",
    placeholder: "默认 3",
    disabled: (__VLS_ctx.urlStage === 'crawling'),
}));
const __VLS_66 = __VLS_65({
    modelValue: (__VLS_ctx.urlMaxHops),
    min: (1),
    max: (10),
    step: (1),
    size: "small",
    controlsPosition: "right",
    placeholder: "默认 3",
    disabled: (__VLS_ctx.urlStage === 'crawling'),
}, ...__VLS_functionalComponentArgsRest(__VLS_65));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "url-action-row" },
});
const __VLS_68 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_69 = __VLS_asFunctionalComponent(__VLS_68, new __VLS_68({
    ...{ 'onClick': {} },
    type: "primary",
    disabled: (!__VLS_ctx.urlInput.trim() || __VLS_ctx.urlStage === 'crawling'),
    loading: (__VLS_ctx.urlStage === 'crawling'),
}));
const __VLS_70 = __VLS_69({
    ...{ 'onClick': {} },
    type: "primary",
    disabled: (!__VLS_ctx.urlInput.trim() || __VLS_ctx.urlStage === 'crawling'),
    loading: (__VLS_ctx.urlStage === 'crawling'),
}, ...__VLS_functionalComponentArgsRest(__VLS_69));
let __VLS_72;
let __VLS_73;
let __VLS_74;
const __VLS_75 = {
    onClick: (__VLS_ctx.startUrlCrawl)
};
__VLS_71.slots.default;
var __VLS_71;
if (__VLS_ctx.urlStage === 'crawling') {
    const __VLS_76 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_77 = __VLS_asFunctionalComponent(__VLS_76, new __VLS_76({
        ...{ 'onClick': {} },
        size: "small",
        type: "danger",
        text: true,
    }));
    const __VLS_78 = __VLS_77({
        ...{ 'onClick': {} },
        size: "small",
        type: "danger",
        text: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_77));
    let __VLS_80;
    let __VLS_81;
    let __VLS_82;
    const __VLS_83 = {
        onClick: (__VLS_ctx.abortUrlCrawl)
    };
    __VLS_79.slots.default;
    var __VLS_79;
}
if (__VLS_ctx.urlStage === 'crawled' && __VLS_ctx.urlCrawlResult) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "url-step" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "url-step-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "url-step-no" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "url-step-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "url-meta-card" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "meta-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "meta-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "meta-value" },
    });
    (__VLS_ctx.urlCrawlResult.pagesCrawled);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "meta-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "meta-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "meta-value" },
    });
    (__VLS_ctx.urlCrawlResult.totalAttachmentCount);
    if (__VLS_ctx.urlCrawlResult.elapsedMs) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "meta-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "meta-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "meta-value" },
        });
        (__VLS_ctx.formatElapsed(__VLS_ctx.urlCrawlResult.elapsedMs));
    }
    if (__VLS_ctx.urlCrawlResult.pages.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "url-pages-card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "url-pages-head" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "url-pages-title" },
        });
        (__VLS_ctx.selectedPageCount);
        (__VLS_ctx.urlCrawlResult.pages.length);
        const __VLS_84 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_85 = __VLS_asFunctionalComponent(__VLS_84, new __VLS_84({
            ...{ 'onClick': {} },
            size: "small",
            text: true,
        }));
        const __VLS_86 = __VLS_85({
            ...{ 'onClick': {} },
            size: "small",
            text: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_85));
        let __VLS_88;
        let __VLS_89;
        let __VLS_90;
        const __VLS_91 = {
            onClick: (__VLS_ctx.toggleAllPages)
        };
        __VLS_87.slots.default;
        (__VLS_ctx.isAllPagesSelected ? '取消全选' : '全选');
        var __VLS_87;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
            ...{ class: "url-pages-list" },
        });
        for (const [p, idx] of __VLS_getVForSourceType((__VLS_ctx.urlCrawlResult.pages))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
                key: (idx),
                ...{ class: "url-page-item" },
                ...{ class: ({ 'url-page-unchecked': !__VLS_ctx.selectedPageUrls.has(p.url) }) },
            });
            const __VLS_92 = {}.ElCheckbox;
            /** @type {[typeof __VLS_components.ElCheckbox, typeof __VLS_components.elCheckbox, ]} */ ;
            // @ts-ignore
            const __VLS_93 = __VLS_asFunctionalComponent(__VLS_92, new __VLS_92({
                ...{ 'onChange': {} },
                modelValue: (__VLS_ctx.selectedPageUrls.has(p.url)),
            }));
            const __VLS_94 = __VLS_93({
                ...{ 'onChange': {} },
                modelValue: (__VLS_ctx.selectedPageUrls.has(p.url)),
            }, ...__VLS_functionalComponentArgsRest(__VLS_93));
            let __VLS_96;
            let __VLS_97;
            let __VLS_98;
            const __VLS_99 = {
                onChange: (...[$event]) => {
                    if (!(__VLS_ctx.urlStage === 'crawled' && __VLS_ctx.urlCrawlResult))
                        return;
                    if (!(__VLS_ctx.urlCrawlResult.pages.length > 0))
                        return;
                    __VLS_ctx.togglePageSelection(p.url);
                }
            };
            var __VLS_95;
            __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
                ...{ class: "url-page-depth" },
            });
            (p.depth);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "url-page-title" },
            });
            (p.title || p.url);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "url-page-stats" },
            });
            (p.contentLength);
            (p.attachmentCount);
        }
    }
    if (__VLS_ctx.urlCrawlResult.attachments.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "url-attachments-card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "url-attachments-title" },
        });
        for (const [groupArr, groupKey] of __VLS_getVForSourceType((__VLS_ctx.groupedAttachments))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (groupKey),
                ...{ class: "url-att-group" },
            });
            __VLS_asFunctionalDirective(__VLS_directives.vShow)(null, { ...__VLS_directiveBindingRestFields, value: (groupArr.length > 0) }, null, null);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "url-att-group-title" },
            });
            (__VLS_ctx.attachmentGroupLabels[groupKey] || groupKey);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "url-att-group-count" },
            });
            (groupArr.length);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
                ...{ class: "url-attachments-list" },
            });
            for (const [a, idx] of __VLS_getVForSourceType((groupArr))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
                    key: (`${groupKey}-${idx}`),
                    ...{ class: "url-attachment-item" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
                    ...{ class: "url-att-type" },
                });
                (a.extension);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
                    ...{ class: "url-att-url" },
                });
                (a.url);
            }
        }
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "url-action-row" },
    });
    const __VLS_100 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_101 = __VLS_asFunctionalComponent(__VLS_100, new __VLS_100({
        ...{ 'onClick': {} },
        type: "primary",
        disabled: (!__VLS_ctx.urlCombinedMarkdown || __VLS_ctx.store.isCompiling || __VLS_ctx.submitting || __VLS_ctx.selectedPageCount === 0),
        loading: (__VLS_ctx.store.isCompiling),
    }));
    const __VLS_102 = __VLS_101({
        ...{ 'onClick': {} },
        type: "primary",
        disabled: (!__VLS_ctx.urlCombinedMarkdown || __VLS_ctx.store.isCompiling || __VLS_ctx.submitting || __VLS_ctx.selectedPageCount === 0),
        loading: (__VLS_ctx.store.isCompiling),
    }, ...__VLS_functionalComponentArgsRest(__VLS_101));
    let __VLS_104;
    let __VLS_105;
    let __VLS_106;
    const __VLS_107 = {
        onClick: (__VLS_ctx.startUrlCompile)
    };
    __VLS_103.slots.default;
    (__VLS_ctx.selectedPageCount);
    (__VLS_ctx.urlCrawlResult.pages.length);
    var __VLS_103;
    const __VLS_108 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_109 = __VLS_asFunctionalComponent(__VLS_108, new __VLS_108({
        ...{ 'onClick': {} },
    }));
    const __VLS_110 = __VLS_109({
        ...{ 'onClick': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_109));
    let __VLS_112;
    let __VLS_113;
    let __VLS_114;
    const __VLS_115 = {
        onClick: (__VLS_ctx.resetUrlFlow)
    };
    __VLS_111.slots.default;
    var __VLS_111;
}
if (__VLS_ctx.urlProgress && __VLS_ctx.urlStage !== 'idle') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "url-progress" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "qq-progress-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "progress-dot" },
        ...{ class: (__VLS_ctx.urlStage) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "progress-text" },
    });
    (__VLS_ctx.urlProgress);
    const __VLS_116 = {}.ElProgress;
    /** @type {[typeof __VLS_components.ElProgress, typeof __VLS_components.elProgress, ]} */ ;
    // @ts-ignore
    const __VLS_117 = __VLS_asFunctionalComponent(__VLS_116, new __VLS_116({
        percentage: (__VLS_ctx.urlStage === 'crawled' ? 100 : 0),
        indeterminate: (__VLS_ctx.urlStage === 'crawling'),
        strokeWidth: (5),
        status: (__VLS_ctx.urlStage === 'crawled' ? 'success' : __VLS_ctx.urlStage === 'error' ? 'exception' : ''),
        striped: (__VLS_ctx.urlStage === 'crawling'),
        stripedFlow: (__VLS_ctx.urlStage === 'crawling'),
        ...{ class: "qq-progress-bar" },
    }));
    const __VLS_118 = __VLS_117({
        percentage: (__VLS_ctx.urlStage === 'crawled' ? 100 : 0),
        indeterminate: (__VLS_ctx.urlStage === 'crawling'),
        strokeWidth: (5),
        status: (__VLS_ctx.urlStage === 'crawled' ? 'success' : __VLS_ctx.urlStage === 'error' ? 'exception' : ''),
        striped: (__VLS_ctx.urlStage === 'crawling'),
        stripedFlow: (__VLS_ctx.urlStage === 'crawling'),
        ...{ class: "qq-progress-bar" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_117));
}
var __VLS_51;
const __VLS_120 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_121 = __VLS_asFunctionalComponent(__VLS_120, new __VLS_120({
    label: "文本粘贴",
    name: "text",
}));
const __VLS_122 = __VLS_121({
    label: "文本粘贴",
    name: "text",
}, ...__VLS_functionalComponentArgsRest(__VLS_121));
__VLS_123.slots.default;
const __VLS_124 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_125 = __VLS_asFunctionalComponent(__VLS_124, new __VLS_124({
    modelValue: (__VLS_ctx.textInput),
    type: "textarea",
    rows: (8),
    placeholder: "在此粘贴要编译为知识库页面的文本内容…",
    resize: "none",
}));
const __VLS_126 = __VLS_125({
    modelValue: (__VLS_ctx.textInput),
    type: "textarea",
    rows: (8),
    placeholder: "在此粘贴要编译为知识库页面的文本内容…",
    resize: "none",
}, ...__VLS_functionalComponentArgsRest(__VLS_125));
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "input-hint" },
});
var __VLS_123;
const __VLS_128 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_129 = __VLS_asFunctionalComponent(__VLS_128, new __VLS_128({
    label: "浏览器书签",
    name: "bookmarks",
}));
const __VLS_130 = __VLS_129({
    label: "浏览器书签",
    name: "bookmarks",
}, ...__VLS_functionalComponentArgsRest(__VLS_129));
__VLS_131.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "bookmark-upload" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "input-hint" },
});
const __VLS_132 = {}.ElUpload;
/** @type {[typeof __VLS_components.ElUpload, typeof __VLS_components.elUpload, typeof __VLS_components.ElUpload, typeof __VLS_components.elUpload, ]} */ ;
// @ts-ignore
const __VLS_133 = __VLS_asFunctionalComponent(__VLS_132, new __VLS_132({
    autoUpload: (false),
    limit: (1),
    accept: ".html,.htm",
    onChange: (__VLS_ctx.handleBookmarkFile),
    showFileList: (false),
    drag: true,
}));
const __VLS_134 = __VLS_133({
    autoUpload: (false),
    limit: (1),
    accept: ".html,.htm",
    onChange: (__VLS_ctx.handleBookmarkFile),
    showFileList: (false),
    drag: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_133));
__VLS_135.slots.default;
const __VLS_136 = {}.ElIcon;
/** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
// @ts-ignore
const __VLS_137 = __VLS_asFunctionalComponent(__VLS_136, new __VLS_136({
    ...{ class: "upload-icon" },
}));
const __VLS_138 = __VLS_137({
    ...{ class: "upload-icon" },
}, ...__VLS_functionalComponentArgsRest(__VLS_137));
__VLS_139.slots.default;
const __VLS_140 = {}.UploadFilled;
/** @type {[typeof __VLS_components.UploadFilled, ]} */ ;
// @ts-ignore
const __VLS_141 = __VLS_asFunctionalComponent(__VLS_140, new __VLS_140({}));
const __VLS_142 = __VLS_141({}, ...__VLS_functionalComponentArgsRest(__VLS_141));
var __VLS_139;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-text" },
});
var __VLS_135;
if (__VLS_ctx.bookmarkResult) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "bookmark-result" },
    });
    const __VLS_144 = {}.ElAlert;
    /** @type {[typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, ]} */ ;
    // @ts-ignore
    const __VLS_145 = __VLS_asFunctionalComponent(__VLS_144, new __VLS_144({
        title: (`已解析 ${__VLS_ctx.bookmarkResult.totalBookmarks} 条书签（${__VLS_ctx.bookmarkResult.totalFolders} 个文件夹）`),
        type: "success",
        closable: (false),
        showIcon: true,
    }));
    const __VLS_146 = __VLS_145({
        title: (`已解析 ${__VLS_ctx.bookmarkResult.totalBookmarks} 条书签（${__VLS_ctx.bookmarkResult.totalFolders} 个文件夹）`),
        type: "success",
        closable: (false),
        showIcon: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_145));
    const __VLS_148 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_149 = __VLS_asFunctionalComponent(__VLS_148, new __VLS_148({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.bookmarkCompiling),
        ...{ style: {} },
    }));
    const __VLS_150 = __VLS_149({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.bookmarkCompiling),
        ...{ style: {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_149));
    let __VLS_152;
    let __VLS_153;
    let __VLS_154;
    const __VLS_155 = {
        onClick: (__VLS_ctx.compileBookmarks)
    };
    __VLS_151.slots.default;
    var __VLS_151;
}
var __VLS_131;
const __VLS_156 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_157 = __VLS_asFunctionalComponent(__VLS_156, new __VLS_156({
    label: "QQ 聊天记录",
    name: "qq",
}));
const __VLS_158 = __VLS_157({
    label: "QQ 聊天记录",
    name: "qq",
}, ...__VLS_functionalComponentArgsRest(__VLS_157));
__VLS_159.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "qq-flow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "qq-step" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "qq-step-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "qq-step-no" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "qq-step-title" },
});
const __VLS_160 = {}.ElUpload;
/** @type {[typeof __VLS_components.ElUpload, typeof __VLS_components.elUpload, typeof __VLS_components.ElUpload, typeof __VLS_components.elUpload, ]} */ ;
// @ts-ignore
const __VLS_161 = __VLS_asFunctionalComponent(__VLS_160, new __VLS_160({
    drag: true,
    autoUpload: (false),
    limit: (1),
    onChange: (__VLS_ctx.handleQqFileChange),
    onRemove: (__VLS_ctx.handleQqFileRemove),
    beforeUpload: (() => false),
    accept: ".txt,.json,.html,.htm,.xlsx",
    disabled: (__VLS_ctx.qqStage === 'uploading' || __VLS_ctx.qqStage === 'extracting'),
}));
const __VLS_162 = __VLS_161({
    drag: true,
    autoUpload: (false),
    limit: (1),
    onChange: (__VLS_ctx.handleQqFileChange),
    onRemove: (__VLS_ctx.handleQqFileRemove),
    beforeUpload: (() => false),
    accept: ".txt,.json,.html,.htm,.xlsx",
    disabled: (__VLS_ctx.qqStage === 'uploading' || __VLS_ctx.qqStage === 'extracting'),
}, ...__VLS_functionalComponentArgsRest(__VLS_161));
__VLS_163.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-inner" },
});
const __VLS_164 = {}.ElIcon;
/** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
// @ts-ignore
const __VLS_165 = __VLS_asFunctionalComponent(__VLS_164, new __VLS_164({
    ...{ class: "upload-icon" },
}));
const __VLS_166 = __VLS_165({
    ...{ class: "upload-icon" },
}, ...__VLS_functionalComponentArgsRest(__VLS_165));
__VLS_167.slots.default;
const __VLS_168 = {}.ArrowDown;
/** @type {[typeof __VLS_components.ArrowDown, ]} */ ;
// @ts-ignore
const __VLS_169 = __VLS_asFunctionalComponent(__VLS_168, new __VLS_168({}));
const __VLS_170 = __VLS_169({}, ...__VLS_functionalComponentArgsRest(__VLS_169));
var __VLS_167;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "upload-hint" },
});
var __VLS_163;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "qq-action-row" },
});
const __VLS_172 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_173 = __VLS_asFunctionalComponent(__VLS_172, new __VLS_172({
    ...{ 'onClick': {} },
    type: "primary",
    disabled: (!__VLS_ctx.qqFile || __VLS_ctx.qqStage === 'uploading' || __VLS_ctx.qqStage === 'extracting'),
    loading: (__VLS_ctx.qqStage === 'uploading'),
}));
const __VLS_174 = __VLS_173({
    ...{ 'onClick': {} },
    type: "primary",
    disabled: (!__VLS_ctx.qqFile || __VLS_ctx.qqStage === 'uploading' || __VLS_ctx.qqStage === 'extracting'),
    loading: (__VLS_ctx.qqStage === 'uploading'),
}, ...__VLS_functionalComponentArgsRest(__VLS_173));
let __VLS_176;
let __VLS_177;
let __VLS_178;
const __VLS_179 = {
    onClick: (__VLS_ctx.uploadQqFile)
};
__VLS_175.slots.default;
var __VLS_175;
if (__VLS_ctx.qqStage === 'uploading') {
    const __VLS_180 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_181 = __VLS_asFunctionalComponent(__VLS_180, new __VLS_180({
        ...{ 'onClick': {} },
        size: "small",
        type: "danger",
        text: true,
    }));
    const __VLS_182 = __VLS_181({
        ...{ 'onClick': {} },
        size: "small",
        type: "danger",
        text: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_181));
    let __VLS_184;
    let __VLS_185;
    let __VLS_186;
    const __VLS_187 = {
        onClick: (__VLS_ctx.abortQqFlow)
    };
    __VLS_183.slots.default;
    var __VLS_183;
}
if (__VLS_ctx.qqStage === 'uploaded' || __VLS_ctx.qqStage === 'extracting' || __VLS_ctx.qqStage === 'done') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "qq-step" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "qq-step-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "qq-step-no" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "qq-step-title" },
    });
    if (__VLS_ctx.qqMeta) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "qq-meta-card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "meta-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "meta-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "meta-value" },
        });
        (__VLS_ctx.qqMeta.chatName);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "meta-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "meta-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "meta-value" },
        });
        (__VLS_ctx.qqMeta.dateRange);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "meta-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "meta-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "meta-value" },
        });
        (__VLS_ctx.qqMeta.originalCount);
        (__VLS_ctx.qqMeta.filteredCount);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "meta-hint" },
        });
        (__VLS_ctx.qqMeta.originalCount - __VLS_ctx.qqMeta.filteredCount);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "meta-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "meta-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "meta-value" },
        });
        (__VLS_ctx.qqMeta.redactedCount);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "meta-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "meta-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
            ...{ class: "meta-value mono" },
        });
        (__VLS_ctx.qqRawId);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "qq-action-row" },
    });
    const __VLS_188 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_189 = __VLS_asFunctionalComponent(__VLS_188, new __VLS_188({
        ...{ 'onClick': {} },
        type: "primary",
        disabled: (__VLS_ctx.qqStage === 'extracting' || __VLS_ctx.qqStage === 'done'),
        loading: (__VLS_ctx.qqStage === 'extracting'),
    }));
    const __VLS_190 = __VLS_189({
        ...{ 'onClick': {} },
        type: "primary",
        disabled: (__VLS_ctx.qqStage === 'extracting' || __VLS_ctx.qqStage === 'done'),
        loading: (__VLS_ctx.qqStage === 'extracting'),
    }, ...__VLS_functionalComponentArgsRest(__VLS_189));
    let __VLS_192;
    let __VLS_193;
    let __VLS_194;
    const __VLS_195 = {
        onClick: (__VLS_ctx.extractQqDrafts)
    };
    __VLS_191.slots.default;
    var __VLS_191;
    if (__VLS_ctx.qqStage === 'extracting') {
        const __VLS_196 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_197 = __VLS_asFunctionalComponent(__VLS_196, new __VLS_196({
            ...{ 'onClick': {} },
            size: "small",
            type: "danger",
            text: true,
        }));
        const __VLS_198 = __VLS_197({
            ...{ 'onClick': {} },
            size: "small",
            type: "danger",
            text: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_197));
        let __VLS_200;
        let __VLS_201;
        let __VLS_202;
        const __VLS_203 = {
            onClick: (__VLS_ctx.abortQqFlow)
        };
        __VLS_199.slots.default;
        var __VLS_199;
    }
}
if (__VLS_ctx.qqStage === 'done') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "qq-step" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "qq-step-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "qq-step-no" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "qq-step-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "qq-drafts-card" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "drafts-tip" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    (__VLS_ctx.qqDrafts.length);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
        ...{ class: "drafts-list" },
    });
    for (const [d] of __VLS_getVForSourceType((__VLS_ctx.qqDrafts))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
            key: (d.path),
            ...{ class: "drafts-item" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
            ...{ class: "drafts-path" },
        });
        (d.path);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "drafts-title" },
        });
        (d.title);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "drafts-hint" },
    });
    const __VLS_204 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_205 = __VLS_asFunctionalComponent(__VLS_204, new __VLS_204({
        ...{ 'onClick': {} },
        type: "primary",
    }));
    const __VLS_206 = __VLS_205({
        ...{ 'onClick': {} },
        type: "primary",
    }, ...__VLS_functionalComponentArgsRest(__VLS_205));
    let __VLS_208;
    let __VLS_209;
    let __VLS_210;
    const __VLS_211 = {
        onClick: (__VLS_ctx.goToDraftReview)
    };
    __VLS_207.slots.default;
    var __VLS_207;
}
if (__VLS_ctx.qqProgress && __VLS_ctx.qqStage !== 'idle') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "qq-progress" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "qq-progress-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "progress-dot" },
        ...{ class: (__VLS_ctx.qqStage) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "progress-text" },
    });
    (__VLS_ctx.qqProgress);
    const __VLS_212 = {}.ElProgress;
    /** @type {[typeof __VLS_components.ElProgress, typeof __VLS_components.elProgress, ]} */ ;
    // @ts-ignore
    const __VLS_213 = __VLS_asFunctionalComponent(__VLS_212, new __VLS_212({
        percentage: (__VLS_ctx.qqStage === 'done' ? 100 : 0),
        indeterminate: (__VLS_ctx.qqStage === 'uploading' || __VLS_ctx.qqStage === 'extracting'),
        strokeWidth: (5),
        status: (__VLS_ctx.qqStage === 'done' ? 'success' : __VLS_ctx.qqStage === 'error' ? 'exception' : ''),
        striped: (__VLS_ctx.qqStage === 'uploading' || __VLS_ctx.qqStage === 'extracting'),
        stripedFlow: (__VLS_ctx.qqStage === 'uploading' || __VLS_ctx.qqStage === 'extracting'),
        ...{ class: "qq-progress-bar" },
    }));
    const __VLS_214 = __VLS_213({
        percentage: (__VLS_ctx.qqStage === 'done' ? 100 : 0),
        indeterminate: (__VLS_ctx.qqStage === 'uploading' || __VLS_ctx.qqStage === 'extracting'),
        strokeWidth: (5),
        status: (__VLS_ctx.qqStage === 'done' ? 'success' : __VLS_ctx.qqStage === 'error' ? 'exception' : ''),
        striped: (__VLS_ctx.qqStage === 'uploading' || __VLS_ctx.qqStage === 'extracting'),
        stripedFlow: (__VLS_ctx.qqStage === 'uploading' || __VLS_ctx.qqStage === 'extracting'),
        ...{ class: "qq-progress-bar" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_213));
}
var __VLS_159;
var __VLS_3;
if (__VLS_ctx.activeTab !== 'qq' && __VLS_ctx.activeTab !== 'url') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "submit-bar" },
    });
    const __VLS_216 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_217 = __VLS_asFunctionalComponent(__VLS_216, new __VLS_216({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
        disabled: (!__VLS_ctx.canSubmit || __VLS_ctx.store.isCompiling || __VLS_ctx.submitting),
        loading: (__VLS_ctx.store.isCompiling),
    }));
    const __VLS_218 = __VLS_217({
        ...{ 'onClick': {} },
        type: "primary",
        size: "large",
        disabled: (!__VLS_ctx.canSubmit || __VLS_ctx.store.isCompiling || __VLS_ctx.submitting),
        loading: (__VLS_ctx.store.isCompiling),
    }, ...__VLS_functionalComponentArgsRest(__VLS_217));
    let __VLS_220;
    let __VLS_221;
    let __VLS_222;
    const __VLS_223 = {
        onClick: (__VLS_ctx.handleSubmit)
    };
    __VLS_219.slots.default;
    (__VLS_ctx.store.isCompiling ? '编译中...' : '开始编译');
    var __VLS_219;
    const __VLS_224 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_225 = __VLS_asFunctionalComponent(__VLS_224, new __VLS_224({
        ...{ 'onClick': {} },
        size: "large",
    }));
    const __VLS_226 = __VLS_225({
        ...{ 'onClick': {} },
        size: "large",
    }, ...__VLS_functionalComponentArgsRest(__VLS_225));
    let __VLS_228;
    let __VLS_229;
    let __VLS_230;
    const __VLS_231 = {
        onClick: (__VLS_ctx.resetInputs)
    };
    __VLS_227.slots.default;
    var __VLS_227;
}
/** @type {__VLS_StyleScopedClasses['ingest-page']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-section']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-orb']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-right']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['ingest-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['ingest-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-inner']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-text']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['folder-dropzone']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-text']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['folder-files']} */ ;
/** @type {__VLS_StyleScopedClasses['folder-files-head']} */ ;
/** @type {__VLS_StyleScopedClasses['folder-files-title']} */ ;
/** @type {__VLS_StyleScopedClasses['folder-files-list']} */ ;
/** @type {__VLS_StyleScopedClasses['folder-file-item']} */ ;
/** @type {__VLS_StyleScopedClasses['folder-file-name']} */ ;
/** @type {__VLS_StyleScopedClasses['url-flow']} */ ;
/** @type {__VLS_StyleScopedClasses['url-tip-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['url-tip-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['url-tip-text']} */ ;
/** @type {__VLS_StyleScopedClasses['url-step']} */ ;
/** @type {__VLS_StyleScopedClasses['url-step-head']} */ ;
/** @type {__VLS_StyleScopedClasses['url-step-no']} */ ;
/** @type {__VLS_StyleScopedClasses['url-step-title']} */ ;
/** @type {__VLS_StyleScopedClasses['url-params-row']} */ ;
/** @type {__VLS_StyleScopedClasses['url-param-item']} */ ;
/** @type {__VLS_StyleScopedClasses['url-param-label']} */ ;
/** @type {__VLS_StyleScopedClasses['url-param-item']} */ ;
/** @type {__VLS_StyleScopedClasses['url-param-label']} */ ;
/** @type {__VLS_StyleScopedClasses['url-action-row']} */ ;
/** @type {__VLS_StyleScopedClasses['url-step']} */ ;
/** @type {__VLS_StyleScopedClasses['url-step-head']} */ ;
/** @type {__VLS_StyleScopedClasses['url-step-no']} */ ;
/** @type {__VLS_StyleScopedClasses['url-step-title']} */ ;
/** @type {__VLS_StyleScopedClasses['url-meta-card']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-label']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-value']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-label']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-value']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-label']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-value']} */ ;
/** @type {__VLS_StyleScopedClasses['url-pages-card']} */ ;
/** @type {__VLS_StyleScopedClasses['url-pages-head']} */ ;
/** @type {__VLS_StyleScopedClasses['url-pages-title']} */ ;
/** @type {__VLS_StyleScopedClasses['url-pages-list']} */ ;
/** @type {__VLS_StyleScopedClasses['url-page-item']} */ ;
/** @type {__VLS_StyleScopedClasses['url-page-depth']} */ ;
/** @type {__VLS_StyleScopedClasses['url-page-title']} */ ;
/** @type {__VLS_StyleScopedClasses['url-page-stats']} */ ;
/** @type {__VLS_StyleScopedClasses['url-attachments-card']} */ ;
/** @type {__VLS_StyleScopedClasses['url-attachments-title']} */ ;
/** @type {__VLS_StyleScopedClasses['url-att-group']} */ ;
/** @type {__VLS_StyleScopedClasses['url-att-group-title']} */ ;
/** @type {__VLS_StyleScopedClasses['url-att-group-count']} */ ;
/** @type {__VLS_StyleScopedClasses['url-attachments-list']} */ ;
/** @type {__VLS_StyleScopedClasses['url-attachment-item']} */ ;
/** @type {__VLS_StyleScopedClasses['url-att-type']} */ ;
/** @type {__VLS_StyleScopedClasses['url-att-url']} */ ;
/** @type {__VLS_StyleScopedClasses['url-action-row']} */ ;
/** @type {__VLS_StyleScopedClasses['url-progress']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-progress-head']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-text']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-progress-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['input-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['bookmark-upload']} */ ;
/** @type {__VLS_StyleScopedClasses['input-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-text']} */ ;
/** @type {__VLS_StyleScopedClasses['bookmark-result']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-flow']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-step']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-step-head']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-step-no']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-step-title']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-inner']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-text']} */ ;
/** @type {__VLS_StyleScopedClasses['upload-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-action-row']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-step']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-step-head']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-step-no']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-step-title']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-meta-card']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-label']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-value']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-label']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-value']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-label']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-value']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-label']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-value']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-row']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-label']} */ ;
/** @type {__VLS_StyleScopedClasses['meta-value']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-action-row']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-step']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-step-head']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-step-no']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-step-title']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-drafts-card']} */ ;
/** @type {__VLS_StyleScopedClasses['drafts-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['drafts-list']} */ ;
/** @type {__VLS_StyleScopedClasses['drafts-item']} */ ;
/** @type {__VLS_StyleScopedClasses['drafts-path']} */ ;
/** @type {__VLS_StyleScopedClasses['drafts-title']} */ ;
/** @type {__VLS_StyleScopedClasses['drafts-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-progress']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-progress-head']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['progress-text']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-progress-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['submit-bar']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            ArrowDown: ArrowDown,
            FolderOpened: FolderOpened,
            UploadFilled: UploadFilled,
            store: store,
            activeTab: activeTab,
            urlInput: urlInput,
            textInput: textInput,
            bookmarkResult: bookmarkResult,
            bookmarkCompiling: bookmarkCompiling,
            folderFiles: folderFiles,
            qqFile: qqFile,
            qqStage: qqStage,
            qqProgress: qqProgress,
            qqRawId: qqRawId,
            qqMeta: qqMeta,
            qqDrafts: qqDrafts,
            MAX_BATCH_SIZE: MAX_BATCH_SIZE,
            MAX_FILE_SIZE_MB: MAX_FILE_SIZE_MB,
            canSubmit: canSubmit,
            allowedExtsText: allowedExtsText,
            allowedExtsAccept: allowedExtsAccept,
            handleFileChange: handleFileChange,
            handleFileRemove: handleFileRemove,
            disableAutoUpload: disableAutoUpload,
            folderInputRef: folderInputRef,
            triggerFolderPick: triggerFolderPick,
            handleFolderChange: handleFolderChange,
            removeFolderFile: removeFolderFile,
            clearFolderFiles: clearFolderFiles,
            submitting: submitting,
            handleSubmit: handleSubmit,
            resetInputs: resetInputs,
            handleQqFileChange: handleQqFileChange,
            handleQqFileRemove: handleQqFileRemove,
            uploadQqFile: uploadQqFile,
            extractQqDrafts: extractQqDrafts,
            abortQqFlow: abortQqFlow,
            goToDraftReview: goToDraftReview,
            urlStage: urlStage,
            urlProgress: urlProgress,
            urlCrawlResult: urlCrawlResult,
            groupedAttachments: groupedAttachments,
            attachmentGroupLabels: attachmentGroupLabels,
            formatElapsed: formatElapsed,
            urlCombinedMarkdown: urlCombinedMarkdown,
            selectedPageUrls: selectedPageUrls,
            selectedPageCount: selectedPageCount,
            isAllPagesSelected: isAllPagesSelected,
            togglePageSelection: togglePageSelection,
            toggleAllPages: toggleAllPages,
            urlMaxPages: urlMaxPages,
            urlMaxHops: urlMaxHops,
            startUrlCrawl: startUrlCrawl,
            handleBookmarkFile: handleBookmarkFile,
            compileBookmarks: compileBookmarks,
            startUrlCompile: startUrlCompile,
            abortUrlCrawl: abortUrlCrawl,
            resetUrlFlow: resetUrlFlow,
            handleUrlInputChange: handleUrlInputChange,
        };
    },
    __typeEmits: {},
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
    __typeEmits: {},
});
; /* PartiallyEnd: #4569/main.vue */
