<script setup lang="ts">
// 移动端「知识浏览」页（SRS FR-BRW）。
// 复用桌面端同一套 API（apiFetch + API_BASE），不引入 vue-router、不依赖 Element Plus。
// 三种视图：list（全部页面）/ search（搜索命中）/ detail（条目正文）。
// 同时支持从「知识问答」页点击 vault 引用跳转（MobileShell 监听 karpathy:jump-vault 后注入 jumpPath）。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { apiFetch, API_BASE } from '../../utils/apiBase';
import MarkdownRenderer from '../MarkdownRenderer.vue';
import type { PageItem, FileContent, SearchHit, SearchResponse } from '../../types';

const props = defineProps<{ jumpPath?: string }>();

type ViewMode = 'list' | 'search' | 'detail';

const view = ref<ViewMode>('list');
const pages = ref<PageItem[]>([]);
const searchHits = ref<SearchHit[]>([]);
const searchQuery = ref('');
const listLoading = ref(false);
const searching = ref(false);
const detailLoading = ref(false);
const errorMsg = ref('');

const current = ref<FileContent | null>(null);
const currentPath = ref('');
const currentTitle = ref('');

// ---------- 辅助：从 frontmatter 取展示字段 ----------
function strOr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function titleOf(p: PageItem): string {
  return strOr(p.frontmatter?.title) || p.name;
}
function typeOf(p: PageItem): string {
  return strOr(p.frontmatter?.type).toLowerCase();
}
function createdOf(p: PageItem): string {
  const c = strOr(p.frontmatter?.created);
  const m = c.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : c;
}
function tagsOf(fm: Record<string, unknown> | undefined): string[] {
  const t = fm?.tags;
  if (Array.isArray(t)) return t.map((x) => String(x));
  if (typeof t === 'string' && t) return [t];
  return [];
}
function titleOfHit(h: SearchHit): string {
  return h.title || h.path;
}

// 详情正文：优先 body（已剥离 frontmatter），否则 content
const detailContent = computed(() => {
  if (!current.value) return '';
  return current.value.body || current.value.content || '';
});
const currentTags = computed(() => tagsOf(current.value?.frontmatter));

// ---------- 加载全部页面列表 ----------
async function loadPages() {
  listLoading.value = true;
  errorMsg.value = '';
  try {
    const res = await apiFetch(`${API_BASE}/files/pages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { pages?: PageItem[] };
    pages.value = data.pages ?? [];
  } catch (err) {
    errorMsg.value = '加载知识库列表失败：' + (err as Error).message;
    pages.value = [];
  } finally {
    listLoading.value = false;
  }
}

// ---------- 搜索（debounce） ----------
let searchTimer: number | undefined;
function onSearchInput() {
  if (searchTimer) window.clearTimeout(searchTimer);
  const q = searchQuery.value.trim();
  if (!q) {
    view.value = 'list';
    searchHits.value = [];
    return;
  }
  searchTimer = window.setTimeout(() => {
    void doSearch(q);
  }, 350);
}
async function doSearch(q: string) {
  searching.value = true;
  errorMsg.value = '';
  try {
    const res = await apiFetch(`${API_BASE}/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as SearchResponse;
    searchHits.value = data.hits ?? [];
    view.value = 'search';
  } catch (err) {
    errorMsg.value = '搜索失败：' + (err as Error).message;
    searchHits.value = [];
  } finally {
    searching.value = false;
  }
}
function clearSearch() {
  searchQuery.value = '';
  searchHits.value = [];
  view.value = 'list';
}

// ---------- 快速定位：滚动内容列表至最上/最下 ----------
const rootRef = ref<HTMLElement | null>(null);
function findScrollContainer(): HTMLElement | null {
  let el = rootRef.value?.parentElement ?? null;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === 'auto' || oy === 'scroll') return el;
    el = el.parentElement;
  }
  return null;
}
function scrollListTo(where: 'top' | 'bottom') {
  const sc = findScrollContainer();
  if (!sc) return;
  sc.scrollTo({ top: where === 'top' ? 0 : sc.scrollHeight, behavior: 'smooth' });
}

// 是否可滚动：仅当内容超出视口高度时才显示悬浮定位图标，避免无滚动时多余控件
const listScrollable = ref(false);
// 定位图标显隐：仅在下拉滚动时显示，停止滚动 ~1.5s 后自动淡出
const isScrolling = ref(false);
let scrollObserver: ResizeObserver | null = null;
let scrollEl: HTMLElement | null = null;
let scrollHideTimer: number | null = null;
function updateScrollable() {
  const sc = findScrollContainer();
  listScrollable.value = !!sc && sc.scrollHeight - sc.clientHeight > 4;
}
function onListScroll() {
  isScrolling.value = true;
  if (scrollHideTimer) window.clearTimeout(scrollHideTimer);
  scrollHideTimer = window.setTimeout(() => {
    isScrolling.value = false;
  }, 1500);
}
function setupScrollWatch() {
  updateScrollable();
  if (scrollObserver) scrollObserver.disconnect();
  const root = rootRef.value;
  if (root && 'ResizeObserver' in window) {
    scrollObserver = new ResizeObserver(() => updateScrollable());
    scrollObserver.observe(root);
  }
  window.addEventListener('resize', updateScrollable);
  // 在滚动容器上挂 scroll 监听，驱动定位图标显隐
  const sc = findScrollContainer();
  if (sc) {
    scrollEl = sc;
    sc.addEventListener('scroll', onListScroll, { passive: true });
  }
}
function teardownScrollWatch() {
  if (scrollObserver) scrollObserver.disconnect();
  scrollObserver = null;
  window.removeEventListener('resize', updateScrollable);
  if (scrollEl) {
    scrollEl.removeEventListener('scroll', onListScroll);
    scrollEl = null;
  }
  if (scrollHideTimer) {
    window.clearTimeout(scrollHideTimer);
    scrollHideTimer = null;
  }
  isScrolling.value = false;
}

// ---------- 打开条目详情 ----------
async function openPath(path: string) {
  view.value = 'detail';
  currentPath.value = path;
  currentTitle.value = path.split('/').pop() || path;
  detailLoading.value = true;
  current.value = null;
  errorMsg.value = '';
  try {
    const res = await apiFetch(`${API_BASE}/files?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as FileContent;
    current.value = data;
    currentTitle.value = strOr(data.frontmatter?.title) || currentTitle.value;
  } catch (err) {
    errorMsg.value = '读取内容失败：' + (err as Error).message;
    current.value = null;
  } finally {
    detailLoading.value = false;
  }
}
function openPage(p: PageItem) {
  void openPath(p.path);
}
function openHit(h: SearchHit) {
  void openPath(h.path);
}
function backToList() {
  view.value = searchQuery.value.trim() ? 'search' : 'list';
  current.value = null;
}

onMounted(async () => {
  await loadPages();
  if (props.jumpPath) {
    if (props.jumpPath.startsWith('__search__:')) {
      const q = props.jumpPath.slice('__search__:'.length);
      searchQuery.value = q;
      await doSearch(q);
    } else {
      await openPath(props.jumpPath);
    }
  }
  setupScrollWatch();
});
onBeforeUnmount(() => {
  if (searchTimer) window.clearTimeout(searchTimer);
  teardownScrollWatch();
});
</script>

<template>
  <div class="mb-root" ref="rootRef">
    <!-- 搜索栏（吸顶） -->
    <div class="mb-search m-safe-top">
      <svg class="mb-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </svg>
      <input
        v-model="searchQuery"
        class="mb-search-input"
        type="search"
        enterkeyhint="search"
        placeholder="搜索知识库…"
        @input="onSearchInput"
      />
      <button v-if="view === 'search' || searchQuery" class="mb-search-clear" @click="clearSearch">取消</button>
    </div>

    <!-- 列表视图：全部页面 -->
    <div v-if="view === 'list'" class="mb-list">
      <div v-if="listLoading" class="mb-hint">加载中…</div>
      <div v-else-if="!pages.length" class="mb-hint">暂无已入库内容</div>
      <button v-for="p in pages" :key="p.path" class="mb-card" @click="openPage(p)">
        <div class="mb-card-top">
          <span class="mb-card-title">{{ titleOf(p) }}</span>
          <span v-if="typeOf(p)" class="mb-chip mb-chip-type">{{ typeOf(p) }}</span>
        </div>
        <div class="mb-card-meta">
          <span v-if="createdOf(p)" class="mb-meta">{{ createdOf(p) }}</span>
          <span v-if="p.dir" class="mb-meta mb-meta-dir">{{ p.dir }}</span>
        </div>
        <div v-if="tagsOf(p.frontmatter).length" class="mb-tags">
          <span v-for="t in tagsOf(p.frontmatter).slice(0, 3)" :key="t" class="mb-chip">#{{ t }}</span>
        </div>
      </button>
    </div>

    <!-- 搜索结果视图 -->
    <div v-else-if="view === 'search'" class="mb-list">
      <div v-if="searching" class="mb-hint">搜索中…</div>
      <div v-else-if="!searchHits.length" class="mb-hint">未找到与「{{ searchQuery }}」相关的内容</div>
      <button v-for="h in searchHits" :key="h.path" class="mb-card" @click="openHit(h)">
        <div class="mb-card-top">
          <span class="mb-card-title">{{ titleOfHit(h) }}</span>
          <span v-if="h.hits" class="mb-chip mb-chip-hit">{{ h.hits }} 命中</span>
        </div>
        <p class="mb-snippet">{{ h.snippet }}</p>
      </button>
    </div>

    <!-- 详情视图 -->
    <div v-else class="mb-detail">
      <div class="mb-detail-head m-safe-top">
        <button class="mb-back" @click="backToList">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          返回
        </button>
        <span class="mb-detail-path">{{ currentPath }}</span>
      </div>

      <div v-if="detailLoading" class="mb-hint">读取内容中…</div>
      <template v-else-if="current">
        <div class="mb-detail-hero">
          <h2 class="mb-detail-title">{{ currentTitle }}</h2>
          <div v-if="typeOf({ path: '', name: '', dir: '', frontmatter: current.frontmatter } as PageItem) || createdOf({ path: '', name: '', dir: '', frontmatter: current.frontmatter } as PageItem) || currentTags.length" class="mb-detail-meta">
            <span v-if="typeOf({ path: '', name: '', dir: '', frontmatter: current.frontmatter } as PageItem)" class="mb-chip mb-chip-type">{{ typeOf({ path: '', name: '', dir: '', frontmatter: current.frontmatter } as PageItem) }}</span>
            <span v-if="createdOf({ path: '', name: '', dir: '', frontmatter: current.frontmatter } as PageItem)" class="mb-meta">{{ createdOf({ path: '', name: '', dir: '', frontmatter: current.frontmatter } as PageItem) }}</span>
            <span v-for="t in currentTags" :key="t" class="mb-chip">#{{ t }}</span>
          </div>
        </div>
        <div class="mb-detail-body">
          <MarkdownRenderer :content="detailContent" />
        </div>
      </template>
      <div v-else class="mb-hint">{{ errorMsg || '内容为空' }}</div>
    </div>

    <div v-if="errorMsg && view !== 'detail'" class="mb-error">{{ errorMsg }}</div>

    <!-- 快速定位：悬浮常驻 -->
    <button v-if="listScrollable" class="mb-scroll-fab mb-scroll-top" :class="{ 'is-scrolling': isScrolling }" title="回到顶部" aria-label="回到顶部" @click="scrollListTo('top')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6" /></svg>
    </button>
    <button v-if="listScrollable" class="mb-scroll-fab mb-scroll-bottom" :class="{ 'is-scrolling': isScrolling }" title="滚动到底部" aria-label="滚动到底部" @click="scrollListTo('bottom')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg>
    </button>
  </div>
</template>

<style scoped>
.mb-root {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  font-family: var(--m-font);
  background: var(--m-bg, #ffffff);
}

/* 搜索栏：吸顶 + 浅色 */
.mb-search {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px calc(10px + env(safe-area-inset-top, 0));
  background: #ffffff;
  border-bottom: 1px solid var(--m-border, #ededed);
}
.mb-search-icon {
  width: 18px;
  height: 18px;
  color: var(--m-text-3, #9aa0a6);
  flex-shrink: 0;
}
.mb-search-input {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--m-border-2, #e2e4e8);
  background: var(--m-bg-soft, #f7f8fa);
  color: var(--m-text, #111111);
  font-size: 14px;
  font-family: var(--m-font);
  outline: none;
}
.mb-search-input::placeholder { color: var(--m-text-3, #9aa0a6); }
.mb-search-input:focus { border-color: var(--m-primary, #1554d1); }
.mb-search-clear {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--m-primary, #1554d1);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

/* 列表 */
.mb-list {
  padding: 12px 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mb-hint {
  text-align: center;
  color: var(--m-text-2, #777777);
  font-size: 13px;
  padding: 28px 16px;
}
.mb-card {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid var(--m-border, #ededed);
  background: #ffffff;
  border-radius: 12px;
  padding: 12px 14px;
  cursor: pointer;
  font-family: var(--m-font);
  color: var(--m-text, #111111);
  transition: border-color 0.18s ease;
}
.mb-card:active { border-color: var(--m-primary, #1554d1); }
.mb-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.mb-card-title {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.4;
  color: var(--m-text, #111111);
}
.mb-card-meta {
  display: flex;
  gap: 10px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.mb-meta {
  font-size: 12px;
  color: var(--m-text-2, #777777);
}
.mb-meta-dir {
  font-family: var(--m-font-mono, monospace);
  opacity: 0.8;
}
.mb-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.mb-chip {
  font-size: 11px;
  font-weight: 600;
  color: var(--m-text-2, #777777);
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--m-fill, #f4f5f7);
  border: 1px solid var(--m-border, #ededed);
}
.mb-chip-type {
  color: var(--m-primary, #1554d1);
  border-color: rgba(21, 84, 209, 0.2);
  background: var(--m-primary-soft, rgba(21, 84, 209, 0.08));
}
.mb-chip-hit {
  color: var(--m-text-2, #777777);
}
.mb-snippet {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--m-text-2, #777777);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 详情 */
.mb-detail {
  padding: 0 14px calc(16px + env(safe-area-inset-bottom, 0));
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mb-detail-head {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  background: #ffffff;
  border-bottom: 1px solid var(--m-border, #ededed);
}
.mb-back {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: none;
  background: transparent;
  color: var(--m-primary, #1554d1);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
}
.mb-back svg { width: 18px; height: 18px; }
.mb-detail-path {
  font-size: 11px;
  color: var(--m-text-2, #777777);
  font-family: var(--m-font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mb-detail-hero {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 0 4px;
}
.mb-detail-title {
  font-size: 21px;
  font-weight: 800;
  line-height: 1.35;
  margin: 0;
  color: var(--m-text, #111111);
}
.mb-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.mb-detail-body {
  background: #ffffff;
  border: 1px solid var(--m-border, #ededed);
  border-radius: 14px;
  padding: 16px;
  box-shadow: 0 1px 3px rgba(17, 17, 17, 0.04);
}

.mb-error {
  margin: 8px 14px 16px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12px;
  color: var(--m-danger, #d93636);
  background: rgba(217, 54, 54, 0.08);
  border: 1px solid rgba(217, 54, 54, 0.3);
}

/* 快速定位 FAB */
.mb-scroll-fab {
  position: fixed;
  left: 12px;
  z-index: 20;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  border: 1px solid var(--m-border-2, #e2e4e8);
  color: var(--m-text-2, #777777);
  cursor: pointer;
  /* 默认隐藏：仅下拉滚动时（.is-scrolling）淡入，停止滚动后自动淡出 */
  opacity: 0;
  transform: translateX(-8px);
  pointer-events: none;
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.mb-scroll-fab.is-scrolling {
  opacity: 1;
  transform: translateX(0);
  pointer-events: auto;
}
.mb-scroll-fab:active { background: var(--m-fill, #f4f5f7); }
.mb-scroll-top { top: calc(58px + env(safe-area-inset-top, 0) + 10px); }
.mb-scroll-bottom { bottom: calc(56px + env(safe-area-inset-bottom, 0) + 14px); }
.mb-scroll-fab svg { width: 20px; height: 20px; }
</style>
