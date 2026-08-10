<script setup lang="ts">
// 移动端「投递采集」页（SRS FR-ING）。
// 复用 useCompileStore 的状态机（prepareCompile + handleEvent）维护进度/时间线/生成页面，
// 自行消费 /api/compile 的 SSE 流（经 apiFetch 注入 Bearer token，避免 useSSEStream 裸 fetch 无鉴权）。
// 三种投递方式：链接(url) / 文字(text) / 文件(file，multipart)。
import { ref } from 'vue';
import { apiFetch, API_BASE } from '../../utils/apiBase';
import { useCompileStore } from '../../stores/compile';
import type { IngestPayload } from '../../types';

const store = useCompileStore();

type Mode = 'url' | 'text' | 'file';
const mode = ref<Mode>('url');

const urlInput = ref('');
const textInput = ref('');
const selectedFile = ref<File | null>(null);
const formErr = ref('');

let abortCtl: AbortController | null = null;

const ALLOWED_EXT = '.md,.txt,.pdf,.html,.json,.docx,.xlsx,.pptx,.doc,.xls';

function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  selectedFile.value = target.files && target.files.length ? target.files[0] : null;
  formErr.value = '';
}

// 消费 /api/compile 的 SSE 流，逐事件转发给 store.handleEvent（单文件模式：progress/page/done/error）
async function runCompile(payload: IngestPayload) {
  store.prepareCompile(payload);
  formErr.value = '';
  abortCtl = new AbortController();

  try {
    const init: RequestInit = { method: 'POST', signal: abortCtl.signal };
    // FormData 让浏览器自动设置 multipart boundary；JSON 由 apiFetch 自动补 Content-Type
    init.body = payload instanceof FormData ? payload : JSON.stringify(payload);

    const res = await apiFetch(`${API_BASE}/compile`, init);
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      store.handleEvent('error', { message: `HTTP ${res.status}: ${msg || res.statusText}` });
      return;
    }
    const reader = res.body?.getReader();
    if (!reader) {
      store.handleEvent('error', { message: '无法读取响应流' });
      return;
    }

    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      let ev = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          ev = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          try {
            store.handleEvent(ev, JSON.parse(line.slice(6)));
          } catch {
            // 跳过无法解析的行
          }
          ev = '';
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // 用户主动取消，store.cancelCompile 已在 cancel() 调用
    } else {
      store.handleEvent('error', { message: (err as Error).message });
    }
  } finally {
    abortCtl = null;
  }
}

function submit() {
  if (store.isCompiling) return;
  formErr.value = '';
  if (mode.value === 'url') {
    const c = urlInput.value.trim();
    if (!c) { formErr.value = '请输入链接'; return; }
    void runCompile({ type: 'url', content: c });
  } else if (mode.value === 'text') {
    const c = textInput.value.trim();
    if (!c) { formErr.value = '请输入内容'; return; }
    void runCompile({ type: 'text', content: c });
  } else {
    if (!selectedFile.value) { formErr.value = '请选择文件'; return; }
    const fd = new FormData();
    fd.append('file', selectedFile.value, selectedFile.value.name);
    void runCompile(fd);
  }
}

function cancel() {
  abortCtl?.abort();
  store.cancelCompile();
}

function resetAll() {
  store.reset();
  urlInput.value = '';
  textInput.value = '';
  selectedFile.value = null;
}

// 已生成页面点击 → 跳转到浏览页查看（复用 MobileShell 监听的 karpathy:jump-vault 事件）
function openPage(path: string) {
  window.dispatchEvent(new CustomEvent('karpathy:jump-vault', { detail: { path } }));
}
</script>

<template>
  <div class="mi-root">
    <!-- 方式切换 -->
    <div class="mi-seg">
      <button :class="{ on: mode === 'url' }" @click="mode = 'url'">链接</button>
      <button :class="{ on: mode === 'text' }" @click="mode = 'text'">文字</button>
      <button :class="{ on: mode === 'file' }" @click="mode = 'file'">文件</button>
    </div>

    <!-- 表单（非编译中展示） -->
    <div v-if="!store.isCompiling && !store.isDone" class="mi-form">
      <label v-if="mode === 'url'" class="mi-field">
        <span class="mi-label">网页链接</span>
        <input
          v-model="urlInput"
          class="mi-input"
          type="url"
          inputmode="url"
          placeholder="https://…"
        />
      </label>

      <label v-else-if="mode === 'text'" class="mi-field">
        <span class="mi-label">粘贴文字 / 笔记</span>
        <textarea
          v-model="textInput"
          class="mi-textarea"
          rows="6"
          placeholder="把要入库的内容粘贴到这里…"
        />
      </label>

      <label v-else class="mi-field">
        <span class="mi-label">选择文件</span>
        <input
          class="mi-file"
          type="file"
          :accept="ALLOWED_EXT"
          @change="onFileChange"
        />
        <span v-if="selectedFile" class="mi-file-name">{{ selectedFile.name }}</span>
        <span v-else class="mi-hint">支持 md/txt/pdf/html/json/docx/xlsx/pptx 等</span>
      </label>

      <p v-if="formErr" class="mi-form-err">{{ formErr }}</p>

      <button class="mi-submit" @click="submit">投递入库</button>
    </div>

    <!-- 进度面板（编译中） -->
    <div v-else-if="store.isCompiling" class="mi-progress">
      <div class="mi-step">
        <span class="mi-spinner" />
        {{ store.stepLabel(store.currentStep) || '处理中…' }}
      </div>
      <div class="mi-bar">
        <div class="mi-bar-fill" :style="{ width: store.progressPercentage + '%' }" />
      </div>
      <p class="mi-pct">{{ store.progressPercentage }}%</p>
      <ul class="mi-timeline">
        <li v-for="(t, i) in store.timeline" :key="i" class="mi-tl-item">
          <span class="mi-tl-dot" :class="'st-' + t.status" />
          <span class="mi-tl-msg">{{ t.message || store.stepLabel(t.step) }}</span>
        </li>
      </ul>
      <button class="mi-cancel" @click="cancel">取消投递</button>
    </div>

    <!-- 结果面板（完成/错误/取消） -->
    <div v-else class="mi-result">
      <div
        class="mi-result-head"
        :class="{ ok: store.isDone && !store.errorMessage, err: !!store.errorMessage, cancel: store.isCancelled }"
      >
        <template v-if="store.isCancelled">已取消投递</template>
        <template v-else-if="store.errorMessage">投递失败</template>
        <template v-else>投递完成</template>
      </div>

      <p v-if="store.doneMessage" class="mi-done-msg">{{ store.doneMessage }}</p>
      <p v-if="store.errorMessage" class="mi-err-msg">{{ store.errorMessage }}</p>

      <div v-if="store.generatedPages.length" class="mi-pages">
        <p class="mi-pages-title">已生成页面</p>
        <button
          v-for="(p, i) in store.generatedPages"
          :key="i"
          class="mi-page"
          @click="openPage(p.path)"
        >
          <span class="mi-page-icon">📄</span>
          <span class="mi-page-title">{{ p.title }}</span>
          <span class="mi-page-go">查看 ›</span>
        </button>
      </div>

      <button class="mi-again" @click="resetAll">再投一篇</button>
    </div>
  </div>
</template>

<style scoped>
.mi-root {
  padding: 14px 14px 16px;
  font-family: var(--font-body);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 方式切换 */
.mi-seg {
  display: flex;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 12px;
  padding: 4px;
  gap: 4px;
}
.mi-seg button {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-soft);
  font-size: 14px;
  font-weight: 600;
  padding: 8px 0;
  border-radius: 9px;
  cursor: pointer;
  transition: all 0.2s ease;
  font-family: var(--font-body);
}
.mi-seg button.on {
  background: var(--grad-fire, linear-gradient(135deg, #ff006e, #8338ec));
  color: #fff;
  box-shadow: 0 2px 10px rgba(255, 0, 110, 0.3);
}

/* 表单 */
.mi-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mi-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-soft);
}
.mi-input,
.mi-textarea {
  width: 100%;
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  background: rgba(0, 0, 0, 0.35);
  color: var(--text-bright);
  border-radius: 10px;
  padding: 11px 12px;
  font-size: 14px;
  font-family: var(--font-body);
  outline: none;
  box-sizing: border-box;
}
.mi-textarea {
  resize: vertical;
  line-height: 1.6;
}
.mi-input:focus,
.mi-textarea:focus {
  border-color: var(--neon-cyan);
  box-shadow: 0 0 0 2px rgba(0, 245, 255, 0.15);
}
.mi-file {
  width: 100%;
  font-size: 13px;
  color: var(--text-soft);
}
.mi-file-name {
  font-size: 13px;
  color: var(--neon-cyan);
  word-break: break-all;
}
.mi-hint {
  font-size: 12px;
  color: var(--text-soft);
}
.mi-form-err {
  color: #ffb4c4;
  font-size: 12px;
  margin: 0;
}
.mi-submit {
  margin-top: 4px;
  height: 44px;
  border: none;
  border-radius: 12px;
  background: var(--grad-aurora, linear-gradient(135deg, #00f5ff, #8338ec));
  color: #04121a;
  font-size: 15px;
  font-weight: 800;
  cursor: pointer;
  letter-spacing: 1px;
}
.mi-submit:active {
  transform: scale(0.985);
}

/* 进度 */
.mi-progress {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mi-step {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
}
.mi-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(0, 245, 255, 0.3);
  border-top-color: var(--neon-cyan);
  border-radius: 50%;
  animation: mi-spin 0.8s linear infinite;
}
@keyframes mi-spin {
  to { transform: rotate(360deg); }
}
.mi-bar {
  height: 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.4);
  overflow: hidden;
  border: 1px solid var(--accent-purple-a30);
}
.mi-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--neon-cyan), #8338ec);
  transition: width 0.4s ease;
}
.mi-pct {
  margin: 0;
  font-size: 12px;
  color: var(--text-soft);
  text-align: right;
}
.mi-timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 40vh;
  overflow-y: auto;
}
.mi-tl-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  color: var(--text-soft);
}
.mi-tl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 5px;
  flex-shrink: 0;
  background: var(--text-soft);
}
.mi-tl-dot.st-done {
  background: var(--neon-cyan);
}
.mi-tl-dot.st-running {
  background: #ffb020;
}
.mi-tl-dot.st-error {
  background: #ff4060;
}
.mi-cancel {
  margin-top: 4px;
  height: 40px;
  border: 1px solid rgba(255, 62, 165, 0.4);
  background: transparent;
  color: var(--neon-magenta, #ff3ea5);
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

/* 结果 */
.mi-result {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mi-result-head {
  font-size: 17px;
  font-weight: 800;
  text-align: center;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid var(--accent-purple-a30);
}
.mi-result-head.ok {
  color: var(--neon-cyan);
  background: rgba(0, 245, 255, 0.08);
}
.mi-result-head.err {
  color: #ff6b8a;
  background: rgba(255, 0, 80, 0.1);
  border-color: rgba(255, 0, 80, 0.3);
}
.mi-result-head.cancel {
  color: var(--neon-magenta, #ff3ea5);
  background: rgba(255, 62, 165, 0.08);
}
.mi-done-msg,
.mi-err-msg {
  margin: 0;
  font-size: 13px;
  color: var(--text-soft);
  text-align: center;
}
.mi-err-msg {
  color: #ffb4c4;
}
.mi-pages {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mi-pages-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-soft);
  margin: 0;
}
.mi-page {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  background: var(--bg-glass, rgba(20, 8, 40, 0.55));
  border-radius: 12px;
  padding: 10px 12px;
  cursor: pointer;
  text-align: left;
  font-family: var(--font-body);
  color: var(--text-bright);
}
.mi-page:active {
  border-color: var(--neon-cyan);
}
.mi-page-icon {
  font-size: 18px;
}
.mi-page-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mi-page-go {
  font-size: 12px;
  color: var(--neon-cyan);
  flex-shrink: 0;
}
.mi-again {
  margin-top: 2px;
  height: 44px;
  border: none;
  border-radius: 12px;
  background: var(--grad-aurora, linear-gradient(135deg, #00f5ff, #8338ec));
  color: #04121a;
  font-size: 15px;
  font-weight: 800;
  cursor: pointer;
  letter-spacing: 1px;
}
.mi-again:active {
  transform: scale(0.985);
}
</style>
