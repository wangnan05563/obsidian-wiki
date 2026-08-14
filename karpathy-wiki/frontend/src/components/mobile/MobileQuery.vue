<script setup lang="ts">
// 移动端知识问答页（SRS FR-QRY，v2 多会话优化）：
// - 双模式：列表模式（历史会话，首屏有历史时进入）/ 聊天模式（首屏无历史直接进入，展示招呼语）
// - 历史会话：置顶排序、长按弹出操作菜单（置顶/取消置顶 · 重命名 · 删除）、右下 FAB 新建会话
// - 输入栏：语音输入（Web Speech API）+ 模型切换（useModelStore 预设）+ 发送/停止
// - 会话切换安全：仅"浏览列表"不打断后台生成；主动打开并发送另一会话时优雅中止上一会话流，避免串台
// 视觉：浅白极简商务风（任务列表 + 深蓝高亮），见 styles/mobile-light.css。
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { ElMessageBox, ElMessage } from 'element-plus';
import {
  Mic,
  Plus,
  MoreFilled,
  Top,
  Edit,
  Delete,
  ChatLineRound,
  Loading,
  Search,
  Close,
} from '@element-plus/icons-vue';
import { API_BASE, apiFetch } from '../../utils/apiBase';
import { renderMarkdown } from '../../utils/markdown';
import { consumeQuerySSE } from '../../utils/sse';
import { useQueryStore, DEFAULT_ACTIVE } from '../../stores/query';
import { useConversationsStore, getLastActiveConversationId } from '../../stores/conversations';
import { useAuthStore } from '../../stores/auth';
import { useModelStore } from '../../stores/model';
import {
  loadAiUserConfigForPreset,
  loadSearchUserConfig,
} from '../../services/userConfig';
import type { AiUserConfig, SearchUserConfig } from '../../services/userConfig';
import { useChatAutoScroll } from '../../composables/useChatAutoScroll';
import { useSpeechRecognition } from '../../composables/useSpeechRecognition';
import ThinkingBlock from '../ThinkingBlock.vue';
import RefsList from '../RefsList.vue';
import FollowupsChips from '../FollowupsChips.vue';
import SessionStatusIcon from '../SessionStatusIcon.vue';
import type { ChatMessage, Reference, ConversationRecord } from '../../types';

const emit = defineEmits<{ (e: 'open-me'): void }>();

const store = useQueryStore();
const conversationsStore = useConversationsStore();
const authStore = useAuthStore();
const modelStore = useModelStore();

// BYOK 配置（与桌面 Query.vue 一致）：读取用户 per-user AI/搜索配置，
// 问答请求时下发 llmConfig / searchConfig 给后端覆盖服务端共享配置。
const byokConfig = ref<AiUserConfig | null>(null);
const byokSearch = ref<SearchUserConfig | null>(null);
const byokReady = computed(() => !!byokConfig.value && !!byokConfig.value.apiKey);
// 模型显示：优先展示用户已配置的 BYOK 模型，否则回退预制模型（与后端实际生效逻辑一致）
const displayModel = computed(() =>
  byokReady.value
    ? (byokConfig.value!.model || '我的模型 (BYOK)')
    : (modelStore.currentModel || '模型'),
);
const inputQuestion = ref('');
const chatBodyRef = ref<HTMLDivElement | null>(null);
// 当前"激活"会话（其消息驻留 store 扁平缓冲，SSE 写入目标）；切到别的会话会优雅中止其后台流
const activeId = ref<string | null>(null);

// 模式：list=历史会话列表（有历史首屏进入）；chat=问答聊天
const mode = ref<'list' | 'chat'>('chat');
const hasHistory = computed(() => conversationsStore.conversations.length > 0);

// 列表筛选：【全部任务】下拉
type FilterKey = 'all' | 'pinned' | 'streaming';
const filter = ref<FilterKey>('all');
const filterLabel = computed(() =>
  filter.value === 'pinned' ? '置顶任务' : filter.value === 'streaming' ? '进行中' : '全部任务',
);
const filterOpen = ref(false);
const filterOptions: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部任务' },
  { key: 'pinned', label: '置顶任务' },
  { key: 'streaming', label: '进行中' },
];

// 列表内搜索（按标题）
const searchOpen = ref(false);
const searchText = ref('');
function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  if (!searchOpen.value) searchText.value = '';
}

// 长按操作菜单（置顶/取消置顶 · 重命名 · 删除）
const actionSheet = reactive<{ open: boolean; id: string | null; pinned: boolean }>({
  open: false,
  id: null,
  pinned: false,
});
// 模型切换底部面板
const modelSheet = ref(false);

// 任务详情 / 根因弹窗
const detailOpen = ref(false);
const detailConv = ref<ConversationRecord | null>(null);
const detailAsk = ref('');

// ===== 计算属性 =====
const hasMessages = computed(() => store.messages.length > 0);
const canSend = computed(() => !!inputQuestion.value.trim() && !store.isLoading);
// 是否有任意会话正在生成（驱动头部历史图标动画）
const isStreaming = computed(() => store.anySessionStreaming);

// 头像首字母（取当前登录用户名首字符）
const avatarInitial = computed(() => {
  const name = authStore.user?.username || '';
  return name ? name.trim().charAt(0).toUpperCase() : 'U';
});

// 历史会话：置顶优先，其次按更新时间倒序
const sortedConversations = computed(() =>
  [...conversationsStore.conversations].sort((a, b) => {
    if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  }),
);

// 列表筛选 + 搜索后的可见会话
const visibleConversations = computed(() => {
  const q = searchText.value.trim().toLowerCase();
  return sortedConversations.value.filter((c) => {
    if (filter.value === 'pinned' && !c.isPinned) return false;
    if (filter.value === 'streaming' && !store.isSessionStreaming(c.id)) return false;
    if (q && !(c.title || '').toLowerCase().includes(q)) return false;
    return true;
  });
});

// 当前会话标题（用于聊天头部）
const currentTitle = computed(() => {
  const id = activeId.value;
  const rec = id ? conversationsStore.conversations.find((c) => c.id === id) : undefined;
  return rec?.title || '新知识问答';
});

// 招呼语（空态展示）
const greeting = '你好，我是知识库助手。向知识库提问，随时获取流式回答与引用来源。';
const suggestions = [
  'Karpathy 怎么看 LLM 训练？',
  '什么是 Software 2.0？',
  '如何入门深度学习？',
];

// 统一 msg.refs 为 Reference[]，兼容 v1 string[] 与 v2 Reference[]
function normalizeRefs(refs: ChatMessage['refs']): Reference[] {
  if (!refs || refs.length === 0) return [];
  if (typeof refs[0] === 'string') {
    return (refs as string[]).map((path, i) => ({
      path,
      title: (path.split('/').pop() || path).replace(/\.md$/, ''),
      snippet: '',
      source: 'vault' as const,
      citeIndex: i + 1,
    }));
  }
  return refs as Reference[];
}

function formatTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 列表项日期：今天显示时间，否则 MM-DD HH:mm
function formatDateTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${mo}-${da} ${hh}:${mm}`;
}

// 自动贴底滚动（流式输出场景）
const { scrollToBottom } = useChatAutoScroll(chatBodyRef, () => store.isLoading);
watch(() => store.messages.length, () => scrollToBottom(true));
watch(
  () => [store.streamingAnswer, store.currentThinking.length] as const,
  () => scrollToBottom(),
);

// ===== 语音输入 =====
const speech = useSpeechRecognition({
  onFinal: (text) => {
    const t = text.trim();
    if (t) inputQuestion.value = (inputQuestion.value ? inputQuestion.value + ' ' : '') + t;
  },
  onError: (msg) => {
    store.setErrorMessage(`语音输入失败：${msg}`);
  },
});
function toggleVoice() {
  if (speech.listening.value) speech.stop();
  else speech.start();
}

// ===== 会话切换（并行流式）=====
let activeAbort: AbortController | null = null;

// 确保当前有真实会话 id（新建首问前若尚未落到某会话，则开一个）
function ensureSessionId(): string {
  if (store.activeId && store.activeId !== DEFAULT_ACTIVE) {
    activeId.value = store.activeId;
    return store.activeId;
  }
  const newId = crypto.randomUUID();
  conversationsStore.currentConversationId = newId;
  store.swapSession(newId);
  activeId.value = newId;
  return newId;
}

// 离开当前会话前：把该会话缓冲（含流式中间态）落盘，避免后台进度丢失
function persistActiveIfAny() {
  const id = store.activeId;
  if (!id || id === DEFAULT_ACTIVE) return;
  const buf = store.getSessionBuffer(id);
  if (buf && buf.messages.length > 0) {
    conversationsStore.currentConversationId = id;
    void conversationsStore.persistConversation(
      store.messagesWithStreamingFor(id),
      buf.currentThreadId ?? undefined,
    );
  }
}

function openConversation(id: string) {
  if (id === store.activeId) {
    mode.value = 'chat';
    return;
  }
  persistActiveIfAny();
  const rec = conversationsStore.conversations.find((c) => c.id === id) ?? null;
  const buf = store.getSessionBuffer(id);
  if (buf && buf.isLoading) {
    store.swapSession(id);
  } else {
    store.swapSession(id, { messages: rec ? rec.messages : [], threadId: rec?.threadId ?? null });
  }
  conversationsStore.currentConversationId = id;
  conversationsStore.markRead(id);
  conversationsStore.setViewing(id);
  activeId.value = id;
  mode.value = 'chat';
  requestAnimationFrame(() => scrollToBottom(true));
}

function newSession() {
  persistActiveIfAny();
  if (activeAbort && store.isLoading) {
    activeAbort.abort();
    activeAbort = null;
  }
  const newId = crypto.randomUUID();
  conversationsStore.currentConversationId = newId;
  conversationsStore.setViewing(newId);
  store.swapSession(newId);
  activeId.value = newId;
  mode.value = 'chat';
  inputQuestion.value = '';
}

function goList() {
  // 回到历史列表：清空「正在查看」会话，使后台完成的会话可被标记为未读
  conversationsStore.setViewing(null);
  mode.value = 'list';
}

// ===== 任务详情 / 根因弹窗 =====
function openDetail(c: ConversationRecord) {
  detailConv.value = c;
  detailAsk.value = '';
  detailOpen.value = true;
}
function closeDetail() {
  detailOpen.value = false;
  detailConv.value = null;
}
// 从最后一条助手消息中提取首个代码块（用于根因技术文本展示）
const detailCode = computed(() => {
  const c = detailConv.value;
  if (!c) return '';
  const last = [...(c.messages ?? [])].reverse().find((m) => m.role === 'assistant');
  if (!last) return '';
  const m = last.content.match(/```[^\n]*\n([\s\S]*?)```/);
  if (!m) return '';
  return m[1].trim().slice(0, 600);
});
const detailBullets = computed(() => {
  const c = detailConv.value;
  if (!c) return [];
  const count = c.messages?.length ?? 0;
  const list = [
    `会话 ID：${c.id}`,
    `消息：${count} 条`,
    `最近更新：${formatDateTime(c.updatedAt)}`,
    `状态：${c.isPinned ? '已置顶' : '普通'}`,
  ];
  return list;
});
function sendDetailAsk() {
  const q = detailAsk.value.trim();
  if (!q) return;
  closeDetail();
  inputQuestion.value = q;
  handleSubmit();
}

// ===== 长按菜单 =====
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressed = false;
function pressStart(id: string, pinned: boolean) {
  longPressed = false;
  if (pressTimer) clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    longPressed = true;
    actionSheet.id = id;
    actionSheet.pinned = pinned;
    actionSheet.open = true;
  }, 500);
}
function pressEnd() {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}
function onConvClick(id: string) {
  if (longPressed) {
    longPressed = false;
    return;
  }
  openConversation(id);
}
function closeActionSheet() {
  actionSheet.open = false;
  actionSheet.id = null;
}
async function doPin() {
  const id = actionSheet.id;
  if (id) await conversationsStore.togglePin(id);
  closeActionSheet();
}
async function doRename() {
  const id = actionSheet.id;
  closeActionSheet();
  if (!id) return;
  const rec = conversationsStore.conversations.find((c) => c.id === id);
  try {
    const { value } = await ElMessageBox.prompt('请输入新的会话名称', '重命名会话', {
      inputValue: rec?.title ?? '',
      inputPlaceholder: '会话名称',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    });
    const name = (value || '').trim();
    if (name) await conversationsStore.renameConversation(id, name);
  } catch {
    /* 用户取消 */
  }
}
async function doDelete() {
  const id = actionSheet.id;
  closeActionSheet();
  if (!id) return;
  try {
    await ElMessageBox.confirm('删除后不可恢复，确定删除该会话？', '删除会话', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    await conversationsStore.deleteConversation(id);
    store.removeSession(id);
    if (activeId.value === id) {
      activeId.value = null;
    }
  } catch {
    /* 用户取消 */
  }
}

// ===== 模型切换 =====
function pickModel(key: string) {
  void modelStore.switchModel(key);
  modelSheet.value = false;
}

// ===== 发送 / 流式 =====
function handleSubmit() {
  const q = inputQuestion.value.trim();
  if (!q || store.isLoading) return;
  const convId = ensureSessionId();
  store.submitQuestion(q);
  conversationsStore.currentConversationId = convId;
  void conversationsStore.persistConversation(
    store.messagesWithStreamingFor(convId),
    store.getSessionBuffer(convId)?.currentThreadId ?? undefined,
  );
  inputQuestion.value = '';
  void sendQuestion(q, convId);
}

function onFollowup(question: string) {
  if (store.isLoading) return;
  inputQuestion.value = question;
  handleSubmit();
}

async function sendQuestion(question: string, convId: string) {
  activeAbort = new AbortController();
  // 会话已失效（auth/me 返回 401 触发自动登出）时，直接提示重新登录/配置，
  // 避免继续打 /api/query 拿到 401/404 等晦涩错误（移动端「会话失效 → 点击发送」的典型崩溃路径）。
  if (!authStore.isLoggedIn) {
    ElMessage.warning('会话已失效，请先登录并在「配置 → AI 服务」填写 API 配置后再提问');
    activeAbort = null;
    return;
  }
  const buf = store.getSessionBuffer(convId);
  const activeThreadId = buf?.currentThreadId ?? null;
  const history = activeThreadId
    ? undefined
    : (buf?.messages ?? []).map((m) => ({ role: m.role, content: m.content }));

  const body: Record<string, unknown> = { question, stream: store.streamMode };
  if (activeThreadId) {
    body.threadId = activeThreadId;
  } else if (history && history.length > 0) {
    body.history = history;
  }

  // ── BYOK per-user 配置注入（对齐桌面 Query.vue）──
  // 每个用户携带自己配置的 AI 服务 / 搜索配置（含 API Key），后端以这些覆盖项替换
  // 服务端共享配置，实现「各用户独立额度、互不抢占限流」。密钥仅经请求体一次性下发，
  // 后端不持久化（参见 services/userConfig.ts）。仅当用户已填 API Key 才下发，
  // 空密钥视为未配置，交由后端 400 拦截。
  const uid = authStore.user?.id || 'guest';
  // 传入当前预设模板：预设槽位为空时让 provider/baseUrl/model 跟随该预设（而非 legacy 扁平配置）
  const activePreset = modelStore.presets.find(p => p.key === modelStore.selectedPresetKey);
  const [aiCfg, searchCfg] = await Promise.all([
    loadAiUserConfigForPreset(uid, modelStore.selectedPresetKey, activePreset),
    loadSearchUserConfig(uid),
  ]);
  if (aiCfg && aiCfg.apiKey) {
    body.llmConfig = aiCfg;
  }
  if (searchCfg && searchCfg.apiKey) {
    body.searchConfig = searchCfg;
  }

  try {
    const response = await apiFetch(`${API_BASE}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: activeAbort.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await consumeQuerySSE(response, store.getSessionWriter(convId), activeAbort.signal);
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') return;
    store.getSessionWriter(convId).handleError((err as Error).message);
    ElMessage.warning((err as Error).message);
  } finally {
    if (!activeAbort?.signal.aborted) {
      conversationsStore.currentConversationId = convId;
      void conversationsStore.persistConversation(
        store.messagesWithStreamingFor(convId),
        store.getSessionBuffer(convId)?.currentThreadId ?? undefined,
      );
    }
    activeAbort = null;
  }
}

function handleStop() {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

function handleNewSession() {
  newSession();
}

// FR-RM-09 断点续答：针对指定会话缓冲续答
function resumeLastAnswer(convId: string) {
  const buf = store.getSessionBuffer(convId);
  if (!buf) return;
  const msgs = buf.messages;
  if (!msgs.length) return;
  const last = msgs[msgs.length - 1];
  if (last.role === 'assistant' && last.status === 'streaming') {
    store.removeMessage(msgs.length - 1);
  }
  let question: string | undefined;
  for (let i = buf.messages.length - 1; i >= 0; i--) {
    if (buf.messages[i].role === 'user') {
      question = buf.messages[i].content;
      break;
    }
  }
  if (!question) return;
  void sendQuestion(question, convId);
}

async function maybeResumeOnLoad() {
  if (store.anySessionStreaming) return;
  const lastId = getLastActiveConversationId();
  if (!lastId) return;
  const rec = conversationsStore.conversations.find((c) => c.id === lastId);
  if (!rec) return;
  store.swapSession(lastId, { messages: rec.messages, threadId: rec.threadId });
  conversationsStore.currentConversationId = lastId;
  activeId.value = lastId;
  const buf = store.getSessionBuffer(lastId);
  const msgs = buf?.messages ?? [];
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'assistant' && last.status === 'streaming') {
    resumeLastAnswer(lastId);
  }
}

onMounted(async () => {
  try {
    await conversationsStore.loadConversations();
  } catch {
    /* IndexedDB 不可用时静默降级 */
  }
  try {
    await modelStore.loadPresets();
  } catch {
    /* 模型列表不可用时静默降级 */
  }
  // 加载 BYOK 配置（用于模型显示 + 问答下发 llmConfig）
  try {
    const uid = authStore.user?.id || 'guest';
    const activePreset = modelStore.presets.find(p => p.key === modelStore.selectedPresetKey);
    byokConfig.value = await loadAiUserConfigForPreset(uid, modelStore.selectedPresetKey, activePreset);
    byokSearch.value = await loadSearchUserConfig(uid);
  } catch {
    /* BYOK 不可用时静默降级 */
  }
  mode.value = hasHistory.value ? 'list' : 'chat';
  try {
    await maybeResumeOnLoad();
  } catch {
    /* 续答失败不阻断首屏 */
  }
});

onBeforeUnmount(() => {
  if (pressTimer) clearTimeout(pressTimer);
  speech.stop();
  activeAbort = null;
});
</script>

<template>
  <div class="mq-root">
    <!-- ============ 列表模式：任务列表 ============ -->
    <div v-if="mode === 'list'" class="mq-listview">
      <!-- 顶栏：左侧【全部任务】下拉 + 右侧搜索 / 头像 -->
      <header class="mq-topbar m-safe-top">
        <button class="mq-filter" :class="{ open: filterOpen }" @click="filterOpen = !filterOpen">
          <span class="mq-filter-label">{{ filterLabel }}</span>
          <svg class="mq-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <div class="mq-top-actions">
          <button class="mq-icon-btn" title="搜索" @click="toggleSearch">
            <el-icon><Search /></el-icon>
          </button>
          <button class="mq-avatar" title="我的" @click="emit('open-me')">{{ avatarInitial }}</button>
        </div>

        <!-- 筛选下拉菜单 -->
        <transition name="mq-pop">
          <div v-if="filterOpen" class="mq-filter-menu" @click.self="filterOpen = false">
            <button
              v-for="opt in filterOptions"
              :key="opt.key"
              class="mq-filter-item"
              :class="{ active: filter === opt.key }"
              @click="filter = opt.key; filterOpen = false"
            >{{ opt.label }}</button>
          </div>
        </transition>
      </header>

      <!-- 搜索条 -->
      <div v-if="searchOpen" class="mq-searchbar">
        <svg class="mq-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        <input v-model="searchText" class="mq-search-input" type="search" enterkeyhint="search" placeholder="搜索会话…" />
        <button class="mq-search-clear" @click="searchText = ''"><el-icon><Close /></el-icon></button>
      </div>

      <!-- 任务列表（分割条目） -->
      <div v-if="!visibleConversations.length" class="mq-empty-list">
        <el-icon class="mq-empty-icon"><ChatLineRound /></el-icon>
        <p>{{ searchText || filter !== 'all' ? '没有匹配的会话' : '还没有会话，点击右下角按钮开始提问' }}</p>
      </div>

      <ul v-else class="mq-tasks">
        <li
          v-for="c in visibleConversations"
          :key="c.id"
          class="mq-task"
          :class="{ pinned: c.isPinned }"
          @click="onConvClick(c.id)"
          @pointerdown="pressStart(c.id, !!c.isPinned)"
          @pointerup="pressEnd"
          @pointerleave="pressEnd"
          @pointercancel="pressEnd"
        >
          <!-- 左侧圆形浅灰图标容器 -->
          <div class="mq-task-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9 9 0 0 1-4-1L3 20l1.5-5.5a8.38 8.38 0 0 1-1-4A8.5 8.5 0 1 1 21 11.5z" />
            </svg>
          </div>
          <!-- 中间：标题 + 灰色标签 -->
          <div class="mq-task-main">
            <div class="mq-task-title">
              <span v-if="c.isPinned" class="mq-task-pin">置顶</span>
              <span class="mq-task-name">{{ c.title || '未命名会话' }}</span>
              <SessionStatusIcon :conv="c" />
            </div>
            <div class="mq-task-tag">□ 对话 · {{ c.preview || '暂无内容' }}</div>
          </div>
          <!-- 右侧：日期 + 根因详情入口 -->
          <div class="mq-task-right">
            <span class="mq-task-time">{{ formatDateTime(c.updatedAt) }}</span>
            <button
              class="mq-task-more"
              title="根因 / 详情"
              @click.stop="openDetail(c)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg>
            </button>
          </div>
        </li>
      </ul>

      <!-- 右下 FAB 新建会话（蓝色圆形加号） -->
      <button class="mq-fab" title="新建会话" @click="newSession">
        <el-icon><Plus /></el-icon>
      </button>
    </div>

    <!-- ============ 聊天模式 ============ -->
    <div v-else class="mq-chat">
      <!-- 顶栏：返回列表 + 标题 + 新建 -->
      <header class="mq-chatbar m-safe-top">
        <button
          v-if="hasHistory"
          class="mq-icon-btn"
          :class="{ spinning: isStreaming }"
          title="历史会话"
          @click="goList"
        >
          <el-icon v-if="isStreaming"><Loading /></el-icon>
          <el-icon v-else><ChatLineRound /></el-icon>
        </button>
        <span class="mq-chat-title">{{ currentTitle }}</span>
        <button class="mq-icon-btn" title="新会话" @click="handleNewSession">
          <el-icon><Plus /></el-icon>
        </button>
      </header>

      <div ref="chatBodyRef" class="mq-messages">
        <!-- 空态：招呼语 + 建议问题 -->
        <div v-if="!hasMessages" class="mq-empty">
          <div class="mq-empty-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9 9 0 0 1-4-1L3 20l1.5-5.5a8.38 8.38 0 0 1-1-4A8.5 8.5 0 1 1 21 11.5z" /></svg>
          </div>
          <p class="mq-empty-greeting">{{ greeting }}</p>
          <div class="mq-suggestions">
            <button v-for="s in suggestions" :key="s" class="mq-suggestion" @click="onFollowup(s)">
              {{ s }}
            </button>
          </div>
        </div>

        <div v-else class="mq-list">
          <div v-for="(msg, idx) in store.messages" :key="msg.id || idx" class="mq-row" :class="msg.role">
            <div class="mq-bubble" :class="msg.role">
              <ThinkingBlock v-if="msg.thinking && msg.thinking.length > 0" :steps="msg.thinking" />
              <div class="markdown-body mq-md" v-html="renderMarkdown(msg.content)"></div>
              <FollowupsChips
                v-if="msg.followups && msg.followups.length > 0"
                :followups="msg.followups"
                @click="onFollowup"
              />
              <RefsList v-if="normalizeRefs(msg.refs).length > 0" :refs="normalizeRefs(msg.refs)" />
              <div v-if="msg.createdAt" class="mq-time">{{ formatTime(msg.createdAt) }}</div>
            </div>
          </div>

          <!-- 流式输出中的 assistant 消息 -->
          <div v-if="store.isLoading || store.streamingAnswer" class="mq-row assistant">
            <div class="mq-bubble assistant" :class="{ streaming: !!store.streamingAnswer }">
              <ThinkingBlock
                v-if="store.currentThinking.length > 0"
                :steps="store.currentThinking"
                :live="store.isLoading"
              />
              <div v-if="store.isLoading && !store.streamingAnswer && store.currentThinking.length === 0" class="mq-dots">
                <span class="dot"></span><span class="dot"></span><span class="dot"></span>
                <span class="mq-dots-text">正在思考…</span>
              </div>
              <div
                v-else
                class="markdown-body mq-md streaming-content"
                v-html="renderMarkdown(store.streamingAnswer || '')"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 错误条 -->
      <div v-if="store.errorMessage" class="mq-error">{{ store.errorMessage }}</div>

      <!-- 输入栏 -->
      <div class="mq-inputbar">
        <button
          class="mq-mic"
          :class="{ listening: speech.listening.value }"
          title="语音输入"
          :disabled="!speech.supported.value"
          @click="toggleVoice"
        >
          <el-icon><Mic /></el-icon>
        </button>
        <textarea
          v-model="inputQuestion"
          class="mq-input"
          rows="1"
          :placeholder="speech.listening.value ? '正在聆听…' : '输入你的问题…'"
          :disabled="store.isLoading"
          @keydown.enter.exact.prevent="handleSubmit"
        ></textarea>
        <button class="mq-model" title="切换模型" @click="modelSheet = true">
          <span class="mq-model-label">{{ displayModel }}</span>
        </button>
        <button
          v-if="store.isLoading"
          class="mq-send mq-stop"
          @click="handleStop"
          title="停止生成"
        >停止</button>
        <button v-else class="mq-send" :disabled="!canSend" @click="handleSubmit" title="发送">发送</button>
      </div>
    </div>

    <!-- 长按操作菜单（白底底部面板） -->
    <transition name="mq-sheet">
      <div v-if="actionSheet.open" class="mq-sheet-mask" @click.self="closeActionSheet">
        <div class="mq-sheet">
          <button class="mq-sheet-item" @click="doPin">
            <el-icon><Top /></el-icon>{{ actionSheet.pinned ? '取消置顶' : '置顶' }}
          </button>
          <button class="mq-sheet-item" @click="doRename">
            <el-icon><Edit /></el-icon>重命名
          </button>
          <button class="mq-sheet-item danger" @click="doDelete">
            <el-icon><Delete /></el-icon>删除
          </button>
          <button class="mq-sheet-item cancel" @click="closeActionSheet">取消</button>
        </div>
      </div>
    </transition>

    <!-- 模型切换面板（白底） -->
    <transition name="mq-sheet">
      <div v-if="modelSheet" class="mq-sheet-mask" @click.self="modelSheet = false">
        <div class="mq-sheet">
          <div class="mq-sheet-title">切换模型</div>
          <button
            v-if="byokReady"
            class="mq-sheet-item byok"
            :class="{ active: true }"
            disabled
          >
            {{ byokConfig?.model }}
            <span class="mq-sheet-sub">{{ byokConfig?.provider }} · BYOK 已生效</span>
          </button>
          <button
            v-for="p in modelStore.presets"
            :key="p.key"
            class="mq-sheet-item"
            :class="{ active: !byokReady && p.key === modelStore.selectedPresetKey }"
            @click="pickModel(p.key)"
          >
            {{ p.label || p.model }}
            <span class="mq-sheet-sub">{{ p.model }}</span>
          </button>
          <button class="mq-sheet-item cancel" @click="modelSheet = false">取消</button>
        </div>
      </div>
    </transition>

    <!-- 任务详情 / 根因弹窗（白底圆角浮窗） -->
    <transition name="mq-sheet">
      <div v-if="detailOpen" class="mq-sheet-mask" @click.self="closeDetail">
        <div class="mq-detail-sheet">
          <div class="mq-detail-head">
            <span class="mq-detail-title">{{ detailConv?.title || '未命名会话' }}</span>
            <button class="mq-icon-btn" @click="closeDetail"><el-icon><Close /></el-icon></button>
          </div>
          <div class="mq-detail-meta">
            <span class="mq-detail-tag">□ 对话</span>
            <span class="mq-detail-date">{{ formatDateTime(detailConv?.updatedAt) }}</span>
          </div>

          <div class="mq-detail-body">
            <div class="mq-rc-title">根因</div>
            <ul class="mq-rc-list">
              <li v-for="(b, i) in detailBullets" :key="i">{{ b }}</li>
            </ul>
            <pre v-if="detailCode" class="mq-rc-code">{{ detailCode }}</pre>
            <p v-else class="mq-rc-note">该会话暂无代码片段。</p>
          </div>

          <!-- 底部输入 + 功能图标栏（简约聊天文档预览） -->
          <div class="mq-detail-foot">
            <input
              v-model="detailAsk"
              class="mq-detail-input"
              type="text"
              placeholder="向该任务追问…"
              enterkeyhint="send"
              @keyup.enter="sendDetailAsk"
            />
            <div class="mq-detail-icons">
              <button class="mq-foot-ic" title="引用"><el-icon><ChatLineRound /></el-icon></button>
              <button class="mq-foot-ic" title="复制"><el-icon><MoreFilled /></el-icon></button>
              <button class="mq-foot-send" title="发送" @click="sendDetailAsk">发送</button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.mq-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--m-bg, #ffffff);
}

/* ===== 顶栏（列表） ===== */
.mq-topbar {
  position: sticky;
  top: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 52px;
  padding: 0 14px;
  background: var(--m-surface, #ffffff);
  border-bottom: 1px solid var(--m-border, #ededed);
}
.mq-filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  padding: 6px 4px;
  cursor: pointer;
  color: var(--m-text, #111111);
  font-family: var(--m-font);
}
.mq-filter-label {
  font-size: 16px;
  font-weight: 700;
}
.mq-caret {
  width: 16px;
  height: 16px;
  color: var(--m-text-2, #777777);
  transition: transform 0.18s ease;
}
.mq-filter.open .mq-caret { transform: rotate(180deg); }
.mq-top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mq-icon-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  color: var(--m-text-2, #777777);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  font-size: 20px;
}
.mq-icon-btn:active { background: var(--m-fill, #f4f5f7); }
.mq-icon-btn.spinning :deep(svg) {
  animation: mq-spin 1s linear infinite;
  color: var(--m-primary, #1554d1);
}
@keyframes mq-spin { to { transform: rotate(360deg); } }
.mq-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--m-border-2, #e2e4e8);
  background: var(--m-fill, #f4f5f7);
  color: var(--m-text, #111111);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--m-font);
}
.mq-avatar:active { background: var(--m-fill-2, #eceef1); }

/* 筛选下拉菜单 */
.mq-filter-menu {
  position: absolute;
  top: 52px;
  left: 14px;
  z-index: 7;
  min-width: 140px;
  background: var(--m-surface, #ffffff);
  border: 1px solid var(--m-border, #ededed);
  border-radius: 12px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow: 0 6px 20px rgba(17, 17, 17, 0.1);
}
.mq-filter-item {
  border: none;
  background: transparent;
  text-align: left;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 14px;
  color: var(--m-text, #111111);
  cursor: pointer;
  font-family: var(--m-font);
}
.mq-filter-item:active { background: var(--m-fill, #f4f5f7); }
.mq-filter-item.active { color: var(--m-primary, #1554d1); font-weight: 600; }

/* 搜索条 */
.mq-searchbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--m-surface, #ffffff);
  border-bottom: 1px solid var(--m-border, #ededed);
}
.mq-search-icon { width: 18px; height: 18px; color: var(--m-text-3, #9aa0a6); flex-shrink: 0; }
.mq-search-input {
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
.mq-search-input:focus { border-color: var(--m-primary, #1554d1); }
.mq-search-clear {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--m-text-3, #9aa0a6);
  cursor: pointer;
  display: flex;
  font-size: 18px;
}

/* ===== 任务列表（分割条目） ===== */
.mq-listview {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 80px;
}
.mq-empty-list {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 60px 24px;
  color: var(--m-text-2, #777777);
  text-align: center;
}
.mq-empty-icon { font-size: 36px; opacity: 0.5; }

.mq-tasks { list-style: none; margin: 0; padding: 0; }
.mq-task {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--m-border, #ededed);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.mq-task:active { background: var(--m-bg-soft, #f7f8fa); }

/* 左侧圆形浅灰图标容器 */
.mq-task-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--m-fill, #f4f5f7);
  color: var(--m-text-2, #777777);
  display: flex;
  align-items: center;
  justify-content: center;
}
.mq-task-icon svg { width: 20px; height: 20px; }

.mq-task-main { flex: 1; min-width: 0; }
.mq-task-title {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mq-task-pin {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  color: var(--m-primary, #1554d1);
  background: var(--m-primary-soft, rgba(21, 84, 209, 0.08));
  border-radius: 5px;
  padding: 1px 5px;
}
.mq-task-name {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--m-text, #111111);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mq-task-tag {
  margin-top: 4px;
  font-size: 12px;
  color: var(--m-text-2, #777777);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mq-task-right {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.mq-task-time {
  font-size: 11px;
  color: var(--m-text-2, #777777);
}
.mq-task-more {
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--m-text-3, #9aa0a6);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 8px;
}
.mq-task-more:active { background: var(--m-fill, #f4f5f7); }
.mq-task-more svg { width: 18px; height: 18px; }

/* FAB 新建会话（蓝色圆形加号） */
.mq-fab {
  position: absolute;
  right: 18px;
  bottom: 22px;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: none;
  background: var(--m-primary, #1554d1);
  color: #ffffff;
  font-size: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(21, 84, 209, 0.28);
  z-index: 8;
  transition: background 0.15s ease, transform 0.12s ease;
}
.mq-fab:active { background: var(--m-primary-press, #0f3f9e); transform: scale(0.92); }
.mq-fab :deep(svg) { width: 26px; height: 26px; }

/* ===== 聊天模式 ===== */
.mq-chat {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.mq-chatbar {
  flex-shrink: 0;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  background: var(--m-surface, #ffffff);
  border-bottom: 1px solid var(--m-border, #ededed);
}
.mq-chat-title {
  flex: 1;
  font-size: 16px;
  font-weight: 700;
  color: var(--m-text, #111111);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mq-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px 12px 8px;
}
.mq-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
}
.mq-empty-badge {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--m-fill, #f4f5f7);
  color: var(--m-primary, #1554d1);
  display: flex;
  align-items: center;
  justify-content: center;
}
.mq-empty-badge svg { width: 28px; height: 28px; }
.mq-empty-greeting {
  color: var(--m-text-2, #777777);
  font-size: 14px;
  margin: 0;
  line-height: 1.6;
}
.mq-suggestions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 320px;
  margin-top: 4px;
}
.mq-suggestion {
  border: 1px solid var(--m-border, #ededed);
  background: var(--m-surface, #ffffff);
  color: var(--m-text, #111111);
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
  font-family: var(--m-font);
  transition: border-color 0.18s ease;
}
.mq-suggestion:active { border-color: var(--m-primary, #1554d1); }

.mq-list { display: flex; flex-direction: column; gap: 14px; }
.mq-row { display: flex; justify-content: flex-start; }
.mq-row.user { justify-content: flex-end; }
.mq-bubble {
  max-width: 86%;
  padding: 10px 13px;
  border-radius: 16px;
  font-size: 15px;
  line-height: 1.6;
  word-break: break-word;
}
.mq-bubble.assistant {
  background: var(--m-surface, #ffffff);
  border: 1px solid var(--m-border-2, #e2e4e8);
  border-bottom-left-radius: 5px;
}
.mq-bubble.user {
  background: var(--m-primary-soft, rgba(21, 84, 209, 0.08));
  border: 1px solid rgba(21, 84, 209, 0.18);
  border-bottom-right-radius: 5px;
}
.mq-md { font-size: 15px; }
.mq-time {
  margin-top: 6px;
  font-size: 11px;
  color: var(--m-text-3, #9aa0a6);
  text-align: right;
}

.mq-dots {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 2px;
}
.mq-dots .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--m-text-3, #9aa0a6);
  animation: mq-blink 1.2s infinite ease-in-out;
}
.mq-dots .dot:nth-child(2) { animation-delay: 0.2s; }
.mq-dots .dot:nth-child(3) { animation-delay: 0.4s; }
.mq-dots-text { font-size: 13px; color: var(--m-text-2, #777777); margin-left: 4px; }
@keyframes mq-blink {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}

.mq-error {
  flex-shrink: 0;
  margin: 0 12px;
  padding: 8px 12px;
  background: rgba(217, 54, 54, 0.08);
  border: 1px solid rgba(217, 54, 54, 0.3);
  border-radius: 10px;
  color: var(--m-danger, #d93636);
  font-size: 13px;
}

/* 输入栏 */
.mq-inputbar {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0));
  background: var(--m-surface, #ffffff);
  border-top: 1px solid var(--m-border, #ededed);
}
.mq-mic,
.mq-model {
  flex-shrink: 0;
  height: 38px;
  border-radius: 10px;
  border: 1px solid var(--m-border-2, #e2e4e8);
  background: var(--m-surface, #ffffff);
  color: var(--m-text-2, #777777);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
}
.mq-mic { width: 38px; }
.mq-mic.listening {
  border-color: var(--m-primary, #1554d1);
  color: var(--m-primary, #1554d1);
}
.mq-mic:disabled { opacity: 0.4; cursor: not-allowed; }
.mq-model { padding: 0 10px; font-size: 12.5px; max-width: 92px; overflow: hidden; }
.mq-model-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mq-input {
  flex: 1;
  min-height: 38px;
  max-height: 110px;
  resize: none;
  border-radius: 12px;
  border: 1px solid var(--m-border-2, #e2e4e8);
  background: var(--m-bg-soft, #f7f8fa);
  color: var(--m-text, #111111);
  padding: 9px 12px;
  font-size: 15px;
  font-family: var(--m-font);
  line-height: 1.45;
  outline: none;
}
.mq-input:focus { border-color: var(--m-primary, #1554d1); }
.mq-input::placeholder { color: var(--m-text-3, #9aa0a6); }

.mq-send {
  flex-shrink: 0;
  height: 38px;
  padding: 0 16px;
  border-radius: 12px;
  border: none;
  background: var(--m-primary, #1554d1);
  color: #ffffff;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  font-family: var(--m-font);
  transition: background 0.15s ease;
}
.mq-send:active { background: var(--m-primary-press, #0f3f9e); }
.mq-send:disabled { opacity: 0.45; cursor: not-allowed; }
.mq-stop { background: var(--m-danger, #d93636); color: #fff; }

/* ===== 底部弹窗（白底） ===== */
.mq-sheet-mask {
  position: fixed;
  inset: 0;
  background: rgba(17, 17, 17, 0.4);
  display: flex;
  align-items: flex-end;
  z-index: 50;
}
.mq-sheet {
  width: 100%;
  background: var(--m-surface, #ffffff);
  border-top-left-radius: 18px;
  border-top-right-radius: 18px;
  padding: 8px 14px calc(14px + env(safe-area-inset-bottom, 0));
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mq-sheet-title {
  text-align: center;
  font-size: 13px;
  color: var(--m-text-2, #777777);
  padding: 6px 0 4px;
}
.mq-sheet-item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 50px;
  border: none;
  border-radius: 12px;
  background: var(--m-fill, #f4f5f7);
  color: var(--m-text, #111111);
  font-size: 15px;
  cursor: pointer;
  font-family: var(--m-font);
}
.mq-sheet-item:active { background: var(--m-fill-2, #eceef1); }
.mq-sheet-item.active { background: var(--m-primary-soft, rgba(21, 84, 209, 0.08)); color: var(--m-primary, #1554d1); font-weight: 600; }
.mq-sheet-item.danger { color: var(--m-danger, #d93636); }
.mq-sheet-item.cancel { color: var(--m-text-2, #777777); background: transparent; }
.mq-sheet-item.byok { color: var(--m-primary, #1554d1); }
.mq-sheet-item:disabled { opacity: 1; cursor: default; }
.mq-sheet-sub { font-size: 11px; color: var(--m-text-3, #9aa0a6); }

.mq-sheet-enter-active,
.mq-sheet-leave-active { transition: opacity 0.2s ease; }
.mq-sheet-enter-from,
.mq-sheet-leave-to { opacity: 0; }
.mq-sheet-enter-active .mq-sheet,
.mq-sheet-leave-active .mq-sheet { transition: transform 0.25s ease; }
.mq-sheet-enter-from .mq-sheet,
.mq-sheet-leave-to .mq-sheet { transform: translateY(100%); }

/* 筛选菜单淡入 */
.mq-pop-enter-active,
.mq-pop-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.mq-pop-enter-from,
.mq-pop-leave-to { opacity: 0; transform: translateY(-6px); }

/* ===== 任务详情 / 根因弹窗 ===== */
.mq-detail-sheet {
  width: 100%;
  max-height: 82vh;
  overflow-y: auto;
  background: var(--m-surface, #ffffff);
  border-top-left-radius: 18px;
  border-top-right-radius: 18px;
  padding: 16px 16px calc(16px + env(safe-area-inset-bottom, 0));
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mq-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.mq-detail-title {
  flex: 1;
  min-width: 0;
  font-size: 17px;
  font-weight: 700;
  color: var(--m-text, #111111);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mq-detail-meta {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mq-detail-tag {
  font-size: 12px;
  color: var(--m-text-2, #777777);
}
.mq-detail-date {
  font-size: 12px;
  color: var(--m-text-3, #9aa0a6);
}
.mq-detail-body {
  border-top: 1px solid var(--m-border, #ededed);
  padding-top: 12px;
}
.mq-rc-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--m-text, #111111);
  margin-bottom: 8px;
}
.mq-rc-list {
  margin: 0 0 10px;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mq-rc-list li {
  font-size: 13px;
  line-height: 1.5;
  color: var(--m-text-2, #777777);
}
.mq-rc-code {
  margin: 0;
  padding: 12px;
  background: var(--m-fill, #f4f5f7);
  border: 1px solid var(--m-border, #ededed);
  border-radius: 10px;
  font-family: var(--m-font-mono, monospace);
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--m-text, #111111);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.mq-rc-note {
  font-size: 13px;
  color: var(--m-text-3, #9aa0a6);
  margin: 0;
}
.mq-detail-foot {
  border-top: 1px solid var(--m-border, #ededed);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mq-detail-input {
  width: 100%;
  box-sizing: border-box;
  height: 42px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid var(--m-border-2, #e2e4e8);
  background: var(--m-bg-soft, #f7f8fa);
  color: var(--m-text, #111111);
  font-size: 14px;
  font-family: var(--m-font);
  outline: none;
}
.mq-detail-input:focus { border-color: var(--m-primary, #1554d1); }
.mq-detail-input::placeholder { color: var(--m-text-3, #9aa0a6); }
.mq-detail-icons {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mq-foot-ic {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  border: 1px solid var(--m-border-2, #e2e4e8);
  background: var(--m-surface, #ffffff);
  color: var(--m-text-2, #777777);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 18px;
}
.mq-foot-ic:active { background: var(--m-fill, #f4f5f7); }
.mq-foot-send {
  margin-left: auto;
  height: 38px;
  padding: 0 20px;
  border-radius: 10px;
  border: none;
  background: var(--m-primary, #1554d1);
  color: #ffffff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--m-font);
}
.mq-foot-send:active { background: var(--m-primary-press, #0f3f9e); }
</style>
