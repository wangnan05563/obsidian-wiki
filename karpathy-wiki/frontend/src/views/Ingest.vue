<script setup lang="ts">
import { API_BASE, apiFetch } from '../utils/apiBase';
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import type { UploadFile } from 'element-plus';
import { ArrowDown, FolderOpened, UploadFilled, WarningFilled } from '@element-plus/icons-vue';
import { useCompileStore } from '../stores/compile';
import { consumeSSE } from '../utils/sse';
import type { ConfigData, QqUploadEvent, DraftCompileEvent, UrlCrawlEvent, UrlCrawlPageSummary, UrlCrawlAttachment } from '../types';

// 使用函数类型写法替代类型字面量（S6598）
const emit = defineEmits<(e: 'start') => void>();

const store = useCompileStore();

const activeTab = ref<'file' | 'folder' | 'url' | 'text' | 'bookmarks' | 'qq' | 'capture'>('file');
const urlInput = ref('');
const textInput = ref('');

// FR-16-2 书签导入状态
interface BookmarkParseResult {
  ok: boolean;
  totalBookmarks: number;
  totalFolders: number;
  combinedMarkdown: string;
  rawPath: string;
}
const bookmarkResult = ref<BookmarkParseResult | null>(null);
const bookmarkCompiling = ref(false);
const selectedFile = ref<File | null>(null);

// ===================== A1 网页捕获（书签捕获）=====================
// 解决被站点 WAF/出口 IP 黑名单拦截的页面（服务端 fetch 永远 420/黑名单页）：
//   由用户本机浏览器访问目标页（走用户受信网络），bookmarklet 把页面 outerHTML 经
//   window.open(同名窗口) + postMessage 跨域发回本页，再调 /api/ingest/raw-html 提取正文。
//   注：不能走 BroadcastChannel（仅同源），书签在目标站域名下、捕获页在知识库域名下，必须跨域传输。
interface CapturedPayload {
  html?: string;
  title?: string;
  url?: string;
}
interface CapturedResult {
  title: string;
  url: string;
  contentLength: number;
  markdown: string;
}
const captured = ref<CapturedResult | null>(null);
const captureLoading = ref(false);
const captureError = ref('');

// 可拖拽到书签栏的 bookmarklet：抓取当前页 outerHTML，经 window.open(同名窗口) 跨域 postMessage 发回知识库「网页捕获」页。
// 为什么不用 BroadcastChannel：BroadcastChannel 仅同源可用，而书签运行在目标站点（如 shcpe.com.cn）、
//   捕获页在知识库域名下，二者不同源 → BroadcastChannel 收不到。改用 window.open('','窗口名') 取得捕获页窗口引用
//   （跨域也能拿到 WindowProxy），再用 postMessage 发送（postMessage 不受同源限制）。捕获页 onMounted 时
//   设置 window.name='karpathy_capture_win' 并监听 window message，二者即可跨域对接。
const bookmarkletCode = `javascript:(function(){try{var d=document.documentElement.outerHTML;var w=window.open('','karpathy_capture_win');if(!w){alert('请先在知识库打开「网页捕获」页面');return;}w.postMessage({type:'WIKI_CAPTURE',html:d,title:document.title,url:location.href},'*');alert('已捕获：'+document.title+'\\n请回到知识库「网页捕获」页点「编译投递」');}catch(e){alert('捕获失败：'+e.message);}})();`;

function onWindowMessage(e: MessageEvent) {
  if (e.data && e.data.type === 'WIKI_CAPTURE') onCaptureMessage(e.data);
}
function setupCaptureListener() {
  // 设置窗口名，供 bookmarklet 经 window.open('', name) 跨域定位本窗口并 postMessage
  try { window.name = 'karpathy_capture_win'; } catch { /* ignore */ }
  window.addEventListener('message', onWindowMessage);
}
function teardownCaptureListener() {
  window.removeEventListener('message', onWindowMessage);
}
function onCaptureMessage(payload: CapturedPayload) {
  if (!payload || typeof payload.html !== 'string' || !payload.html.trim()) return;
  void handleCaptureMessage(payload);
}

async function handleCaptureMessage(payload: CapturedPayload) {
  captureLoading.value = true;
  captureError.value = '';
  try {
    const res = await apiFetch(`${API_BASE}/ingest/raw-html`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: payload.html, url: payload.url ?? '', title: payload.title ?? '' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    captured.value = {
      title: data.title,
      url: data.sourceUrl ?? '',
      contentLength: data.contentLength ?? 0,
      markdown: data.combinedMarkdown ?? '',
    };
    ElMessage.success(`已捕获并解析：${data.title}`);
  } catch (e) {
    captureError.value = (e as Error).message;
    ElMessage.error('捕获解析失败：' + (e as Error).message);
  } finally {
    captureLoading.value = false;
  }
}

function compileCaptured() {
  if (!captured.value || !captured.value.markdown) return;
  if (store.isCompiling || submitting.value) return;
  store.prepareCompile({ type: 'text', content: captured.value.markdown });
  emit('start');
}

async function copyBookmarklet() {
  try {
    await navigator.clipboard.writeText(bookmarkletCode);
    ElMessage.success('书签代码已复制到剪贴板');
  } catch {
    ElMessage.warning('复制失败，请手动选中书签代码复制');
  }
}
// 文件夹模式：扫描得到的有效文件列表
const folderFiles = ref<Array<{ name: string; file: File }>>([]);

// ===== QQ 上传状态 =====
// QQ 流程独立于 compile store：upload → extract 是两段 SSE，不走 /api/compile
const qqFile = ref<File | null>(null);
// 上传/抽取阶段：'idle' | 'uploading' | 'uploaded' | 'extracting' | 'done' | 'error'
type QqStage = 'idle' | 'uploading' | 'uploaded' | 'extracting' | 'done' | 'error';
const qqStage = ref<QqStage>('idle');
const qqProgress = ref<string>('');
// 上传完成后的 rawId 与预清洗统计
const qqRawId = ref<string>('');
const qqMeta = ref<{
  chatName: string;
  dateRange: string;
  originalCount: number;
  filteredCount: number;
  redactedCount: number;
} | null>(null);
// 抽取阶段产生的 draft 列表（page 事件收集）
const qqDrafts = ref<Array<{ path: string; title: string }>>([]);
let qqAbortController: AbortController | null = null;

// 批量编译限制：从后端 GET /api/config 动态获取，替代硬编码值
// 为什么需要动态获取：用户在配置中心调整 maxBatchSize/maxFileSizeMb/allowedExtensions 后，
//   前端校验必须同步生效，否则会出现"配置 200 但前端截断到 20"的不一致问题
// 为什么保留默认值：后端不可用时降级到本地默认值，不阻断主流程（fallback-rule）
const ALLOWED_EXTS = ref<Set<string>>(new Set(['md', 'txt', 'pdf', 'html', 'json', 'docx', 'xlsx', 'pptx', 'doc', 'xls']));
const MAX_BATCH_SIZE = ref<number>(50);
const MAX_FILE_SIZE_MB = ref<number>(10);

// 从后端加载 batch 配置，更新前端校验限制
// 为什么在 Ingest 页面独立加载：Config.vue 的配置变更需即时反映到 Ingest 页面，
//   每次进入页面都重新拉取最新配置，避免使用 stale 缓存值
async function loadBatchConfig(): Promise<void> {
  try {
    const res = await apiFetch(`${API_BASE}/config`);
    if (!res.ok) return;
    const cfg: ConfigData = await res.json();
    if (cfg.batch) {
      // 统一小写以匹配文件扩展名判断
      ALLOWED_EXTS.value = new Set(cfg.batch.allowedExtensions.map(e => e.toLowerCase()));
      MAX_BATCH_SIZE.value = cfg.batch.maxBatchSize;
      MAX_FILE_SIZE_MB.value = cfg.batch.maxFileSizeMb;
    }
  } catch {
    // 后端不可用时保留默认值，不阻断投递流程（fallback-rule）
  }
}

onMounted(() => {
  loadBatchConfig();
  setupCaptureListener();
});

onUnmounted(() => {
  teardownCaptureListener();
});

// canSubmit 仅覆盖共用 submit-bar 的 file/folder/text 三种模式
// URL 模式独立两段式流程（爬取 → 编译），由独立按钮触发，不参与 canSubmit 判断
const canSubmit = computed(() => {
  if (activeTab.value === 'file') return !!selectedFile.value;
  if (activeTab.value === 'folder') return folderFiles.value.length > 0;
  return textInput.value.trim().length > 0;
});

// 扩展名白名单的显示文本：从 Set 动态生成，避免模板中硬编码扩展名列表
const allowedExtsText = computed(() => [...ALLOWED_EXTS.value].join(' / '));
// el-upload accept 属性格式：.md,.txt,.pdf,.html,.json,.docx,.xlsx,.pptx,.doc,.xls
const allowedExtsAccept = computed(() => [...ALLOWED_EXTS.value].map(e => `.${e}`).join(','));

function handleFileChange(file: UploadFile) {
  selectedFile.value = file.raw ?? null;
}

function handleFileRemove() {
  selectedFile.value = null;
}

function disableAutoUpload(): boolean {
  return false;
}

// 文件夹选取：通过隐藏 input[type=file][webkitdirectory] 触发
// 浏览器把文件夹下所有文件（含子目录）平铺返回，前端按白名单过滤
const folderInputRef = ref<HTMLInputElement | null>(null);

function triggerFolderPick() {
  folderInputRef.value?.click();
}

function handleFolderChange(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files || input.files.length === 0) return;
  const valid: Array<{ name: string; file: File }> = [];
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
  } else {
    folderFiles.value = valid;
  }
  if (valid.length === 0) {
    ElMessage.warning(`所选文件夹中没有符合白名单（${[...ALLOWED_EXTS.value].join('/')}）的文件`);
  } else if (rejectedCount > 0 || oversizedCount > 0) {
    const parts: string[] = [];
    if (rejectedCount > 0) parts.push(`${rejectedCount} 个不符白名单`);
    if (oversizedCount > 0) parts.push(`${oversizedCount} 个超过 ${MAX_FILE_SIZE_MB.value}MB`);
    ElMessage.info(`已跳过 ${parts.join('、')}`);
  }
  // 清空 input value 以便再次选取同一文件夹能触发 change
  input.value = '';
}

function removeFolderFile(idx: number) {
  folderFiles.value.splice(idx, 1);
}

function clearFolderFiles() {
  folderFiles.value = [];
}

function buildPayload(): FormData | { type: 'text'; content: string } | null {
  if (activeTab.value === 'file') {
    if (!selectedFile.value) return null;
    const fd = new FormData();
    fd.append('file', selectedFile.value);
    return fd;
  }
  if (activeTab.value === 'folder') {
    if (folderFiles.value.length === 0) return null;
    const fd = new FormData();
    // 字段名统一为 files（复数），后端按此名收集
    for (const item of folderFiles.value) {
      fd.append('files', item.file, item.name);
    }
    return fd;
  }
  // URL 模式不走 buildPayload：两段式流程由 startUrlCrawl/startUrlCompile 独立处理
  const content = textInput.value.trim();
  if (!content) return null;
  return { type: 'text', content };
}

// 防重复提交：store.isCompiling 是跨组件状态，本地的 submitting 防止同 tick 内重复触发
const submitting = ref(false);

function handleSubmit() {
  if (submitting.value || store.isCompiling) return;
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
    } else {
      store.prepareCompile(payload);
    }
    emit('start');
  } finally {
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

function handleQqFileChange(file: UploadFile) {
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
    const res = await apiFetch(`${API_BASE}/qq-ingest/upload`, {
      method: 'POST',
      body: fd,
      signal: qqAbortController.signal,
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    await consumeSSE(res, handleUploadEvent, qqAbortController.signal);
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      qqStage.value = 'idle';
      qqProgress.value = '已取消';
      return;
    }
    qqStage.value = 'error';
    ElMessage.error('QQ 文件上传失败：' + (err as Error).message);
  } finally {
    qqAbortController = null;
  }
}

// upload SSE 事件处理：progress/done/error
function handleUploadEvent(eventType: string, data: QqUploadEvent) {
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
      ElMessage.success(
        `预清洗完成：${data.data.meta.originalCount} → ${data.data.meta.filteredCount} 条，脱敏 ${data.data.meta.redactedCount} 条`,
      );
    } else {
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
    const res = await apiFetch(`${API_BASE}/qq-ingest/extract/${qqRawId.value}`,
      { method: 'POST', signal: qqAbortController.signal },
    );
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    await consumeSSE(res, handleExtractEvent, qqAbortController.signal);
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // 中止后回到 uploaded 状态，允许重新触发抽取
      qqStage.value = 'uploaded';
      qqProgress.value = '已取消，可重新抽取';
      return;
    }
    qqStage.value = 'error';
    ElMessage.error('LLM 抽取失败：' + (err as Error).message);
  } finally {
    qqAbortController = null;
  }
}

// extract SSE 事件处理：progress/page/done/error
// 复用 DraftCompileEvent 类型（字段结构与后端 ProgressEvent 对齐）
function handleExtractEvent(eventType: string, data: DraftCompileEvent) {
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

// ============================================================
// URL 爬取两段式流程
// 阶段 1：crawl（BFS 爬取）→ 阶段 2：compile（用 combinedMarkdown 作为 text 编译）
// 为什么独立于 compile store：爬取阶段走 /api/url-ingest/crawl 路由，不复用 /api/compile
// 编译阶段才复用 store.prepareCompile({ type: 'text', content: combinedMarkdown })
// ============================================================

// URL 流程阶段：idle/crawling/crawled/error（编译由 store.isCompiling 接管）
type UrlStage = 'idle' | 'crawling' | 'crawled' | 'error';
const urlStage = ref<UrlStage>('idle');
const urlProgress = ref<string>('');
// 爬取完成后的摘要信息（done 事件携带）
// 5.4.4 扩展 elapsedMs：用于在结果区域展示爬取耗时
const urlCrawlResult = ref<{
  pagesCrawled: number;
  totalAttachmentCount: number;
  pages: UrlCrawlPageSummary[];
  attachments: UrlCrawlAttachment[];
  elapsedMs?: number;
  diagnosis?: string;
  errorCount?: number;
} | null>(null);

// 5.4.2 附件按类型分组展示：document/image/audio/video/other
// 为什么用 computed 而非方法：依赖 urlCrawlResult.attachments，computed 自动响应更新
const groupedAttachments = computed(() => {
  const groups: Record<string, UrlCrawlAttachment[]> = {
    document: [],
    image: [],
    audio: [],
    video: [],
    other: [],
  };
  if (!urlCrawlResult.value?.attachments) return groups;
  for (const att of urlCrawlResult.value.attachments) {
    const key = groups[att.type] ? att.type : 'other';
    groups[key].push(att);
  }
  return groups;
});

// 附件分组中文标签
const attachmentGroupLabels: Record<string, string> = {
  document: '文档',
  image: '图片',
  audio: '音频',
  video: '视频',
  other: '其他',
};

// 格式化耗时：ms → "X.Xs" 或 "Xm Ys"
function formatElapsed(ms?: number): string {
  if (!ms || ms <= 0) return '';
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}
// done 事件返回的合并 Markdown，编译阶段直接作为 text 输入
const urlCombinedMarkdown = ref<string>('');
let urlAbortController: AbortController | null = null;

// 5.4.1 爬取预览：勾选的页面 URL 集合，默认全选
// 为什么用 Set 而非数组：勾选状态查询用 Set O(1)，数组 O(n)
const selectedPageUrls = ref<Set<string>>(new Set());
const allPageUrls = computed(() => urlCrawlResult.value?.pages.map((p) => p.url) ?? []);
const selectedPageCount = computed(() => selectedPageUrls.value.size);
const isAllPagesSelected = computed(
  () => allPageUrls.value.length > 0 && selectedPageUrls.value.size === allPageUrls.value.length,
);

function togglePageSelection(url: string) {
  const next = new Set(selectedPageUrls.value);
  if (next.has(url)) next.delete(url);
  else next.add(url);
  selectedPageUrls.value = next;
}

function toggleAllPages() {
  if (isAllPagesSelected.value) {
    selectedPageUrls.value = new Set();
  } else {
    selectedPageUrls.value = new Set(allPageUrls.value);
  }
}

// 5.1.4 maxPages/maxHops 前端可配置：默认 null 表示使用后端 config 值
// 为什么用 null 而非 0：null 在 JSON.stringify 时被忽略，0 会被后端当作"覆盖为 0"
// 上限与后端 url-ingest.ts 对齐：maxPages≤500、maxHops≤10
const urlMaxPages = ref<number | null>(null);
const urlMaxHops = ref<number | null>(null);
// B 方案：可选的 egress 代理（绕开服务器出口 IP 黑名单）。留空则使用全局代理/直连。
const urlProxy = ref('');
// B 方案：代理连通性自检结果（爬取前由后端 proxy_probe 事件推送），null 表示未探测。
const urlProxyProbe = ref<{ level: 'ok' | 'warn' | 'error'; message: string } | null>(null);

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
  urlProxyProbe.value = null;
  urlAbortController = new AbortController();

  try {
    // 5.1.4 请求级覆盖：仅在用户显式输入时携带 maxPages/maxHops
    const reqBody: { url: string; maxPages?: number; maxHops?: number; proxyUrl?: string } = { url: entryUrl };
    if (urlMaxPages.value !== null && urlMaxPages.value > 0) {
      reqBody.maxPages = Math.min(Math.floor(urlMaxPages.value), 500);
    }
    if (urlMaxHops.value !== null && urlMaxHops.value > 0) {
      reqBody.maxHops = Math.min(Math.floor(urlMaxHops.value), 10);
    }
    // B 方案：请求级 egress 代理（可选），覆盖服务端默认配置
    if (urlProxy.value.trim()) {
      reqBody.proxyUrl = urlProxy.value.trim();
    }
    const res = await apiFetch(`${API_BASE}/url-ingest/crawl`, {
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
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      urlStage.value = 'idle';
      urlProgress.value = '已取消';
      return;
    }
    urlStage.value = 'error';
    ElMessage.error('URL 爬取失败：' + (err as Error).message);
  } finally {
    urlAbortController = null;
  }
}

// SSE 事件分发：progress/page_start/page_done/page_error/page_skipped/attachment/done/error/proxy_probe
function handleUrlCrawlEvent(eventType: string, data: UrlCrawlEvent) {
  // B 方案：代理连通性自检结果（proxy_probe 事件）。显示分级状态，不阻断后续爬取事件。
  if (eventType === 'proxy_probe') {
    urlProgress.value = data.message ?? '代理探测完成';
    const pd = (data.data ?? {}) as { level?: 'ok' | 'warn' | 'error'; message?: string };
    urlProxyProbe.value = { level: pd.level ?? 'warn', message: data.message ?? '' };
    return;
  }
  // progress/page_start/page_done/page_skipped/attachment 都会更新进度文本
  if (eventType === 'progress' || eventType === 'page_start' || eventType === 'page_done' || eventType === 'page_skipped' || eventType === 'attachment') {
    urlProgress.value = data.message ?? '';
    return;
  }
  if (eventType === 'page_error') {
    // 单页失败不阻断整体，但按错误类型给出明确提示，避免"静默失败"
    const errType = (data.data as { errorType?: string })?.errorType;
    const typeLabel: Record<string, string> = {
      timeout: '超时', http: 'HTTP错误', network: '网络错误', ssrf: '安全拦截', unknown: '未知错误',
      blocked: '防火墙拦截', auth: '需登录',
    };
    const label = errType ? (typeLabel[errType] || '错误') : '错误';
    urlProgress.value = `[${label}] ${data.message ?? '页面抓取失败'}`;
    return;
  }
  if (eventType === 'done') {
    // done 事件携带汇总数据：pagesCrawled/totalAttachmentCount/combinedMarkdown/pages/attachments/elapsedMs/pagesSkipped
    //   + 错误诊断字段 errorCount/errors/diagnosis（0 页面时由后端聚合最可能是根因的提示）
    const d = data.data;
    if (d?.combinedMarkdown) {
      urlCombinedMarkdown.value = d.combinedMarkdown;
      urlCrawlResult.value = {
        pagesCrawled: d.pagesCrawled ?? 0,
        totalAttachmentCount: d.totalAttachmentCount ?? 0,
        pages: d.pages ?? [],
        attachments: d.attachments ?? [],
        elapsedMs: d.elapsedMs,
        // 代理探测结论（后端并入 done.diagnosis，形如「【代理探测】…」）随结果一并展示，便于事后回溯
        diagnosis: d.diagnosis,
      };
      // 5.4.1 爬取预览：初始化勾选集合为全选
      selectedPageUrls.value = new Set((d.pages ?? []).map((p) => p.url));
      urlStage.value = 'crawled';
      // 5.4.4 耗时显示 + 5.1.3 跳过页面数
      const elapsedStr = formatElapsed(d.elapsedMs);
      const skippedStr = d.pagesSkipped && d.pagesSkipped > 0 ? `，跳过 ${d.pagesSkipped} 个未变更` : '';

      // 0 页面但有错误 → 明确诊断，不再静默显示 0
      if ((d.pagesCrawled ?? 0) === 0 && (d.errorCount ?? 0) > 0) {
        const diag = d.diagnosis || '所有页面抓取失败，请查看后端日志';
        urlProgress.value = `爬取失败（0 个页面）：${diag}`;
        ElMessage.error(`爬取失败：${diag}`);
        urlCrawlResult.value = { ...urlCrawlResult.value, diagnosis: diag, errorCount: d.errorCount };
        return;
      }

      urlProgress.value = `爬取完成：${d.pagesCrawled ?? 0} 个页面，${d.totalAttachmentCount ?? 0} 个附件${skippedStr}${elapsedStr ? `，耗时 ${elapsedStr}` : ''}`;
      const errNote = (d.errorCount ?? 0) > 0 ? `（${d.errorCount} 个页面失败，已跳过）` : '';
      ElMessage.success(`爬取完成：共 ${d.pagesCrawled ?? 0} 个页面，${d.totalAttachmentCount ?? 0} 个附件${errNote}${skippedStr}${elapsedStr ? `，耗时 ${elapsedStr}` : ''}`);
    } else {
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
async function handleBookmarkFile(file: UploadFile) {
  bookmarkResult.value = null;
  const raw = file.raw;
  if (!raw) return;

  const formData = new FormData();
  formData.append('file', raw);

  try {
    const res = await apiFetch(`${API_BASE}/ingest/bookmarks`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json() as BookmarkParseResult;
    bookmarkResult.value = data;
    ElMessage.success(`已解析 ${data.totalBookmarks} 条书签`);
  } catch (err) {
    ElMessage.error('书签解析失败：' + (err as Error).message);
  }
}

async function compileBookmarks() {
  if (!bookmarkResult.value) return;
  if (store.isCompiling || bookmarkCompiling.value) return;

  bookmarkCompiling.value = true;
  try {
    // 复用 compile store 的 text 模式：将书签 Markdown 作为文本编译
    store.prepareCompile({
      type: 'text',
      content: bookmarkResult.value.combinedMarkdown,
    });
    emit('start');
  } finally {
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
  if (store.isCompiling || submitting.value) return;
  // 5.4.1 基于勾选状态拼接 markdown
  // 为什么不直接用 combinedMarkdown：用户可能取消勾选部分页面，需重新拼接
  const selectedPages = urlCrawlResult.value.pages.filter((p) => selectedPageUrls.value.has(p.url));
  const markdownParts: string[] = [];
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
  } finally {
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
</script>

<template>
  <div class="ingest-page">
    <!-- 不对称英雄区：机器人偏左，标题偏右 -->
    <div class="hero-section fade-up">
      <div class="hero-orb"></div>
      <div class="hero-right">
        <h2 class="hero-title grad-text">投递第一篇资料</h2>
        <p class="hero-tip">
          上传文件、粘贴 URL 或直接贴文本，机器人会按 SCHEMA 编译为知识库页面
        </p>
      </div>
    </div>
      <div class="glass-card ingest-card fade-up" style="animation-delay: 0.2s">
      <div class="card-deco"></div>
      <el-tabs v-model="activeTab" class="ingest-tabs">
        <el-tab-pane label="文件上传" name="file">
          <el-upload
            drag
            :auto-upload="false"
            :limit="1"
            :on-change="handleFileChange"
            :on-remove="handleFileRemove"
            :before-upload="disableAutoUpload"
            :accept="allowedExtsAccept"
          >
            <div class="upload-inner">
              <el-icon class="upload-icon"><ArrowDown /></el-icon>
      <div class="upload-text">将文件拖到此处，或点击上传</div>
      <div class="upload-hint">SUPPORT: {{ allowedExtsText }}</div>
            </div>
          </el-upload>
        </el-tab-pane>

        <el-tab-pane label="文件夹上传" name="folder">
          <!-- 隐藏 input：webkitdirectory 让浏览器调起文件夹选择器 -->
          <input
            ref="folderInputRef"
            type="file"
            webkitdirectory
            directory
            multiple
            style="display: none"
            @change="handleFolderChange"
          />
          <div class="folder-dropzone" @click="triggerFolderPick">
            <el-icon class="upload-icon"><FolderOpened /></el-icon>
            <div class="upload-text">点击选取文件夹</div>
            <div class="upload-hint">
              将扫描子目录下所有 {{ allowedExtsText }} 文件（上限 {{ MAX_BATCH_SIZE }} 个，单文件 ≤ {{ MAX_FILE_SIZE_MB }}MB）
            </div>
          </div>
          <!-- 已选文件列表 -->
          <div v-if="folderFiles.length > 0" class="folder-files">
            <div class="folder-files-head">
              <span class="folder-files-title">
                已选 {{ folderFiles.length }} 个文件
              </span>
              <el-button size="small" text @click="clearFolderFiles">清空</el-button>
            </div>
            <ul class="folder-files-list">
              <li v-for="(item, idx) in folderFiles" :key="idx" class="folder-file-item">
                <code class="folder-file-name">{{ item.name }}</code>
                <el-button
                  size="small"
                  text
                  type="danger"
                  @click="removeFolderFile(idx)"
                >
                  ×
                </el-button>
              </li>
            </ul>
          </div>
        </el-tab-pane>

        <el-tab-pane label="URL 粘贴" name="url">
          <div class="url-flow">
            <!-- 显著提示文本：用户操作前必须看到的功能特性与限制 -->
            <div class="url-tip-banner">
              <span class="url-tip-icon">i</span>
              <p class="url-tip-text">
                系统将从入口网页开始，自动查询同级路径或子路径下、最多三次跳转内的页面内容
              </p>
            </div>

            <!-- 步骤 1：输入入口 URL 并爬取 -->
            <div class="url-step">
              <div class="url-step-head">
                <span class="url-step-no">1</span>
                <span class="url-step-title">输入入口 URL 并爬取</span>
              </div>
              <el-input
                v-model="urlInput"
                placeholder="http://www.example.com/content/index.html"
                clearable
                size="large"
                :disabled="urlStage === 'crawling'"
                @input="handleUrlInputChange"
              >
                <template #prepend>URI</template>
              </el-input>
              <!-- 5.1.4 高级参数：留空则使用后端 config 默认值（maxPages=50、maxHops=3） -->
              <div class="url-params-row">
                <div class="url-param-item">
                  <label class="url-param-label">最大页数</label>
                  <el-input-number
                    v-model="urlMaxPages"
                    :min="1"
                    :max="500"
                    :step="10"
                    size="small"
                    controls-position="right"
                    placeholder="默认 50"
                    :disabled="urlStage === 'crawling'"
                  />
                </div>
                <div class="url-param-item">
                  <label class="url-param-label">最大跳数</label>
                  <el-input-number
                    v-model="urlMaxHops"
                    :min="1"
                    :max="10"
                    :step="1"
                    size="small"
                    controls-position="right"
                    placeholder="默认 3"
                    :disabled="urlStage === 'crawling'"
                  />
                </div>
              </div>
              <!-- B 方案：自定义 egress 代理（可选）。配置后爬取请求经该代理 egress，绕开服务器出口 IP 黑名单 -->
              <div class="url-params-row" style="margin-top: 8px;">
                <div class="url-param-item" style="flex: 1 1 100%;">
                  <label class="url-param-label">出口代理（可选）</label>
                  <el-input
                    v-model="urlProxy"
                    placeholder="http://127.0.0.1:7890 或 https://user:pass@proxy.example.com:443"
                    clearable
                    size="small"
                    :disabled="urlStage === 'crawling'"
                  />
                  <p class="url-proxy-hint">仅支持 http/https 代理。目标站点把服务器出口 IP 拉黑时，填一个未被拉黑的代理即可绕开。留空则用全局代理/直连。</p>
                  <p v-if="urlProxyProbe" class="url-proxy-probe" :class="'probe-' + urlProxyProbe.level">
                    <span class="probe-tag">{{ urlProxyProbe.level === 'ok' ? '可用' : (urlProxyProbe.level === 'error' ? '不可用' : '注意') }}</span>
                    {{ urlProxyProbe.message }}
                  </p>
                </div>
              </div>
              <div class="url-action-row">
                <el-button
                  type="primary"
                  :disabled="!urlInput.trim() || urlStage === 'crawling'"
                  :loading="urlStage === 'crawling'"
                  @click="startUrlCrawl"
                >开始爬取</el-button>
                <el-button
                  v-if="urlStage === 'crawling'"
                  size="small"
                  type="danger"
                  text
                  @click="abortUrlCrawl"
                >取消</el-button>
              </div>
            </div>

            <!-- 步骤 2：爬取结果 + 触发编译 -->
            <div v-if="urlStage === 'crawled' && urlCrawlResult" class="url-step">
              <div class="url-step-head">
                <span class="url-step-no">2</span>
                <span class="url-step-title">爬取结果</span>
              </div>
              <div class="url-meta-card">
                <div class="meta-row">
                  <span class="meta-label">页面数</span>
                  <span class="meta-value">{{ urlCrawlResult.pagesCrawled }}</span>
                </div>
                <div class="meta-row">
                  <span class="meta-label">附件数</span>
                  <span class="meta-value">{{ urlCrawlResult.totalAttachmentCount }}</span>
                </div>
                <!-- 5.4.4 耗时显示 -->
                <div v-if="urlCrawlResult.elapsedMs" class="meta-row">
                  <span class="meta-label">耗时</span>
                  <span class="meta-value">{{ formatElapsed(urlCrawlResult.elapsedMs) }}</span>
                </div>
              </div>
              <!-- 0 页面诊断横幅：明确告知失败原因，避免"静默 0 页"无法定位 -->
              <div v-if="urlCrawlResult.diagnosis" class="url-diagnosis-banner">
                <el-icon><WarningFilled /></el-icon>
                <span>{{ urlCrawlResult.diagnosis }}</span>
              </div>
              <!-- 已爬取页面列表（5.4.1 爬取预览：支持勾选式编译） -->
              <div v-if="urlCrawlResult.pages.length > 0" class="url-pages-card">
                <div class="url-pages-head">
                  <p class="url-pages-title">已爬取页面（{{ selectedPageCount }}/{{ urlCrawlResult.pages.length }}）：</p>
                  <el-button size="small" text @click="toggleAllPages">
                    {{ isAllPagesSelected ? '取消全选' : '全选' }}
                  </el-button>
                </div>
                <ul class="url-pages-list">
                  <li
                    v-for="(p, idx) in urlCrawlResult.pages"
                    :key="idx"
                    class="url-page-item"
                    :class="{ 'url-page-unchecked': !selectedPageUrls.has(p.url) }"
                  >
                    <el-checkbox
                      :model-value="selectedPageUrls.has(p.url)"
                      @change="togglePageSelection(p.url)"
                    />
                    <code class="url-page-depth">[d={{ p.depth }}]</code>
                    <span class="url-page-title">{{ p.title || p.url }}</span>
                    <span class="url-page-stats">（{{ p.contentLength }} 字符，{{ p.attachmentCount }} 附件）</span>
                  </li>
                </ul>
              </div>
              <!-- 5.4.2 附件按类型分组展示 -->
              <div v-if="urlCrawlResult.attachments.length > 0" class="url-attachments-card">
                <p class="url-attachments-title">发现的附件（按类型分组）：</p>
                <div
                  v-for="(groupArr, groupKey) in groupedAttachments"
                  :key="groupKey"
                  v-show="groupArr.length > 0"
                  class="url-att-group"
                >
                  <p class="url-att-group-title">
                    {{ attachmentGroupLabels[groupKey] || groupKey }}
                    <span class="url-att-group-count">（{{ groupArr.length }}）</span>
                  </p>
                  <ul class="url-attachments-list">
                    <li v-for="(a, idx) in groupArr" :key="`${groupKey}-${idx}`" class="url-attachment-item">
                      <code class="url-att-type">[{{ a.extension }}]</code>
                      <code class="url-att-url">{{ a.url }}</code>
                    </li>
                  </ul>
                </div>
              </div>
              <div class="url-action-row">
                <el-button
                  type="primary"
                  :disabled="!urlCombinedMarkdown || store.isCompiling || submitting || selectedPageCount === 0"
                  :loading="store.isCompiling"
                  @click="startUrlCompile"
                >开始编译（{{ selectedPageCount }}/{{ urlCrawlResult.pages.length }}）</el-button>
                <el-button @click="resetUrlFlow">重新爬取</el-button>
              </div>
            </div>

            <!-- 实时进度消息 -->
            <div v-if="urlProgress && urlStage !== 'idle'" class="url-progress">
              <div class="qq-progress-head">
                <span class="progress-dot" :class="urlStage"></span>
                <span class="progress-text">{{ urlProgress }}</span>
              </div>
              <el-progress
                :percentage="urlStage === 'crawled' ? 100 : 0"
                :indeterminate="urlStage === 'crawling'"
                :stroke-width="5"
                :status="urlStage === 'crawled' ? 'success' : urlStage === 'error' ? 'exception' : ''"
                :striped="urlStage === 'crawling'"
                :striped-flow="urlStage === 'crawling'"
                class="qq-progress-bar"
              />
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="文本粘贴" name="text">
          <el-input
            v-model="textInput"
            type="textarea"
            :rows="8"
            placeholder="在此粘贴要编译为知识库页面的文本内容…"
            resize="none"
          />
          <p class="input-hint">文本将作为原始资料直接进入提取流程</p>
        </el-tab-pane>

        <!-- FR-16-2 浏览器书签导入 -->
        <el-tab-pane label="浏览器书签" name="bookmarks">
          <div class="bookmark-upload">
            <p class="input-hint">从 Chrome/Edge/Firefox 导出书签为 HTML 文件后上传。书签将被解析为 Markdown 并存入知识库。</p>
            <el-upload
              :auto-upload="false"
              :limit="1"
              accept=".html,.htm"
              :on-change="handleBookmarkFile"
              :show-file-list="false"
              drag
            >
              <el-icon class="upload-icon"><UploadFilled /></el-icon>
              <div class="upload-text">点击或拖拽书签 HTML 文件到此区域</div>
            </el-upload>
            <div v-if="bookmarkResult" class="bookmark-result">
              <el-alert
                :title="`已解析 ${bookmarkResult.totalBookmarks} 条书签（${bookmarkResult.totalFolders} 个文件夹）`"
                type="success"
                :closable="false"
                show-icon
              />
              <el-button
                type="primary"
                :loading="bookmarkCompiling"
                @click="compileBookmarks"
                style="margin-top:12px"
              >
                开始编译
              </el-button>
            </div>
          </div>
        </el-tab-pane>

        <!-- A1 网页捕获：适用被服务器出口 IP 拉黑的站点，走用户本机浏览器抓内容回传 -->
        <el-tab-pane label="网页捕获" name="capture">
          <div class="capture-wrap">
            <p class="input-hint">
              适用于被 WAF / 出口 IP 黑名单拦截的站点（如 shcpe）：服务端抓取永远失败，
              改用你本机浏览器访问目标页（走你自己的网络），再把页面内容发回知识库。
            </p>
            <ol class="capture-steps">
              <li>把下面的「网页捕获」拖到浏览器书签栏（或右键复制链接地址）。</li>
              <li>在你的浏览器打开目标网页（需能正常访问）。</li>
              <li>点击该书签，页面内容会发回本页。</li>
              <li>回到此页，点「编译投递」即可生成知识库页面。</li>
            </ol>
            <div class="bookmarklet-row">
              <a class="bookmarklet" :href="bookmarkletCode" draggable="true">网页捕获</a>
              <el-button size="small" @click="copyBookmarklet">复制书签代码</el-button>
            </div>
            <div v-if="captureLoading" class="capture-status">正在解析页面…</div>
            <div v-else-if="captureError" class="capture-status capture-error">{{ captureError }}</div>
            <div v-else-if="captured" class="capture-result">
              <el-alert :title="`已捕获：${captured.title}`" type="success" :closable="false" show-icon />
              <p class="input-hint">
                来源：{{ captured.url || '（未提供）' }}<br />
                正文长度：{{ captured.contentLength }} 字符
              </p>
              <el-button type="primary" :loading="store.isCompiling" @click="compileCaptured">
                编译投递
              </el-button>
            </div>
            <div v-else class="capture-status capture-muted">
              尚未捕获。打开目标网页并点击书签后，这里会显示捕获内容。
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="QQ 聊天记录" name="qq">
          <div class="qq-flow">
            <!-- 步骤 1：选择文件并上传 -->
            <div class="qq-step">
              <div class="qq-step-head">
                <span class="qq-step-no">1</span>
                <span class="qq-step-title">选择 QQ 导出文件并上传</span>
              </div>
              <el-upload
                drag
                :auto-upload="false"
                :limit="1"
                :on-change="handleQqFileChange"
                :on-remove="handleQqFileRemove"
                :before-upload="() => false"
                accept=".txt,.json,.html,.htm,.xlsx"
                :disabled="qqStage === 'uploading' || qqStage === 'extracting'"
              >
                <div class="upload-inner">
                  <el-icon class="upload-icon"><ArrowDown /></el-icon>
                  <div class="upload-text">将 QQ 导出文件拖到此处，或点击选择</div>
                  <div class="upload-hint">SUPPORT: txt / json / html / xlsx（QQ 导出的聊天记录）</div>
                </div>
              </el-upload>
              <div class="qq-action-row">
                <el-button
                  type="primary"
                  :disabled="!qqFile || qqStage === 'uploading' || qqStage === 'extracting'"
                  :loading="qqStage === 'uploading'"
                  @click="uploadQqFile"
                >上传并预清洗</el-button>
                <el-button
                  v-if="qqStage === 'uploading'"
                  size="small"
                  type="danger"
                  text
                  @click="abortQqFlow"
                >取消</el-button>
              </div>
            </div>

            <!-- 步骤 2：预清洗结果 + 触发抽取 -->
            <div v-if="qqStage === 'uploaded' || qqStage === 'extracting' || qqStage === 'done'" class="qq-step">
              <div class="qq-step-head">
                <span class="qq-step-no">2</span>
                <span class="qq-step-title">预清洗结果</span>
              </div>
              <div v-if="qqMeta" class="qq-meta-card">
                <div class="meta-row">
                  <span class="meta-label">会话名</span>
                  <span class="meta-value">{{ qqMeta.chatName }}</span>
                </div>
                <div class="meta-row">
                  <span class="meta-label">时间范围</span>
                  <span class="meta-value">{{ qqMeta.dateRange }}</span>
                </div>
                <div class="meta-row">
                  <span class="meta-label">消息条数</span>
                  <span class="meta-value">
                    {{ qqMeta.originalCount }} → {{ qqMeta.filteredCount }} 条
                    <span class="meta-hint">（过滤 {{ qqMeta.originalCount - qqMeta.filteredCount }} 条噪声）</span>
                  </span>
                </div>
                <div class="meta-row">
                  <span class="meta-label">脱敏条数</span>
                  <span class="meta-value">{{ qqMeta.redactedCount }} 条</span>
                </div>
                <div class="meta-row">
                  <span class="meta-label">rawId</span>
                  <code class="meta-value mono">{{ qqRawId }}</code>
                </div>
              </div>
              <div class="qq-action-row">
                <el-button
                  type="primary"
                  :disabled="qqStage === 'extracting' || qqStage === 'done'"
                  :loading="qqStage === 'extracting'"
                  @click="extractQqDrafts"
                >开始 LLM 抽取</el-button>
                <el-button
                  v-if="qqStage === 'extracting'"
                  size="small"
                  type="danger"
                  text
                  @click="abortQqFlow"
                >取消抽取</el-button>
              </div>
            </div>

            <!-- 步骤 3：抽取结果 + 跳转审核 -->
            <div v-if="qqStage === 'done'" class="qq-step">
              <div class="qq-step-head">
                <span class="qq-step-no">3</span>
                <span class="qq-step-title">抽取完成</span>
              </div>
              <div class="qq-drafts-card">
                <p class="drafts-tip">共生成 <strong>{{ qqDrafts.length }}</strong> 个草稿：</p>
                <ul class="drafts-list">
                  <li v-for="d in qqDrafts" :key="d.path" class="drafts-item">
                    <code class="drafts-path">{{ d.path }}</code>
                    <span class="drafts-title">{{ d.title }}</span>
                  </li>
                </ul>
                <p class="drafts-hint">请到「知识浏览 → 草稿审核」页面审核并发布</p>
                <el-button type="primary" @click="goToDraftReview">前往草稿审核</el-button>
              </div>
            </div>

            <!-- 实时进度消息 + 可视化进度条 -->
            <div v-if="qqProgress && qqStage !== 'idle'" class="qq-progress">
              <div class="qq-progress-head">
                <span class="progress-dot" :class="qqStage"></span>
                <span class="progress-text">{{ qqProgress }}</span>
              </div>
              <el-progress
                  :percentage="qqStage === 'done' ? 100 : 0"
                :indeterminate="qqStage === 'uploading' || qqStage === 'extracting'"
                :stroke-width="5"
                :status="qqStage === 'done' ? 'success' : qqStage === 'error' ? 'exception' : ''"
                :striped="qqStage === 'uploading' || qqStage === 'extracting'"
                :striped-flow="qqStage === 'uploading' || qqStage === 'extracting'"
                class="qq-progress-bar"
              />
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>

      <!-- QQ / URL / 网页捕获 Tab 自带操作按钮，file/folder/text 共用 submit-bar -->
      <div v-if="activeTab !== 'qq' && activeTab !== 'url' && activeTab !== 'capture'" class="submit-bar">
        <el-button
          type="primary"
          size="large"
          :disabled="!canSubmit || store.isCompiling || submitting"
          :loading="store.isCompiling"
          @click="handleSubmit"
        >
          {{ store.isCompiling ? '编译中...' : '开始编译' }}
        </el-button>
        <el-button size="large" @click="resetInputs">清空</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ingest-page {
  display: flex;
  flex-direction: column;
  gap: 28px;
}

/* 英雄区：不对称布局 + 发光球装饰 */
.hero-section {
  position: relative;
  padding: 16px 32px;
  display: flex;
  align-items: center;
  gap: 36px;
  overflow: hidden;
}

.hero-orb {
  position: absolute;
  top: -80px;
  left: 40%;
  width: 280px;
  height: 280px;
  background: radial-gradient(circle, var(--neon-purple), transparent 70%);
  filter: blur(60px);
  opacity: 0.3;
  pointer-events: none;
  animation: orb-float-1 12s ease-in-out infinite;
}

.hero-left {
  flex-shrink: 0;
  z-index: 1;
}

.hero-right {
  z-index: 1;
}

.hero-tag {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-cyan);
  letter-spacing: 2px;
  display: block;
  margin-bottom: 10px;
}

.hero-title {
  margin: 0 0 6px;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 1px;
  line-height: 1.1;
}

.hero-tip {
  margin: 0;
  color: var(--text-soft);
  max-width: 480px;
  line-height: 1.6;
  font-size: 13px;
}

.ingest-card {
  padding: 28px 32px;
  position: relative;
  overflow: hidden;
}

/* 卡片装饰：倾斜渐变块 */
.card-deco {
  position: absolute;
  bottom: -40px;
  right: -40px;
  width: 200px;
  height: 200px;
  background: var(--grad-cool);
  opacity: 0.08;
  transform: rotate(20deg);
  border-radius: 32px;
  pointer-events: none;
}

.ingest-tabs {
  --el-color-primary: var(--neon-magenta);
  position: relative;
  z-index: 1;
}

.upload-inner {
  padding: 32px 0;
}

.upload-icon {
  font-size: 48px;
  color: var(--neon-cyan);
  margin-bottom: 12px;
  font-family: var(--font-display);
  text-shadow: var(--glow-cyan);
  animation: neon-pulse 2s ease-in-out infinite;
}

.upload-text {
  font-size: 15px;
  color: var(--text-bright);
  font-weight: 600;
  font-family: var(--font-body);
}

.upload-hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  letter-spacing: 2px;
}

.input-hint {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--text-soft);
  font-family: var(--font-mono);
  letter-spacing: 0.5px;
}

/* A1 网页捕获 Tab */
.capture-wrap {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}
.capture-steps {
  margin: 0;
  padding-left: 20px;
  color: var(--text-soft);
  font-size: 13px;
  line-height: 1.9;
}
.bookmarklet-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.bookmarklet {
  display: inline-block;
  padding: 8px 18px;
  background: var(--color-primary, #0f4c81);
  color: #fff;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  cursor: grab;
  user-select: none;
}
.bookmarklet:active {
  cursor: grabbing;
}
.capture-status {
  font-size: 13px;
}
.capture-muted {
  color: var(--text-soft);
}
.capture-error {
  color: #c0392b;
}
.capture-result {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
}

.submit-bar {
  margin-top: 24px;
  display: flex;
  justify-content: flex-end;
  gap: 14px;
  position: relative;
  z-index: 1;
}

/* ===== 文件夹上传模式样式 ===== */
.folder-dropzone {
  padding: 32px 0;
  text-align: center;
  cursor: pointer;
  border: 2px dashed var(--accent-purple-a30, rgba(176, 38, 255, 0.3));
  border-radius: var(--radius-card);
  transition: border-color 0.3s ease, background-color 0.3s ease;
}

.folder-dropzone:hover {
  border-color: var(--neon-purple);
  background: var(--accent-purple-a05, rgba(176, 38, 255, 0.05));
}

.folder-files {
  margin-top: 16px;
  padding: 12px 16px;
  background: var(--accent-cyan-a04, rgba(0, 245, 255, 0.04));
  border: 1px solid var(--accent-cyan-a15, rgba(0, 245, 255, 0.15));
  border-radius: var(--radius-card);
}

.folder-files-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.folder-files-title {
  font-size: 13px;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
  font-weight: 600;
}

.folder-files-list {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.folder-file-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  font-size: 12px;
}

.folder-file-name {
  font-family: var(--font-mono);
  color: var(--text-bright);
  word-break: break-all;
  flex: 1;
  margin-right: 8px;
}

/* ============================================================
 * QQ 聊天记录上传 Tab 样式
 * 三步骤渐进式表单，每步骤独立卡片
 * ============================================================ */

.qq-flow {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 4px 0;
}

.qq-step {
  padding: 18px 20px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a15);
  border-radius: var(--radius-card);
}

.qq-step-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.qq-step-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: var(--accent-purple-a20);
  border: 1px solid var(--accent-purple-a40);
  border-radius: 50%;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--neon-purple);
}

.qq-step-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
  font-family: var(--font-display);
}

.qq-action-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}

/* 预清洗结果卡片 */
.qq-meta-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  background: var(--accent-cyan-a08);
  border: 1px solid var(--accent-cyan-a20);
  border-radius: 10px;
  margin-bottom: 14px;
}

.meta-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-size: 12px;
}

.meta-label {
  width: 80px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  flex-shrink: 0;
}

.meta-value {
  color: var(--text-base);
  flex: 1;
}

.meta-value.mono {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-cyan);
  background: var(--accent-cyan-a10);
  padding: 2px 8px;
  border-radius: 4px;
  word-break: break-all;
}

.meta-hint {
  color: var(--text-dim);
  font-size: 11px;
}

/* 抽取结果卡片 */
.qq-drafts-card {
  padding: 16px;
  background: var(--accent-magenta-a08);
  border: 1px solid var(--accent-magenta-a25);
  border-radius: 10px;
}

.drafts-tip {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text-base);
}

.drafts-tip strong {
  color: var(--neon-magenta);
  font-size: 16px;
}

.drafts-list {
  list-style: none;
  padding: 0;
  margin: 0 0 14px;
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.drafts-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
}

.drafts-path {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-cyan);
  word-break: break-all;
}

.drafts-title {
  font-size: 12px;
  color: var(--text-base);
}

.drafts-hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--text-soft);
  font-family: var(--font-mono);
}

/* 进度条 */
.qq-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: var(--accent-purple-a08);
  border: 1px solid var(--accent-purple-a20);
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-base);
  font-family: var(--font-mono);
}

.progress-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
  flex-shrink: 0;
}

.progress-dot.uploading,
.progress-dot.extracting {
  background: var(--neon-cyan);
  animation: neon-pulse 1.2s ease-in-out infinite;
}

.progress-dot.done {
  background: var(--neon-magenta);
}

.progress-dot.error {
  background: var(--neon-pink);
}

/* ============================================================
 * URL 爬取两段式 Tab 样式
 * - url-tip-banner: 显著提示横幅，使用 info 主题色突出显示
 * - url-step: 步骤卡片，复用 qq-step 视觉风格保持一致
 * - url-pages-card / url-attachments-card: 列表卡片
 * ============================================================ */

.url-flow {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 4px 0;
}

/* 提示横幅：使用 cyan 主题色作为信息提示 */
.url-tip-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 16px;
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
  border: 1px solid var(--accent-cyan-a25, rgba(0, 245, 255, 0.25));
  border-radius: var(--radius-card);
  font-size: 13px;
  color: var(--text-bright);
  line-height: 1.6;
}

.url-tip-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  background: var(--neon-cyan);
  color: var(--bg-scene);
  border-radius: 50%;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  font-style: italic;
  margin-top: 1px;
}

.url-tip-text {
  margin: 0;
  flex: 1;
  font-family: var(--font-body);
}

/* 步骤卡片 */
.url-step {
  padding: 18px 20px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a15);
  border-radius: var(--radius-card);
}

.url-step-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.url-step-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: var(--accent-purple-a20);
  border: 1px solid var(--accent-purple-a40);
  border-radius: 50%;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--neon-purple);
}

.url-step-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
  font-family: var(--font-display);
}

.url-action-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}

/* 5.1.4 高级参数行：maxPages / maxHops 留空使用后端默认值 */
.url-params-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 12px;
  padding: 10px 14px;
  background: var(--accent-cyan-a05);
  border: 1px dashed var(--accent-cyan-a20);
  border-radius: 8px;
}

.url-param-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.url-param-label {
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
}

/* 爬取结果卡片 */
.url-meta-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  background: var(--accent-cyan-a08);
  border: 1px solid var(--accent-cyan-a20);
  border-radius: 10px;
  margin-bottom: 14px;
}

.url-pages-card,
.url-attachments-card {
  padding: 12px 16px;
  background: var(--accent-purple-a05);
  border: 1px solid var(--accent-purple-a15);
  border-radius: 10px;
  margin-bottom: 14px;
}

.url-diagnosis-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 16px;
  background: var(--accent-red-a08, rgba(255, 119, 158, 0.12));
  border: 1px solid var(--accent-red-a30, rgba(255, 119, 158, 0.35));
  border-radius: 10px;
  margin-bottom: 14px;
  color: var(--accent-red-text, #d6336c);
  font-size: 13px;
  line-height: 1.6;
}

.url-diagnosis-banner .el-icon {
  margin-top: 2px;
  flex-shrink: 0;
  color: var(--accent-red-text, #d6336c);
}

.url-pages-title,
.url-attachments-title {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--neon-purple);
  font-family: var(--font-mono);
  font-weight: 600;
}

.url-pages-list,
.url-attachments-list {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.url-page-item,
.url-attachment-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  font-size: 12px;
}

/* 5.4.1 爬取预览：未勾选页面降低视觉优先级 */
.url-page-item.url-page-unchecked {
  opacity: 0.5;
}

.url-pages-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.url-page-depth {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-cyan);
  flex-shrink: 0;
}

.url-page-title {
  color: var(--text-base);
  flex: 1;
  word-break: break-all;
}

.url-page-stats {
  color: var(--text-dim);
  font-size: 11px;
  font-family: var(--font-mono);
  flex-shrink: 0;
}

.url-att-type {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-magenta);
  flex-shrink: 0;
}

.url-att-url {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-base);
  word-break: break-all;
  flex: 1;
}

/* 5.4.2 附件分组样式 */
.url-att-group {
  margin-bottom: 10px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
  border-left: 3px solid var(--accent-cyan-a30);
  border-radius: 4px;
}

.url-att-group:last-child {
  margin-bottom: 0;
}

.url-att-group-title {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
  font-weight: 600;
}

.url-att-group-count {
  color: var(--text-dim);
  font-weight: normal;
  margin-left: 4px;
}

/* URL 进度条复用 QQ 进度条视觉风格 */
.url-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px;
  background: var(--accent-purple-a08);
  border: 1px solid var(--accent-purple-a20);
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-base);
  font-family: var(--font-mono);
}

/* URL 阶段对应的进度点颜色 */
.progress-dot.crawling {
  background: var(--neon-cyan);
  animation: neon-pulse 1.2s ease-in-out infinite;
}

.progress-dot.crawled {
  background: var(--neon-magenta);
}

/* B 方案：代理连通性自检状态行（浅色主题下用文字色区分级别，避免花哨背景） */
.url-proxy-probe {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.url-proxy-probe .probe-tag {
  flex: 0 0 auto;
  font-weight: 600;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
}
.url-proxy-probe.probe-ok { color: #1a7f37; }
.url-proxy-probe.probe-ok .probe-tag { background: #e6f4ea; color: #1a7f37; }
.url-proxy-probe.probe-warn { color: #9a6700; }
.url-proxy-probe.probe-warn .probe-tag { background: #fdf3d7; color: #9a6700; }
.url-proxy-probe.probe-error { color: #c62828; }
.url-proxy-probe.probe-error .probe-tag { background: #fdecea; color: #c62828; }
</style>
