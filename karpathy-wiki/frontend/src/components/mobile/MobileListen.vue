<script setup lang="ts">
// 移动端「聆听」播放器（SRS FR-LIS，TTS 播客模式）。
// 独立于桌面端 useTtsStore（单条消息朗读模型），自实现「播放列表 + 顺序播放 + 后台播放」。
// 复用：apiFetch+API_BASE（注入 token）、loadTtsConfig（per-user voice/rate）、/api/files/pages 内容源、/api/tts/synthesize 合成。
// 合成策略：POST /api/tts/synthesize → MP3 blob → <audio>.src（后端该端点返回 audio/mpeg，前端用 blob 播放最稳）。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { apiFetch, API_BASE } from '../../utils/apiBase';
import { loadTtsConfig } from '../../services/ttsConfig';
import { useAuthStore } from '../../stores/auth';
import MarkdownRenderer from '../MarkdownRenderer.vue';
import type { PageItem } from '../../types';

const authStore = useAuthStore();

interface QueueItem {
  path: string;
  title: string;
  body: string;
}

const pages = ref<PageItem[]>([]);
const queue = ref<QueueItem[]>([]);
const currentIndex = ref(-1);
const isPlaying = ref(false);
const position = ref(0);
const duration = ref(0);
const speed = ref(1);
const loading = ref(false);
const errorMsg = ref('');
const synthWarn = ref('');
const SPEEDS = [0.75, 1, 1.25, 1.5];

// 预览视图（点击标题进入，查看文章正文文字；与播放/入列解耦）
const previewPath = ref('');
const previewTitle = ref('');
const previewBody = ref('');
const previewLoading = ref(false);
const currentPreviewPage = ref<PageItem | null>(null);

const audioEl = ref<HTMLAudioElement | null>(null);
let voice = 'zh-CN-XiaoxiaoNeural';
let objectUrl: string | null = null;

const currentItem = computed(() =>
  currentIndex.value >= 0 ? queue.value[currentIndex.value] : null,
);
const progressFrac = computed(() =>
  duration.value > 0 ? Math.min(1, position.value / duration.value) : 0,
);

function titleOf(p: PageItem): string {
  const t = p.frontmatter?.title;
  return typeof t === 'string' && t ? t : p.name;
}

async function loadPages() {
  try {
    const res = await apiFetch(`${API_BASE}/files/pages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { pages?: PageItem[] };
    pages.value = data.pages ?? [];
  } catch (e) {
    errorMsg.value = '加载可朗读列表失败：' + (e as Error).message;
  }
}

async function fetchBody(path: string): Promise<string> {
  const res = await apiFetch(`${API_BASE}/files?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { body?: string; content?: string };
  return data.body || data.content || '';
}

// 点击标题 → 打开正文预览（仅查看文字，不触发播放/入列）
async function openPreview(p: PageItem) {
  currentPreviewPage.value = p;
  previewPath.value = p.path;
  previewTitle.value = titleOf(p);
  previewBody.value = '';
  previewLoading.value = true;
  errorMsg.value = '';
  try {
    previewBody.value = await fetchBody(p.path);
  } catch (e) {
    errorMsg.value = '读取内容失败：' + (e as Error).message;
  } finally {
    previewLoading.value = false;
  }
}
function closePreview() {
  previewPath.value = '';
  currentPreviewPage.value = null;
}
function inQueue(p: PageItem): boolean {
  return queue.value.some((q) => q.path === p.path);
}
function enqueuePreview() {
  if (currentPreviewPage.value) void enqueue(currentPreviewPage.value);
}
function playPreview() {
  if (currentPreviewPage.value) void playPage(currentPreviewPage.value);
}

// 播放某条目：确保已在队列，并从该条开始
async function playPage(p: PageItem) {
  errorMsg.value = '';
  synthWarn.value = '';
  let idx = queue.value.findIndex((q) => q.path === p.path);
  if (idx < 0) {
    loading.value = true;
    try {
      const body = await fetchBody(p.path);
      queue.value.push({ path: p.path, title: titleOf(p), body });
      idx = queue.value.length - 1;
    } catch (e) {
      errorMsg.value = '获取正文失败：' + (e as Error).message;
      return;
    } finally {
      loading.value = false;
    }
  }
  await startAt(idx);
}

// 把整页内容加入队列（不立即播放）
async function enqueue(p: PageItem) {
  if (queue.value.some((q) => q.path === p.path)) return;
  loading.value = true;
  try {
    const body = await fetchBody(p.path);
    queue.value.push({ path: p.path, title: titleOf(p), body });
  } catch (e) {
    errorMsg.value = '获取正文失败：' + (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function startAt(idx: number) {
  if (idx < 0 || idx >= queue.value.length) return;
  currentIndex.value = idx;
  await synthAndPlay(queue.value[idx]);
}

// 合成并播放单条（后端单条上限 5000 字，超长截断提示）
async function synthAndPlay(item: QueueItem) {
  const a = audioEl.value;
  if (!a) return;
  const text = (item.body || '').trim();
  if (!text) {
    errorMsg.value = '该条目无正文可读';
    return;
  }
  let toSynth = text;
  if (text.length > 5000) {
    toSynth = text.slice(0, 5000);
    synthWarn.value = `「${item.title}」较长，已截取前 5000 字朗读`;
  } else {
    synthWarn.value = '';
  }

  loading.value = true;
  errorMsg.value = '';
  try {
    const res = await apiFetch(`${API_BASE}/tts/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: toSynth, voice, rate: '+0%' }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${msg || res.statusText}`);
    }
    const blob = await res.blob();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    a.src = objectUrl;
    a.playbackRate = speed.value;
    await a.play();
    isPlaying.value = true;
    updateMediaMetadata(item);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  } catch (e) {
    errorMsg.value = '语音合成失败：' + (e as Error).message;
    isPlaying.value = false;
  } finally {
    loading.value = false;
  }
}

function togglePlay() {
  const a = audioEl.value;
  if (!a) return;
  if (isPlaying.value) {
    a.pause();
    isPlaying.value = false;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  } else if (currentItem.value) {
    a.play().catch(() => {});
    isPlaying.value = true;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  } else if (queue.value.length) {
    void startAt(0);
  }
}

function next() {
  if (currentIndex.value < queue.value.length - 1) void startAt(currentIndex.value + 1);
  else {
    isPlaying.value = false;
    currentIndex.value = -1;
  }
}

function prev() {
  if (currentIndex.value > 0) void startAt(currentIndex.value - 1);
  else if (audioEl.value && position.value > 3) audioEl.value.currentTime = 0;
}

function removeFromQueue(idx: number) {
  const wasCurrent = idx === currentIndex.value;
  queue.value.splice(idx, 1);
  if (wasCurrent) {
    audioEl.value?.pause();
    isPlaying.value = false;
    currentIndex.value = -1;
  } else if (idx < currentIndex.value) {
    currentIndex.value -= 1;
  }
}

function setSpeed(s: number) {
  speed.value = s;
  if (audioEl.value) audioEl.value.playbackRate = s;
}

function seekTo(frac: number) {
  if (audioEl.value && duration.value) audioEl.value.currentTime = frac * duration.value;
}

function onEnded() {
  next();
}
function onTimeUpdate() {
  if (audioEl.value) position.value = audioEl.value.currentTime;
}
function onLoadedMeta() {
  if (audioEl.value) duration.value = audioEl.value.duration;
}

function updateMediaMetadata(item: QueueItem) {
  if (!('mediaSession' in navigator) || typeof window.MediaMetadata === 'undefined') return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.title,
    artist: '知识库聆听',
    album: 'Karpathy Wiki',
  });
}

function registerMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const noop = () => {};
  ms.setActionHandler('play', () => togglePlay());
  ms.setActionHandler('pause', () => togglePlay());
  ms.setActionHandler('previoustrack', () => prev());
  ms.setActionHandler('nexttrack', () => next());
  void noop;
}

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

onMounted(async () => {
  const cfg = await loadTtsConfig(authStore.user?.id ?? 'guest');
  voice = cfg.voice || 'zh-CN-XiaoxiaoNeural';
  if (cfg.rate >= 0.5 && cfg.rate <= 2) speed.value = cfg.rate;
  registerMediaSession();
  await loadPages();
});

onBeforeUnmount(() => {
  audioEl.value?.pause();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    (['play', 'pause', 'previoustrack', 'nexttrack'] as MediaSessionAction[]).forEach((a) =>
      ms.setActionHandler(a, null),
    );
  }
});
</script>

<template>
  <div class="ml-root">
    <!-- 正文预览视图（点击标题进入，仅查看文字） -->
    <section v-if="previewPath" class="ml-preview">
      <div class="ml-preview-head">
        <button class="ml-back" @click="closePreview">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          返回
        </button>
        <span class="ml-preview-path">{{ previewPath }}</span>
      </div>
      <div v-if="previewLoading" class="ml-hint">读取内容中…</div>
      <template v-else>
        <h2 class="ml-preview-title">{{ previewTitle }}</h2>
        <div class="ml-preview-actions">
          <button class="ml-mini" :disabled="!!(currentPreviewPage && inQueue(currentPreviewPage))" @click="enqueuePreview">＋ 队列</button>
          <button class="ml-mini play" @click="playPreview">▶ 播放</button>
        </div>
        <MarkdownRenderer :content="previewBody" />
      </template>
    </section>

    <!-- 可朗读内容列表 + 播放队列 -->
    <template v-else>
    <section class="ml-section">
      <h3 class="ml-h3">知识库内容</h3>
      <div v-if="pages.length === 0 && !errorMsg" class="ml-hint">加载中…</div>
      <div v-for="p in pages" :key="p.path" class="ml-page">
        <span class="ml-page-title" @click="openPreview(p)">{{ titleOf(p) }}</span>
        <span class="ml-page-actions">
          <span v-if="inQueue(p)" class="ml-mini in-queue" title="已在队列">✓</span>
          <span class="ml-mini" @click.stop="enqueue(p)" title="加入队列">＋</span>
          <span class="ml-mini play" @click.stop="playPage(p)" title="播放">▶</span>
        </span>
      </div>
    </section>

    <!-- 播放队列 -->
    <section v-if="queue.length" class="ml-section">
      <h3 class="ml-h3">播放队列（{{ queue.length }}）</h3>
      <div
        v-for="(q, i) in queue"
        :key="q.path"
        class="ml-qitem"
        :class="{ active: i === currentIndex, playing: i === currentIndex && isPlaying }"
        @click="startAt(i)"
      >
        <span class="ml-q-icon">{{ i === currentIndex && isPlaying ? '🔊' : '🔈' }}</span>
        <span class="ml-q-title">{{ q.title }}</span>
        <span class="ml-q-del" @click.stop="removeFromQueue(i)" title="移除">✕</span>
      </div>
    </section>
    </template>

    <p v-if="errorMsg" class="ml-error">{{ errorMsg }}</p>
    <p v-if="synthWarn" class="ml-warn">{{ synthWarn }}</p>

    <!-- 播放器控件（吸底） -->
    <div v-if="currentItem || queue.length" class="ml-player">
      <div class="ml-progress" @click="seekTo($event.offsetX / $el.offsetWidth)">
        <div class="ml-progress-fill" :style="{ width: progressFrac * 100 + '%' }" />
      </div>
      <div class="ml-player-row">
        <div class="ml-now">
          <div class="ml-now-title">{{ currentItem?.title || '未选择' }}</div>
          <div class="ml-now-time">{{ fmt(position) }} / {{ fmt(duration) }}</div>
        </div>
        <div class="ml-ctrls">
          <button class="ml-btn" @click="prev" title="上一首">⏮</button>
          <button class="ml-btn ml-play" @click="togglePlay" :disabled="loading">
            {{ loading ? '…' : isPlaying ? '⏸' : '▶' }}
          </button>
          <button class="ml-btn" @click="next" title="下一首">⏭</button>
        </div>
      </div>
      <div class="ml-speeds">
        <button
          v-for="s in SPEEDS"
          :key="s"
          class="ml-speed"
          :class="{ on: Math.abs(speed - s) < 0.01 }"
          @click="setSpeed(s)"
        >{{ s }}×</button>
      </div>
    </div>

    <!-- 隐藏音频元素：承载 TTS MP3 流 -->
    <audio
      ref="audioEl"
      @ended="onEnded"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onLoadedMeta"
    />
  </div>
</template>

<style scoped>
.ml-root {
  padding: 14px 14px 16px;
  font-family: var(--font-body);
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ml-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ml-h3 {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-soft);
  margin: 0;
  letter-spacing: 0.5px;
}
.ml-hint {
  color: var(--text-soft);
  font-size: 13px;
  padding: 12px 0;
}
.ml-page {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--accent-purple-a30);
  background: var(--bg-glass, rgba(20, 8, 40, 0.55));
  border-radius: 12px;
  padding: 11px 12px;
  cursor: pointer;
  text-align: left;
  font-family: var(--font-body);
  color: var(--text-bright);
}
.ml-page:active {
  border-color: var(--neon-cyan);
}
.ml-page-title {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ml-page-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.ml-mini {
  font-size: 12px;
  font-weight: 700;
  color: var(--neon-cyan);
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  border-radius: 8px;
  padding: 3px 8px;
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
}
.ml-mini.play {
  color: #04121a;
  background: var(--neon-cyan);
  border-color: var(--neon-cyan);
}
.ml-mini.in-queue {
  color: var(--neon-magenta, #ff3ea5);
  border-color: rgba(255, 62, 165, 0.3);
  background: rgba(255, 62, 165, 0.08);
}
.ml-qitem {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid transparent;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 10px;
  padding: 9px 11px;
  cursor: pointer;
  color: var(--text-soft);
}
.ml-qitem.active {
  border-color: var(--neon-cyan);
  background: rgba(0, 245, 255, 0.08);
  color: var(--text-bright);
}
.ml-q-icon {
  font-size: 15px;
  flex-shrink: 0;
}
.ml-q-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ml-q-del {
  color: var(--text-soft);
  font-size: 14px;
  flex-shrink: 0;
  padding: 0 4px;
}
.ml-error {
  color: #ffb4c4;
  font-size: 12px;
  margin: 0;
}
.ml-warn {
  color: #ffd27a;
  font-size: 12px;
  margin: 0;
}

/* 预览视图（阅读型） */
.ml-preview {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
.ml-preview-head {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0 8px;
  background: var(--bg-void);
}
.ml-back {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: none;
  background: transparent;
  color: var(--neon-cyan);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
}
.ml-back svg {
  width: 18px;
  height: 18px;
}
.ml-preview-path {
  font-size: 11px;
  color: var(--text-soft);
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ml-preview-title {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 800;
  line-height: 1.4;
  margin: 4px 0 10px;
  color: var(--text-bright);
}
.ml-preview-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

/* 播放器 */
.ml-player {
  position: sticky;
  bottom: 0;
  z-index: 4;
  margin: 4px -14px -16px;
  padding: 12px 14px calc(12px + env(safe-area-inset-bottom, 0));
  background: rgba(5, 0, 16, 0.95);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-top: 1px solid var(--accent-purple-a30);
}
.ml-progress {
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
  margin-bottom: 10px;
}
.ml-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--neon-cyan), #8338ec);
}
.ml-player-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.ml-now {
  min-width: 0;
  flex: 1;
}
.ml-now-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ml-now-time {
  font-size: 11px;
  color: var(--text-soft);
  font-family: var(--font-mono, monospace);
}
.ml-ctrls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.ml-btn {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 1px solid var(--accent-purple-a30);
  background: rgba(0, 0, 0, 0.35);
  color: var(--text-bright);
  font-size: 15px;
  cursor: pointer;
}
.ml-btn:active {
  transform: scale(0.92);
}
.ml-btn.ml-play {
  width: 46px;
  height: 46px;
  font-size: 18px;
  background: var(--grad-aurora, linear-gradient(135deg, #00f5ff, #8338ec));
  color: #04121a;
  border: none;
}
.ml-btn:disabled {
  opacity: 0.5;
}
.ml-speeds {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  justify-content: center;
}
.ml-speed {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-soft);
  border: 1px solid var(--accent-purple-a30);
  background: transparent;
  border-radius: 8px;
  padding: 3px 10px;
  cursor: pointer;
}
.ml-speed.on {
  color: var(--neon-cyan);
  border-color: var(--neon-cyan);
  background: rgba(0, 245, 255, 0.1);
}
</style>
