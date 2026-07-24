<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import type { UploadFile } from 'element-plus';
import { useCompileStore } from '../stores/compile';
import { consumeSSE } from '../utils/sse';
import type { ConfigData, QqUploadEvent, DraftCompileEvent } from '../types';

// 使用函数类型写法替代类型字面量（S6598）
const emit = defineEmits<(e: 'start') => void>();

const store = useCompileStore();

const activeTab = ref<'file' | 'folder' | 'url' | 'text' | 'qq'>('file');
const urlInput = ref('');
const textInput = ref('');
const selectedFile = ref<File | null>(null);
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
const MAX_BATCH_SIZE = ref<number>(20);
const MAX_FILE_SIZE_MB = ref<number>(10);

// 从后端加载 batch 配置，更新前端校验限制
// 为什么在 Ingest 页面独立加载：Config.vue 的配置变更需即时反映到 Ingest 页面，
//   每次进入页面都重新拉取最新配置，避免使用 stale 缓存值
async function loadBatchConfig(): Promise<void> {
  try {
    const res = await fetch('/api/config');
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
});

const canSubmit = computed(() => {
  if (activeTab.value === 'file') return !!selectedFile.value;
  if (activeTab.value === 'folder') return folderFiles.value.length > 0;
  if (activeTab.value === 'url') return urlInput.value.trim().length > 0;
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

function buildPayload(): FormData | { type: 'url' | 'text'; content: string } | null {
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
  if (activeTab.value === 'url') {
    const content = urlInput.value.trim();
    if (!content) return null;
    return { type: 'url', content };
  }
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
    const res = await fetch('/api/qq-ingest/upload', {
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
    const res = await fetch(
      `/api/qq-ingest/extract/${qqRawId.value}`,
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
</script>

<template>
  <div class="ingest-page">
    <!-- 不对称英雄区：机器人偏左，标题偏右 -->
    <div class="hero-section fade-up">
      <div class="hero-orb"></div>
      <div class="hero-right">
        <span class="hero-tag">// INGEST PIPELINE</span>
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
              <div class="upload-icon">↓</div>
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
            <div class="upload-icon">📁</div>
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
          <el-input
            v-model="urlInput"
            placeholder="https://example.com/article"
            clearable
            size="large"
          >
            <template #prepend>URI</template>
          </el-input>
          <p class="input-hint">机器人会抓取该 URL 内容并编译</p>
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
                accept=".txt,.json"
                :disabled="qqStage === 'uploading' || qqStage === 'extracting'"
              >
                <div class="upload-inner">
                  <div class="upload-icon">↓</div>
                  <div class="upload-text">将 QQ 导出文件拖到此处，或点击选择</div>
                  <div class="upload-hint">SUPPORT: txt / json（QQ 导出的聊天记录）</div>
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

      <!-- QQ Tab 自带操作按钮，其他 Tab 共用 submit-bar -->
      <div v-if="activeTab !== 'qq'" class="submit-bar">
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
</style>
