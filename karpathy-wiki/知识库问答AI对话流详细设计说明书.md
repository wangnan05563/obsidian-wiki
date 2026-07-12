# 知识库问答 AI 对话流 — 详细设计说明书

| 字段 | 值 |
| --- | --- |
| 文档版本 | V1.0.1 |
| 编写日期 | 2026-07-11 |
| 修订日期 | 2026-07-11 |
| 编写人 | wiki-code-dev |
| 适用项目 | Karpathy AI + Obsidian 知识库（karpathy-wiki） |
| 需求基准 | 《知识库问答AI对话流需求规格说明书》v1.1.0 |
| 设计基线 | 《知识库问答AI对话流概要设计说明书》V1.0.1 |
| 现有实现 | DELIVERY.md §14（v1 交付清单） |
| 范围 | 13 项功能的详细设计，可直接作为编码实施依据 |
| 修订记录 | V1.0.1：按评审报告修正 P0-1/P0-2/P1-1/P1-3/P2-2/P2-4 共 6 项问题 |

---

## 目录

1. [引言](#1-引言)
2. [前端组件详细设计](#2-前端组件详细设计)
3. [前端 Store 详细设计](#3-前端-store-详细设计)
4. [前端 Composables 详细设计](#4-前端-composables-详细设计)
5. [后端详细设计](#5-后端详细设计)
6. [数据持久化详细设计](#6-数据持久化详细设计)
7. [SSE 事件流详细设计](#7-sse-事件流详细设计)
8. [样式详细设计](#8-样式详细设计)
9. [错误处理详细设计](#9-错误处理详细设计)
10. [附录](#10-附录)

---

## 1. 引言

### 1.1 编写目的

本文档对知识库问答 AI 对话流 v2 升级进行详细级设计，覆盖每个组件、store、composable、后端模块的内部实现细节，可直接作为编码实施的依据。

### 1.2 设计约定

- 所有源文件 UTF-8 无 BOM
- TypeScript strict 模式，0 `any`
- Vue 3 Composition API + `<script setup>` 语法
- 注释解释「为什么」而非「做什么」
- CSS scoped + CSS 变量（`--neon-cyan` 等）

### 1.3 文件路径约定

```
packages/web/src/
├── views/Query.vue（改造）
├── components/
│   ├── MarkdownRenderer.vue（改造）
│   ├── ThinkingBlock.vue（新增）
│   ├── ConversationSidebar.vue（新增）
│   ├── InputToolbar.vue（新增）
│   ├── MessageActions.vue（新增）
│   ├── RefsList.vue（新增）
│   ├── FollowupsChips.vue（新增）
│   ├── ModelSelector.vue（新增）
│   ├── AttachmentUploader.vue（新增）
│   ├── TtsController.vue（新增）
│   └── RobotAvatar.vue（已有）
├── stores/
│   ├── query.ts（改造）
│   ├── conversations.ts（新增）
│   ├── model.ts（新增）
│   ├── tts.ts（新增）
│   └── attachments.ts（新增）
├── composables/
│   ├── useSSEStream.ts（改造）
│   ├── useTTS.ts（新增）
│   ├── useClipboard.ts（新增）
│   └── useImageCompress.ts（新增）
└── types.ts（改造）

services/api/src/
├── routes/
│   ├── query.ts（改造）
│   └── search.ts（新增）
├── workflows/
│   └── query-workflow.ts（改造）
├── tools/
│   └── web-search.ts（新增）
├── engine/
│   └── harness-adapter.ts（已有，不改）
└── types.ts（改造）
```

---

## 2. 前端组件详细设计

### 2.1 Query.vue（改造）

#### 2.1.1 职责

问答主视图，集成侧栏、消息区、工具栏、输入区。协调各 store 与 composables。

#### 2.1.2 模板结构

```vue
<template>
  <div class="query-page" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <!-- 左侧栏 -->
    <ConversationSidebar
      :collapsed="sidebarCollapsed"
      @toggle="toggleSidebar"
      @new-session="handleNewSession"
      @select="handleSelectConversation"
    />

    <!-- 主区域 -->
    <div class="main-area">
      <!-- 顶部条 -->
      <div class="top-bar">
        <span class="warning">AI 生成内容可能存在错误</span>
        <ModelSelector />
      </div>

      <!-- 会话头 -->
      <div class="session-header" v-if="currentConversation">
        <h3>{{ currentConversation.title }}</h3>
      </div>

      <!-- 消息区 -->
      <div ref="chatBodyRef" class="chat-body">
        <div v-if="messages.length === 0 && !streamingAnswer" class="chat-empty">
          <RobotAvatar :size="120" :floating="true" />
          <div class="empty-suggestions">
            <span class="suggestion-chip" v-for="s in suggestions" :key="s"
              @click="inputQuestion = s">{{ s }}</span>
          </div>
        </div>

        <MessageItem
          v-for="(msg, idx) in messages"
          :key="msg.id || idx"
          :message="msg"
          :index="idx"
          @regenerate="handleRegenerate"
          @archive="handleArchive"
        />

        <!-- 流式输出中 -->
        <div v-if="isLoading" class="streaming-msg">
          <ThinkingBlock :steps="currentThinking" v-if="currentThinking.length" />
          <MarkdownRenderer :content="streamingAnswer" v-if="streamingAnswer" />
          <div v-else class="loading-dots">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>

      <!-- 工具栏 -->
      <InputToolbar
        :tools="tools"
        :active-mode="activeMode"
        @select="handleToolSelect"
      />

      <!-- 输入区 -->
      <div class="input-area">
        <AttachmentUploader
          :attachments="pendingAttachments"
          @add="handleAddAttachment"
          @remove="handleRemoveAttachment"
        />
        <textarea
          v-model="inputQuestion"
          @keydown="handleKeydown"
          placeholder="输入问题，Ctrl+Enter 发送..."
        />
        <button @click="handleSubmit" :disabled="!inputQuestion.trim() || isLoading">
          发送
        </button>
      </div>
    </div>
  </div>
</template>
```

#### 2.1.3 关键逻辑

```typescript
<script setup lang="ts">
import { ref, computed, onMounted, watch, onBeforeUnmount } from 'vue';
import { useQueryStore } from '../stores/query';
import { useConversationsStore } from '../stores/conversations';
import { useModelStore } from '../stores/model';
import { useAttachmentsStore } from '../stores/attachments';
import { usePersistentState } from '../composables/usePersistentState';

const queryStore = useQueryStore();
const conversationsStore = useConversationsStore();
const modelStore = useModelStore();
const attachmentsStore = useAttachmentsStore();

// 侧栏折叠状态持久化
const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState('sidebar-collapsed', false);
const inputQuestion = ref('');
const activeMode = ref<string>('');
const pendingAttachments = ref<string[]>([]);

// 应用启动时加载历史对话 + 模型预设
onMounted(async () => {
  await conversationsStore.loadConversations();
  await modelStore.loadPresets();
});

// done 事件时持久化到 IndexedDB
watch(() => queryStore.messages.length, (newLen, oldLen) => {
  if (newLen > 0 && oldLen !== undefined) {
    conversationsStore.persistConversation(queryStore.messages);
  }
});

function handleToolSelect(mode: string) {
  activeMode.value = activeMode.value === mode ? '' : mode;
}

async function handleSubmit() {
  const q = inputQuestion.value.trim();
  if (!q || queryStore.isLoading) return;

  // flush 附件
  if (pendingAttachments.value.length > 0) {
    await attachmentsStore.flush();
  }

  queryStore.submitQuestion(q);
  inputQuestion.value = '';
  await sendQuestion(q);
}

async function sendQuestion(question: string) {
  // SSE 请求，携带 model/mode/webSearch/attachments
  const body = {
    question,
    history: queryStore.messages.map(m => ({ role: m.role, content: m.content })),
    model: modelStore.currentModel || undefined,
    mode: activeMode.value || undefined,
    webSearch: activeMode.value === 'web' || undefined,
    // flush() 返回已上传的 attachment ids 并清空 pending
    attachments: pendingAttachments.value.length > 0 ? attachmentsStore.flush() : undefined,
  };
  // ... SSE 读取逻辑同 v1，扩展 thinking/image/progress 事件处理
}
</script>
```

### 2.2 ThinkingBlock.vue（新增）

#### 2.2.1 职责

展示 AI 思考过程，可折叠/展开，显示工具调用日志。

#### 2.2.2 实现

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ThinkingStep } from '../types';

const props = defineProps<{ steps: ThinkingStep[] }>();
const expanded = ref(true);

// 折叠态摘要：已思考 N 步 · 搜索 N 次 · 阅读 N 页
const summary = computed(() => {
  const toolCalls = props.steps.filter(s => s.phase === 'tool_call');
  const searches = toolCalls.filter(s => s.tool === 'search_pages').length;
  const reads = toolCalls.filter(s => s.tool === 'read_page').length;
  return `已思考 ${props.steps.length} 步 · 搜索 ${searches} 次 · 阅读 ${reads} 页`;
});
</script>

<template>
  <div class="thinking-block" :class="{ collapsed: !expanded }">
    <div class="thinking-header" @click="expanded = !expanded">
      <span class="thinking-icon">💭</span>
      <span class="thinking-summary">{{ summary }}</span>
      <span class="toggle">{{ expanded ? '▼' : '▶' }}</span>
    </div>
    <div class="thinking-body" v-if="expanded">
      <div v-for="(step, idx) in steps" :key="idx" class="thinking-step">
        <span class="step-phase" :class="step.phase">{{ phaseLabel(step.phase) }}</span>
        <span class="step-message">{{ step.message }}</span>
        <span class="step-tool" v-if="step.tool">{{ step.tool }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.thinking-block {
  margin: 8px 0;
  padding: 8px 12px;
  background: rgba(176, 38, 255, 0.06);
  border-left: 3px solid var(--neon-purple);
  border-radius: 0 8px 8px 0;
}
.thinking-header {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-soft);
}
.thinking-body {
  margin-top: 8px;
  max-height: 200px;
  overflow-y: auto;
}
.thinking-step {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.05);
}
.step-phase {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
}
.step-phase.tool_call { background: rgba(0, 245, 255, 0.15); }
.step-phase.thinking { background: rgba(176, 38, 255, 0.15); }
.step-phase.composing { background: rgba(181, 234, 215, 0.15); }
</style>
```

### 2.3 ConversationSidebar.vue（新增）

#### 2.3.1 职责

历史对话列表 + 搜索 + 新建 + 折叠。

#### 2.3.2 实现

```vue
<script setup lang="ts">
import { computed } from 'vue';
import { useConversationsStore } from '../stores/conversations';

const props = defineProps<{ collapsed: boolean }>();
const emit = defineEmits<{
  toggle: [];
  newSession: [];
  select: [id: string];
}>();

const store = useConversationsStore();

// 过滤 + 排序：置顶在前，然后按 updatedAt 倒序
const sortedConversations = computed(() => {
  const filtered = store.searchKeyword
    ? store.conversations.filter(c => c.title.includes(store.searchKeyword))
    : store.conversations;
  return [...filtered].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
});
</script>

<template>
  <aside class="conversation-sidebar" :class="{ collapsed }">
    <div class="sidebar-header" v-if="!collapsed">
      <button class="new-btn" @click="emit('new-session')">+ 新对话</button>
      <input class="search-input" v-model="store.searchKeyword"
        placeholder="搜索对话..." />
    </div>
    <div class="conversation-list" v-if="!collapsed">
      <div v-for="conv in sortedConversations" :key="conv.id"
        class="conversation-item"
        :class="{ active: conv.id === store.currentConversationId }"
        @click="emit('select', conv.id)">
        <span class="pin-icon" v-if="conv.isPinned">📌</span>
        <div class="conv-info">
          <div class="conv-title">{{ conv.title }}</div>
          <div class="conv-time">{{ formatTime(conv.updatedAt) }}</div>
        </div>
      </div>
    </div>
    <button class="collapse-btn" @click="emit('toggle')">
      {{ collapsed ? '▶' : '◀' }}
    </button>
  </aside>
</template>
```

### 2.4 InputToolbar.vue（新增）

```vue
<script setup lang="ts">
const props = defineProps<{
  tools: Array<{ key: string; label: string; icon: string }>;
  activeMode: string;
}>();
const emit = defineEmits<{ select: [mode: string] }>();
</script>

<template>
  <div class="input-toolbar">
    <button v-for="tool in tools" :key="tool.key"
      class="tool-chip"
      :class="{ active: activeMode === tool.key }"
      @click="emit('select', tool.key)">
      <span class="tool-icon">{{ tool.icon }}</span>
      <span class="tool-label">{{ tool.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.input-toolbar {
  display: flex;
  gap: 8px;
  padding: 8px 16px;
  overflow-x: auto;
}
.tool-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: 16px;
  border: 1px solid rgba(0, 245, 255, 0.2);
  background: rgba(0, 245, 255, 0.05);
  color: var(--text-soft);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.tool-chip:hover {
  background: rgba(0, 245, 255, 0.12);
  border-color: var(--neon-cyan);
}
.tool-chip.active {
  background: rgba(0, 245, 255, 0.2);
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
}
</style>
```

### 2.5 MessageActions.vue（新增）

hover 浮窗，包含复制/朗读/重新生成/反馈。

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useClipboard } from '../composables/useClipboard';
import { useTtsStore } from '../stores/tts';

const props = defineProps<{
  message: { id: string; content: string };
  index: number;
}>();
const emit = defineEmits<{
  regenerate: [index: number];
  feedback: [index: number, type: 'up' | 'down'];
}>();

const { copy, copyPlainText } = useClipboard();
const ttsStore = useTtsStore();
const copied = ref(false);

async function handleCopyPlain() {
  await copy(copyPlainText(props.message.content));
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}

async function handleCopyMd() {
  await copy(props.message.content);
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}

function handleTts() {
  if (ttsStore.state === 'playing' && ttsStore.currentMsgId === props.message.id) {
    ttsStore.stop();
  } else {
    ttsStore.speak(props.message.content, props.message.id);
  }
}
</script>
```

### 2.6 RefsList.vue（新增）

```vue
<script setup lang="ts">
import type { Reference } from '../types';

const props = defineProps<{ refs: Reference[] }>();
const expanded = ref(true);

function handleRefClick(ref: Reference) {
  if (ref.source === 'vault' && ref.path) {
    // 跳转到知识库浏览页
    window.location.hash = `#/files?path=${encodeURIComponent(ref.path)}`;
  } else if (ref.url) {
    window.open(ref.url, '_blank', 'noopener,noreferrer');
  }
}
</script>
```

### 2.7 ModelSelector.vue（新增）

```vue
<script setup lang="ts">
import { onMounted } from 'vue';
import { useModelStore } from '../stores/model';

const store = useModelStore();

onMounted(() => store.loadPresets());

async function handleChange(key: string) {
  await store.switchModel(key);
}
</script>

<template>
  <select class="model-selector" :value="store.currentModel" @change="handleChange(($event.target as HTMLSelectElement).value)">
    <option v-for="preset in store.presets" :key="preset.key" :value="preset.key">
      {{ preset.label }}
    </option>
  </select>
</template>
```

### 2.8 AttachmentUploader.vue（新增）

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useAttachmentsStore } from '../stores/attachments';

const props = defineProps<{ attachments: string[] }>();
const emit = defineEmits<{ add: [id: string]; remove: [id: string] }>();
const store = useAttachmentsStore();
const dragOver = ref(false);

async function handleFile(file: File) {
  // 校验 MIME
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
    ElMessage.error('仅支持 jpg/png/webp/gif');
    return;
  }
  // 校验大小
  if (file.size > 10 * 1024 * 1024) {
    ElMessage.error('图片大小不能超过 10MB');
    return;
  }
  const id = await store.addImage(file);
  emit('add', id);
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
</script>
```

### 2.9 FollowupsChips.vue（改造 v1）

```vue
<script setup lang="ts">
defineProps<{ followups: string[] }>();
const emit = defineEmits<{ click: [question: string] }>();
</script>

<template>
  <div class="followups-chips" v-if="followups.length > 0">
    <span class="followups-label">💭 你可能想问：</span>
    <div class="chips-scroll">
      <button v-for="(f, i) in followups" :key="i"
        class="followup-chip"
        @click="emit('click', f)"
        :title="'点击继续追问'">
        {{ f }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.followups-chips {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.chips-scroll {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  /* 隐藏滚动条 */
}
.followup-chip {
  white-space: nowrap;
  padding: 6px 14px;
  border-radius: 16px;
  background: rgba(255, 214, 224, 0.15);
  border: 1px solid rgba(255, 214, 224, 0.3);
  color: var(--text-soft);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.followup-chip:hover {
  background: rgba(255, 214, 224, 0.25);
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
}
</style>
```

### 2.10 MarkdownRenderer.vue（改造 v1）

v1 已实现，v2 扩展图片懒加载 + 代码块语言徽章：

```typescript
// v2 新增：图片懒加载 + 点击放大
const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
});

// 自定义图片渲染：懒加载 + 点击放大
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const src = token.attrGet('src') || '';
  const alt = token.content || '';
  return `<img src="${src}" alt="${alt}" loading="lazy" 
    style="max-width:100%;border-radius:8px;cursor:pointer" 
    onclick="this.dispatchEvent(new CustomEvent('image-click',{bubbles:true,detail:{src:'${src}'}}))" />`;
};
```

#### 2.10.1 图片点击放大集成

```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import MarkdownIt from 'markdown-it';

const props = defineProps<{ content: string }>();
const md = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false });
const html = computed(() => props.content ? md.render(props.content) : '');

// 图片预览状态
const previewSrc = ref('');
const previewVisible = ref(false);
const rootRef = ref<HTMLElement | null>(null);

// 监听自定义事件实现图片预览
onMounted(() => {
  rootRef.value?.addEventListener('image-click', (e: Event) => {
    const detail = (e as CustomEvent).detail;
    previewSrc.value = detail.src;
    previewVisible.value = true;
  });
});
onBeforeUnmount(() => {
  rootRef.value?.removeEventListener('image-click');
});
</script>

<template>
  <div ref="rootRef" class="md-body" v-html="html"></div>
  <!-- Element Plus 图片预览 -->
  <el-image-viewer v-if="previewVisible" :url-list="[previewSrc]" @close="previewVisible = false" />
</template>
```

---

## 3. 前端 Store 详细设计

### 3.1 useQueryStore（改造）

```typescript
// stores/query.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ChatMessage, Reference, ThinkingStep } from '../types';

export const useQueryStore = defineStore('query', () => {
  // v1 已有
  const messages = ref<ChatMessage[]>([]);
  const streamingAnswer = ref<string>('');
  const currentRefs = ref<Reference[]>([]);  // v2: string[] → Reference[]
  const currentFollowups = ref<string[]>([]);
  const isLoading = ref(false);
  const errorMessage = ref<string>('');

  // v2 新增
  const currentThinking = ref<ThinkingStep[]>([]);
  const searchProgress = ref<{ step: string; count?: number } | null>(null);

  // v1 已有 actions（保留）
  function appendAnswer(text: string) { streamingAnswer.value += text; }
  function setRefs(refs: Reference[]) { currentRefs.value = refs; }
  function setFollowups(followups: string[]) { currentFollowups.value = followups; }

  // v2 新增 actions
  function appendThinking(step: ThinkingStep) {
    currentThinking.value.push(step);
  }
  function setProgress(step: string, count?: number) {
    searchProgress.value = { step, count };
  }
  function clearThinking() {
    currentThinking.value = [];
  }

  // 改造：finalizeAnswer 保存 thinking 历史
  function finalizeAnswer(sessionId?: string, messageIndex?: number, followups?: string[]) {
    if (streamingAnswer.value) {
      const finalFollowups = followups?.length ? followups : currentFollowups.value;
      messages.value.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: streamingAnswer.value,
        refs: currentRefs.value.length > 0 ? [...currentRefs.value] : undefined,
        followups: finalFollowups.length > 0 ? [...finalFollowups] : undefined,
        thinking: currentThinking.value.length > 0 ? [...currentThinking.value] : undefined,
        createdAt: new Date().toISOString(),
        sessionId,
        messageIndex,
      });
    }
    streamingAnswer.value = '';
    currentRefs.value = [];
    currentFollowups.value = [];
    currentThinking.value = [];
    searchProgress.value = null;
    isLoading.value = false;
  }

  function submitQuestion(question: string) {
    messages.value.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: question,
      createdAt: new Date().toISOString(),
    });
    streamingAnswer.value = '';
    currentRefs.value = [];
    currentFollowups.value = [];
    currentThinking.value = [];
    searchProgress.value = null;
    errorMessage.value = '';
    isLoading.value = true;
  }

  function handleError(message: string) {
    errorMessage.value = message;
    if (streamingAnswer.value) {
      messages.value.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: streamingAnswer.value + `\n\n[出错: ${message}]`,
        refs: currentRefs.value.length > 0 ? [...currentRefs.value] : undefined,
        createdAt: new Date().toISOString(),
      });
      streamingAnswer.value = '';
    }
    currentThinking.value = [];
    currentRefs.value = [];
    currentFollowups.value = [];
    isLoading.value = false;
  }

  function reset() {
    messages.value = [];
    streamingAnswer.value = '';
    currentRefs.value = [];
    currentFollowups.value = [];
    currentThinking.value = [];
    searchProgress.value = null;
    errorMessage.value = '';
    isLoading.value = false;
  }

  function markArchived(index: number) {
    if (messages.value[index]) {
      messages.value[index].archived = true;
    }
  }

  // v2 新增：重新生成
  function removeMessagesFrom(index: number) {
    messages.value = messages.value.slice(0, index);
  }

  // v2 新增：设置反馈
  function setFeedback(index: number, feedback: 'up' | 'down') {
    if (messages.value[index]) {
      messages.value[index].feedback = feedback;
    }
  }

  // v2 新增：从持久化数据加载
  function loadMessages(msgs: ChatMessage[]) {
    messages.value = msgs;
  }

  return {
    messages, streamingAnswer, currentRefs, currentFollowups,
    currentThinking, searchProgress, isLoading, errorMessage,
    appendAnswer, setRefs, setFollowups, appendThinking, setProgress,
    clearThinking, finalizeAnswer, submitQuestion, handleError, reset,
    markArchived, removeMessagesFrom, setFeedback, loadMessages,
  };
});
```

### 3.2 useConversationsStore（新增）

```typescript
// stores/conversations.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { openDB, type IDBPDatabase } from 'idb';
import type { ChatMessage, ConversationRecord } from '../types';

const DB_NAME = 'karpathy-wiki-chat';
const DB_VERSION = 2;
const STORE_NAME = 'conversations';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v1 → v2 迁移
        if (oldVersion < 1) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
        if (oldVersion < 2) {
          const store = db.transaction.objectStore(STORE_NAME);
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('isPinned', 'isPinned');
        }
      },
    });
  }
  return dbPromise;
}

export const useConversationsStore = defineStore('conversations', () => {
  const conversations = ref<ConversationRecord[]>([]);
  const currentConversationId = ref<string | null>(null);
  const searchKeyword = ref('');

  async function loadConversations() {
    const db = await getDB();
    const all = await db.getAll(STORE_NAME);
    conversations.value = all as ConversationRecord[];
  }

  async function persistConversation(messages: ChatMessage[]) {
    if (messages.length === 0) return;

    const id = currentConversationId.value || crypto.randomUUID();
    const existing = conversations.value.find(c => c.id === id);

    const record: ConversationRecord = {
      id,
      title: existing?.title || messages[0].content.slice(0, 30),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: messages.length,
      isPinned: existing?.isPinned || false,
      preview: messages[messages.length - 1].content.slice(0, 60),
      messages,
    };

    const db = await getDB();
    await db.put(STORE_NAME, record);

    // 更新内存列表
    const idx = conversations.value.findIndex(c => c.id === id);
    if (idx >= 0) {
      conversations.value[idx] = record;
    } else {
      conversations.value.push(record);
    }
    currentConversationId.value = id;
  }

  async function deleteConversation(id: string) {
    const db = await getDB();
    await db.delete(STORE_NAME, id);
    conversations.value = conversations.value.filter(c => c.id !== id);
    if (currentConversationId.value === id) {
      currentConversationId.value = null;
    }
  }

  async function renameConversation(id: string, title: string) {
    const db = await getDB();
    const record = await db.get(STORE_NAME, id);
    if (record) {
      record.title = title;
      await db.put(STORE_NAME, record);
      const idx = conversations.value.findIndex(c => c.id === id);
      if (idx >= 0) conversations.value[idx].title = title;
    }
  }

  async function togglePin(id: string) {
    const db = await getDB();
    const record = await db.get(STORE_NAME, id);
    if (record) {
      record.isPinned = !record.isPinned;
      await db.put(STORE_NAME, record);
      const idx = conversations.value.findIndex(c => c.id === id);
      if (idx >= 0) conversations.value[idx].isPinned = record.isPinned;
    }
  }

  async function selectConversation(id: string) {
    currentConversationId.value = id;
    // 加载会话消息到 query store
    const db = await getDB();
    const record = await db.get(STORE_NAME, id);
    if (record) {
      const { useQueryStore } = await import('./query');
      useQueryStore().loadMessages(record.messages);
    }
  }

  function startNewConversation() {
    currentConversationId.value = null;
  }

  return {
    conversations, currentConversationId, searchKeyword,
    loadConversations, persistConversation, deleteConversation,
    renameConversation, togglePin, selectConversation, startNewConversation,
  };
});
```

### 3.3 useModelStore（新增）

```typescript
// stores/model.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { LlmPreset } from '../types';

export const useModelStore = defineStore('model', () => {
  const currentModel = ref<string>(localStorage.getItem('selectedModel') || '');
  const presets = ref<LlmPreset[]>([]);

  async function loadPresets() {
    const res = await fetch('/api/ai/presets');
    if (res.ok) {
      presets.value = await res.json();
      // 若未选择或选择的模型不在预设中，取第一个
      if (!currentModel.value || !presets.value.find(p => p.key === currentModel.value)) {
        currentModel.value = presets.value[0]?.key || '';
      }
    }
  }

  async function switchModel(key: string) {
    currentModel.value = key;
    localStorage.setItem('selectedModel', key);
    // 调用后端即时生效（与概要设计 §2.3.3 一致）
    await fetch('/api/ai/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: key }),
    });
  }

  return { currentModel, presets, loadPresets, switchModel };
});
```

### 3.4 useTtsStore（新增）

```typescript
// stores/tts.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useTTS } from '../composables/useTTS';

export const useTtsStore = defineStore('tts', () => {
  const state = ref<'idle' | 'playing' | 'paused'>('idle');
  const currentMsgId = ref<string | null>(null);
  const { speak: ttsSpeak, pause: ttsPause, resume: ttsResume, stop: ttsStop } = useTTS();

  function speak(text: string, msgId: string) {
    // 切换到新消息时停止当前朗读
    if (currentMsgId.value && currentMsgId.value !== msgId) {
      ttsStop();
    }
    currentMsgId.value = msgId;
    state.value = 'playing';
    ttsSpeak(text);
  }

  function pause() {
    ttsPause();
    state.value = 'paused';
  }

  function resume() {
    ttsResume();
    state.value = 'playing';
  }

  function stop() {
    ttsStop();
    state.value = 'idle';
    currentMsgId.value = null;
  }

  return { state, currentMsgId, speak, pause, resume, stop };
});
```

### 3.5 useAttachmentsStore（新增）

```typescript
// stores/attachments.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { openDB } from 'idb';
import { useImageCompress } from '../composables/useImageCompress';

const DB_NAME = 'karpathy-wiki-chat';
const STORE_NAME = 'attachments';

export const useAttachmentsStore = defineStore('attachments', () => {
  const pendingIds = ref<string[]>([]);

  async function addImage(file: File): Promise<string> {
    const { compress, generateThumbnail } = useImageCompress();

    // 压缩到 ≤ 2MB
    const compressed = await compress(file, 2);
    // 生成缩略图
    const thumbnail = await generateThumbnail(compressed, 200);

    const id = crypto.randomUUID();
    const db = await openDB(DB_NAME, 2);
    await db.put(STORE_NAME, {
      id,
      filename: file.name,
      mimeType: file.type,
      size: compressed.size,
      blob: compressed,
      thumbnail,
    });

    pendingIds.value.push(id);
    return id;
  }

  function remove(id: string) {
    pendingIds.value = pendingIds.value.filter(i => i !== id);
  }

  async function getThumbnail(id: string): Promise<Blob | null> {
    const db = await openDB(DB_NAME, 2);
    const record = await db.get(STORE_NAME, id);
    return record?.thumbnail || null;
  }

  function flush() {
    // 提交问答时调用，清空 pending（已存入 IndexedDB）
    const ids = [...pendingIds.value];
    pendingIds.value = [];
    return ids;
  }

  return { pendingIds, addImage, remove, getThumbnail, flush };
});
```

---

## 4. 前端 Composables 详细设计

### 4.1 useTTS.ts（新增）

```typescript
// composables/useTTS.ts
import { ref } from 'vue';

export function useTTS() {
  const utterance = ref<SpeechSynthesisUtterance | null>(null);
  const state = ref<'idle' | 'playing' | 'paused'>('idle');

  // 剥离 Markdown 语法，生成纯净文本供朗读
  function stripMarkdown(md: string): string {
    return md
      .replace(/```[\s\S]*?```/g, '代码块')  // 代码块替换为"代码块"
      .replace(/`([^`]+)`/g, '$1')         // 行内代码保留内容
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片保留 alt
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // 链接保留文本
      .replace(/^#+\s*/gm, '')               // 标题符号
      .replace(/\*\*([^*]+)\*\*/g, '$1')     // 粗体
      .replace(/\*([^*]+)\*/g, '$1')         // 斜体
      .replace(/^>\s*/gm, '')                 // 引用
      .replace(/^[-*+]\s*/gm, '')            // 列表
      .replace(/^\d+\.\s*/gm, '')            // 有序列表
      .replace(/\|/g, ' ')                   // 表格
      .replace(/^-+$/gm, '')                 // 分割线
      .trim();
  }

  function speak(text: string, lang = 'zh-CN') {
    if (!('speechSynthesis' in window)) {
      console.warn('浏览器不支持语音合成');
      return;
    }
    speechSynthesis.cancel();  // 停止当前朗读

    const cleanText = stripMarkdown(text);
    const u = new SpeechSynthesisUtterance(cleanText);
    u.lang = lang;
    u.rate = 1.0;

    // 选择对应语言的 voice
    const voices = speechSynthesis.getVoices();
    const voice = voices.find(v => v.lang === lang) || voices.find(v => v.lang.startsWith(lang.split('-')[0]));
    if (voice) u.voice = voice;

    u.onend = () => { state.value = 'idle'; };
    u.onerror = () => { state.value = 'idle'; };

    utterance.value = u;
    speechSynthesis.speak(u);
    state.value = 'playing';
  }

  function pause() { speechSynthesis.pause(); state.value = 'paused'; }
  function resume() { speechSynthesis.resume(); state.value = 'playing'; }
  function stop() { speechSynthesis.cancel(); state.value = 'idle'; }

  return { state, speak, pause, resume, stop };
}
```

### 4.2 useClipboard.ts（新增）

```typescript
// composables/useClipboard.ts
export function useClipboard() {
  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 降级：document.execCommand('copy')（非 HTTPS 环境）
      return fallbackCopy(text);
    }
  }

  function fallbackCopy(text: string): boolean {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  }

  // 剥离 Markdown，生成纯文本
  function copyPlainText(md: string): string {
    return md
      .replace(/```[\s\S]*?```/g, '代码块')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#+\s*/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .trim();
  }

  return { copy, copyPlainText };
}
```

### 4.3 useImageCompress.ts（新增）

```typescript
// composables/useImageCompress.ts
export function useImageCompress() {
  // canvas 压缩图片到指定大小以内
  async function compress(file: File, maxSizeMB: number): Promise<Blob> {
    if (file.size <= maxSizeMB * 1024 * 1024) {
      return file;  // 已在限制内，无需压缩
    }

    const img = await loadImage(file);
    const canvas = document.createElement('canvas');
    let { width, height } = calculateSize(img.width, img.height, 1920);

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, width, height);

    // 逐步降低质量直到满足大小
    let quality = 0.9;
    let blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    while (blob.size > maxSizeMB * 1024 * 1024 && quality > 0.1) {
      quality -= 0.1;
      blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    }
    return blob;
  }

  async function generateThumbnail(blob: Blob, size: number): Promise<Blob> {
    const img = await loadImage(blob);
    const canvas = document.createElement('canvas');
    const { width, height } = calculateSize(img.width, img.height, size);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, width, height);
    return canvasToBlob(canvas, 'image/jpeg', 0.8);
  }

  function loadImage(src: File | Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(src);
    });
  }

  function calculateSize(origW: number, origH: number, maxSide: number) {
    if (origW > origH) {
      return { width: maxSide, height: Math.round(origH * (maxSide / origW)) };
    }
    return { width: Math.round(origW * (maxSide / origH)), height: maxSide };
  }

  function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob!), type, quality));
  }

  return { compress, generateThumbnail };
}
```

---

## 5. 后端详细设计

### 5.1 routes/query.ts（改造）

```typescript
// services/api/src/routes/query.ts
import { FastifyInstance } from 'fastify';
import { queryWorkflow } from '../workflows/query-workflow';
import { engineAdapter } from '../engine/harness-adapter';
import { config } from '../config';

export async function queryRoutes(fastify: FastifyInstance) {
  fastify.post('/api/query', async (request, reply) => {
    const { question, history, model, mode, webSearch, attachments } = request.body;

    // 模型切换：若请求携带 model，调用 engineAdapter.updateConfig 即时生效
    if (model && model !== config.llm.model) {
      engineAdapter.updateConfig({ model });
    }

    // SSE 头
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    // SSE 发送辅助函数
    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await queryWorkflow(
        { question, history, mode, webSearch, attachments },
        {
          onThinking: (phase, message, tool?, args?) =>
            send('thinking', { phase, message, tool, args }),
          onAnswer: (text) => send('answer', { text }),
          onImage: (url, alt, width?, height?) =>
            send('image', { url, alt, width, height }),
          onRefs: (refs) => send('refs', { refs }),
          onProgress: (step, count?) => send('progress', { step, count }),
          onFollowups: (followups) => send('followups', { followups }),
          onDone: (sessionId, messageIndex, followups?) =>
            send('done', { sessionId, messageIndex, followups }),
        }
      );
    } catch (err) {
      send('error', { message: (err as Error).message, code: 'QUERY_FAILED' });
    }
  });

  // v1 已有：归档路由
  fastify.post('/api/query/archive', async (request, reply) => {
    // ... v1 实现
  });
}
```

### 5.2 workflows/query-workflow.ts（改造）

```typescript
// services/api/src/workflows/query-workflow.ts

interface QueryOptions {
  mode?: string;
  webSearch?: boolean;
  attachments?: string[];
}

interface QueryCallbacks {
  onThinking: (phase: string, message: string, tool?: string, args?: Record<string, unknown>) => void;
  onAnswer: (text: string) => void;
  onImage: (url: string, alt: string, width?: number, height?: number) => void;
  onRefs: (refs: Reference[]) => void;
  onProgress: (step: string, count?: number) => void;
  onFollowups: (followups: string[]) => void;
  onDone: (sessionId: string, messageIndex: number, followups?: string[]) => void;
}

export async function queryWorkflow(
  input: { question: string; history: ChatMessage[] },
  options: QueryOptions,
  callbacks: QueryCallbacks
) {
  const { question, history } = input;
  const lockKey = question.slice(0, 32);
  const release = await sessionLock.acquire(lockKey);

  try {
    // 首选：queryWithHarness
    await queryWithHarness(question, history, options, callbacks);
  } catch (err) {
    // 降级：queryWithSearchFallback
    callbacks.onThinking('composing', '降级搜索中...');
    try {
      await queryWithSearchFallback(question, history, callbacks);
    } catch (err2) {
      // 兜底
      callbacks.onAnswer('抱歉，问答服务暂时不可用，请稍后重试。');
      callbacks.onDone('', 0);
    }
  } finally {
    release();
  }
}

async function queryWithHarness(
  question: string,
  history: ChatMessage[],
  options: QueryOptions,
  callbacks: QueryCallbacks
) {
  callbacks.onThinking('thinking', '正在思考...');

  // 构建工具列表
  const tools = [searchPagesTool, readPageTool];
  if (options.webSearch) {
    tools.push(createWebSearchTool(config.webSearch));
  }

  // ReAct 循环
  for await (const step of harness.run(question, history, tools)) {
    switch (step.type) {
      case 'tool_call':
        callbacks.onThinking('tool_call', `正在调用：${step.tool}`, step.tool, step.args);
        break;
      case 'tool_result':
        if (step.tool === 'web_search') {
          callbacks.onProgress('done', step.results.length);
        }
        break;
      case 'answer_chunk':
        callbacks.onAnswer(step.text);
        break;
      case 'image':
        callbacks.onImage(step.url, step.alt, step.width, step.height);
        break;
    }
  }

  // 推送 refs + followups + done
  const { content, refs, followups } = parseAnswerAndRefs(answerBuffer);
  if (refs.length > 0) callbacks.onRefs(refs);
  if (followups.length > 0) callbacks.onFollowups(followups);
  callbacks.onDone(sessionId, messageIndex, followups);
}
```

### 5.3 tools/web-search.ts（新增）

```typescript
// services/api/src/tools/web-search.ts

interface WebSearchConfig {
  provider: 'tavily' | 'bing';
  apiKey: string;
  maxResults?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function createWebSearchTool(config: WebSearchConfig) {
  return {
    name: 'web_search',
    description: '搜索互联网实时信息。返回摘要 + URL。',
    parameters: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '返回结果数，默认 5' },
      },
      required: ['query'],
    },
    handler: async (args: { query: string; limit?: number }): Promise<SearchResult[]> => {
      const limit = args.limit || config.maxResults || 5;
      if (config.provider === 'tavily') {
        return tavilySearch(config.apiKey, args.query, limit);
      }
      return bingSearch(config.apiKey, args.query, limit);
    },
  };
}

async function tavilySearch(apiKey: string, query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily API error: ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

async function bingSearch(apiKey: string, query: string, count: number): Promise<SearchResult[]> {
  const res = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${count}`, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
  });
  if (!res.ok) throw new Error(`Bing API error: ${res.status}`);
  const data = await res.json();
  return (data.webPages?.value || []).map((r: any) => ({
    title: r.name,
    url: r.url,
    snippet: r.snippet,
  }));
}
```

### 5.4 routes/search.ts（新增）

```typescript
// services/api/src/routes/search.ts
import { FastifyInstance } from 'fastify';
import { createWebSearchTool } from '../tools/web-search';
import { config } from '../config';

export async function searchRoutes(fastify: FastifyInstance) {
  // 直接调用联网搜索（不经过 LLM）
  fastify.post('/api/search/web', async (request, reply) => {
    const { query, limit } = request.body as { query: string; limit?: number };

    if (!config.webSearch?.apiKey) {
      return reply.code(400).send({ error: '搜索 API Key 未配置' });
    }

    try {
      const tool = createWebSearchTool({
        provider: config.webSearch.provider,
        apiKey: config.webSearch.apiKey,
        maxResults: limit,
      });
      const results = await tool.handler({ query, limit });
      return { results };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
```

---

## 6. 数据持久化详细设计

### 6.1 IndexedDB Schema

```
Database: karpathy-wiki-chat
Version: 2

Object Store: conversations (keyPath: id)
  索引:
    - updatedAt（按时间排序）
    - isPinned（置顶筛选）

Object Store: attachments (keyPath: id)
  索引:
    - conversationId（按会话查询附件）

Object Store: preferences (keyPath: key)
  存储: sidebarCollapsed, selectedModel, ttsRate 等
```

### 6.2 迁移函数

```typescript
// 应用启动时执行
async function migrateV1ToV2() {
  const db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        // 全新安装
        db.createObjectStore('conversations', { keyPath: 'id' });
        db.createObjectStore('attachments', { keyPath: 'id' });
        db.createObjectStore('preferences', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        // v1 → v2 迁移：添加索引
        const convStore = db.transaction.objectStore('conversations');
        convStore.createIndex('updatedAt', 'updatedAt');
        convStore.createIndex('isPinned', 'isPinned');
      }
    },
  });

  // 数据迁移：v1 ChatMessage → v2 ChatMessage
  const allConversations = await db.getAll('conversations');
  for (const conv of allConversations) {
    let needsMigration = false;
    conv.messages = conv.messages.map((msg: any) => {
      if (!msg.id) {
        needsMigration = true;
        return migrateV1Message(msg);
      }
      return msg;
    });
    if (needsMigration) {
      await db.put('conversations', conv);
    }
  }
}

function migrateV1Message(msg: any): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: msg.role,
    content: msg.content,
    // v1 refs 是 string[]，v2 升级为 Reference[]
    refs: msg.refs?.map((path: string, i: number) => ({
      path,
      title: path.split('/').pop() || path,
      snippet: '',
      source: 'vault' as const,
      citeIndex: i + 1,
    })),
    followups: msg.followups,
    sessionId: msg.sessionId,
    messageIndex: msg.messageIndex,
    archived: msg.archived,
    createdAt: new Date().toISOString(),
  };
}
```

---

## 7. SSE 事件流详细设计

### 7.1 完整事件序列

```
[前端 POST /api/query]
  ↓
[后端 queryWorkflow 开始]
  ↓
thinking { phase: 'thinking', message: '正在思考...' }
  ↓
thinking { phase: 'tool_call', message: '正在搜索：LLM Wiki', tool: 'search_pages' }
  ↓
thinking { phase: 'tool_call', message: '正在阅读：harness.md', tool: 'read_page' }
  ↓
[若开启联网搜索]
progress { step: 'searching' }
progress { step: 'done', count: 5 }
  ↓
answer { text: 'LLM Wiki 是一种...' }  (流式多次)
answer { text: '...' }
  ↓
refs { refs: [...] }
  ↓
followups { followups: ['LLM Wiki 如何保证质量？', ...] }
  ↓
done { sessionId: 'xxx', messageIndex: 0, followups: [...] }
  ↓
[前端 finalizeAnswer → persistConversation]
```

### 7.2 降级场景事件序列

```
[queryWithHarness 失败]
  ↓
thinking { phase: 'composing', message: '降级搜索中...' }
  ↓
[queryWithSearchFallback]
answer { text: '...' }  (单轮 LLM)
  ↓
refs { refs: [...] }
done { sessionId: 'xxx', messageIndex: 0 }
```

### 7.3 错误场景事件序列

```
[全链路失败]
  ↓
error { message: '问答服务不可用', code: 'QUERY_FAILED' }
```

---

## 8. 样式详细设计

### 8.1 CSS 变量

沿用 v1 macaron 主题：

```css
:root {
  --neon-cyan: #00f5ff;
  --neon-purple: #b026ff;
  --text-base: #e0e0e0;
  --text-soft: #b0b0b0;
  --text-dim: #707070;
  --font-mono: 'JetBrains Mono', monospace;
  --blur: blur(20px);
}
```

### 8.2 新增组件样式

| 组件 | 样式要点 |
| --- | --- |
| ThinkingBlock | 紫色左边框 + 半透明背景 + 折叠动画 |
| ConversationSidebar | 玻璃质感 + 280px/60px/0px 三态 |
| InputToolbar | chip 横排 + hover 玻璃光泽 |
| MessageActions | hover 浮窗 + 玻璃模糊 |
| RefsList | 卡片式 + 来源徽章（vault 青/web 蓝） |
| FollowupsChips | 横向滚动 + 淡粉背景 |

### 8.3 响应式断点

```css
/* ≥ 1280px：完整布局 */
/* 1024-1280px：侧栏默认折叠 */
@media (max-width: 1280px) {
  .conversation-sidebar { width: 60px; }
}

/* 768-1024px：侧栏默认隐藏 */
@media (max-width: 1024px) {
  .conversation-sidebar { width: 0; }
}

/* < 768px：仅阅读模式 */
@media (max-width: 768px) {
  .input-area { display: none; }
}
```

---

## 9. 错误处理详细设计

### 9.1 前端错误处理

| 场景 | 处理 |
| --- | --- |
| SSE 连接中断 | 保留已接收答案到 store，显示"连接中断"徽章 + 重试按钮 |
| 模型切换时 in-flight | 等待 done/error 后再切换 |
| 图片上传失败 | Toast 提示 + 移除 pending |
| TTS 不支持 | 按钮灰显 + tooltip |
| 剪贴板不可用 | 降级 execCommand('copy') |
| IndexedDB 满 | Toast 提示清理旧对话 |
| IndexedDB 迁移失败 | 降级只读模式 + 提示导出 |

#### 9.1.1 SSE 中断重连实现

```typescript
// composables/useSSEStream.ts 中扩展
function handleStreamError(error: Error) {
  // 保留已接收的流式答案到 store（不丢失部分结果）
  if (queryStore.streamingAnswer) {
    queryStore.finalizeAnswer();  // 保留部分答案为 assistant 消息
  }
  queryStore.errorMessage = '连接中断，请重试';
  queryStore.isLoading = false;
  // UI 层根据 errorMessage 显示重试按钮（Query.vue 中监听）
}

// Query.vue 中监听 errorMessage 显示重试 UI
const showRetry = computed(() => queryStore.errorMessage.includes('连接中断'));

function handleRetry() {
  // 重新发送最后一条 user 问题
  const lastUserMsg = queryStore.messages.findLast(m => m.role === 'user');
  if (lastUserMsg) {
    queryStore.removeMessagesFrom(queryStore.messages.length - 1);  // 移除部分答案
    queryStore.submitQuestion(lastUserMsg.content);
    void sendQuestion(lastUserMsg.content);
  }
}
```

### 9.2 后端错误处理

| 场景 | 处理 |
| --- | --- |
| LLM API 超时 | 降级到 queryWithSearchFallback |
| 联网搜索超时（>5s） | 仅返回 vault refs + Toast「联网超时」 |
| 搜索 API Key 未配置 | 返回 400 + 提示配置 |
| 图片 MIME 伪造 | 拒绝 + 400 |
| per-session Lock 冲突 | 排队等待 |

---

## 10. 附录

### 10.1 类型定义汇总

```typescript
// types.ts 扩展

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  refs?: Reference[];
  followups?: string[];
  thinking?: ThinkingStep[];
  attachments?: string[];
  feedback?: 'up' | 'down' | null;
  createdAt: string;
  sessionId?: string;
  messageIndex?: number;
  archived?: boolean;
}

interface Reference {
  url?: string;
  title: string;
  path?: string;
  snippet: string;
  source: 'vault' | 'web';
  citeIndex: number;
}

interface ThinkingStep {
  phase: 'thinking' | 'tool_call' | 'composing';
  message: string;
  tool?: string;
  args?: Record<string, unknown>;
  ts: string;
}

interface ConversationRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  isPinned: boolean;
  preview: string;
  messages: ChatMessage[];
}

interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  blob: Blob;
  thumbnail: Blob;
}
```

### 10.2 修订历史

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| V1.0.0 | 2026-07-11 | 初版 |
| V1.0.1 | 2026-07-11 | 按评审报告修正：①useModelStore 调用后端即时生效（P0-1）；②routes/query.ts 补充 engineAdapter 导入（P0-2）；③sendQuestion 使用 flush() 返回值（P1-1）；④补充 SSE 中断重连实现（P1-3）；⑤selectConversation 补充 loadMessages（P2-2）；⑥MarkdownRenderer 图片点击放大集成（P2-4） |

---

## 阶段交接声明

- 当前阶段：详细设计 V1.0.0 ✅ 已完成
- 下一阶段：实施计划
- 下一阶段智能体：wiki-code-dev
- 下一阶段技能：wiki-code-dev
- 交接上下文：本文档涵盖 11 个前端组件 + 5 个 store + 3 个 composable + 4 个后端模块的详细实现，可直接作为编码依据。
