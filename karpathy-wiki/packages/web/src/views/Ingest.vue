<script setup lang="ts">
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import type { UploadFile } from 'element-plus';
import RobotAvatar from '../components/RobotAvatar.vue';
import { useCompileStore } from '../stores/compile';

const emit = defineEmits<{
  (e: 'start'): void;
}>();

const store = useCompileStore();

const activeTab = ref<'file' | 'url' | 'text'>('file');
const urlInput = ref('');
const textInput = ref('');
const selectedFile = ref<File | null>(null);

// 是否可以投递：每种方式各自校验
const canSubmit = computed(() => {
  if (activeTab.value === 'file') return !!selectedFile.value;
  if (activeTab.value === 'url') return urlInput.value.trim().length > 0;
  return textInput.value.trim().length > 0;
});

// el-upload 选择文件后保存到 ref，不真正上传
function handleFileChange(file: UploadFile) {
  // raw 才是真正的 File 对象
  selectedFile.value = file.raw ?? null;
}

function handleFileRemove() {
  selectedFile.value = null;
}

// 控制是否手动上传：返回 false 阻止 element-plus 自动上传
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
  // 载荷预存到 store，进度页据此发起 SSE 请求
  store.prepareCompile(payload);
  emit('start');
}

function resetInputs() {
  // 投递成功切到进度页后，清空当前页输入便于下次重新投递
  selectedFile.value = null;
  urlInput.value = '';
  textInput.value = '';
}
</script>

<template>
  <div class="ingest-page">
    <div class="empty-hero">
      <RobotAvatar :size="160" :floating="true" />
      <h2 class="hero-title">投递第一篇资料</h2>
      <p class="hero-tip">
        上传文件、粘贴 URL 或直接贴文本，机器人会按 SCHEMA 编译为知识库页面
      </p>
    </div>

    <div class="glass-card ingest-card">
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
              <div class="upload-emoji">📎</div>
              <div class="upload-text">将文件拖到此处，或点击上传</div>
              <div class="upload-hint">支持 md / txt / pdf / html / json</div>
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
            <template #prepend>🔗</template>
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
  gap: 24px;
}

.empty-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 32px 0 8px;
}

.hero-title {
  margin: 16px 0 8px;
  font-size: 24px;
  font-weight: 700;
  color: var(--color-text);
}

.hero-tip {
  margin: 0;
  color: var(--color-text-soft);
  max-width: 480px;
  line-height: 1.6;
}

.ingest-card {
  padding: 24px 28px;
}

.ingest-tabs {
  --el-color-primary: var(--color-primary-deep);
}

.upload-inner {
  padding: 24px 0;
}

.upload-emoji {
  font-size: 40px;
  margin-bottom: 8px;
}

.upload-text {
  font-size: 15px;
  color: var(--color-text);
  font-weight: 600;
}

.upload-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-text-soft);
}

.input-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--color-text-soft);
}

.submit-bar {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
</style>
