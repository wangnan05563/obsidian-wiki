<script setup lang="ts">
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import type { UploadFile } from 'element-plus';
import { useCompileStore } from '../stores/compile';

// 使用函数类型写法替代类型字面量（S6598）
const emit = defineEmits<(e: 'start') => void>();

const store = useCompileStore();

const activeTab = ref<'file' | 'url' | 'text'>('file');
const urlInput = ref('');
const textInput = ref('');
const selectedFile = ref<File | null>(null);

const canSubmit = computed(() => {
  if (activeTab.value === 'file') return !!selectedFile.value;
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

function buildPayload(): FormData | { type: 'url' | 'text'; content: string } | null {
  if (activeTab.value === 'file') {
    if (!selectedFile.value) return null;
    const fd = new FormData();
    fd.append('file', selectedFile.value);
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
  store.prepareCompile(payload);
  emit('start');
}

function resetInputs() {
  selectedFile.value = null;
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
</style>
