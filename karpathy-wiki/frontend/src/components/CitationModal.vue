<script setup lang="ts">
// FR-21 引用溯源：引用浮层（T01755 桌面 / T01756 移动抽屉）。
// 展示被引页面的 chunk 原文（GET /api/search/chunks）+ 查询词高亮 + 页面标题/路径 +
// 「打开页面」跳转；桌面用 AppModal dialog 形态，移动端 variant="drawer"（不加 append-to-body，
// 遵循既有测试 DOM 约定）。复用 AppModal 规范，不做第二套样式（SRS 规格 3）。
import { computed, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import { API_BASE } from '../utils/apiBase';
import { useAuthStore } from '../stores/auth';

const props = defineProps<{
  /** 是否展示 */
  open: boolean;
  /** 被引页面相对路径（refs[slot-1]） */
  pagePath: string;
  /** 槽位编号（角标 [n] 的 n） */
  slotNum: number;
  /** 当前会话用户查询词（命中段高亮用；多词空格分隔） */
  query: string;
  /** 移动端抽屉形态 */
  drawer?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'open-page', path: string): void;
}>();

const authStore = useAuthStore();
const loading = ref(false);
const chunks = ref<Array<{ index: number; content: string; heading: string | null }>>([]);

const title = computed(() => {
  const name = props.pagePath.split('/').pop()?.replace(/\.md$/, '') ?? props.pagePath;
  return `引用 [${props.slotNum}] · ${name}`;
});

// 打开时拉取该页 chunk 列表（未索引页面返回空 → 浮层显示「暂无索引内容」）
watch(
  () => [props.open, props.pagePath] as const,
  async ([open]) => {
    if (!open || !props.pagePath) return;
    loading.value = true;
    chunks.value = [];
    try {
      const res = await authStore.authFetch(`${API_BASE}/search/chunks?path=${encodeURIComponent(props.pagePath)}`);
      if (res.ok) {
        const data = await res.json();
        chunks.value = data.chunks ?? [];
      }
    } catch {
      /* 拉取失败浮层内展示空态，不阻断 */
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

// 命中段高亮：按查询词分词，命中片段 <mark> 包裹（chunk 内容纯文本，转义后替换受控词）
function highlight(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const terms = props.query.trim().split(/\s+/).filter((t) => t.length >= 2);
  if (terms.length === 0) return escaped;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return escaped.replace(re, '<mark class="cite-hit">$1</mark>');
}

function openPage() {
  emit('open-page', props.pagePath);
  emit('update:open', false);
}
</script>

<template>
  <AppModal
    :model-value="open"
    :title="title"
    :variant="drawer ? 'drawer' : 'dialog'"
    :data-testid="drawer ? 'citation-drawer' : 'citation-modal'"
    @update:model-value="emit('update:open', $event)"
  >
    <div class="citation-body">
      <div class="citation-path" :title="pagePath">{{ pagePath }}</div>
      <div v-if="loading" class="citation-loading">加载 chunk 中…</div>
      <template v-else-if="chunks.length > 0">
        <div v-for="c in chunks" :key="c.index" class="citation-chunk">
          <div class="citation-chunk-head">#{{ c.index + 1 }}<span v-if="c.heading" class="citation-chunk-heading">{{ c.heading }}</span></div>
          <!-- chunk 原文纯文本展示 + 查询词高亮（受控词表，转义先行） -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="citation-chunk-content" v-html="highlight(c.content)"></div>
        </div>
      </template>
      <div v-else class="citation-empty">该页面尚未建立语义索引，暂无 chunk 内容。</div>
      <div class="citation-actions">
        <el-button type="primary" size="small" data-testid="citation-open-page" data-tip="在知识浏览中打开被引页面" @click="openPage">打开页面</el-button>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
.citation-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 60vh;
  overflow-y: auto;
}
.citation-path {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-2, #666);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.citation-loading,
.citation-empty {
  font-size: 12px;
  color: var(--text-2, #666);
  padding: 12px 0;
}
.citation-chunk {
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
  border-radius: 8px;
  padding: 8px 10px;
}
.citation-chunk-head {
  font-size: 11px;
  color: var(--neon-cyan);
  font-weight: 600;
  margin-bottom: 4px;
}
.citation-chunk-heading {
  margin-left: 8px;
  color: var(--text-2, #666);
  font-weight: 400;
}
.citation-chunk-content {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-base);
  white-space: pre-wrap;
  word-break: break-word;
}
.citation-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
}
/* 查询词命中高亮：黄底黑字，全站通用可读 */
:deep(.cite-hit) {
  background: rgba(255, 213, 79, 0.55);
  color: #1a1a1a;
  border-radius: 2px;
  padding: 0 1px;
}
</style>
