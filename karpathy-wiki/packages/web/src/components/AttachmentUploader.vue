<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useAttachmentsStore } from '../stores/attachments';

// §2.8 AttachmentUploader — 图片附件上传组件。
// 职责：支持点击/拖拽/粘贴上传图片，压缩后存入 IndexedDB，展示缩略图列表。
// 设计选择：三种输入方式统一走 handleFile；缩略图 URL 在本组件内加载并缓存。
const props = defineProps<{ attachments: string[] }>();
const emit = defineEmits<{
  add: [id: string];
  remove: [id: string];
}>();
const store = useAttachmentsStore();
const dragOver = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);

// 缩略图 URL 缓存：id -> objectURL
// 为什么用 Map 而非 reactive 对象：避免频繁增删 key 触发多次响应式更新
const thumbUrls = ref<Map<string, string>>(new Map());

// 允许的图片 MIME 白名单
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

async function handleFile(file: File) {
  if (!ALLOWED_MIME.has(file.type)) {
    ElMessage.error('仅支持 jpg/png/webp/gif');
    return;
  }
  if (file.size > MAX_SIZE) {
    ElMessage.error('图片大小不能超过 10MB');
    return;
  }
  try {
    const id = await store.addImage(file);
    emit('add', id);
    // 立即加载缩略图
    const blob = await store.getThumbnail(id);
    if (blob) {
      thumbUrls.value.set(id, URL.createObjectURL(blob));
    }
  } catch (err) {
    ElMessage.error('图片处理失败');
    console.error(err);
  }
}

function handleDrop(e: DragEvent) {
  dragOver.value = false;
  const files = e.dataTransfer?.files;
  if (files) {
    for (const file of files) {
      handleFile(file);
    }
  }
}

function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (items) {
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) handleFile(file);
      }
    }
  }
}

// 全局监听 paste 事件，支持在输入区粘贴图片
onMounted(() => {
  globalThis.addEventListener('paste', handlePaste);
});
onBeforeUnmount(() => {
  globalThis.removeEventListener('paste', handlePaste);
  // 释放所有 objectURL 避免内存泄漏
  thumbUrls.value.forEach(url => URL.revokeObjectURL(url));
});

// 监听 attachments 变化，为新 id 加载缩略图
watch(() => props.attachments, async (ids) => {
  for (const id of ids) {
    if (!thumbUrls.value.has(id)) {
      const blob = await store.getThumbnail(id);
      if (blob) {
        thumbUrls.value.set(id, URL.createObjectURL(blob));
      }
    }
  }
}, { deep: true });

function triggerFileInput() {
  fileInputRef.value?.click();
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files;
  if (files) {
    for (const file of files) {
      handleFile(file);
    }
  }
  // 清空 input value 以支持重复选择同一文件
  input.value = '';
}

function handleRemove(id: string) {
  // 释放被移除附件的 objectURL
  const url = thumbUrls.value.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    thumbUrls.value.delete(id);
  }
  emit('remove', id);
}
</script>

<template>
  <div class="attachment-uploader">
    <input ref="fileInputRef" type="file"
      accept="image/jpeg,image/png,image/webp,image/gif"
      multiple
      @change="onFileChange"
      style="display: none" />
    <!-- 附件上传按钮：自定义 SVG 回形针图标，符合霓虹科技风 -->
    <button class="upload-btn" @click="triggerFileInput" title="上传图片">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M21 11.5l-8.5 8.5a5 5 0 01-7-7l8-8a3.5 3.5 0 015 5l-8 8a2 2 0 01-3-3l7-7"
          stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="attachment-list"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop.prevent="handleDrop"
      :class="{ 'drag-over': dragOver }">
      <div v-for="id in props.attachments" :key="id" class="attachment-item">
        <img v-if="thumbUrls.get(id)" :src="thumbUrls.get(id)" class="thumb-img" alt="附件缩略图" />
        <div v-else class="thumb-placeholder">...</div>
        <button class="remove-btn" @click="handleRemove(id)">×</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.attachment-uploader {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
}
.upload-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  border: 1px solid rgba(0, 245, 255, 0.2);
  background: rgba(0, 245, 255, 0.05);
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-soft, #888);
  transition: all 0.25s;
}
.upload-btn:hover {
  background: rgba(0, 245, 255, 0.12);
  border-color: var(--neon-cyan, #00f5ff);
  color: var(--neon-cyan, #00f5ff);
  box-shadow: 0 0 8px rgba(0, 245, 255, 0.2);
}
.attachment-list {
  display: flex;
  gap: 6px;
  padding: 4px;
  border-radius: 6px;
  transition: background 0.2s;
}
.attachment-list.drag-over {
  background: rgba(0, 245, 255, 0.1);
  border: 1px dashed var(--neon-cyan, #00f5ff);
}
.attachment-item {
  position: relative;
  width: 48px;
  height: 48px;
}
.thumb-img {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
}
.thumb-placeholder {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  font-size: 10px;
  color: var(--text-soft, #888);
}
.remove-btn {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: none;
  background: #d32f2f;
  color: white;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.remove-btn:hover {
  background: #c62828;
}
</style>
