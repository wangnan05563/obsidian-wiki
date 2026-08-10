<script setup lang="ts">
// 移动端「聆听」播放器（SRS FR-LIS，TTS 播客模式）。
// 独立于桌面端 useTtsStore（单条消息朗读模型），自实现「播放列表 + 顺序播放 + 后台播放」。
// 复用：apiFetch+API_BASE（注入 token）、loadTtsConfig（per-user voice/rate）、/api/files/pages 内容源、/api/tts/synthesize 合成。
// 合成策略：POST /api/tts/synthesize → MP3 blob → <audio>.src（后端该端点返回 audio/mpeg，前端用 blob 播放最稳）。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { apiFetch, API_BASE } from '../../utils/apiBase';
import { loadTtsConfig } from '../../services/ttsConfig';
import { useAuthStore } from '../../stores/auth';
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
    <!-- 可朗读内容列表 -->
    <section class="ml-section">
      <h3 class="ml-h3">知识库内容</h3>
      <div v-if="pages.length === 0 && !errorMsg" class="ml-hint">加载中…</div>
      <button v-for="p in pages" :key="p.path" class="ml-page" @click="playPage(p)">
        <span class="ml-page-title">{{ titleOf(p) }}</span>
        <span class="ml-page-actions">
          <span
            v-if="queue.some((q) => q.path === p.path)"
            class="ml-mini in-queue"
            title="已在队列"
            @click.stop="enqueue(p)"
          >✓ 队列</span>
          <span class="ml-mini" @click.stop="enqueue(p)" title="加入队列">＋</span>
          <span class="ml-mini play" title="播放">▶</span>
        </span>
      </button>
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
