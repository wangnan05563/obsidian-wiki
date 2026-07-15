<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import MarkdownIt from 'markdown-it';

// Markdown 渲染组件。
// v1：用于把 LLM 流式输出的 Markdown 文本实时渲染为 HTML。
// v2 改造：添加图片点击放大预览（el-image-viewer）。
// 设计选择：
// - html: false：禁止源 HTML 直通，markdown-it 默认会转义 < >，防 XSS
// - breaks: true：聊天场景下单换行应渲染为 <br>，否则需要两个空格才换行，体验差
// - linkify: true：URL 自动转链接，方便用户点击
// - typographer: false：禁用排版替换（如 " -> "），避免中文标点被误替换
const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
});

const props = defineProps<{ content: string }>();

const html = computed(() => {
  if (!props.content) return '';
  return md.render(props.content);
});

// v2：图片预览状态
const previewSrc = ref('');
const previewVisible = ref(false);
const rootRef = ref<HTMLElement | null>(null);

// 事件委托处理器：提取为命名函数以便卸载时移除
const handleClick = (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  if (target.tagName === 'IMG') {
    e.preventDefault();
    previewSrc.value = (target as HTMLImageElement).src;
    previewVisible.value = true;
  }
};

// 事件委托：监听根元素 click，若点击目标是 img 则触发预览
// 为什么用事件委托而非在 v-html 中注入 onclick：v-html 内容不经过 Vue 编译，无法绑定 Vue 事件
onMounted(() => {
  rootRef.value?.addEventListener('click', handleClick);
});

onBeforeUnmount(() => {
  rootRef.value?.removeEventListener('click', handleClick);
});
</script>

<template>
  <div ref="rootRef" class="md-body" v-html="html"></div>
  <!-- v2：图片点击放大预览 -->
  <el-image-viewer
    v-if="previewVisible"
    :url-list="[previewSrc]"
    @close="previewVisible = false"
  />
</template>

<style scoped>
.md-body {
  font-size: 14px;
  line-height: 1.75;
  color: var(--text-base);
  word-break: break-word;
}

/* 标题：紧凑、层级清晰 */
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4),
.md-body :deep(h5),
.md-body :deep(h6) {
  margin: 1.2em 0 0.6em;
  font-weight: 700;
  line-height: 1.4;
  color: var(--neon-cyan);
}

.md-body :deep(h1) { font-size: 1.45em; }
.md-body :deep(h2) { font-size: 1.3em; }
.md-body :deep(h3) { font-size: 1.18em; }
.md-body :deep(h4) { font-size: 1.06em; }
.md-body :deep(h5),
.md-body :deep(h6) { font-size: 1em; }

.md-body :deep(h1):first-child,
.md-body :deep(h2):first-child,
.md-body :deep(h3):first-child { margin-top: 0; }

/* 段落 */
.md-body :deep(p) {
  margin: 0.5em 0;
}

/* 列表：缩进 + 圆点 */
.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.6em;
}

.md-body :deep(li) {
  margin: 0.25em 0;
}

.md-body :deep(li > ul),
.md-body :deep(li > ol) {
  margin: 0.25em 0;
}

/* 行内代码：浅底 + 等宽 */
.md-body :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  padding: 2px 6px;
  background: rgba(0, 245, 255, 0.1);
  border: 1px solid rgba(0, 245, 255, 0.18);
  border-radius: 4px;
  color: var(--neon-cyan);
  word-break: break-all;
}

/* 代码块：深底 + 滚动 + 等宽 */
.md-body :deep(pre) {
  margin: 0.75em 0;
  padding: 14px 16px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(0, 245, 255, 0.2);
  border-radius: 10px;
  overflow-x: auto;
  backdrop-filter: var(--blur);
}

.md-body :deep(pre code) {
  padding: 0;
  background: transparent;
  border: 0;
  color: var(--text-base);
  font-size: 0.92em;
  line-height: 1.6;
  word-break: normal;
}

/* 引用块：左侧色条 */
.md-body :deep(blockquote) {
  margin: 0.75em 0;
  padding: 0.5em 1em;
  border-left: 3px solid var(--neon-purple);
  background: rgba(176, 38, 255, 0.06);
  color: var(--text-soft);
  border-radius: 0 8px 8px 0;
}

.md-body :deep(blockquote p) {
  margin: 0.25em 0;
}

/* 表格：玻璃风格 */
.md-body :deep(table) {
  margin: 0.75em 0;
  border-collapse: collapse;
  width: 100%;
  font-size: 0.94em;
  border: 1px solid rgba(0, 245, 255, 0.2);
  border-radius: 8px;
  overflow: hidden;
}

.md-body :deep(th),
.md-body :deep(td) {
  padding: 8px 12px;
  border: 1px solid rgba(0, 245, 255, 0.12);
  text-align: left;
}

.md-body :deep(th) {
  background: rgba(0, 245, 255, 0.08);
  font-weight: 700;
  color: var(--neon-cyan);
}

.md-body :deep(tr:nth-child(2n) td) {
  background: rgba(0, 245, 255, 0.03);
}

/* 链接：发光高亮 */
.md-body :deep(a) {
  color: var(--neon-cyan);
  text-decoration: none;
  border-bottom: 1px dashed rgba(0, 245, 255, 0.4);
  transition: all 0.2s ease;
}

.md-body :deep(a:hover) {
  color: var(--neon-purple);
  border-bottom-color: var(--neon-purple);
  text-shadow: 0 0 6px rgba(176, 38, 255, 0.6);
}

/* v2：图片样式 */
.md-body :deep(img) {
  max-width: 100%;
  border-radius: 8px;
  cursor: zoom-in;
  transition: opacity 0.2s;
}
.md-body :deep(img:hover) {
  opacity: 0.9;
}

/* 分割线 */
.md-body :deep(hr) {
  margin: 1em 0;
  border: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--neon-cyan), transparent);
  opacity: 0.4;
}

/* 强调 */
.md-body :deep(strong) {
  font-weight: 700;
  color: var(--neon-cyan);
}

.md-body :deep(em) {
  font-style: italic;
  color: var(--neon-purple);
}

/* 删除线 */
.md-body :deep(del) {
  color: var(--text-dim);
}
</style>
