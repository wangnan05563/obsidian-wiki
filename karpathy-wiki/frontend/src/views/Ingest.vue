<script setup lang="ts">
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import type { UploadFile } from 'element-plus';
import { useCompileStore } from '../stores/compile';

// 使用函数类型写法替代类型字面量（S6598）
const emit = defineEmits<(e: 'start') => void>();

const store = useCompileStore();

const activeTab = ref<'file' | 'folder' | 'url' | 'text'>('file');
const urlInput = ref('');
const textInput = ref('');
const selectedFile = ref<File | null>(null);
// 文件夹模式：扫描得到的有效文件列表
const folderFiles = ref<Array<{ name: string; file: File }>>([]);

// 与后端 config.batch.allowedExtensions 保持一致的白名单
// 为什么前端也要校验：用户在确认弹窗里能看到哪些文件被跳过，避免上传空 FormData
const ALLOWED_EXTS = ['md', 'txt', 'pdf', 'html', 'json'];
const MAX_BATCH_SIZE = 20;
const MAX_FILE_SIZE_MB = 10;

const canSubmit = computed(() => {
  if (activeTab.value === 'file') return !!selectedFile.value;
  if (activeTab.value === 'folder') return folderFiles.value.length > 0;
  if (activeTab.value === 'url') return urlInput.value.trim().length > 0;
  return textInput.value.trim().length > 0;
});

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
  for (let i = 0; i < input.files.length; i++) {
    const f = input.files[i];
    // webkitRelativePath 含文件夹前缀，这里仅取 basename 作为显示与上传名
    const baseName = (f.webkitRelativePath || f.name).split('/').pop() ?? f.name;
    const ext = baseName.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXTS.includes(ext)) {
      rejectedCount++;
      continue;
    }
    if (f.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      oversizedCount++;
      continue;
    }
    valid.push({ name: baseName, file: f });
  }
  // 超过批量上限时截断并提示
  if (valid.length > MAX_BATCH_SIZE) {
    ElMessage.warning(`文件数超过 ${MAX_BATCH_SIZE} 上限，仅保留前 ${MAX_BATCH_SIZE} 个文件`);
    folderFiles.value = valid.slice(0, MAX_BATCH_SIZE);
  } else {
    folderFiles.value = valid;
  }
  if (valid.length === 0) {
    ElMessage.warning('所选文件夹中没有符合白名单（md/txt/pdf/html/json）的文件');
  } else if (rejectedCount > 0 || oversizedCount > 0) {
    const parts: string[] = [];
    if (rejectedCount > 0) parts.push(`${rejectedCount} 个不符白名单`);
    if (oversizedCount > 0) parts.push(`${oversizedCount} 个超过 ${MAX_FILE_SIZE_MB}MB`);
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

function handleSubmit() {
  const payload = buildPayload();
  if (!payload) {
    ElMessage.warning('请先准备好要投递的资料');
    return;
  }
  // 文件夹模式走批量编译 store action，其他模式走单文件
  if (activeTab.value === 'folder' && payload instanceof FormData) {
    store.prepareBatchCompile(payload);
  } else {
    store.prepareCompile(payload);
  }
  emit('start');
}

function resetInputs() {
  selectedFile.value = null;
  folderFiles.value = [];
  urlInput.value = '';
  textInput.value = '';
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
            accept=".md,.txt,.pdf,.html,.json"
          >
            <div class="upload-inner">
              <div class="upload-icon">↓</div>
      <div class="upload-text">将文件拖到此处，或点击上传</div>
      <div class="upload-hint">SUPPORT: md / txt / pdf / html / json</div>
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
              将扫描子目录下所有 md / txt / pdf / html / json 文件（上限 {{ MAX_BATCH_SIZE }} 个，单文件 ≤ {{ MAX_FILE_SIZE_MB }}MB）
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
      </el-tabs>

      <div class="submit-bar">
        <el-button
          type="primary"
          size="large"
          :disabled="!canSubmit"
          @click="handleSubmit"
        >
          开始编译
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
  border: 2px dashed rgba(176, 38, 255, 0.3);
  border-radius: var(--radius-card);
  transition: border-color 0.3s ease, background-color 0.3s ease;
}

.folder-dropzone:hover {
  border-color: var(--neon-purple);
  background: rgba(176, 38, 255, 0.05);
}

.folder-files {
  margin-top: 16px;
  padding: 12px 16px;
  background: rgba(0, 245, 255, 0.04);
  border: 1px solid rgba(0, 245, 255, 0.15);
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
</style>
