<script setup lang="ts">
import { API_BASE, apiFetch, downloadVaultFile } from '../utils/apiBase';
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { TreeInstance } from 'element-plus';
import { Search, Check, Close, CircleClose, Location, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, MoreFilled, FullScreen, Download, Edit } from '@element-plus/icons-vue';
import { consumeSSE } from '../utils/sse';
import { useCompileStore } from '../stores/compile';
import { usePermission } from '../composables/usePermission';
import DocumentTabs from '../components/DocumentTabs.vue';
import TocTree from '../components/TocTree.vue';
import type { TocNode } from '../components/TocTree.vue';
import type {
  TreeNode,
  FileContent,
  SearchHit,
  DraftItem,
  DraftBatchItem,
  DraftCompileEvent,
  PendingTagPage,
  PageItem,
} from '../types';

// §草稿发布状态提升到 compile store：App.vue 用 v-if 切换视图，
//   Browse.vue 卸载会丢失局部 ref，切换走 SSE 流仍能继续运行；
//   store 状态跨组件生命周期保留，切回页面后能继续看到进度信息
const compileStore = useCompileStore();
// 管理员判定：用于隐藏草稿审核 / AI 标签两个 Tab（需求：除管理员外只开放知识浏览 Tab）
const { isAdmin } = usePermission();

// 视图模式：knowledge=知识浏览，draft=草稿审核，tags=AI标签审核
// 为什么独立 ref 而非路由：多模式共用 Browse 页面骨架，避免引入新菜单项
type BrowseMode = 'knowledge' | 'draft' | 'tags';
const mode = ref<BrowseMode>('knowledge');

// T00260：标题栏展开/收起状态，默认展开（显示标题栏），点击收起后浏览区自动放大
// 为什么默认展开：收起标题栏是用户主动优化视野的操作，首次进入保持完整头部信息
const headCollapsed = ref(false);

// FR-11 知识浏览子视图：tree=目录树, kanban=看板, calendar=日历
// 持久化到 localStorage 满足 AC-11-7（视图模式刷新后保持）
// T00299：新增 toc 视图——「章节」选项标签切换到的章节树结构视图
type KnowledgeView = 'tree' | 'toc' | 'kanban' | 'calendar';
const KNOWLEDGE_VIEW_STORAGE_KEY = 'karpathy:browseView';
const knowledgeView = ref<KnowledgeView>(
  (localStorage.getItem(KNOWLEDGE_VIEW_STORAGE_KEY) as KnowledgeView) || 'tree',
);
watch(knowledgeView, (v) => {
  localStorage.setItem(KNOWLEDGE_VIEW_STORAGE_KEY, v);
  // 切到看板/日历/章节时按需拉取页面列表，避免目录树模式下多余请求
  if ((v === 'kanban' || v === 'calendar' || v === 'toc') && allPages.value.length === 0) {
    loadAllPages();
  }
});

// T00268：左侧文档树栏可拖拽宽度 + 收起/展开。
// 为什么复用问答页 ConversationSidebar 的 T00264 模式：document 级 mousemove/mouseup
//   可在鼠标移出手柄后持续跟踪，避免抖动；拖拽过程禁用 width 过渡保证宽度即时跟随。
// 宽度与收起态一并持久化，刷新后保持用户设置。
const TREE_PANEL_STORAGE_KEY = 'karpathy:browseTreePanel';
const TREE_DEFAULT_WIDTH = 280;
const TREE_MIN_WIDTH = 200;
const TREE_MAX_WIDTH = 480;
const treeWidth = ref(TREE_DEFAULT_WIDTH);
const treeCollapsed = ref(false);
const treeDragging = ref(false);
let treeDragStartX = 0;
let treeDragStartWidth = 0;

function loadTreePanelState(): void {
  try {
    const raw = localStorage.getItem(TREE_PANEL_STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as { width?: number; collapsed?: boolean };
      if (typeof s.width === 'number') {
        treeWidth.value = Math.min(TREE_MAX_WIDTH, Math.max(TREE_MIN_WIDTH, s.width));
      }
      if (typeof s.collapsed === 'boolean') treeCollapsed.value = s.collapsed;
    }
  } catch {
    // localStorage 不可用（隐私模式/被禁用）时回退默认值
  }
}

function saveTreePanelState(): void {
  try {
    localStorage.setItem(
      TREE_PANEL_STORAGE_KEY,
      JSON.stringify({ width: treeWidth.value, collapsed: treeCollapsed.value }),
    );
  } catch {
    /* 持久化失败不阻塞交互 */
  }
}

function toggleTreeCollapsed(): void {
  treeCollapsed.value = !treeCollapsed.value;
  saveTreePanelState();
}

function onTreeResizeStart(e: MouseEvent) {
  treeDragging.value = true;
  treeDragStartX = e.clientX;
  treeDragStartWidth = treeWidth.value;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onTreeResizeMove);
  document.addEventListener('mouseup', onTreeResizeEnd);
}

function onTreeResizeMove(e: MouseEvent) {
  if (!treeDragging.value) return;
  treeWidth.value = Math.min(
    TREE_MAX_WIDTH,
    Math.max(TREE_MIN_WIDTH, treeDragStartWidth + (e.clientX - treeDragStartX)),
  );
}

function onTreeResizeEnd() {
  if (!treeDragging.value) return;
  treeDragging.value = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  document.removeEventListener('mousemove', onTreeResizeMove);
  document.removeEventListener('mouseup', onTreeResizeEnd);
  saveTreePanelState();
}

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onTreeResizeMove);
  document.removeEventListener('mouseup', onTreeResizeEnd);
});

// FR-11 扁平化页面列表（看板/日历视图数据源）
const allPages = ref<PageItem[]>([]);
const pagesLoading = ref(false);

// ── FR-18 时效角标：读取后端注入的 knowledge_status，构建 path→status 映射 ──
// statusByPath 供目录树叶子节点使用（/files/tree 不含 frontmatter，没有注入 status，
// 而 /files/pages 已注入；树叶子按 path 从该映射取状态）。
// 为什么用 computed：《/files/pages》是看板/日历的数据源，树视图也一并 loaded，
//   保证两个来源 path 一致、映射最新。
const statusByPath = computed(() => {
  const m = new Map<string, string>();
  for (const p of allPages.value) m.set(p.path, p.knowledge_status || 'unknown');
  return m;
});

// 归一化知识时效状态，保证 class 命名稳定（后端注入值全小写，此处兜底）
function statusClass(s: string | undefined): 'ok' | 'stale' | 'unknown' {
  if (s === 'ok' || s === 'stale') return s;
  return 'unknown';
}

// 计算页面距最近时效日期（updated 优先，缺失回退 reviewed_at）的天数，供 hover 提示。
// 不参与判定（判定在后端），仅展示人读信息；非法/缺失返回 null。
function ageLabel(fm: Record<string, unknown>): string | null {
  const raw = fm.updated ?? fm.reviewed_at;
  if (raw == null) return null;
  const t = typeof raw === 'string' ? Date.parse(raw) : raw instanceof Date ? raw.getTime() : NaN;
  if (Number.isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
  if (days < 0) return null;
  return `距上次更新 ${days} 天`;
}

// 角标 hover 文案：状态 + 距今时长
function statusTitle(status: string | undefined, fm: Record<string, unknown>): string {
  const labels: Record<string, string> = { ok: '时效正常', stale: '已过期待复核', unknown: '未知时效' };
  const s: 'ok' | 'stale' | 'unknown' = statusClass(status);
  const age = ageLabel(fm);
  return age ? `${labels[s]} · ${age}` : labels[s];
}

// 看板分列：4 个核心类型 + 其他
// 为什么用 type 而非 dir：dir 受 LLM 输出目录影响，type 是 frontmatter 字段更稳定
const KANBAN_COLUMNS = [
  { key: 'entity', label: '实体', icon: '◆' },
  { key: 'concept', label: '概念', icon: '◇' },
  { key: 'comparison', label: '对比', icon: '◈' },
  { key: 'query', label: '问答', icon: '◐' },
  { key: 'qa', label: '业务问答', icon: '◑' },
  { key: 'solution', label: '方案沉淀', icon: '◒' },
  { key: 'other', label: '未分类', icon: '◓' },
] as const;

// 看板分组计算：按 frontmatter.type 分列，缺失则按 dir 推断，再不行归 'other'
const kanbanGroups = computed(() => {
  const groups: Record<string, PageItem[]> = {};
  for (const col of KANBAN_COLUMNS) groups[col.key] = [];
  for (const p of allPages.value) {
    const t = String(p.frontmatter.type ?? '').toLowerCase();
    if (groups[t]) {
      groups[t].push(p);
    } else if (groups[p.dir]) {
      // frontmatter 缺 type 时回退到目录名（entities→entity 等单复数映射）
      const dirMap: Record<string, string> = {
        entities: 'entity',
        concepts: 'concept',
        comparisons: 'comparison',
        queries: 'query',
        qa: 'qa',
        solutions: 'solution',
      };
      const mapped = dirMap[p.dir];
      if (mapped && groups[mapped]) groups[mapped].push(p);
      else groups.other.push(p);
    } else {
      groups.other.push(p);
    }
  }
  return groups;
});

// 日历视图：按 created 字段分组
// 为什么按日期而非月份：知识库页面密度低，按日期聚合后点击日期跳转更直观
const calendarGroups = computed(() => {
  const groups: Record<string, PageItem[]> = {};
  for (const p of allPages.value) {
    const created = p.frontmatter.created;
    if (!created || typeof created !== 'string') continue;
    // 取 YYYY-MM-DD 部分（兼容 ISO 字符串与日期对象 toString）
    const dateMatch = created.match(/^\d{4}-\d{2}-\d{2}/);
    if (!dateMatch) continue;
    const date = dateMatch[0];
    if (!groups[date]) groups[date] = [];
    groups[date].push(p);
  }
  // 按日期降序排序（最新在前）
  return Object.entries(groups)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, pages]) => ({ date, pages }));
});

async function loadAllPages() {
  pagesLoading.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/files/pages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allPages.value = data.pages ?? [];
  } catch (err) {
    ElMessage.error('加载页面列表失败：' + (err as Error).message);
    allPages.value = [];
  } finally {
    pagesLoading.value = false;
  }
}

const treeData = ref<TreeNode[]>([]);
const currentNode = ref<string>('');
// 目录树组件实例：用于跨入口打开文档后自动展开/高亮树中对应节点（如从问答页参考跳转）
const treeRef = ref<TreeInstance | null>(null);
const fileContent = ref<FileContent | null>(null);
const loading = ref(false);
const editing = ref(false);
const editBuffer = ref('');
// T00294：全屏查看/编辑当前文档状态（固定遮罩层，非浏览器原生全屏，
//   避免依赖浏览器全屏权限，且能在应用内统一关闭按钮交互）
const fullscreenView = ref(false);

// ── 多文档 Tab（仅 knowledge 模式）──
// 需求：知识浏览页同时打开多个文档，Tab 切换查看；每个 Tab 拥有独立内容缓存。
// 设计取舍：
//   - 仅 knowledge 模式使用；draft/tags 模式仍走 fileContent 单内容区，避免互相干扰；
//   - 切换缓存：Tab 首次打开时请求内容并缓存，切换/恢复直接展示缓存，不重新请求；
//   - 固定状态持久化到 localStorage，刷新/切换后重新打开该文档仍保持固定；
//   - activeTab 为当前激活 Tab，knowledge 内容区以它渲染，替代原 fileContent 作用。
interface DocTab {
  path: string;
  name: string;
  content: FileContent | null;
  loading: boolean;
  pinned: boolean;
}
const openTabs = ref<DocTab[]>([]);
const activePath = ref<string>('');
// 固定 Tab 路径集合的 localStorage 键
const PIN_STORAGE_KEY = 'karpathy:tabPins';
// 当前激活 Tab（computed 派生，knowledge 内容区以此为渲染源）
const activeTab = computed<DocTab | undefined>(() => openTabs.value.find((t) => t.path === activePath.value));

// ── Tab 固定持久化 ──
// 固定路径缓存：避免每次读取 localStorage；首次访问时加载一次
let pinSetCache: Set<string> = new Set();
let pinSetLoaded = false;
function loadPinSet(): Set<string> {
  if (pinSetLoaded) return pinSetCache;
  try {
    const raw = localStorage.getItem(PIN_STORAGE_KEY);
    if (raw) {
      (JSON.parse(raw) as unknown[]).forEach((p) => pinSetCache.add(String(p)));
    }
  } catch {
    // 忽略损坏的持久化数据，从空集合开始
  }
  pinSetLoaded = true;
  return pinSetCache;
}
function persistPins(): void {
  try {
    localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify([...pinSetCache]));
  } catch {
    // 写入失败静默降级，不影响使用
  }
}

// 打开文档：若已有对应 Tab 则仅激活（切换缓存）；否则新建 Tab 并加载内容。
// 被目录/看板/日历/搜索 4 个入口共用。
async function openTab(path: string, name: string): Promise<void> {
  const existing = openTabs.value.find((t) => t.path === path);
  if (existing) {
    await switchTab(path);
    return;
  }
  // 新建 Tab 前若当前 Tab 有未保存编辑先征询，避免误弃
  if (hasUnsavedChanges()) {
    try {
      await ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
    } catch { return; }
  }
  const pins = loadPinSet();
  const tab: DocTab = { path, name, content: null, loading: true, pinned: pins.has(path) };
  openTabs.value.push(tab);
  activePath.value = path;
  currentNode.value = path;
  editing.value = false;
  editBuffer.value = '';
  // 为什么重新取数组末尾的 proxy：push 后 openTabs 里存的是 Vue reactive 代理，
  //   而局部 tab 仍是原始对象；若把原始对象传给 loadTabContent，其上的 loading/content
  //   赋值不会触发响应式更新，导致「加载中」永不消失（既有多 Tab 改动遗留 bug）
  await loadTabContent(openTabs.value[openTabs.value.length - 1]);
  // 目录树跟随当前文档自动展开/高亮（覆盖问答页参考跳转等跨入口场景）
  void syncTreeToPath(path);
  // 章节面板自动展开 + 滚动定位 + 高亮第一个章节（替代原手动展开按钮）
  void syncFileTocToPath(path);
}

// 加载单个 Tab 内容并写入该 Tab 缓存（切换缓存策略：仅首次打开时请求）
async function loadTabContent(tab: DocTab): Promise<void> {
  tab.loading = true;
  tab.content = null;
  try {
    const res = await apiFetch(`${API_BASE}/files?path=${encodeURIComponent(tab.path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // 加载期间用户可能已关闭该 Tab，不再写入缓存
    if (openTabs.value.includes(tab)) tab.content = data;
  } catch (err) {
    if (!openTabs.value.includes(tab)) {
      // 用户已关闭该 Tab，静默终止（避免污染后续状态）
      tab.loading = false;
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    // T00311：参考资料引用为『页面名』时 path 常无扩展名，后端 ENOENT 返回 404。
    //   补 .md 重试一次，命中同名文件即可正常打开；仍失败则落到下方友好提示
    const is404 = /^HTTP 404/.test(msg);
    if (is404 && tab.path && !/\.[a-z0-9]+$/i.test(tab.path)) {
      try {
        const retry = await apiFetch(`${API_BASE}/files?path=${encodeURIComponent(tab.path + '.md')}`);
        if (retry.ok) {
          const data = await retry.json();
          if (openTabs.value.includes(tab)) {
            // 命中后把 tab.path 归一化为真实文件路径（无扩展名 → +'.md'），
            // 才能让目录树定位（setCurrentKey）与后续编辑保存使用一致路径（评审 H2）
            tab.path += '.md';
            tab.content = data;
          }
          tab.loading = false;
          return;
        }
      } catch {
        /* 兜底失败按原路径提示 */
      }
    }
    tab.content = null;
    // 仅激活态 Tab 加载失败时提示，避免后台 Tab 报错噪音
    if (activePath.value === tab.path) {
      ElMessage.error(
        is404 ? `目标文件不存在或已移动（参考：${tab.path}）` : '读取文件失败：' + msg,
      );
    }
  } finally {
    tab.loading = false;
  }
}

// 切换 Tab：退出编辑态并切换当前文档路径；切换缓存（不重新请求）。
// 若当前 Tab 有未保存编辑先征询，避免误弃。
async function switchTab(path: string): Promise<void> {
  if (path === activePath.value) return;
  const tab = openTabs.value.find((t) => t.path === path);
  if (!tab) return;
  if (hasUnsavedChanges()) {
    try {
      await ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
    } catch { return; }
  }
  activePath.value = path;
  currentNode.value = path;
  editing.value = false;
  editBuffer.value = '';
  // 切换文档时同样同步目录树定位，保持目录高亮与激活文档一致
  void syncTreeToPath(path);
  void syncFileTocToPath(path);
}

// 关闭单个 Tab；关闭激活 Tab 时自动转移激活到相邻 Tab；
// 若全部关闭则清空知识内容区（需求：至少保留一个 Tab → 由前端逻辑兜底）
async function closeTab(path: string): Promise<void> {
  const idx = openTabs.value.findIndex((t) => t.path === path);
  if (idx < 0) return;
  openTabs.value.splice(idx, 1);
  if (activePath.value === path) {
    const next = openTabs.value[idx] ?? openTabs.value[idx - 1];
    if (next) {
      await switchTab(next.path);
      // switchTab 已切换；若该 Tab 尚未加载内容则补加载
      if (!next.content) void loadTabContent(next);
    } else {
      activePath.value = '';
      currentNode.value = '';
      fileContent.value = null;
      editing.value = false;
    }
  }
}

// 全部关闭：保留当前激活 Tab（需求：至少保留一个 Tab）
function closeOthers(): void {
  const keep = activePath.value || openTabs.value[0]?.path;
  if (!keep) return;
  openTabs.value = openTabs.value.filter((t) => t.path === keep);
  activePath.value = keep;
}

// 切换固定状态并持久化：固定态 Tab 刷新后重新打开仍保持固定
function togglePin(path: string): void {
  const tab = openTabs.value.find((t) => t.path === path);
  if (!tab) return;
  const pins = loadPinSet();
  if (pins.has(path)) {
    pins.delete(path);
    tab.pinned = false;
  } else {
    pins.add(path);
    tab.pinned = true;
  }
  persistPins();
}

// ── T00270：Tab 拖拽排序 + 置顶固定最左 ──
// 排序逻辑：置顶（pinned）Tab 恒排最左且不参与拖拽；其余 Tab 按用户拖拽顺序排列，
//   顺序持久化到 localStorage（karpathy:tabOrder），刷新后保持。
// 为什么用 ref 存顺序而非普通变量：sortedTabs 是 computed，需依赖响应式数据才能在
//   拖拽后即时重算；普通变量无法触发重渲染。
const TAB_ORDER_STORAGE_KEY = 'karpathy:tabOrder';
const tabOrderRef = ref<string[]>([]);
let tabOrderLoaded = false;

function loadTabOrder(): string[] {
  if (tabOrderLoaded) return tabOrderRef.value;
  try {
    const raw = localStorage.getItem(TAB_ORDER_STORAGE_KEY);
    tabOrderRef.value = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    tabOrderRef.value = [];
  }
  tabOrderLoaded = true;
  return tabOrderRef.value;
}

function persistTabOrder(): void {
  try {
    localStorage.setItem(TAB_ORDER_STORAGE_KEY, JSON.stringify(tabOrderRef.value));
  } catch {
    /* 顺序持久化失败不阻塞拖拽交互 */
  }
}

// 供 DocumentTabs 渲染的排序视图：置顶固定最左，其余按持久化顺序，未记录的新 Tab 追加在后
const sortedTabs = computed<DocTab[]>(() => {
  const order = loadTabOrder();
  const byPath = new Map(openTabs.value.map((t) => [t.path, t]));
  const pinned = openTabs.value.filter((t) => t.pinned);
  const ordered = order
    .map((p) => byPath.get(p))
    .filter((t): t is DocTab => !!t && !t.pinned);
  const rest = openTabs.value.filter((t) => !t.pinned && !ordered.includes(t));
  return [...pinned, ...ordered, ...rest];
});

// 拖拽排序：把 from 移到 to 之前；置顶 Tab 不可参与拖拽（事件层已拦截，此处兜底）
function reorderTabs(from: string, to: string): void {
  if (from === to) return;
  const src = openTabs.value.find((t) => t.path === from);
  if (!src || src.pinned) return;
  const order = loadTabOrder().filter((p) => p !== from);
  const idx = order.indexOf(to);
  order.splice(idx < 0 ? order.length : idx, 0, from);
  tabOrderRef.value = order;
  persistTabOrder();
}

const searchQuery = ref('');

// ── 文档树：文件节点快速定位 ──
// contentPanelRef：右侧内容区滚动容器（.content-panel，overflow-y:auto）
const contentPanelRef = ref<HTMLElement | null>(null);
// locateFlashPath：最近一次定位的文件 path，用于按钮短暂高亮反馈（active 态）
const locateFlashPath = ref<string | null>(null);
// 高亮自动消退定时器句柄：避免连续点击时定时器互相污染
let locateFlashTimer: ReturnType<typeof setTimeout> | null = null;

// 定位指定文件：打开/激活对应 Tab，并平滑滚动右侧到该文档内容顶部
// 为什么用 openTab/switchTab 复用：保证右侧展示目标文档（与树节点点击行为一致），
//   定位目标是"该文档内容起始处"，故 open 后滚动容器到顶部即可
// 为什么 @click.stop 在模板触发而非此处：避免冒泡触发 handleNodeClick 重复 switchTab
async function locateFile(node: TreeNode): Promise<void> {
  try {
    const opened = openTabs.value.some((t) => t.path === node.path);
    if (opened) {
      await switchTab(node.path);
    } else {
      await openTab(node.path, node.name);
    }
  } catch {
    // openTab/switchTab 内部对未保存更改征询取消会 throw，静默终止定位
    return;
  }
  // 等 Tab 激活与内容渲染完成后滚动；若目标文档加载失败（content 为空）则友好提示
  await nextTick();
  const panel = contentPanelRef.value;
  if (!panel) return;
  if (activeTab.value?.path !== node.path) return;
  if (!activeTab.value.content) {
    ElMessage.warning('目标文档尚未加载完成，请稍后重试');
    return;
  }
  panel.scrollTo({ top: 0, behavior: 'smooth' });

  // 按钮短暂高亮反馈：清除旧定时器避免快速点击时闪烁残留
  locateFlashPath.value = node.path;
  if (locateFlashTimer) clearTimeout(locateFlashTimer);
  locateFlashTimer = setTimeout(() => {
    locateFlashPath.value = null;
    locateFlashTimer = null;
  }, 1000);
}

// ── 目录树自动定位（T00254：从问答页参考资料跳转后，目录自动定位到对应文档）──
// 深度优先在目录树中查找指定 path 的节点
function findTreeNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const hit = findTreeNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

// 让目录树展开到目标文档并高亮：先展开祖先目录链使节点可见，再设置当前选中
// 为什么放在 openTab/switchTab 后调用：无论从参考跳转还是树内点击打开文档，
//   目录树都保持与右侧激活文档同步，避免跳转后目录仍停留在旧位置
async function syncTreeToPath(path: string): Promise<void> {
  await nextTick();
  const tree = treeRef.value;
  if (!tree || !path || treeData.value.length === 0) return;
  if (!findTreeNode(treeData.value, path)) return;
  // 逐级展开祖先目录（path 的父路径段），保证目标文档在树中可见
  const dirParts = path.split('/').slice(0, -1);
  let dir = '';
  for (const part of dirParts) {
    dir = dir ? `${dir}/${part}` : part;
    const elNode = tree.getNode(dir);
    if (elNode) elNode.expanded = true;
  }
  tree.setCurrentKey(path);
}

// ── 章节树（T00291 起位于左侧目录文件节点内，点击文件名开头展开按钮显示）──
// TocItem：章节目录条目，从源 markdown 提取（level 1~3 对应 h1~h3）
interface TocItem {
  id: string;
  text: string;
  level: number;
}

// activeTocId：最近定位的章节 id，用于目录项高亮反馈
const activeTocId = ref<string | null>(null);

// 把扁平章节列表过滤为顶级章节：用栈判断层级，栈空即顶级。
// 为什么用栈而非直接 level===1：文档无 h1 时 h2 也应收录为顶级，避免整份文档无章节可显示
function buildTocTree(items: TocItem[]): TocNode[] {
  const root: TocNode[] = [];
  const stack: { level: number }[] = [];
  for (const it of items) {
    while (stack.length > 0 && stack[stack.length - 1].level >= it.level) {
      stack.pop();
    }
    if (stack.length === 0) root.push({ id: it.id, text: it.text });
    stack.push({ level: it.level });
  }
  return root;
}

// 跳转到指定标题锚点：平滑滚动 + 高亮目录项
// 为什么 scrollIntoView：自动滚动到最近的滚动祖先（.content-panel），无需自行计算 scrollTop，
//   且天生支持平滑动画；block:'start' 使标题顶部对齐可视区上沿
function navigateToc(id: string): void {
  const el = document.getElementById(id);
  if (!el) {
    ElMessage.warning('目标章节不存在');
    return;
  }
  activeTocId.value = id;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── T00291：左侧目录文件节点的章节树（按需加载 + 缓存）──
// 为什么从源 markdown 解析而非渲染 DOM：左侧目录任意文件都可能被展开，
//   文件未打开时没有已渲染 DOM 可提取，只能解析源文本
// T00297：文件级互斥展开——一次仅允许一个文件的章节面板展开，避免多文件面板交错叠加；
//   扁平化后展开不再由用户按钮控制，而是跟随当前打开的文档自动定位
const fileTocExpanded = ref<Set<string>>(new Set());
// 章节树缓存：path → TocNode[]，跨文件持久缓存，避免重复请求/解析
const fileTocCache = ref<Map<string, TocNode[]>>(new Map());
// 加载中集合：防止快速连点触发重复请求
const fileTocLoading = ref<Set<string>>(new Set());

// 从源 markdown 解析标题，id 生成顺序与 renderMarkdown 链式 replace 完全一致
// 为什么先替换代码块：renderMarkdown 中代码块先于标题被替换，块内 # 不算标题
function parseMarkdownToc(body: string): TocNode[] {
  const cleaned = body.replace(/```([\s\S]*?)```/g, '');
  const heads: { level: number; text: string }[] = [];
  for (const line of cleaned.split('\n')) {
    let m = line.match(/^### (.+)$/);
    if (m) { heads.push({ level: 3, text: m[1] }); continue; }
    m = line.match(/^## (.+)$/);
    if (m) { heads.push({ level: 2, text: m[1] }); continue; }
    m = line.match(/^# (.+)$/);
    if (m) { heads.push({ level: 1, text: m[1] }); continue; }
  }
  // id 分配顺序与 renderMarkdown 链式 replace 一致（h3→h2→h1），
  // 保证重复标题的去重编号与右侧正文锚点相同，左侧跳转才能命中
  const used = new Set<string>();
  const idByHead: string[] = new Array(heads.length).fill('');
  for (const lvl of [3, 2, 1]) {
    heads.forEach((h, i) => {
      if (h.level === lvl) idByHead[i] = buildHeaderId(h.text, used);
    });
  }
  const items: TocItem[] = heads.map((h, i) => ({ id: `cht-${idByHead[i]}`, text: h.text, level: h.level }));
  return buildTocTree(items);
}

// 读取并解析文件章节（有缓存直接用，否则按需请求）
async function getFileToc(path: string): Promise<TocNode[] | null> {
  const cached = fileTocCache.value.get(path);
  if (cached) return cached;
  if (fileTocLoading.value.has(path)) return null;
  fileTocLoading.value.add(path);
  try {
    // 优先复用已打开 Tab 的内容缓存，未打开时按需读取文件，避免重复请求
    const tab = openTabs.value.find((t) => t.path === path);
    let body = tab?.content?.body;
    if (body === undefined) {
      const res = await apiFetch(`${API_BASE}/files?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as FileContent;
      body = data.body;
    }
    const tocs = parseMarkdownToc(body ?? '');
    fileTocCache.value.set(path, tocs);
    return tocs;
  } catch (err) {
    ElMessage.error('读取章节失败：' + (err as Error).message);
    return null;
  } finally {
    fileTocLoading.value.delete(path);
  }
}

// 自动定位章节面板：打开/切换文档时互斥展开对应文件章节面板，
// 滚动左侧树栏使其进入可视区，并高亮第一个顶级章节。
// 为什么替代原手动展开按钮：目录栏扁平化后无展开/折叠交互，章节面板跟随当前文档自动定位
async function syncFileTocToPath(path: string): Promise<void> {
  if (!path) return;
  fileTocExpanded.value = new Set([path]);
  // 目录树（tree）视图已无章节面板，无需加载章节数据，省一次 /api/files 请求（评审 M2）
  if (knowledgeView.value === 'tree') return;
  // 章节数据可能尚未缓存（首次打开），此时面板还没渲染，需等数据就绪再定位
  const tocs = await getFileToc(path);
  if (tocs === null) return;
  await nextTick();
  scrollTocPanelIntoView(path);
  // 高亮第一个顶级章节：让用户一眼看到当前文档的起始章节
  activeTocId.value = tocs[0]?.id ?? null;
}

// 滚动左侧树栏，使指定文件的章节面板进入可视区（data-toc-path 标记定位目标）
function scrollTocPanelIntoView(path: string): void {
  const panel = document.querySelector<HTMLElement>(
    `.file-toc-panel[data-toc-path="${CSS.escape(path)}"]`,
  );
  if (!panel) return;
  // 'nearest'：仅当面板在可视区外才滚动，已可见时不动，避免无谓的视觉跳动
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 等待指定文件章节数据就绪（无论由谁触发加载）：
// 避免 openTab 触发的异步自动高亮晚于用户点击执行，覆盖掉目标章节的高亮
function waitTocSettled(path: string): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (fileTocCache.value.has(path) || !fileTocLoading.value.has(path)) resolve();
      else setTimeout(tick, 30);
    };
    tick();
  });
}

// 点击左侧章节：目标文档未打开时先打开，再跳转正文锚点（复用右侧定位逻辑）
async function navigateFileToc(path: string, id: string): Promise<void> {
  if (activeTab.value?.path !== path) {
    await openTab(path, path.split('/').pop()?.replace(/\.md$/i, '') || '文档');
    // openTab 会自动高亮该文档第一个章节；等它完成后，再覆盖为用户点击的目标章节
    await waitTocSettled(path);
  }
  await nextTick();
  navigateToc(id);
}

// ── 章节滚动跟随（scrollspy）：右侧滚动时自动高亮左侧「章节」栏当前章节 ──
// 为什么用 getBoundingClientRect 相对面板顶部判定：标题顶端"进入可视区上缘即视为已达"，
//   而非等章节完全滚出可视区，保证高亮在阅读到章节时就完成切换；
// 为什么要归并到顶级章节：左侧章节栏只展示顶级章节（buildTocTree 扁平化），
//   右侧 h2/h3 必须归并到其所属顶级标题才能命中左侧节点
// 为什么用 rAF 节流：scroll 高频触发，且需读取 getBoundingClientRect（强制同步重排），
//   每帧只算一次避免长文档滚动掉帧；跨帧累加的事件合并到帧首处理（评审 M1）
let spyRaf = 0;
function onContentScroll(): void {
  if (spyRaf) return;
  spyRaf = requestAnimationFrame(() => {
    spyRaf = 0;
    computeActiveToc();
  });
}

function computeActiveToc(): void {
  if (editing.value) return;
  const panel = contentPanelRef.value;
  const body = activeTab.value?.content?.body;
  if (!panel || !body) return;
  // 预览态才有锚点标题；编辑态（el-input）无 DOM 可定位，直接跳过
  const container = panel.querySelector('.markdown-body') as HTMLElement | null;
  if (!container) return;
  const heads = Array.from(
    container.querySelectorAll<HTMLElement>('h1[id^="cht-"], h2[id^="cht-"], h3[id^="cht-"]'),
  );
  if (heads.length === 0) return;
  const panelTop = panel.getBoundingClientRect().top;
  // 取最后一个顶端已进入可视区上缘的标题（DOM 与文档顺序一致，首个越过即终止）
  let current: HTMLElement | null = null;
  for (const h of heads) {
    if (h.getBoundingClientRect().top - panelTop > 0) break;
    current = h;
  }
  if (!current) current = heads[0];
  activeTocId.value = topLevelIdOf(heads, current.id);
}

// 切换文档后右侧 DOM 整体替换，但 .content-panel 的 scrollTop 可能保留而 scroll 不触发，
// 需在内容变化后主动重算一次，使左侧「章节」栏与右侧实际首屏一致（评审 H1）
watch(
  () => activeTab.value?.content,
  () => nextTick(() => computeActiveToc()),
);

// 把任意标题 id 归并到其所属顶级章节 id；栈判级逻辑与 buildTocTree 完全一致，
// 保证 h2/h3 也能命中左侧顶级章节节点（无 h1 时 h2 顺着根层也被视为顶级）
function topLevelIdOf(heads: HTMLElement[], targetId: string): string {
  const stack: { id: string; level: number }[] = [];
  let topId: string | null = null;
  for (const h of heads) {
    const level = Number(h.tagName[1]);
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length === 0) topId = h.id;
    stack.push({ id: h.id, level });
    if (h.id === targetId) return topId ?? h.id;
  }
  return targetId;
}

const searchHits = ref<SearchHit[]>([]);
const searching = ref(false);
const showSearchResults = ref(false);

// AC-10: source/status 过滤 + FR-15-3: type 过滤
// 按 frontmatter.source 过滤（如 "qq-chat", "web", "manual"），空串 = 全部
const sourceFilter = ref('');
// 按 frontmatter.status 过滤（如 "draft", "published"），空串 = 全部
const statusFilter = ref('');
// FR-15-3：按 frontmatter.type 过滤（entity/concept/comparison/query/qa/solution），空串 = 全部
const typeFilter = ref('');

// 过滤选项预设值
const sourceOptions = [
  { label: '全部来源', value: '' },
  { label: 'QQ 聊天', value: 'qq-chat' },
  { label: '网页', value: 'web' },
  { label: '手工录入', value: 'manual' },
];
const statusOptions = [
  { label: '全部状态', value: '' },
  { label: '草稿', value: 'draft' },
  { label: '已发布', value: 'published' },
];
// FR-15-3：type 选项复用 KANBAN_COLUMNS 派生，避免重复维护枚举
// 为什么排除 other：other 是前端兜底分类，不是 SCHEMA.md 合法 type 值，不能作为过滤条件
const typeOptions = [
  { label: '全部类型', value: '' },
  ...KANBAN_COLUMNS.filter((c) => c.key !== 'other').map((c) => ({
    label: c.label,
    value: c.key,
  })),
];

const treeProps = {
  label: 'name',
  children: 'children',
};

// ===== 草稿审核状态 =====
// draft 列表与当前选中 draft 复用 fileContent（结构一致：frontmatter+body）
const drafts = ref<DraftItem[]>([]);
const currentDraftPath = ref<string>('');
// 批量编译进度：每项对应一个 draft 的编译状态
// §全部走 store：batchItems/compiling/progressMessage 从 compileStore 读取，
//   切页面时 Browse.vue 卸载但 store 状态保留，SSE 仍在后台运行
const batchItems = computed(() => compileStore.draftBatchItems);
const compiling = computed(() => compileStore.draftIsPublishing);
const progressMessage = computed(() => compileStore.draftProgressMessage);
let clearPanelTimer: ReturnType<typeof setTimeout> | null = null;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// ===== FR-10-1 AI 标签审核状态 =====
// 待审核 tag 页面列表（GET /api/tags/pending 返回）
const pendingTagPages = ref<PendingTagPage[]>([]);
const currentTagPagePath = ref<string>('');
// 单页面 tag 操作进行中标志（禁用按钮防重复点击）
const tagOperating = ref(false);
// 重新生成 tag 建议进行中标志
const tagRegenerating = ref(false);

async function loadTree() {
  try {
    const res = await apiFetch(`${API_BASE}/files/tree`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    treeData.value = data.tree ?? [];
  } catch (err) {
    ElMessage.error('加载目录树失败：' + (err as Error).message);
  }
}

async function loadDrafts() {
  try {
    const res = await apiFetch(`${API_BASE}/qq-ingest/drafts`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    drafts.value = data.drafts ?? [];
  } catch (err) {
    ElMessage.error('加载草稿列表失败：' + (err as Error).message);
    drafts.value = [];
  }
}

// FR-10-1: 加载待审核 tag 页面列表
// 为什么独立函数：与 loadDrafts 解耦，tags 模式切换时单独触发
async function loadPendingTags() {
  try {
    const res = await apiFetch(`${API_BASE}/tags/pending`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    pendingTagPages.value = data.pages ?? [];
  } catch (err) {
    ElMessage.error('加载待审核标签失败：' + (err as Error).message);
    pendingTagPages.value = [];
  }
}

// FR-10-1: 选中待审核 tag 页面，加载文件内容到右侧
// 为什么复用 fileContent：与 knowledge/draft 模式共享右侧内容渲染逻辑
async function handleTagPageClick(p: PendingTagPage) {
  if (hasUnsavedChanges()) {
    try {
      await ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
    } catch { return; }
  }
  currentTagPagePath.value = p.path;
  editing.value = false;
  loading.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/files?path=${encodeURIComponent(p.path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fileContent.value = await res.json();
    editBuffer.value = fileContent.value?.content ?? '';
  } catch (err) {
    ElMessage.error('读取页面失败：' + (err as Error).message);
    fileContent.value = null;
  } finally {
    loading.value = false;
  }
}

// FR-10-1: 确认单个 tag（从 ai_tags 移到 tags）
// 为什么逐个确认：用户可挑选合适的 tag，拒绝不合适的（不点击即可）
async function confirmTag(pagePath: string, tag: string) {
  if (tagOperating.value) return;
  tagOperating.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/tags/confirm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: pagePath, tag }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    // 就地更新 pendingTagPages 中的对应项
    const idx = pendingTagPages.value.findIndex((p) => p.path === pagePath);
    if (idx >= 0) {
      // 若 ai_tags 已空，从列表移除；否则更新字段
      if (data.aiTags && data.aiTags.length === 0) {
        pendingTagPages.value.splice(idx, 1);
        // 当前选中的页面被移除时清空内容区
        if (currentTagPagePath.value === pagePath) {
          fileContent.value = null;
          currentTagPagePath.value = '';
        }
      } else {
        pendingTagPages.value[idx] = {
          ...pendingTagPages.value[idx],
          aiTags: data.aiTags ?? [],
          existingTags: data.tags ?? pendingTagPages.value[idx].existingTags,
        };
      }
    }
    ElMessage.success(`已确认标签：${tag}`);
  } catch (err) {
    ElMessage.error('确认标签失败：' + (err as Error).message);
  } finally {
    tagOperating.value = false;
  }
}

// FR-10-1: 重新生成 tag 建议（POST /api/tags/suggest）
// 为什么独立按钮：LLM 可能首次生成质量不佳，用户可重试
async function regenerateTags(pagePath: string) {
  if (tagRegenerating.value) return;
  try {
    await ElMessageBox.confirm(
      '重新生成将覆盖当前 AI 标签建议，且会调用 LLM 产生费用。继续？',
      '重新生成确认',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  tagRegenerating.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/tags/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: pagePath }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    // 就地更新 aiTags
    const idx = pendingTagPages.value.findIndex((p) => p.path === pagePath);
    if (idx >= 0) {
      pendingTagPages.value[idx] = {
        ...pendingTagPages.value[idx],
        aiTags: data.aiTags ?? [],
      };
    }
    ElMessage.success(`已重新生成 ${data.aiTags?.length ?? 0} 个标签建议`);
  } catch (err) {
    ElMessage.error('重新生成失败：' + (err as Error).message);
  } finally {
    tagRegenerating.value = false;
  }
}

// 构建搜索 URL，附加 source/status/type 过滤参数（AC-10 + FR-15-3）
function buildSearchUrl(): string | null {
  const q = searchQuery.value.trim();
  const src = sourceFilter.value;
  const st = statusFilter.value;
  const tp = typeFilter.value;
  // 无关键词且无过滤条件时返回 null（不搜索）
  if (!q && !src && !st && !tp) return null;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (src) params.set('source', src);
  if (st) params.set('status', st);
  if (tp) params.set('type', tp);
  return `${API_BASE}/search?${params.toString()}`;
}

async function doSearch() {
  const url = buildSearchUrl();
  if (!url) {
    showSearchResults.value = false;
    searchHits.value = [];
    return;
  }
  searching.value = true;
  showSearchResults.value = true;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    searchHits.value = data.hits ?? [];
  } catch (err) {
    ElMessage.error('搜索失败：' + (err as Error).message);
    searchHits.value = [];
  } finally {
    searching.value = false;
  }
}

function clearSearch() {
  searchQuery.value = '';
  searchHits.value = [];
  showSearchResults.value = false;
  // 同时清除过滤条件（AC-10）
  sourceFilter.value = '';
  statusFilter.value = '';
}

// 过滤条件变更时立即触发搜索（无防抖，因为是下拉选择）
function handleFilterChange() {
  doSearch();
}

async function handleSearchHit(hit: SearchHit) {
  await openTab(hit.path, hit.title);
}

async function handleNodeClick(node: TreeNode) {
  if (node.type !== 'file') return;
  await openTab(node.path, node.name);
}

// FR-11 看板/日历视图点击页面：复用打开 Tab 逻辑（入参类型不同，但语义等价）
async function handlePageClick(p: PageItem) {
  await openTab(p.path, String(p.frontmatter.title || p.name));
}

// T00xxx：章节视图点击文件行 → 打开文档（章节面板由 openTab 自动展开定位）。
// 为什么不再用 toggleFileToc：扁平化后无手动展开按钮，点击文件行即打开文档更直观
async function handleTocFileClick(p: PageItem) {
  await openTab(p.path, String(p.frontmatter.title || p.name));
}

// 选中 draft：复用 /api/files 读取内容（draft 是 vault 内 .md 文件）
async function handleDraftClick(d: DraftItem) {
  if (hasUnsavedChanges()) {
    try {
      await ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
    } catch { return; }
  }
  currentDraftPath.value = d.path;
  editing.value = false;
  loading.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/files?path=${encodeURIComponent(d.path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fileContent.value = await res.json();
    editBuffer.value = fileContent.value?.content ?? '';
  } catch (err) {
    ElMessage.error('读取草稿失败：' + (err as Error).message);
    fileContent.value = null;
  } finally {
    loading.value = false;
  }
}

function startEdit() {
  // knowledge 模式基于激活 Tab 内容，draft/tags 基于 fileContent
  const content = mode.value === 'knowledge' ? activeTab.value?.content : fileContent.value;
  if (!content) return;
  editBuffer.value = content.content ?? '';
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
  editBuffer.value = '';
}

async function saveEdit() {
  // knowledge 模式目标为激活 Tab 路径（可能在切换模式后 currentNode 已被清空）
  const target = mode.value === 'draft'
    ? currentDraftPath.value
    : mode.value === 'knowledge'
      ? (activeTab.value?.path || currentNode.value)
      : currentNode.value;
  if (!target) return;
  try {
    const res = await apiFetch(`${API_BASE}/files?path=${encodeURIComponent(target)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editBuffer.value }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    ElMessage.success('保存成功');
    editing.value = false;
    // 重新读取保留模式上下文：draft 模式回拉 draft，knowledge 模式刷新当前 Tab 缓存
    if (mode.value === 'draft') {
      await handleDraftClick({ path: target, name: '' });
    } else {
      // 刷新已保存 Tab 的内容缓存，保证切回时展示最新（不新建 Tab）
      const tab = openTabs.value.find((t) => t.path === target);
      if (tab) await loadTabContent(tab);
      else await openTab(target, target.split('/').pop() || '');
    }
  } catch (err) {
    ElMessage.error('保存失败：' + (err as Error).message);
  }
}

// 发布单个 draft：调用 POST /api/qq-ingest/compile/:draftPath（SSE）
async function publishDraft(d: DraftItem) {
  if (compiling.value) {
    ElMessage.warning('正在编译中，请稍候');
    return;
  }
  // 二次确认：发布会调用 LLM 产生费用且写入正式页面
  try {
    await ElMessageBox.confirm(
      `确认发布草稿「${d.name}」到知识库？发布后将生成正式页面。`,
      '发布确认',
      { type: 'warning' },
    );
  } catch {
    return; // 用户取消
  }

  // §走 store：初始化 batchItems 列表 + publishing 状态，便于切回后恢复
  compileStore.startSingleDraftPublish({
    path: d.path,
    name: d.name,
    status: 'running',
    pages: [],
  });
  const controller = new AbortController();
  compileStore.setDraftAbortController(controller);

  try {
    const res = await apiFetch(`${API_BASE}/qq-ingest/compile/${encodeURIComponent(d.path)}`,
      { method: 'POST', signal: controller.signal },
    );
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    await consumeSSE(res, handleCompileEvent, controller.signal);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    ElMessage.error('发布失败：' + (err as Error).message);
    compileStore.updateDraftItem(0, { status: 'error', message: (err as Error).message });
  } finally {
    // §store 状态保留：SSE 流结束后保持 batchItems 可见
    //   compiling=false 标记已完成但不清空列表，由用户点击关闭按钮触发 clearDraftPublish
    compileStore.finalizeDraftPublish();
    compileStore.setDraftAbortController(null);
    // 编译完成后自动刷新草稿列表
    loadDrafts();
    loadTree();
  }
}

// 批量发布：调用 POST /api/qq-ingest/compile/batch（SSE）
async function publishAllDrafts() {
  if (compiling.value) {
    ElMessage.warning('正在编译中，请稍候');
    return;
  }
  if (drafts.value.length === 0) {
    ElMessage.info('没有可发布的草稿');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确认批量发布 ${drafts.value.length} 个草稿？此操作将逐个调用 LLM 编译并写入正式页面。`,
      '批量发布确认',
      { type: 'warning' },
    );
  } catch {
    return;
  }

  // §走 store：初始化 batchItems 列表为 drafts 全部状态 pending，publishing=true
  compileStore.startDraftPublish(drafts.value.map((d) => ({
    path: d.path,
    name: d.name,
    status: 'pending',
    pages: [],
  })));
  const controller = new AbortController();
  compileStore.setDraftAbortController(controller);

  try {
    const res = await apiFetch(`${API_BASE}/qq-ingest/compile/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 不传 drafts 字段：后端扫描 drafts/ 目录全部文件
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    await consumeSSE(res, handleCompileEvent, controller.signal);
    ElMessage.success('批量发布完成');
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    ElMessage.error('批量发布失败：' + (err as Error).message);
  } finally {
    // §store 状态保留：SSE 流结束后保持 batchItems 可见
    compileStore.finalizeDraftPublish();
    compileStore.setDraftAbortController(null);
  }
}

// 辅助函数：处理进度事件
function handleProgressEvent(data: DraftCompileEvent) {
  compileStore.setDraftProgress(data.message ?? '');
  if (typeof data.data?.fileIndex === 'number') {
    const idx = data.data.fileIndex;
    if (batchItems.value[idx]) {
      if (data.status === 'running' && data.step === 'compile') {
        compileStore.updateDraftItem(idx, { status: 'running' });
      }
      compileStore.updateDraftItem(idx, { message: data.message });
    }
  }
}

// 辅助函数：处理页面生成事件
function handlePageEvent(data: DraftCompileEvent) {
  if (!data.data?.path || !data.data?.title) return;
  const idx = typeof data.data.fileIndex === 'number' ? data.data.fileIndex : 0;
  if (batchItems.value[idx]) {
    compileStore.appendDraftItemPage(idx, {
      path: data.data.path,
      title: data.data.title,
    });
  }
}

// 辅助函数：处理完成事件
function handleDoneEvent(data: DraftCompileEvent) {
  if (data.step === 'batch_done') {
    compileStore.setDraftProgress(data.message ?? '批量编译完成');
    loadDrafts();
    loadTree();
    return;
  }
  const idx = typeof data.data?.fileIndex === 'number' ? data.data.fileIndex : 0;
  if (batchItems.value[idx]) {
    compileStore.updateDraftItem(idx, {
      status: data.status === 'done' ? 'done' : 'error',
      message: data.message,
    });
  }
  if (data.status === 'done' && batchItems.value.length === 1) {
    ElMessage.success('发布成功');
    compileStore.setDraftProgress(data.message ?? '编译完成');
  }
}

// 辅助函数：处理错误事件
function handleErrorEvent(data: DraftCompileEvent) {
  const idx = typeof data.data?.fileIndex === 'number' ? data.data.fileIndex : 0;
  if (batchItems.value[idx]) {
    compileStore.updateDraftItem(idx, {
      status: 'error',
      message: data.message,
    });
  } else {
    ElMessage.error(data.message ?? '编译失败');
  }
}

// SSE 事件统一处理：单/批量编译共用
// §所有变更通过 store：保证切页面切回时 store 状态能完整恢复
function handleCompileEvent(eventType: string, data: DraftCompileEvent) {
  if (eventType === 'progress') { handleProgressEvent(data); return; }
  if (eventType === 'page') { handlePageEvent(data); return; }
  if (eventType === 'done') { handleDoneEvent(data); return; }
  if (eventType === 'error') { handleErrorEvent(data); }
}
function abortCompile() {
  // §走 store：触发 AbortController + 标记 batchItems 中非终态项为 cancelled
  compileStore.abortDraftPublish();
  // 将所有非 done/error/cancelled 的项标记为 cancelled，避免状态混乱
  for (let i = 0; i < batchItems.value.length; i++) {
    const item = batchItems.value[i];
    if (item.status !== 'done' && item.status !== 'error' && item.status !== 'cancelled') {
      compileStore.updateDraftItem(i, { status: 'cancelled' });
    }
  }
  // 5 秒后自动清理编译面板（通过 store 调用，跨页面也生效）
  if (clearPanelTimer) clearTimeout(clearPanelTimer);
  clearPanelTimer = setTimeout(() => {
    compileStore.clearDraftPublish();
    clearPanelTimer = null;
  }, 5000);
}

// 切换模式时重置内容区状态，避免上一模式文件残留
async function switchMode(m: BrowseMode) {
  if (mode.value === m) return;
  if (hasUnsavedChanges()) {
    try {
      await import('element-plus').then(({ ElMessageBox }) => {
        return ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
      });
    } catch {
      return; // 用户取消切换
    }
  }
  mode.value = m;
  fileContent.value = null;
  editing.value = false;
  currentDraftPath.value = '';
  currentNode.value = '';
  currentTagPagePath.value = '';
  if (m === 'draft') {
    loadDrafts();
  } else if (m === 'tags') {
    // FR-10-1: 进入 tags 模式时加载待审核页面列表
    loadPendingTags();
  }
}

// 批量编译统计
const batchSuccessCount = computed(() => batchItems.value.filter((b) => b.status === 'done').length);
const batchErrorCount = computed(() => batchItems.value.filter((b) => b.status === 'error').length);
const batchCancelledCount = computed(() => batchItems.value.filter((b) => b.status === 'cancelled').length);
// 编译进度百分比：基于 done/cancelled/error 的总数计算
const progressPercentage = computed(() => {
  if (batchItems.value.length === 0) return 0;
  const finished = batchSuccessCount.value + batchErrorCount.value + batchCancelledCount.value;
  return Math.round((finished / batchItems.value.length) * 100);
});
// 是否有未保存的编辑更改
// knowledge 模式基于激活 Tab 的内容基准，draft/tags 基于 fileContent
function hasUnsavedChanges(): boolean {
  if (!editing.value) return false;
  const base = mode.value === 'knowledge'
    ? activeTab.value?.content?.content ?? ''
    : fileContent.value?.content ?? '';
  return editBuffer.value !== base;
}

// 下载当前打开的文档（知识浏览→内容操作栏「下载」按钮）
const downloading = ref(false);
async function downloadCurrent() {
  // knowledge 模式以激活 Tab 路径为准（切换模式后 currentNode 可能为空）
  const path = mode.value === 'knowledge' ? activeTab.value?.path : currentNode.value;
  if (!path) return;
  downloading.value = true;
  try {
    await downloadVaultFile(path, path.split('/').pop() || 'document');
    ElMessage.success('已开始下载');
  } catch (err) {
    ElMessage.error('下载失败：' + (err as Error).message);
  } finally {
    downloading.value = false;
  }
}

// 从列表（看板/日历卡片）直接下载文档，带 @click.stop 避免触发卡片打开详情
// downloadingPage：防快速连点重复下载（评审发现 #4）
const downloadingPage = ref(false);
async function downloadPage(p: PageItem) {
  if (downloadingPage.value) return;
  downloadingPage.value = true;
  try {
    await downloadVaultFile(p.path, String(p.frontmatter.title || p.name));
    ElMessage.success('已开始下载');
  } catch (err) {
    ElMessage.error('下载失败：' + (err as Error).message);
  } finally {
    downloadingPage.value = false;
  }
}

// ── GFM 表格辅助函数 ──
// 知识正文常含 Markdown 表格；原简易解析器未识别 | 分隔语法，导致表格原样显示符号。
// 这里在行内语法（加粗/斜体/wiki链接/行内代码）处理完成后、分块包裹 <p> 之前，
// 识别独立表格块并组装为 <table>，单元格内已渲染的行内标签原样保留。

// 解析单行表格：去首尾 | 后按 | 分割，返回去空白单元格数组
function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
// 判断 block 是否为表格：≥3 行、每行以 | 起止、且第 2 行为分隔行（每段仅含 : - 空格，即 GFM 对齐语法）
function isTableBlock(block: string): boolean {
  const lines = block.split('\n');
  if (lines.length < 3) return false;
  const trimmed = lines.map((l) => l.trim());
  if (!trimmed.every((l) => l.startsWith('|') && l.endsWith('|'))) return false;
  const sepCells = parseTableRow(trimmed[1]);
  if (sepCells.length === 0) return false;
  return sepCells.every((c) => /^:?-+:?$/.test(c.replace(/ +/g, '')));
}
// 解析列对齐：分隔行段两侧/单侧冒号决定 th/td 的 text-align
function tableAlign(cell: string): string {
  const c = cell.replace(/ +/g, '');
  if (c.startsWith(':') && c.endsWith(':')) return 'center';
  if (c.endsWith(':')) return 'right';
  if (c.startsWith(':')) return 'left';
  return '';
}
function renderTable(block: string): string {
  const lines = block.split('\n').map((l) => l.trim());
  const headers = parseTableRow(lines[0]);
  const aligns = parseTableRow(lines[1]).map(tableAlign);
  const attrs = (i: number) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : '');
  const thead = `<thead><tr>${headers.map((h, i) => `<th${attrs(i)}>${h}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${lines.slice(2).map((r) => `<tr>${parseTableRow(r).map((c, i) => `<td${attrs(i)}>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

// 标题锚点 id 生成：正文渲染与左侧章节树共用同一算法，
// 保证左侧点击章节跳转时能命中正文同名锚点（重复标题去重编号也一致）
function buildHeaderId(raw: string, used: Set<string>): string {
  const base = raw.trim().toLowerCase()
    .replace(/[`*_~#\[\]()!<>]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim().replace(/\s+/g, '-') || 'sec';
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

function renderMarkdown(md: string): string {
  if (!md) return '';
  // 标题锚点去重集合：保证同文档内重复标题 id 唯一（如出现多个"引言"）
  const usedHeadings = new Set<string>();
  // 生成稳定标题 id：保留中英文/数字，其余符号归一为 '-'；空标题回退 'sec'
  // 为什么每次渲染重建集合：切换 Tab / 保存后同文档 id 稳定，且不同文档间不互相污染
  // 为什么用 unicode 属性 \p{L}\p{N}：正文含中文，需按"Unicode 字母/数字"保留而非仅 ASCII
  const headerId = (raw: string): string => buildHeaderId(raw, usedHeadings);
  let html = md
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>'); // NOSONAR 需要正则捕获组提取代码块
  html = html.replace(/^### (.+)$/gm, (_, t) => `<h3 id="cht-${headerId(t as string)}">${t as string}</h3>`) // NOSONAR 需要多行锚点
    .replace(/^## (.+)$/gm, (_, t) => `<h2 id="cht-${headerId(t as string)}">${t as string}</h2>`) // NOSONAR 需要多行锚点
    .replace(/^# (.+)$/gm, (_, t) => `<h1 id="cht-${headerId(t as string)}">${t as string}</h1>`); // NOSONAR 需要多行锚点
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') // NOSONAR 需要正则捕获组
    .replace(/\*(.+?)\*/g, '<em>$1</em>'); // NOSONAR 需要正则捕获组
  html = html.replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">[[$1]]</span>'); // NOSONAR 需要正则捕获组
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>'); // NOSONAR 需要正则捕获组
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>'); // NOSONAR 需要多行锚点
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`); // NOSONAR 需要正则分组匹配
  html = html.split(/\n\n+/).map((block) => {
    if (/^<(h\d|ul|pre|li)/.test(block.trim())) return block;
    if (isTableBlock(block)) return renderTable(block);
    if (!block.trim()) return '';
    return `<p>${block.replaceAll('\n', '<br>')}</p>`;
  }).join('\n');
  return html;
}

let lastSavedContent = '';

// 搜索防抖：输入停止 400ms 后自动触发搜索
// 为什么 400ms：中文字输入法可能较慢，400ms 比英文用户习惯略长但不会让用户等待太久
watch(searchQuery, (newVal) => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  if (!newVal.trim()) {
    showSearchResults.value = false;
    searchHits.value = [];
    return;
  }
  searchDebounceTimer = setTimeout(() => {
    doSearch();
  }, 400);
});

// 编辑未保存保护：记录了编辑开始时的原始内容，用于切换前对比
// 为什么不在 startEdit 中设置：cancelEdit/saveEdit 等路径可能不经过 startEdit
watch(editing, (val) => {
  if (val && fileContent.value) {
    lastSavedContent = fileContent.value.content ?? '';
  }
});

onMounted(async () => {
  // T00268：恢复文档树栏的拖拽宽度与收起态（刷新后保持用户设置）
  loadTreePanelState();
  // §从 localStorage 恢复草稿发布状态：刷新页面或长时间切走后能继续看到之前的工作
  // 必须在 loadDrafts/loadTree 之前调用，确保 batchItems 已填充到模板
  compileStore.loadDraftPublishState();

  // Ingest.vue 抽取完成后跳转过来时，通过 sessionStorage 传递目标模式
  // 为什么用 sessionStorage 而非 props：跨组件通信，避免 App.vue 中间层传递
  const jumpMode = sessionStorage.getItem('karpathy:jumpMode');
  // 需求：草稿审核 Tab 仅管理员可见；非管理员即便携带 jumpMode=draft 也不跳入，强制回知识浏览
  if (jumpMode === 'draft' && isAdmin.value) {
    sessionStorage.removeItem('karpathy:jumpMode');
    switchMode('draft');
  } else {
    if (jumpMode) sessionStorage.removeItem('karpathy:jumpMode');
    await loadTree();
  }
  // FR-11: 刷新后 knowledgeView 已从 localStorage 恢复为 kanban/calendar，
  // 但 watch 默认不立即触发，需在此主动加载页面列表避免视图空白
  if (
    allPages.value.length === 0 &&
    jumpMode !== 'draft'
  ) {
    await loadAllPages();
  }
  // RefsList 派发的 jump-vault 事件：App.vue 切到 browse 后
  // 从 sessionStorage 读取目标 path 并自动打开该文件
  const jumpPath = sessionStorage.getItem('karpathy:jumpPath');
  if (jumpPath) {
    sessionStorage.removeItem('karpathy:jumpPath');
    // 以文件名为 Tab 标题；jumpPath 来自 RefsList/知识抽取跳转，可能含扩展名
    await openTab(jumpPath, jumpPath.split('/').pop()?.replace(/\.md$/i, '') || '文档');
  }
});
</script>

<template>
  <div class="browse-page">
    <div class="glass-card browse-card fade-up">
      <div class="card-deco"></div>
      <!-- T00260：标题栏可折叠行——头部 + 收起按钮；
           T00293：收起时整行不渲染（v-if），顶部不残留空白，
           展开图标改为悬浮按钮叠加在知识目录（tree-panel）上 -->
      <div v-if="!headCollapsed" class="browse-head-row">
        <Transition name="head-collapse">
          <!-- 不对称头部 -->
          <div class="browse-head">
            <div class="head-text">
              <h2 class="head-title grad-text">{{
                mode === 'draft' ? '草稿审核' : mode === 'tags' ? 'AI 标签审核' : '知识浏览'
              }}</h2>
              <!-- T00258：原三条副标题文字迁移到下方对应切换按钮的 title 悬浮提示，
                   此处不再直接展示，以收窄头部、扩大浏览视野 -->
            </div>
            <!-- 模式切换：单选按钮组，避免新增菜单项 -->
            <el-radio-group v-model="mode" size="small" @change="switchMode">
              <el-radio-button
                value="knowledge"
                title="点击左侧文件查看内容，支持编辑保存"
                data-tip="点击左侧文件查看内容，支持编辑保存"
              >知识浏览</el-radio-button>
              <el-radio-button
                v-if="isAdmin"
                value="draft"
                title="审核 LLM 抽取的草稿，编辑后发布为正式页面"
                data-tip="审核 LLM 抽取的草稿，编辑后发布为正式页面"
              >草稿审核</el-radio-button>
              <el-radio-button
                v-if="isAdmin"
                value="tags"
                title="审核 AI 生成的标签建议，确认后合并到正式 tags 字段"
                data-tip="审核 AI 生成的标签建议，确认后合并到正式 tags 字段"
              >AI 标签</el-radio-button>
            </el-radio-group>
            <el-button
              v-if="mode === 'knowledge'"
              size="small"
              data-tip="重新加载知识库目录树"
              @click="loadTree"
            >刷新目录</el-button>
            <el-button
              v-else-if="mode === 'draft'"
              size="small"
              data-tip="重新加载草稿列表"
              @click="loadDrafts"
            >刷新草稿</el-button>
            <el-button
              v-else
              size="small"
              data-tip="重新加载待审核的 AI 标签建议"
              @click="loadPendingTags"
            >刷新标签</el-button>
            <!-- 收起按钮：悬浮提示随状态变化 -->
            <button
              class="head-collapse-btn"
              title="收起标题栏"
              data-tip="收起标题栏"
              @click="headCollapsed = true"
            >
              <el-icon>
                <ArrowUp />
              </el-icon>
            </button>
          </div>
        </Transition>
      </div>
      <!-- T00293：收起标题栏后的悬浮展开按钮，叠加在知识目录栏左上角，点击恢复标题栏 -->
      <button
        v-if="headCollapsed"
        type="button"
        class="head-expand-float"
        title="展开标题栏"
        data-tip="展开标题栏"
        @click="headCollapsed = false"
      >
        <el-icon><ArrowDown /></el-icon>
      </button>

      <!-- ===== 草稿审核模式 ===== -->
      <div v-if="mode === 'draft'" class="browse-body">
        <!-- 左侧草稿列表 -->
        <div class="tree-panel draft-panel">
          <div class="draft-toolbar">
            <span class="draft-count">{{ drafts.length }} 个草稿</span>
            <el-button
              size="small"
              type="primary"
              data-tip="将全部草稿编译并发布为正式知识库文档"
              :disabled="compiling || drafts.length === 0"
              @click="publishAllDrafts"
            >批量发布</el-button>
          </div>

          <div v-if="drafts.length === 0" class="tree-empty">
            暂无草稿。请先在「投递资料」上传 QQ 聊天记录并触发抽取
          </div>

          <!-- 草稿列表项 -->
          <div
            v-for="d in drafts"
            :key="d.path"
            class="draft-item hover-glow"
            :class="{ active: currentDraftPath === d.path }"
            @click="handleDraftClick(d)"
          >
            <div class="draft-name">
              <span class="file-icon">◈</span>
              {{ d.name }}
            </div>
            <div class="draft-path">{{ d.path }}</div>
            <!-- 单个发布按钮 -->
            <el-button
              size="small"
              type="primary"
              text
              data-tip="编译并发布此草稿为正式文档"
              :disabled="compiling"
              @click.stop="publishDraft(d)"
            >发布</el-button>
          </div>
        </div>

        <!-- 右侧：草稿内容 + 编译进度 -->
        <div class="content-panel">
          <!-- 编译进度面板 -->
          <div v-if="compiling || batchItems.length > 0" class="compile-progress">
            <div class="progress-header">
              <el-tooltip :content="progressMessage" placement="top" :show-after="500">
                <span class="progress-msg">{{ progressMessage }}</span>
              </el-tooltip>
              <div class="progress-stats">
                <span class="stat-success"><el-icon><Check /></el-icon> {{ batchSuccessCount }}</span>
                <span v-if="batchCancelledCount > 0" class="stat-cancelled"><el-icon><CircleClose /></el-icon> {{ batchCancelledCount }}</span>
                <span v-if="batchErrorCount > 0" class="stat-error"><el-icon><Close /></el-icon> {{ batchErrorCount }}</span>
                <span class="stat-total">/ {{ batchItems.length }}</span>
                <el-button
                  v-if="compiling"
                  size="small"
                  text
                  type="danger"
                  data-tip="中止当前批量发布任务"
                  @click="abortCompile"
                >取消</el-button>
                <el-button
                  v-if="!compiling && batchItems.length > 0"
                  size="small"
                  text
                  data-tip="关闭批量发布进度面板"
                  @click="compileStore.clearDraftPublish()"
                >关闭</el-button>
              </div>
            </div>
            <!-- 进度条 -->
            <el-progress
              :percentage="progressPercentage"
              :stroke-width="6"
              :status="batchErrorCount > 0 && !compiling ? 'exception' : progressPercentage === 100 ? 'success' : ''"
              :striped="compiling"
              :striped-flow="compiling"
              class="compile-progress-bar"
            />
            <!-- 批量编译明细列表 -->
            <div v-if="batchItems.length > 1" class="batch-list">
              <div
                v-for="(item, idx) in batchItems"
                :key="item.path"
                class="batch-row"
                :class="`status-${item.status}`"
              >
                <span class="batch-index">#{{ idx + 1 }}</span>
                <span class="batch-name">{{ item.name }}</span>
                <span class="batch-status">{{ item.status === 'cancelled' ? '已取消' : item.status === 'done' ? '已完成' : item.status === 'running' ? '进行中' : item.status === 'error' ? '失败' : '待处理' }}</span>
                <span v-if="item.pages.length > 0" class="batch-pages">
                  → {{ item.pages.map((p) => p.title).join(', ') }}
                </span>
                <span v-if="item.message" class="batch-msg">{{ item.message }}</span>
              </div>
            </div>
          </div>

          <div v-if="loading" class="content-loading">
            <p>加载中…</p>
          </div>
          <div v-else-if="!fileContent" class="content-empty">
            <p class="empty-tip">选择左侧草稿查看内容</p>
          </div>
          <div v-else class="content-show">
            <!-- frontmatter 元信息 -->
            <div
              v-if="fileContent.frontmatter && Object.keys(fileContent.frontmatter).length > 0"
              class="frontmatter-bar"
            >
              <span v-for="(val, key) in fileContent.frontmatter" :key="key" class="fm-chip">
                <strong>{{ key }}:</strong> {{ String(val) }}
              </span>
            </div>

            <!-- 操作栏 -->
            <div class="action-bar">
              <span class="current-path">{{ currentDraftPath }}</span>
              <div class="actions">
                <el-button
                  v-if="!editing"
                  size="small"
                  type="primary"
                  data-tip="编译并发布此草稿为正式文档"
                  :disabled="compiling"
                  @click="publishDraft({ path: currentDraftPath, name: currentDraftPath.split('/').pop() || '' })"
                >发布此草稿</el-button>
                <el-button v-if="!editing" size="small" data-tip="进入内容编辑模式" @click="startEdit">编辑</el-button>
                <template v-else>
                  <el-button size="small" type="primary" data-tip="保存对内容的修改" @click="saveEdit">保存</el-button>
                  <el-button size="small" data-tip="退出编辑模式并放弃未保存的修改" @click="cancelEdit">取消</el-button>
                </template>
              </div>
            </div>

            <!-- 编辑模式 -->
            <el-input
              v-if="editing"
              v-model="editBuffer"
              type="textarea"
              :rows="20"
              resize="none"
              class="editor-area"
            />

            <!-- 预览模式 -->
            <div v-else class="markdown-body" v-html="renderMarkdown(fileContent.body)"></div>
          </div>
        </div>
      </div>

      <!-- ===== FR-10-1 AI 标签审核模式 ===== -->
      <div v-else-if="mode === 'tags'" class="browse-body">
        <!-- 左侧：待审核页面列表 -->
        <div class="tree-panel tag-panel">
          <div class="draft-toolbar">
            <span class="draft-count">{{ pendingTagPages.length }} 个待审核</span>
          </div>

          <div v-if="pendingTagPages.length === 0" class="tree-empty">
            暂无待审核的 AI 标签建议。编译新页面后将自动生成标签建议
          </div>

          <div
            v-for="p in pendingTagPages"
            :key="p.path"
            class="draft-item hover-glow"
            :class="{ active: currentTagPagePath === p.path }"
            @click="handleTagPageClick(p)"
          >
            <div class="draft-name">
              <span class="file-icon">◈</span>
              {{ p.title }}
            </div>
            <div class="draft-path">{{ p.path }}</div>
            <div class="tag-count-badge">{{ p.aiTags.length }} 个建议</div>
          </div>
        </div>

        <!-- 右侧：页面内容 + 标签审核操作 -->
        <div class="content-panel">
          <div v-if="loading" class="content-loading">
            <p>加载中…</p>
          </div>
          <div v-else-if="!fileContent" class="content-empty">
            <p class="empty-tip">选择左侧页面查看内容与 AI 标签建议</p>
          </div>
          <div v-else class="content-show">
            <!-- frontmatter 元信息 -->
            <div
              v-if="fileContent.frontmatter && Object.keys(fileContent.frontmatter).length > 0"
              class="frontmatter-bar"
            >
              <span v-for="(val, key) in fileContent.frontmatter" :key="key" class="fm-chip">
                <strong>{{ key }}:</strong> {{ String(val) }}
              </span>
            </div>

            <!-- FR-10-1: AI 标签审核操作栏 -->
            <div class="tag-action-bar">
              <span class="current-path">{{ currentTagPagePath }}</span>
              <el-button
                size="small"
                type="primary"
                data-tip="重新调用模型生成该页面的 AI 标签建议"
                :loading="tagRegenerating"
                :disabled="!currentTagPagePath"
                @click="regenerateTags(currentTagPagePath)"
              >重新生成建议</el-button>
            </div>

            <!-- AI 标签建议列表（可点击确认） -->
            <div
              v-if="currentTagPagePath && (pendingTagPages.find(p => p.path === currentTagPagePath)?.aiTags.length ?? 0) > 0"
              class="tag-suggest-list"
            >
              <div class="tag-suggest-title">AI 标签建议（点击确认采纳）：</div>
              <div class="tag-chips">
                <el-tag
                  v-for="tag in pendingTagPages.find(p => p.path === currentTagPagePath)?.aiTags ?? []"
                  :key="tag"
                  class="tag-chip hover-glow"
                  :type="'info'"
                  effect="plain"
                  :disable-transitions="false"
                  @click="confirmTag(currentTagPagePath, tag)"
                >
                  <span class="tag-add-icon">+</span>
                  {{ tag }}
                </el-tag>
              </div>
            </div>

            <!-- 已存在的 tags（展示，不可点击） -->
            <div
              v-if="currentTagPagePath && (pendingTagPages.find(p => p.path === currentTagPagePath)?.existingTags.length ?? 0) > 0"
              class="tag-existing-list"
            >
              <div class="tag-suggest-title">已有标签：</div>
              <div class="tag-chips">
                <el-tag
                  v-for="tag in pendingTagPages.find(p => p.path === currentTagPagePath)?.existingTags ?? []"
                  :key="tag"
                  class="tag-chip"
                  :type="'success'"
                  effect="dark"
                >
                  {{ tag }}
                </el-tag>
              </div>
            </div>

            <!-- 操作栏（编辑/保存） -->
            <div class="action-bar">
              <span class="current-path">{{ currentTagPagePath }}</span>
              <div class="actions">
                <el-button v-if="!editing" size="small" data-tip="进入内容编辑模式" @click="startEdit">编辑</el-button>
                <template v-else>
                  <el-button size="small" type="primary" data-tip="保存对内容的修改" @click="saveEdit">保存</el-button>
                  <el-button size="small" data-tip="退出编辑模式并放弃未保存的修改" @click="cancelEdit">取消</el-button>
                </template>
              </div>
            </div>

            <!-- 编辑模式 -->
            <el-input
              v-if="editing"
              v-model="editBuffer"
              type="textarea"
              :rows="20"
              resize="none"
              class="editor-area"
            />

            <!-- 预览模式 -->
            <div v-else class="markdown-body" v-html="renderMarkdown(fileContent.body)"></div>
          </div>
        </div>
      </div>

      <!-- ===== 知识浏览模式（FR-11: 三视图切换） ===== -->
      <div v-else class="browse-body">
        <!-- 左侧目录树 + 搜索（T00268：可拖拽宽度 + 收起/展开） -->
        <div
          class="tree-panel"
          :class="{
            'view-expanded': knowledgeView !== 'tree',
            collapsed: treeCollapsed,
            'tree-dragging': treeDragging,
          }"
          :style="knowledgeView === 'tree' && !treeCollapsed ? { width: treeWidth + 'px' } : undefined"
        >
          <!-- T00300：收起按钮移入 search-row 筛选条件后同行，移除独立 tree-toolbar 行 -->
          <div class="search-box">
            <!-- T00292：搜索框收窄 + 右侧三点图标展开三个过滤下拉 -->
            <div class="search-row">
              <el-input
                v-model="searchQuery"
                placeholder="搜索知识库…"
                size="small"
                :prefix-icon="Search"
                clearable
                class="search-input"
                @keyup.enter="doSearch"
                @clear="clearSearch"
              />
              <el-popover placement="bottom-end" :width="230" trigger="click" popper-class="browse-filter-popper">
                <template #reference>
                  <button type="button" class="filter-more-btn" title="筛选条件" data-tip="筛选条件">
                    <el-icon><MoreFilled /></el-icon>
                  </button>
                </template>
                <!-- AC-10: source/status 过滤 + FR-15-3: type 过滤 -->
                <div class="filter-pop">
                  <div class="filter-field">
                    <span class="filter-label">来源</span>
                    <el-select
                      v-model="sourceFilter"
                      placeholder="来源筛选"
                      size="small"
                      clearable
                      @change="handleFilterChange"
                    >
                      <el-option
                        v-for="opt in sourceOptions"
                        :key="opt.value"
                        :label="opt.label"
                        :value="opt.value"
                      />
                    </el-select>
                  </div>
                  <div class="filter-field">
                    <span class="filter-label">状态</span>
                    <el-select
                      v-model="statusFilter"
                      placeholder="状态筛选"
                      size="small"
                      clearable
                      @change="handleFilterChange"
                    >
                      <el-option
                        v-for="opt in statusOptions"
                        :key="opt.value"
                        :label="opt.label"
                        :value="opt.value"
                      />
                    </el-select>
                  </div>
                  <!-- FR-15-3：type 过滤下拉框（按 frontmatter.type 过滤） -->
                  <div class="filter-field">
                    <span class="filter-label">类型</span>
                    <el-select
                      v-model="typeFilter"
                      placeholder="类型筛选"
                      size="small"
                      clearable
                      @change="handleFilterChange"
                    >
                      <el-option
                        v-for="opt in typeOptions"
                        :key="opt.value"
                        :label="opt.label"
                        :value="opt.value"
                      />
                    </el-select>
                  </div>
                </div>
              </el-popover>
              <!-- T00300：文档树栏收起按钮移到筛选条件后同行（仅 tree 视图显示） -->
              <button
                v-if="knowledgeView === 'tree'"
                type="button"
                class="tree-collapse-btn"
                :title="treeCollapsed ? '展开文档树栏' : '收起文档树栏'"
                data-tip="收起/展开文档树栏"
                @click="toggleTreeCollapsed"
              >
                <el-icon><ArrowLeft /></el-icon>
              </button>
            </div>
            <!-- FR-11 视图模式切换器（AC-11-1, AC-11-7） -->
            <div class="view-switcher">
              <el-radio-group v-model="knowledgeView" size="small">
                <el-radio-button value="tree">目录</el-radio-button>
                <el-radio-button value="toc">章节</el-radio-button>
                <el-radio-button value="kanban">看板</el-radio-button>
                <el-radio-button value="calendar">日历</el-radio-button>
              </el-radio-group>
            </div>
          </div>

          <!-- 搜索结果（搜索时优先显示，覆盖所有视图） -->
          <div v-if="showSearchResults" class="search-results">
            <div class="search-header">
              <span class="search-count">{{ searchHits.length }} 条结果</span>
              <el-button size="small" text data-tip="清空搜索关键词，返回完整目录" @click="clearSearch">返回目录</el-button>
            </div>
            <div v-if="searching" class="search-loading">SEARCHING...</div>
            <div v-else-if="searchHits.length === 0" class="search-empty">未找到匹配页面</div>
            <div
              v-for="hit in searchHits"
              :key="hit.path"
              class="search-hit-item hover-glow"
              @click="handleSearchHit(hit)"
            >
              <div class="hit-title">{{ hit.title }}</div>
              <div class="hit-path">{{ hit.path }}</div>
              <div class="hit-snippet">{{ hit.snippet }}</div>
            </div>
          </div>

          <!-- 目录树视图 -->
          <template v-else-if="knowledgeView === 'tree'">
            <el-tree
              ref="treeRef"
              :data="treeData"
              :props="treeProps"
              node-key="path"
              :current-node-key="currentNode"
              @node-click="handleNodeClick"
              :default-expand-all="false"
              :expand-on-click-node="true"
              :highlight-current="true"
            >
              <template #default="{ data }">
                <div class="tree-node" :class="{ 'is-file': data.type === 'file' }">
                  <div class="tree-node-row">
                    <span v-if="data.type === 'dir'">▸</span>
                    <span v-else class="file-icon">◈</span>
                    {{ data.name }}
                    <span
                      v-if="data.type === 'file'"
                      class="status-dot"
                      :class="statusClass(statusByPath.get(data.path))"
                      :title="statusTitle(statusByPath.get(data.path), {})"
                    ></span>
                    <!-- FR：文件节点快速定位按钮：未悬停低调、悬停高亮；点击滚动右侧文档到该文档内容顶部
                         为什么 @click.stop：避免冒泡触发 node-click 重复打开 Tab → 仅执行定位 -->
                    <button
                      v-if="data.type === 'file'"
                      type="button"
                      class="locate-btn"
                      :class="{ active: locateFlashPath === data.path }"
                      title="定位到右侧文档内容"
                      data-tip="定位到右侧文档内容"
                      @click.stop="locateFile(data)"
                    >
                      <el-icon><Location /></el-icon>
                    </button>
                  </div>
                </div>
              </template>
            </el-tree>
            <div v-if="treeData.length === 0" class="tree-empty">
              知识库还是空的，先去投递资料吧
            </div>
          </template>

          <!-- 章节视图：按文件分组的章节树，点击文件行打开文档并自动展开其章节 -->
          <template v-else-if="knowledgeView === 'toc'">
            <div v-if="allPages.length === 0" class="tree-empty">加载中…</div>
            <div v-else class="toc-file-list">
              <div
                v-for="p in allPages"
                :key="p.path"
                class="toc-file-item"
              >
                <div class="tree-node-row toc-file-row" @click.stop="handleTocFileClick(p)">
                  <span class="file-icon">◈</span>
                  <span class="toc-file-name" :title="p.path">{{ p.frontmatter.title || p.name }}</span>
                  <span
                    class="status-dot"
                    :class="statusClass(p.knowledge_status)"
                    :title="statusTitle(p.knowledge_status, p.frontmatter)"
                  ></span>
                </div>
                <div
                  v-if="fileTocExpanded.has(p.path)"
                  class="file-toc-panel"
                  :data-toc-path="p.path"
                  @click.stop
                >
                  <div v-if="fileTocLoading.has(p.path)" class="file-toc-loading">加载章节…</div>
                  <template v-else-if="(fileTocCache.get(p.path) ?? []).length > 0">
                    <TocTree
                      :nodes="fileTocCache.get(p.path) ?? []"
                      :active-id="activeTocId"
                      @navigate="(id: string) => navigateFileToc(p.path, id)"
                    />
                  </template>
                  <div v-else class="file-toc-loading">无章节</div>
                </div>
              </div>
            </div>
          </template>

          <!-- 看板视图（FR-11 AC-11-2）：按 type 分列 -->
          <template v-else-if="knowledgeView === 'kanban'">
            <div v-if="pagesLoading" class="tree-empty">加载中…</div>
            <div v-else-if="allPages.length === 0" class="tree-empty">
              暂无页面。先去投递资料并编译
            </div>
            <div v-else class="kanban-scroll">
              <div
                v-for="col in KANBAN_COLUMNS"
                :key="col.key"
                class="kanban-col"
              >
                <div class="kanban-col-head">
                  <span class="kanban-icon">{{ col.icon }}</span>
                  <span class="kanban-label">{{ col.label }}</span>
                  <span class="kanban-count">{{ kanbanGroups[col.key]?.length ?? 0 }}</span>
                </div>
                <div
                  v-for="p in kanbanGroups[col.key] ?? []"
                  :key="p.path"
                  class="kanban-card hover-glow"
                  :class="{ active: currentNode === p.path }"
                  @click="handlePageClick(p)"
                >
                  <div class="kanban-card-title">
                    <span
                      class="status-dot"
                      :class="statusClass(p.knowledge_status)"
                      :title="statusTitle(p.knowledge_status, p.frontmatter)"
                    ></span>
                    {{ p.frontmatter.title || p.name }}
                  </div>
                  <div class="kanban-card-path">{{ p.path }}</div>
                  <div v-if="p.frontmatter.tags" class="kanban-card-tags">
                    <span
                      v-for="t in (Array.isArray(p.frontmatter.tags) ? p.frontmatter.tags : [p.frontmatter.tags]).slice(0, 3)"
                      :key="String(t)"
                      class="kanban-tag"
                    >{{ t }}</span>
                  </div>
                  <div class="kanban-card-actions">
                    <el-button
                      size="small"
                      text
                      type="primary"
                      data-tip="下载此页面为 Markdown 文件"
                      :disabled="downloadingPage"
                      @click.stop="downloadPage(p)"
                    >下载</el-button>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- 日历视图（FR-11 AC-11-3）：按 created 分组，点击日期折叠/展开 -->
          <template v-else-if="knowledgeView === 'calendar'">
            <div v-if="pagesLoading" class="tree-empty">加载中…</div>
            <div v-else-if="calendarGroups.length === 0" class="tree-empty">
              暂无带 created 字段的页面
            </div>
            <div v-else class="calendar-list">
              <div
                v-for="group in calendarGroups"
                :key="group.date"
                class="calendar-group"
              >
                <div class="calendar-date">
                  <span class="date-icon">◢</span>
                  <span class="date-text">{{ group.date }}</span>
                  <span class="date-count">{{ group.pages.length }} 个页面</span>
                </div>
                <div
                  v-for="p in group.pages"
                  :key="p.path"
                  class="calendar-card hover-glow"
                  :class="{ active: currentNode === p.path }"
                  @click="handlePageClick(p)"
                >
                  <div class="calendar-card-title">
                    <span
                      class="status-dot"
                      :class="statusClass(p.knowledge_status)"
                      :title="statusTitle(p.knowledge_status, p.frontmatter)"
                    ></span>
                    {{ p.frontmatter.title || p.name }}
                  </div>
                  <div class="calendar-card-path">{{ p.path }}</div>
                  <div class="calendar-card-actions">
                    <el-button
                      size="small"
                      text
                      type="primary"
                      data-tip="下载此页面为 Markdown 文件"
                      :disabled="downloadingPage"
                      @click.stop="downloadPage(p)"
                    >下载</el-button>
                  </div>
                </div>
              </div>
            </div>
          </template>
          <!-- T00268：拖拽手柄——右边缘竖条，拖拽调整树栏宽度（仅 tree 视图且未收起） -->
          <div
            v-if="knowledgeView === 'tree' && !treeCollapsed"
            class="tree-resize-handle"
            title="拖拽调整宽度"
            @mousedown.prevent="onTreeResizeStart"
          ></div>
        </div>

        <!-- T00268：树栏收起后的展开按钮（悬浮在内容区左缘，点击恢复树栏） -->
        <button
          v-if="knowledgeView === 'tree' && treeCollapsed"
          type="button"
          class="tree-expand-btn"
          title="展开文档树栏"
          data-tip="展开文档树栏"
          @click="toggleTreeCollapsed"
        >
          <el-icon><ArrowRight /></el-icon>
        </button>

        <!-- 右侧内容区：多文档 Tab + 当前激活 Tab 内容 -->
        <div class="content-panel" ref="contentPanelRef" @scroll="onContentScroll">
          <!-- Tab 栏：仅在至少打开一个文档时显示（T00269：下载/编辑等按钮移入 Tab 行右侧） -->
          <DocumentTabs
            v-if="openTabs.length > 0"
            :tabs="sortedTabs"
            :active-path="activePath"
            @switch="switchTab"
            @close="closeTab"
            @close-others="closeOthers"
            @toggle-pin="togglePin"
            @reorder="reorderTabs"
          >
            <template #actions>
              <!-- T00296：下载/编辑/退出全屏改为简洁可交互图标按钮（文字移入悬浮提示） -->
              <el-button
                v-if="!editing"
                size="small"
                :icon="Download"
                data-tip="下载当前页面为 Markdown 文件"
                :loading="downloading"
                @click="downloadCurrent"
              ></el-button>
              <!-- T00294：文档浏览栏右上角全屏查看/编辑图标（打开全屏遮罩浏览或编辑文本） -->
              <el-button
                v-if="activeTab?.content"
                size="small"
                :icon="FullScreen"
                data-tip="全屏查看/编辑当前文档"
                @click="fullscreenView = true"
              ></el-button>
              <el-button v-if="!editing" size="small" :icon="Edit" data-tip="进入内容编辑模式" @click="startEdit"></el-button>
              <template v-else>
                <el-button size="small" type="primary" data-tip="保存对内容的修改" @click="saveEdit">保存</el-button>
                <el-button size="small" data-tip="退出编辑模式并放弃未保存的修改" @click="cancelEdit">取消</el-button>
              </template>
            </template>
          </DocumentTabs>
          <div v-if="activeTab?.loading" class="content-loading">
            <p>加载中…</p>
          </div>
          <div v-else-if="!activeTab || !activeTab.content" class="content-empty">
            <p class="empty-tip">打开左侧目录/看板/日历中的文档以开始浏览</p>
          </div>
          <div v-else class="content-show">
            <!-- T00269：文档标题与操作按钮已移至 Tab 行（下载/编辑按钮在 Tab 页签右侧），此处不再重复显示 -->

            <!-- 编辑模式 -->
            <el-input
              v-if="editing"
              v-model="editBuffer"
              type="textarea"
              :rows="20"
              resize="none"
              class="editor-area"
            />

            <!-- 预览模式 -->
            <div v-else class="markdown-body" v-html="renderMarkdown(activeTab.content.body)"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- T00294：全屏查看/编辑遮罩（Teleport 到 body，脱离滚动容器不被裁剪；
         内部复用编辑/保存/取消逻辑，全屏编辑同样走 editBuffer + saveEdit） -->
    <Teleport to="body">
      <div v-if="fullscreenView && activeTab?.content" class="fullscreen-overlay">
        <div class="fs-toolbar">
          <div class="fs-info">
            <span class="fs-path">{{ activeTab.path }}</span>
          </div>
          <div class="fs-actions">
            <!-- T00296：全屏内编辑为图标，退出用 X 图标，简洁可交互 -->
            <el-button v-if="!editing" size="small" :icon="Edit" data-tip="进入内容编辑模式" @click="startEdit"></el-button>
            <template v-else>
              <el-button size="small" type="primary" data-tip="保存对内容的修改" @click="saveEdit">保存</el-button>
              <el-button size="small" data-tip="退出编辑模式并放弃未保存的修改" @click="cancelEdit">取消</el-button>
            </template>
            <el-button size="small" :icon="Close" data-tip="退出全屏" @click="fullscreenView = false"></el-button>
          </div>
        </div>
        <!-- 编辑态：全屏文本编辑 -->
        <el-input
          v-if="editing"
          v-model="editBuffer"
          type="textarea"
          resize="none"
          class="fs-editor"
        />
        <!-- 浏览态：全屏渲染 markdown -->
        <div v-else class="markdown-body fs-body" v-html="renderMarkdown(activeTab.content.body)"></div>
      </div>
    </Teleport>

    <!-- 文档摘要条（T00257）：从浏览框上方迁移到页面整体底部，长条小字弱化视觉权重，
         随激活文档切换自动刷新（v-if 绑定 activeTab 天然响应式） -->
    <div
      v-if="mode === 'knowledge' && activeTab?.content?.frontmatter && Object.keys(activeTab.content.frontmatter).length > 0"
      class="doc-summary-bar"
      :key="activeTab.path"
    >
      <span v-for="(val, key) in activeTab.content.frontmatter" :key="key" class="fm-chip">
        <strong>{{ key }}:</strong> {{ String(val) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.browse-page {
  display: flex;
  flex-direction: column;
  /* 高度填满 .content：侧栏布局后顶部导航与页脚已删除，
     .content 高度 = 100vh - app-shell 上下 padding，让浏览页视野延展到底部 */
  height: 100%;
}

.browse-card {
  padding: 28px 32px;
  /* flex: 1 让卡片填满 .browse-page 剩余高度，
     替代原 calc(100vh - 240px) 顶部布局下为导航+页脚预留的固定减去值 */
  flex: 1;
  min-height: 480px;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

.card-deco {
  position: absolute;
  top: -40px;
  right: -40px;
  width: 200px;
  height: 200px;
  background: var(--grad-fire);
  opacity: 0.08;
  transform: rotate(25deg);
  border-radius: 32px;
  pointer-events: none;
}

/* T00260：标题栏行——头部（可折叠） */
.browse-head-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

/* 展开/收起切换按钮：小尺寸图标按钮，颜色跟随主题变量。
   T00271：去边框——去掉 border 与 hover 光晕，改用悬浮背景色反馈，避免多余描边 */
.head-collapse-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-top: 2px;
  border: none;
  background: transparent;
  color: var(--text-soft);
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;
}

/* 悬浮反馈：仅背景色与文字色变化，无边框/光晕 */
.head-collapse-btn:hover {
  background: var(--accent-purple-a15);
  color: var(--neon-cyan);
}

/* 键盘可达：focus 有明确焦点环，满足 WCAG 焦点可见性 */
.head-collapse-btn:focus-visible {
  outline: 2px solid var(--neon-cyan);
  outline-offset: 1px;
}

/* T00293：收起标题栏后的悬浮展开按钮——叠加在知识目录栏左上角，
   半透明卡片背景 + 主题描边，hover 高亮提示可点击恢复 */
.head-expand-float {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: 6px 0 0 6px;
  padding: 0;
  background: var(--bg-card);
  border: 1px solid var(--accent-purple-a25);
  border-radius: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  box-shadow: 0 4px 12px var(--accent-purple-a15);
  transition: color 0.2s ease, border-color 0.2s ease;
}

.head-expand-float:hover {
  color: var(--neon-cyan);
  border-color: var(--accent-cyan-a40);
}

/* 键盘可达：focus 有明确焦点环 */
.head-expand-float:focus-visible {
  outline: 2px solid var(--neon-cyan);
  outline-offset: 1px;
}

/* 头部收起/展开动画：max-height + 透明度 + 下边距同步过渡，流畅不跳动 */
.head-collapse-enter-active,
.head-collapse-leave-active {
  transition: max-height 0.25s ease, opacity 0.25s ease, margin-bottom 0.25s ease;
  overflow: hidden;
}

.head-collapse-enter-from,
.head-collapse-leave-to {
  max-height: 0;
  opacity: 0;
  margin-bottom: 0;
}

.head-collapse-enter-to,
.head-collapse-leave-from {
  max-height: 60px;
  opacity: 1;
  margin-bottom: 12px;
}

/* 不对称头部 */
/* T00258：移除副标题后收窄头部——减小下边距，标题行内垂直居中 */
.browse-head {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 12px;
  position: relative;
  z-index: 1;
}

.head-text {
  flex: 1;
}

.head-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--neon-cyan);
  letter-spacing: 2px;
  display: block;
  margin-bottom: 2px;
}

.head-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 1px;
}

.browse-body {
  flex: 1;
  display: flex;
  gap: 18px;
  overflow: hidden;
  position: relative;
  z-index: 1;
}

/* 左侧目录树（T00268：position 供拖拽手柄定位；width 过渡实现收起/展开动画） */
.tree-panel {
  width: 280px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 14px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a15);
  border-radius: var(--radius-card);
  position: relative;
  transition: width 250ms ease;
}

/* T00300：收起按钮移入 search-row 与筛选条件同行——靠右对齐，与三点图标视觉一致 */
.tree-collapse-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color 0.2s ease, background 0.2s ease;
}

.tree-collapse-btn:hover {
  color: var(--neon-cyan);
  background: var(--accent-purple-a12);
}

/* T00268：收起态——宽度归零、隐藏边框与内边距，内容区自动扩展 */
.tree-panel.collapsed {
  width: 0;
  min-width: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
}

/* T00268：拖拽过程中禁用 width 过渡，保证宽度跟随鼠标即时变化不滞后 */
.tree-panel.tree-dragging {
  transition: none;
}

/* T00268：拖拽手柄——右侧内边缘 6px 竖条，hover/拖拽时高亮提示可拖 */
.tree-resize-handle {
  position: absolute;
  top: 0;
  right: 0;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 2;
}

.tree-resize-handle:hover,
.tree-panel.tree-dragging .tree-resize-handle {
  background: var(--accent-cyan-a20);
}

/* T00268：收起后悬浮在内容区左缘的展开按钮 */
.tree-expand-btn {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 3;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 44px;
  padding: 0;
  background: var(--bg-card);
  border: 1px solid var(--accent-purple-a20);
  border-radius: 0 8px 8px 0;
  color: var(--text-secondary);
  cursor: pointer;
  box-shadow: 0 4px 12px var(--accent-purple-a15);
  transition: color 0.2s ease;
}

.tree-expand-btn:hover {
  color: var(--neon-cyan);
}

/* FR-11 看板/日历视图下放宽左侧面板，给多列/分组留出空间 */
.tree-panel.view-expanded {
  width: auto;
  flex: 1;
  min-width: 0;
}

.search-box {
  margin-bottom: 12px;
}

/* T00292：搜索框行——搜索框收窄 + 右侧三点过滤按钮（过滤条件收进 popover） */
.search-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 收窄搜索框：让出右侧空间给过滤按钮，目录栏观感更紧凑 */
.search-input {
  flex: 1;
  min-width: 0;
}

/* 三点过滤按钮：小图标按钮，hover 高亮提示可展开过滤条件 */
.filter-more-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color 0.2s ease, background 0.2s ease;
}

.filter-more-btn:hover {
  color: var(--neon-cyan);
  background: var(--accent-purple-a12);
}

/* 过滤 popover 内：三个下拉条件纵向排列，字段标签 + 选择器 */
.filter-pop {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.filter-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.filter-label {
  font-size: 11px;
  color: var(--text-soft);
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

/* FR-11 视图切换器 */
.view-switcher {
  margin-top: 10px;
  display: flex;
  justify-content: center;
}

.view-switcher :deep(.el-radio-button__inner) {
  padding: 6px 14px;
}

/* FR-11 看板视图 */
.kanban-scroll {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 8px;
  /* 横向滚动条主题适配 */
  scrollbar-width: thin;
}

.kanban-col {
  flex: 0 0 200px;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kanban-col-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--accent-purple-a10);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
  /* T00259：--text-primary 仅 light-business 定义，其他主题回退成暗色近白导致看不清；
     改用全主题通用的 --text-bright */
  color: var(--text-bright);
  position: sticky;
  top: 0;
  z-index: 1;
}

.kanban-icon {
  color: var(--neon-pink);
  font-size: 14px;
}

.kanban-label {
  flex: 1;
}

.kanban-count {
  font-size: 11px;
  color: var(--text-soft);
  background: var(--bg-card);
  padding: 1px 6px;
  border-radius: 8px;
  font-family: var(--font-mono);
}

.kanban-card {
  padding: 8px 10px;
  background: var(--bg-card);
  border: 1px solid var(--accent-purple-a15);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s ease;
}

.kanban-card:hover {
  border-color: var(--accent-pink-a40);
  transform: translateY(-1px);
}

.kanban-card.active {
  border-color: var(--neon-pink);
  background: var(--accent-pink-a10);
}

.kanban-card-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-bright);
  margin-bottom: 4px;
  /* 标题过长省略，避免撑高卡片 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kanban-card-path {
  font-size: 11px;
  color: var(--text-soft);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kanban-card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.kanban-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--accent-cyan-a15);
  color: var(--text-bright);
}

/* 看板/日历卡片底部下载操作行 */
.kanban-card-actions,
.calendar-card-actions {
  margin-top: 8px;
  display: flex;
  justify-content: flex-end;
}

/* FR-11 日历视图 */
.calendar-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.calendar-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.calendar-date {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--accent-cyan-a10);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  font-family: var(--font-mono);
}

.date-icon {
  color: var(--neon-cyan);
}

.date-text {
  flex: 1;
}

.date-count {
  font-size: 11px;
  color: var(--text-soft);
  background: var(--bg-card);
  padding: 1px 6px;
  border-radius: 8px;
}

.calendar-card {
  padding: 8px 12px;
  background: var(--bg-card);
  border: 1px solid var(--accent-purple-a15);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s ease;
  margin-left: 22px;
}

.calendar-card:hover {
  border-color: var(--accent-cyan-a40);
  transform: translateX(2px);
}

.calendar-card.active {
  border-color: var(--neon-cyan);
  background: var(--accent-cyan-a10);
}

.calendar-card-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-bright);
  margin-bottom: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.calendar-card-path {
  font-size: 11px;
  color: var(--text-soft);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* FR-18 时效角标：ok=绿(stale 语义用 --graph-solutions) / stale=橙(--graph-qa) / unknown=灰(text-secondary)。
   只用主题既有变量，保证深浅主题下语义一致。hover 的 title 展示距今时长。 */
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  vertical-align: middle;
  background: var(--text-secondary);
}
.status-dot.ok {
  background: var(--graph-solutions, #00ff88);
  box-shadow: 0 0 6px rgba(0, 255, 136, 0.5);
}
.status-dot.stale {
  background: var(--graph-qa, #ff9500);
  box-shadow: 0 0 6px rgba(255, 149, 0, 0.55);
}
.status-dot.unknown {
  background: var(--text-secondary);
}

.search-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.search-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0 10px;
  border-bottom: 1px dashed var(--accent-purple-a20);
  margin-bottom: 8px;
}

.search-count {
  font-size: 11px;
  color: var(--neon-cyan);
  font-weight: 600;
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

.search-loading,
.search-empty {
  text-align: center;
  font-size: 11px;
  color: var(--text-dim);
  padding: 24px 0;
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

.search-hit-item {
  padding: 10px 12px;
  background: var(--accent-purple-a05);
  border: 1px solid var(--accent-purple-a15);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.search-hit-item:hover {
  background: var(--accent-purple-a12);
  border-color: var(--neon-purple);
  transform: translateX(3px);
}

.hit-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
  margin-bottom: 3px;
}

.hit-path {
  font-size: 10px;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
  margin-bottom: 5px;
}

.hit-snippet {
  font-size: 11px;
  color: var(--text-soft);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* T00291：文件节点改为纵向结构——第一行节点信息，第二行章节树 */
.tree-node {
  display: flex;
  flex-direction: column;
  font-size: 13px;
  color: var(--text-base);
}

.tree-node-row {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}

.tree-node.is-file {
  cursor: pointer;
}

/* T00291：文件节点下方的章节树容器——左侧主题色描边强调层级关系 */
.file-toc-panel {
  margin: 4px 0 6px 18px;
  padding-left: 8px;
  border-left: 1px solid var(--accent-cyan-a25);
  max-height: 260px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.file-toc-loading {
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  letter-spacing: 1px;
  padding: 4px 0;
}

.file-icon {
  color: var(--neon-cyan);
}

/* T00299：章节视图——按文件分组的章节树列表 */
.toc-file-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toc-file-item {
  border-bottom: 1px dashed var(--accent-purple-a12);
  padding-bottom: 2px;
}

.toc-file-row {
  padding: 5px 4px;
  border-radius: 6px;
  cursor: pointer;
}

.toc-file-row:hover {
  background: var(--accent-cyan-a10);
}

.toc-file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--text-base);
}

/* 文档树文件节点：快速定位按钮
   为什么放节点文字右侧：不挤压文件名，hover 节点时浮现避免视觉噪音；
   active 高亮反馈定位成功（跟随主题色，不引入硬编码颜色） */
.locate-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 6px;
  padding: 1px;
  width: 18px;
  height: 18px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-dim);
  cursor: pointer;
  vertical-align: middle;
  opacity: 0;
  transition: opacity 0.2s ease, color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
}

/* hover 节点行显示按钮；按钮自身 hover 高亮
   :deep 指向 el-tree 节点内容行，保证整行悬停即浮现 */
:deep(.el-tree-node__content:hover) .locate-btn,
.tree-node:hover .locate-btn,
.locate-btn:hover {
  opacity: 1;
}

.locate-btn:hover {
  color: var(--neon-cyan);
  border-color: var(--accent-cyan-a40);
  background: var(--accent-cyan-a12);
}

/* 定位成功短暂反馈：霓虹青高亮，随 locateFlashTimer 消退 */
.locate-btn.active {
  opacity: 1;
  color: var(--neon-cyan);
  border-color: var(--accent-cyan-a60);
  background: var(--accent-cyan-a20);
  box-shadow: 0 0 8px var(--accent-cyan-a40);
}

.tree-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  padding: 24px 8px;
  font-family: var(--font-mono);
}

/* 右侧内容区 */
.content-panel {
  flex: 1;
  overflow-y: auto;
  padding: 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-cyan-a12);
  border-radius: var(--radius-card);
}

.content-loading,
.content-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--text-soft);
  font-family: var(--font-mono);
}

.empty-tip {
  margin: 0;
  font-size: 14px;
}

.content-show {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.frontmatter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 16px;
  background: var(--accent-magenta-a08);
  border: 1px solid var(--accent-magenta-a25);
  border-radius: 12px;
  margin-bottom: 14px;
}

.fm-chip {
  font-size: 12px;
  color: var(--text-base);
  font-family: var(--font-mono);
}

.fm-chip strong {
  color: var(--neon-pink);
}

/* 文档摘要条（T00257）：固定在浏览页底部，长条单行小字，横向滚动溢出，
   弱化视觉权重不干扰正文阅读；切换文档时以 :key 重新渲染 */
.doc-summary-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
  margin-top: 10px;
  padding: 6px 16px;
  background: var(--accent-magenta-a06);
  border: 1px solid var(--accent-magenta-a20);
  border-radius: 8px;
  overflow-x: auto;
  white-space: nowrap;
  /* 小字弱化，不抢正文焦点 */
  font-size: 11px;
  color: var(--text-soft);
  scrollbar-width: thin;
}

.doc-summary-bar .fm-chip {
  font-size: 11px;
  color: var(--text-soft);
}

.doc-summary-bar .fm-chip strong {
  color: var(--neon-pink);
  margin-right: 2px;
}

.editor-area {
  flex: 1;
}

.editor-area :deep(.el-textarea__inner) {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.7;
  height: 100%;
}

/* Markdown 渲染 */
.markdown-body {
  font-size: 14px;
  line-height: 1.8;
  color: var(--text-base);
  overflow-y: auto;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  margin: 18px 0 10px;
  color: var(--text-bright);
  font-family: var(--font-display);
}

.markdown-body :deep(h1) {
  font-size: 24px;
  border-bottom: 2px solid var(--neon-magenta);
  padding-bottom: 8px;
  text-shadow: 0 0 16px var(--accent-pink-a30);
}

.markdown-body :deep(h2) {
  font-size: 20px;
  color: var(--neon-cyan);
}

.markdown-body :deep(h3) {
  font-size: 17px;
  color: var(--neon-purple);
}

.markdown-body :deep(p) {
  margin: 10px 0;
}

.markdown-body :deep(ul) {
  padding-left: 24px;
  margin: 10px 0;
}

.markdown-body :deep(li) {
  margin: 5px 0;
}

.markdown-body :deep(code) {
  padding: 2px 8px;
  background: var(--accent-purple-a15);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--neon-purple);
}

.markdown-body :deep(pre) {
  padding: 14px 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-cyan-a20);
  border-radius: 12px;
  overflow-x: auto;
  margin: 14px 0;
}

.markdown-body :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
  color: var(--neon-cyan);
}

.markdown-body :deep(.wikilink) {
  color: var(--neon-magenta);
  background: var(--accent-pink-a10);
  padding: 2px 8px;
  border-radius: 6px;
  font-weight: 600;
  font-size: 13px;
  font-family: var(--font-mono);
  border: 1px solid var(--accent-pink-a25);
}

/* GFM 表格样式：与对照的 .Markdown 语法一致，边框/表头用主题变量适配深浅色切换 */
.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 14px 0;
  font-size: 13px;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--accent-purple-a25);
  padding: 8px 12px;
  text-align: left;
}

.markdown-body :deep(th) {
  background: var(--accent-cyan-a10);
  color: var(--text-bright);
  font-weight: 600;
  white-space: nowrap;
}

.markdown-body :deep(strong) {
  font-weight: 700;
  color: var(--text-bright);
}

/* ============================================================
 * 草稿审核模式样式
 * 复用现有 CSS 变量与圆角/边框风格，保持视觉一致
 * ============================================================ */

.draft-panel {
  display: flex;
  flex-direction: column;
}

.draft-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 4px 12px;
  border-bottom: 1px dashed var(--accent-purple-a20);
  margin-bottom: 10px;
}

.draft-count {
  font-size: 11px;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

.draft-item {
  position: relative;
  padding: 10px 12px;
  margin-bottom: 6px;
  background: var(--accent-purple-a05);
  border: 1px solid var(--accent-purple-a15);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.draft-item:hover {
  background: var(--accent-purple-a12);
  border-color: var(--neon-purple);
  transform: translateX(3px);
}

.draft-item.active {
  background: var(--accent-cyan-a10);
  border-color: var(--neon-cyan);
}

.draft-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
  margin-bottom: 3px;
  padding-right: 60px; /* 给右侧「发布」按钮留位 */
}

.draft-path {
  font-size: 10px;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
}

/* 单 draft 行内的发布按钮：绝对定位到右上角 */
.draft-item :deep(.el-button) {
  position: absolute;
  top: 8px;
  right: 8px;
}

/* 编译进度面板：顶部固定，下方滚动内容 */
.compile-progress {
  margin-bottom: 14px;
  padding: 12px 16px;
  background: var(--accent-cyan-a08);
  border: 1px solid var(--accent-cyan-a20);
  border-radius: 12px;
}

.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.progress-msg {
  flex: 1;
  font-size: 12px;
  color: var(--text-base);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-family: var(--font-mono);
}

.stat-success {
  color: var(--neon-cyan);
  font-weight: 700;
}

.stat-error {
  color: var(--neon-magenta);
  font-weight: 700;
}

.stat-total {
  color: var(--text-dim);
}

.batch-list {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--accent-cyan-a20);
  max-height: 180px;
  overflow-y: auto;
}

.batch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-soft);
}

.batch-row.status-done {
  color: var(--neon-cyan);
}

.batch-row.status-error {
  color: var(--neon-magenta);
}

.batch-row.status-running {
  color: var(--neon-purple);
}

.batch-index {
  color: var(--text-dim);
  min-width: 28px;
}

.batch-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-status {
  text-transform: uppercase;
  letter-spacing: 1px;
  font-weight: 600;
}

.batch-pages {
  color: var(--neon-cyan);
  font-size: 10px;
}

.batch-msg {
  color: var(--text-dim);
  font-size: 10px;
  font-style: italic;
}

.batch-row.status-cancelled {
  color: var(--text-dim);
  opacity: 0.5;
}

/* 进度条定制造型 */
.compile-progress-bar {
  margin: 8px 0 4px;
}

.stat-cancelled {
  color: var(--text-dim);
  font-weight: 600;
}

/* ============================================================
 * FR-10-1 AI 标签审核模式样式
 * 复用 draft-panel / draft-item 风格保持视觉一致
 * ============================================================ */

.tag-panel {
  display: flex;
  flex-direction: column;
}

/* 待审核页面项角标：右上角显示建议数 */
.tag-count-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 10px;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
  padding: 2px 8px;
  background: var(--accent-cyan-a10);
  border: 1px solid var(--accent-cyan-a25);
  border-radius: 10px;
  letter-spacing: 0.5px;
}

/* AI 标签审核操作栏：路径 + 重新生成按钮 */
.tag-action-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--accent-cyan-a20);
}

/* AI 标签建议列表容器 */
.tag-suggest-list,
.tag-existing-list {
  margin-bottom: 14px;
  padding: 12px 16px;
  border-radius: 12px;
}

.tag-suggest-list {
  background: var(--accent-magenta-a08);
  border: 1px solid var(--accent-magenta-a25);
}

.tag-existing-list {
  background: var(--accent-cyan-a08);
  border: 1px solid var(--accent-cyan-a20);
}

.tag-suggest-title {
  font-size: 12px;
  color: var(--text-soft);
  font-family: var(--font-mono);
  margin-bottom: 10px;
  letter-spacing: 0.5px;
}

/* 标签芯片容器：flex wrap 自动换行 */
.tag-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 单个标签芯片：可点击的 AI 建议带 hover 效果 */
.tag-chip {
  cursor: pointer;
  transition: all 0.3s ease;
  font-size: 12px;
}

.tag-chip.hover-glow:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px var(--accent-pink-a20);
}

/* AI 建议前的 + 号图标：提示用户点击可采纳 */
.tag-add-icon {
  margin-right: 4px;
  font-weight: 700;
  color: var(--neon-cyan);
}
</style>

<!-- T00294：全屏遮罩样式需放在非 scoped 块——Teleport 到 body 的元素不受 scoped 属性选择器影响，
     否则全屏层样式不生效（同 DocumentTabs 右键菜单的 scoped-pitfall 处理） -->
<style>
.fullscreen-overlay {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  flex-direction: column;
  padding: 20px 28px;
  background: var(--bg-scene);
  overflow: hidden;
}

/* 全屏顶部工具条：路径 + 操作按钮 */
.fs-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--accent-purple-a20);
  margin-bottom: 14px;
  flex-shrink: 0;
}

.fs-path {
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fs-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* 全屏编辑区：占满剩余高度 */
.fs-editor {
  flex: 1;
  display: flex;
}

.fs-editor .el-textarea {
  height: 100%;
}

.fs-editor .el-textarea__inner {
  height: 100% !important;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.7;
  resize: none;
}

/* 全屏浏览区：占满剩余高度并独立滚动 */
.fs-body {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
}

/* 全屏 markdown 样式：Teleport 到 body 后 scoped 的 .markdown-body 规则不命中，
   此处按主题变量补齐核心排版，保证全屏浏览与正文区观感一致 */
.fullscreen-overlay .markdown-body {
  font-size: 14px;
  line-height: 1.8;
  color: var(--text-base);
}

.fullscreen-overlay .markdown-body h1,
.fullscreen-overlay .markdown-body h2,
.fullscreen-overlay .markdown-body h3 {
  margin: 18px 0 10px;
  color: var(--text-bright);
  font-family: var(--font-display);
}

.fullscreen-overlay .markdown-body h1 {
  font-size: 24px;
  border-bottom: 2px solid var(--neon-magenta);
  padding-bottom: 8px;
  text-shadow: 0 0 16px var(--accent-pink-a30);
}

.fullscreen-overlay .markdown-body h2 {
  font-size: 20px;
  color: var(--neon-cyan);
}

.fullscreen-overlay .markdown-body h3 {
  font-size: 17px;
  color: var(--neon-purple);
}

.fullscreen-overlay .markdown-body p {
  margin: 10px 0;
}

.fullscreen-overlay .markdown-body ul {
  padding-left: 24px;
  margin: 10px 0;
}

.fullscreen-overlay .markdown-body li {
  margin: 5px 0;
}

.fullscreen-overlay .markdown-body code {
  padding: 2px 8px;
  background: var(--accent-purple-a15);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--neon-purple);
}

.fullscreen-overlay .markdown-body pre {
  padding: 14px 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-cyan-a20);
  border-radius: 12px;
  overflow-x: auto;
  margin: 14px 0;
}

.fullscreen-overlay .markdown-body pre code {
  background: none;
  border: none;
  padding: 0;
  color: var(--neon-cyan);
}

.fullscreen-overlay .markdown-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 14px 0;
  font-size: 13px;
}

.fullscreen-overlay .markdown-body th,
.fullscreen-overlay .markdown-body td {
  border: 1px solid var(--accent-purple-a25);
  padding: 8px 12px;
  text-align: left;
}

.fullscreen-overlay .markdown-body th {
  background: var(--accent-cyan-a10);
  color: var(--text-bright);
  font-weight: 600;
  white-space: nowrap;
}

.fullscreen-overlay .markdown-body strong {
  font-weight: 700;
  color: var(--text-bright);
}

/* 过滤 popover 弹层主题适配：popover 渲染在 body 下（scoped 不命中），
   背景/文字/描边全部取主题变量，避免浅色弹层与深色主题文字对比度冲突 */
.browse-filter-popper.el-popover {
  background: var(--bg-card);
  border: 1px solid var(--accent-purple-a25);
  box-shadow: 0 8px 24px var(--accent-purple-a20);
}

.browse-filter-popper .filter-pop {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.browse-filter-popper .filter-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.browse-filter-popper .filter-label {
  font-size: 11px;
  color: var(--text-soft);
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

/* popover 内 el-select 撑满宽度，避免弹层过窄 */
.browse-filter-popper .filter-field .el-select {
  width: 100%;
}
</style>
