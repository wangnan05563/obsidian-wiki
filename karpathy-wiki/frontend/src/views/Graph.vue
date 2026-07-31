<script setup lang="ts">
import { API_BASE } from '../utils/apiBase';
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { Lightning, Iphone, Link, Close, StarFilled, Document } from '@element-plus/icons-vue';
import { Network, type Options } from 'vis-network';
import { DataSet } from 'vis-data';
import type { GraphData, RecommendedPage } from '../types';

const containerRef = ref<HTMLDivElement | null>(null);
const loading = ref(false);
const nodeCount = ref(0);
const edgeCount = ref(0);
let network: Network | null = null;

// FR-16-1 Discover Sources 状态
// 右键菜单：contextMenu.visible 控制显示，contextMenu.x/y 是相对画布坐标
// 为什么用画布坐标：菜单是 graph-card 子元素，position absolute 相对父容器定位
const contextMenu = ref<{ visible: boolean; x: number; y: number; pagePath: string }>({
  visible: false,
  x: 0,
  y: 0,
  pagePath: '',
});
// 推荐侧边栏：selectedPage 为空时侧边栏隐藏
const selectedPage = ref<string>('');
const recommendations = ref<RecommendedPage[]>([]);
const recommendLoading = ref(false);
// 链接建立中的目标 path，用于按钮 loading 状态
const linkingPath = ref<string>('');

// §12.3-2 大节点降级：节点数超过阈值时切换为高性能模式
// 200 节点以下：完整渲染（平滑曲线 + 阴影 + 悬停）
// 200-500 节点：关闭平滑曲线与阴影，保留物理引擎
// 500+ 节点：关闭物理引擎稳定（直接布局），简化节点样式
const LARGE_THRESHOLD = 200;
const HUGE_THRESHOLD = 500;
const isLarge = computed(() => nodeCount.value >= LARGE_THRESHOLD && nodeCount.value < HUGE_THRESHOLD);
const isHuge = computed(() => nodeCount.value >= HUGE_THRESHOLD);
const degraded = computed(() => isLarge.value || isHuge.value);

// §12.3-3 响应式小屏降级：窄屏切换为列表视图
const isNarrowScreen = ref(false);
const listView = ref(false);

// FR-15-5：类型过滤 + 实体子图视图模式
// typeFilter: 空字符串=全部，否则按目录首段过滤（与 SCHEMA.md type 枚举对齐）
// entityOnly: 实体子图模式，只显示 entities/ 节点及其一阶邻居（入链+出链）
const typeFilter = ref('');
const entityOnly = ref(false);

// 6 目录与中文标签映射（复用图例标签，避免重复维护）
const DIR_OPTIONS = [
  { label: '全部类型', value: '' },
  { label: '实体', value: 'entities' },
  { label: '概念', value: 'concepts' },
  { label: '对比', value: 'comparisons' },
  { label: '问答', value: 'queries' },
  { label: '业务问答', value: 'qa' },
  { label: '方案沉淀', value: 'solutions' },
];

// Read theme color from CSS variable (theme-aware)
function getThemeVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#b026ff';
}
// Directory color mapping: read from CSS vars so nodes follow the active theme
// FR-15-5：补全 6 目录颜色，与 SCHEMA.md type 枚举对齐
function getDirColors(): Record<string, string> {
  return {
    entities: getThemeVar('--graph-entities'),
    concepts: getThemeVar('--graph-concepts'),
    comparisons: getThemeVar('--graph-comparisons'),
    queries: getThemeVar('--graph-queries'),
    qa: getThemeVar('--graph-qa'),
    solutions: getThemeVar('--graph-solutions'),
  };
}
function getDirBorders(): Record<string, string> {
  return {
    entities: getThemeVar('--graph-entities-border'),
    concepts: getThemeVar('--graph-concepts-border'),
    comparisons: getThemeVar('--graph-comparisons-border'),
    queries: getThemeVar('--graph-queries-border'),
    qa: getThemeVar('--graph-qa-border'),
    solutions: getThemeVar('--graph-solutions-border'),
  };
}

// 检测屏幕宽度，窄屏（<768px）自动切换列表视图
function checkScreenSize() {
  isNarrowScreen.value = window.innerWidth < 768;
}

// FR-15-5：过滤图谱数据
// - typeFilter: 按目录首段过滤节点（仅保留该目录的节点 + 相连的边）
// - entityOnly: 实体子图模式，只显示 entities/ 节点及其一阶邻居（入链+出链）
// 为什么 entityOnly 优先于 typeFilter：实体子图是更严格的过滤模式，两者同时开启时以实体子图为准
function filterGraphData(data: GraphData): GraphData {
  if (!typeFilter.value && !entityOnly.value) return data;

  let keptNodes: Set<string>;

  if (entityOnly.value) {
    // 实体子图：entities 节点 + 一阶邻居（入链+出链目标）
    // 为什么包含一阶邻居：实体图谱需展示实体与其他页面的关联关系
    const entityNodes = new Set(data.nodes.filter((n) => n.startsWith('entities/')));
    keptNodes = new Set(entityNodes);
    for (const edge of data.edges) {
      if (entityNodes.has(edge.from)) keptNodes.add(edge.to);
      if (entityNodes.has(edge.to)) keptNodes.add(edge.from);
    }
  } else {
    // 类型过滤：只保留该目录的节点
    keptNodes = new Set(
      data.nodes.filter((n) => {
        const dir = n.split('/')[0] ?? '';
        return dir === typeFilter.value;
      }),
    );
  }

  const nodes = data.nodes.filter((n) => keptNodes.has(n));
  const edges = data.edges.filter((e) => keptNodes.has(e.from) && keptNodes.has(e.to));
  return { nodes, edges };
}

// FR-15-5：切换实体子图模式
// 为什么切换时清空 typeFilter：避免两个过滤模式冲突
function toggleEntityOnly() {
  entityOnly.value = !entityOnly.value;
  if (entityOnly.value) typeFilter.value = '';
  loadGraph();
}

// 加载图谱数据并渲染
async function loadGraph() {
  loading.value = true;
  try {
    const res = await fetch(`${API_BASE}/graph`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw: GraphData = await res.json();
    // FR-15-5：按类型过滤 + 实体子图模式
    const data = filterGraphData(raw);
    nodeCount.value = data.nodes.length;
    edgeCount.value = data.edges.length;
    // 窄屏或用户手动切换时用列表视图，否则用图谱
    if (isNarrowScreen.value || listView.value) {
      renderList(data);
    } else {
      renderGraph(data);
    }
  } catch (err) {
    ElMessage.error('加载图谱失败：' + (err as Error).message);
  } finally {
    loading.value = false;
  }
}

// §12.3-3 小屏降级：列表视图，按目录分组展示页面与链接
// 保留原始数据，避免 vis-network 在小屏的渲染开销
function renderList(data: GraphData) {
  if (network) {
    network.destroy();
    network = null;
  }
  // 列表数据存到 listData，template 中渲染
  listData.value = buildListData(data);
}

// 列表视图数据：按目录分组
interface ListGroup {
  dir: string;
  color: string;
  pages: Array<{ path: string; name: string; links: number }>;
}
const listData = ref<ListGroup[]>([]);

function buildListData(data: GraphData): ListGroup[] {
  // 统计每个页面的出链数
  const linkCounts = new Map<string, number>();
  for (const e of data.edges) {
    linkCounts.set(e.from, (linkCounts.get(e.from) ?? 0) + 1);
  }
  // 按目录分组
  const groups = new Map<string, Array<{ path: string; name: string; links: number }>>();
  for (const path of data.nodes) {
    const parts = path.split('/');
    const dir = parts[0] ?? 'default';
    const name = parts[parts.length - 1]?.replace('.md', '') ?? path;
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push({ path, name, links: linkCounts.get(path) ?? 0 });
  }
  // 转为数组
  return Array.from(groups.entries()).map(([dir, pages]) => ({
    dir,
    color: getDirColors()[dir] ?? getThemeVar('--graph-comparisons'),
    pages: pages.sort((a, b) => b.links - a.links),
  }));
}

// 构建节点：根据降级级别调整样式，霓虹色 + 发光阴影；大图模式简化样式降低 GPU 开销
function buildNodes(data: GraphData, huge: boolean, large: boolean) {
  // 提前计算节点尺寸，避免嵌套三元运算符
  let nodeSize = 16;
  if (large) nodeSize = 12;
  if (huge) nodeSize = 8;

  return data.nodes.map((path) => {
    const parts = path.split('/');
    const dir = parts[0] ?? 'default';
    const label = parts[parts.length - 1]?.replace('.md', '') ?? path;
    const bg = getDirColors()[dir] ?? getThemeVar('--graph-comparisons');
    const border = getDirBorders()[dir] ?? getThemeVar('--graph-comparisons-border');
    return {
      id: path,
      // 超大图隐藏标签，仅悬停显示，减少 DOM 开销
      label: huge ? '' : label,
      title: label,
      color: { background: bg, border: border, highlight: { background: border, border: bg } },
      shape: 'dot',
      size: nodeSize,
      font: { size: huge ? 10 : 12, color: getThemeVar('--graph-label'), face: 'Rajdhani' },
      // 发光阴影：用节点同色系，营造霓虹辉光
      shadow: huge ? false : { enabled: true, size: 18, color: bg + 'aa' },
    };
  });
}

// 构建边：半透明霓虹紫，大图模式关闭平滑曲线减少 Canvas 绘制
function buildEdges(data: GraphData, huge: boolean, large: boolean) {
  return data.edges.map((e, idx) => ({
    id: idx,
    from: e.from,
    to: e.to,
    arrows: 'to' as const,
    color: { color: getThemeVar('--graph-edge'), highlight: getThemeVar('--graph-edge-highlight'), opacity: huge ? 0.25 : 0.5 },
    width: huge ? 1 : 1.5,
    smooth: !large && !huge,
  }));
}

// vis-network 配置：根据节点数自适应降级
function buildGraphOptions(huge: boolean, large: boolean): Options {
  // 提前计算迭代次数，避免嵌套三元运算符
  let stabilizationIterations = 100;
  if (large) stabilizationIterations = 80;
  if (huge) stabilizationIterations = 50;

  return {
    nodes: {
      borderWidth: huge ? 1 : 2,
    },
    edges: {
      // §12.3-2 大图降级：关闭 smooth 减少 GPU 开销
      smooth: large || huge ? false : { enabled: true, type: 'continuous', roundness: 0.5 },
    },
    physics: {
      enabled: true,
      // 超大图减少稳定迭代次数，快速进入静态布局
      stabilization: { iterations: stabilizationIterations },
      barnesHut: {
        gravitationalConstant: huge ? -5000 : -3000,
        springLength: huge ? 80 : 120,
        springConstant: 0.04,
      },
    },
    interaction: {
      hover: !huge,
      tooltipDelay: 200,
      zoomView: true,
    },
  };
}

// 将后端 nodes/edges 转为 vis-network 格式
function renderGraph(data: GraphData) {
  if (!containerRef.value) return;

  const huge = isHuge.value;
  const large = isLarge.value;

  const nodes = buildNodes(data, huge, large);
  const edges = buildEdges(data, huge, large);
  const nodesDS = new DataSet(nodes);
  const edgesDS = new DataSet(edges);
  const options = buildGraphOptions(huge, large);

  if (network) {
    network.destroy();
  }
  network = new Network(containerRef.value, { nodes: nodesDS, edges: edgesDS }, options);

  // FR-16-1 右键节点弹出上下文菜单
  // 为什么用 oncontext 而非 oncontext({node})：vis-network 的 oncontext 回调签名无 node 参数，
  // 需用 getNodeAt(pointer.DOM) 显式查询，否则拿到 undefined
  network.on('oncontext', (params) => {
    // 阻止默认浏览器右键菜单
    if (params.event) {
      params.event.preventDefault();
    }
    if (!network) return;
    // pointer.DOM 是相对画布的坐标，用于菜单定位
    const nodeId = network.getNodeAt(params.pointer.DOM);
    if (typeof nodeId === 'string' && nodeId) {
      // 转换为相对 graph-card 的坐标（菜单的定位父元素）
      const canvasRect = containerRef.value?.getBoundingClientRect();
      const cardRect = containerRef.value?.parentElement?.getBoundingClientRect();
      if (canvasRect && cardRect) {
        contextMenu.value = {
          visible: true,
          x: canvasRect.left - cardRect.left + params.pointer.DOM.x,
          y: canvasRect.top - cardRect.top + params.pointer.DOM.y,
          pagePath: nodeId,
        };
      }
    } else {
      // 点空白处隐藏菜单
      contextMenu.value.visible = false;
    }
  });

  // 左键点击节点也加载推荐（提升发现性，右键作为高级入口）
  network.on('click', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0] as string;
      // 不弹菜单，直接打开侧边栏加载推荐
      openRecommendations(nodeId);
    }
  });
}

// FR-16-1 加载推荐页面列表
async function openRecommendations(pagePath: string) {
  selectedPage.value = pagePath;
  contextMenu.value.visible = false;
  recommendLoading.value = true;
  recommendations.value = [];
  try {
    const url = `${API_BASE}/discover/recommend?pagePath=${encodeURIComponent(pagePath)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = (await res.json()) as { recommendations: RecommendedPage[] };
    recommendations.value = data.recommendations;
    if (data.recommendations.length === 0) {
      ElMessage.info('未找到相关但未连接的笔记');
    }
  } catch (err) {
    ElMessage.error('加载推荐失败：' + (err as Error).message);
  } finally {
    recommendLoading.value = false;
  }
}

// FR-16-1 一键建立双链
async function createLink(targetPath: string) {
  if (!selectedPage.value) return;
  linkingPath.value = targetPath;
  try {
    const res = await fetch(`${API_BASE}/discover/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: selectedPage.value, targetPath }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    ElMessage.success('已建立双链：' + targetPath);
    // 从推荐列表移除已链接的项
    recommendations.value = recommendations.value.filter((r) => r.path !== targetPath);
    // 刷新图谱以显示新边
    await loadGraph();
  } catch (err) {
    ElMessage.error('建立双链失败：' + (err as Error).message);
  } finally {
    linkingPath.value = '';
  }
}

// 关闭推荐侧边栏
function closeRecommendations() {
  selectedPage.value = '';
  recommendations.value = [];
}

// 关闭右键菜单（点击菜单外区域时触发）
function closeContextMenu() {
  contextMenu.value.visible = false;
}

// FR-15-5（AC-15-7）：打开笔记到 Browse 视图
// 复用 RefsList.vue 的 karpathy:jump-vault 事件机制，App.vue 监听后切换到 browse 视图，
// Browse.vue onMounted 读取 sessionStorage.karpathy:jumpPath 自动定位到对应文件
function openPageInBrowse(pagePath: string) {
  sessionStorage.setItem('karpathy:jumpPath', pagePath);
  globalThis.dispatchEvent(new CustomEvent('karpathy:jump-vault', { detail: { path: pagePath } }));
  contextMenu.value.visible = false;
}

onMounted(() => {
  checkScreenSize();
  window.addEventListener('resize', handleResize);
  loadGraph();
});

onBeforeUnmount(() => {
  // 清理 vis-network 实例与事件监听，避免内存泄漏
  if (network) {
    network.destroy();
    network = null;
  }
  window.removeEventListener('resize', handleResize);
});

// 窗口大小变化时：窄屏切换列表，宽屏重绘图谱
function handleResize() {
  checkScreenSize();
  if (network && !isNarrowScreen.value && !listView.value) {
    network.redraw();
  }
}

// 切换视图模式
function toggleView() {
  listView.value = !listView.value;
  loadGraph();
}

// 窗口大小变化时重新绘制
watch(loading, () => {
  if (network && !loading.value) {
    network.redraw();
  }
});
</script>

<template>
  <div class="graph-page">
    <div class="glass-card graph-card">
      <!-- 不对称装饰块：旋转的极光渐变 -->
      <div class="card-deco"></div>

      <div class="graph-head">
        <div class="head-text">
          <h2 class="head-title grad-text">知识图谱</h2>
          <p class="head-tip">页面间的双向链接关系可视化</p>
        </div>
      <div class="graph-stats">
          <span class="stat-chip grad-cool-text">
            <span class="chip-num">{{ nodeCount }}</span>
            <span class="chip-label">节点</span>
          </span>
          <span class="stat-chip grad-fire-text">
            <span class="chip-num">{{ edgeCount }}</span>
            <span class="chip-label">链接</span>
          </span>
        </div>
        <el-button size="small" class="neon-btn" @click="toggleView">
          {{ listView ? '图谱视图' : '列表视图' }}
        </el-button>
        <el-button size="small" class="neon-btn" :loading="loading" @click="loadGraph">刷新</el-button>
      </div>

      <!-- FR-15-5：类型过滤 + 实体子图模式（AC-15-5, AC-15-7） -->
      <!-- 为什么仅图谱视图显示：列表视图本身按目录分组，无需额外过滤 -->
      <div v-if="!listView" class="graph-filter-bar">
        <el-select
          v-model="typeFilter"
          placeholder="类型筛选"
          size="small"
          clearable
          class="graph-type-select"
          @change="loadGraph"
        >
          <el-option
            v-for="opt in DIR_OPTIONS"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <el-button
          size="small"
          :class="['neon-btn', { 'entity-active': entityOnly }]"
          @click="toggleEntityOnly"
        >
          {{ entityOnly ? '退出实体子图' : '实体子图' }}
        </el-button>
      </div>

      <!-- 降级提示 -->
      <div v-if="degraded && !listView" class="degrade-bar">
        <el-icon class="degrade-icon"><Lightning /></el-icon>
        <span class="degrade-text">
          {{ isHuge ? '节点数超过 500，已启用超大图模式（简化样式 + 快速布局）' : '节点数超过 200，已启用性能优化模式' }}
        </span>
      </div>

      <!-- 小屏提示 -->
      <div v-if="isNarrowScreen && !listView" class="degrade-bar">
        <el-icon class="degrade-icon"><Iphone /></el-icon>
        <span class="degrade-text">小屏设备，建议切换列表视图以获得更好体验</span>
      </div>

      <!-- 图例：霓虹色点带发光 -->
      <!-- FR-15-5：补全 6 目录图例，与 SCHEMA.md type 枚举对齐 -->
      <div v-if="!listView" class="legend-bar">
        <span class="legend-item">
          <span class="legend-dot" style="background: var(--graph-entities); box-shadow: 0 0 10px var(--graph-entities)"></span>实体
        </span>
        <span class="legend-item">
          <span class="legend-dot" style="background: var(--graph-concepts); box-shadow: 0 0 10px var(--graph-concepts)"></span>概念
        </span>
        <span class="legend-item">
          <span class="legend-dot" style="background: var(--graph-comparisons); box-shadow: 0 0 10px var(--graph-comparisons)"></span>对比
        </span>
        <span class="legend-item">
          <span class="legend-dot" style="background: var(--graph-queries); box-shadow: 0 0 10px var(--graph-queries)"></span>问答
        </span>
        <span class="legend-item">
          <span class="legend-dot" style="background: var(--graph-qa); box-shadow: 0 0 10px var(--graph-qa)"></span>业务问答
        </span>
        <span class="legend-item">
          <span class="legend-dot" style="background: var(--graph-solutions); box-shadow: 0 0 10px var(--graph-solutions)"></span>方案沉淀
        </span>
      </div>

      <!-- 图谱画布 -->
      <div v-if="!listView" class="graph-canvas-wrapper">
        <div v-if="loading" class="graph-loading">
<p class="loading-text">// 构建图谱中…</p>
        </div>
      <div v-else-if="nodeCount === 0" class="graph-empty">
<p class="empty-tip">知识库还是空的，没有图谱数据</p>
        </div>
      <div ref="containerRef" class="graph-canvas" v-show="!loading && nodeCount > 0"></div>
      </div>

      <!-- §12.3-3 列表视图（小屏降级 / 手动切换） -->
      <div v-else class="list-view-wrapper">
        <div v-if="loading" class="graph-loading">
<p class="loading-text">// 加载中…</p>
        </div>
      <div v-else-if="listData.length === 0" class="graph-empty">
<p class="empty-tip">知识库还是空的，没有图谱数据</p>
        </div>
      <div v-else class="list-groups">
          <div v-for="group in listData" :key="group.dir" class="list-group hover-glow">
            <div class="group-head">
              <span class="group-dot" :style="{ background: group.color, boxShadow: `0 0 12px ${group.color}` }"></span>
              <span class="group-name">{{ group.dir }}</span>
              <span class="group-count">{{ group.pages.length }} 页</span>
            </div>
      <div class="group-pages">
              <div v-for="page in group.pages" :key="page.path" class="page-item" @click="openRecommendations(page.path)">
                <span class="page-name">▸ {{ page.name }}</span>
                <span class="page-links">⟶ {{ page.links }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- FR-16-1 右键上下文菜单：仅图谱视图 + 节点上右键时显示 -->
      <div
        v-if="contextMenu.visible && !listView"
        class="ctx-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
      >
        <div class="ctx-item" @click="openPageInBrowse(contextMenu.pagePath)">
          <el-icon class="ctx-icon"><Document /></el-icon>
          <span>打开笔记</span>
        </div>
        <div class="ctx-item" @click="openRecommendations(contextMenu.pagePath)">
          <el-icon class="ctx-icon"><Link /></el-icon>
          <span>查看推荐笔记</span>
        </div>
        <div class="ctx-item ctx-close" @click="closeContextMenu">
          <el-icon class="ctx-icon"><Close /></el-icon>
          <span>关闭</span>
        </div>
      </div>

      <!-- FR-16-1 推荐侧边栏：右侧浮层，覆盖图谱右半部分 -->
      <div v-if="selectedPage" class="recommend-panel">
        <div class="recommend-head">
          <div class="recommend-title">
            <el-icon class="recommend-icon"><Lightning /></el-icon>
            <span>推荐笔记</span>
          </div>
          <button class="recommend-close" @click="closeRecommendations" aria-label="关闭">
            <el-icon><Close /></el-icon>
          </button>
        </div>
        <div class="recommend-source">
          <span class="source-label">源页面：</span>
          <code class="source-path">{{ selectedPage }}</code>
        </div>
        <div v-if="recommendLoading" class="recommend-loading">
          <p>// 寻找相关笔记中…</p>
        </div>
        <div v-else-if="recommendations.length === 0" class="recommend-empty">
          <p>未找到相关但未连接的笔记</p>
        </div>
        <div v-else class="recommend-list">
          <div
            v-for="rec in recommendations"
            :key="rec.path"
            class="recommend-card"
          >
            <div class="rec-head">
              <span class="rec-title">{{ rec.title }}</span>
              <span class="rec-score" :title="`匹配 ${rec.score} 个维度`">
                <el-icon><StarFilled /></el-icon>{{ rec.score }}
              </span>
            </div>
            <div class="rec-path"><code>{{ rec.path }}</code></div>
            <div class="rec-reasons">
              <span v-for="(reason, idx) in rec.reasons" :key="idx" class="rec-reason">{{ reason }}</span>
            </div>
            <button
              class="neon-btn rec-link-btn"
              :disabled="linkingPath === rec.path"
              @click="createLink(rec.path)"
            >
              {{ linkingPath === rec.path ? '建立中…' : '建立双链' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.graph-page {
  display: flex;
  flex-direction: column;
  /* 高度填满 .content：侧栏布局后顶部导航与页脚已删除，
     让图谱画布视野延展到页面底部 */
  height: 100%;
}

.graph-card {
  position: relative;
  padding: 24px 28px;
  /* flex: 1 让卡片填满 .graph-page 剩余高度，
     替代原 calc(100vh - 220px) 顶部布局下为导航+页脚预留的固定减去值 */
  flex: 1;
  min-height: 480px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 不对称装饰块：旋转极光渐变，营造艺术感 */
.card-deco {
  position: absolute;
  bottom: -60px;
  left: -40px;
  width: 220px;
  height: 220px;
  background: var(--grad-aurora);
  filter: blur(60px);
  opacity: 0.35;
  transform: rotate(-15deg);
  border-radius: 50%;
  pointer-events: none;
  z-index: 0;
}

.graph-head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 14px;
}

.head-text {
  flex: 1;
}

.head-tag {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--neon-cyan);
  text-transform: uppercase;
  margin-bottom: 2px;
}

.head-title {
  margin: 0 0 2px;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 12px;
}

.graph-stats {
  display: flex;
  gap: 8px;
}

.stat-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 6px 14px;
  background: var(--bg-glass);
  border: 1px solid var(--accent-purple-a30);
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  font-size: 12px;
}

.chip-num {
  font-size: 15px;
  font-weight: 700;
}

.chip-label {
  font-size: 11px;
  color: var(--text-soft);
}

.grad-cool-text {
  background: var(--grad-cool);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}

.grad-fire-text {
  background: var(--grad-fire);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}

/* 霓虹按钮：透明底 + 紫色边框 + 悬停发光 */
.neon-btn {
  background: var(--bg-glass) !important;
  border: 1px solid var(--accent-purple-a40) !important;
  color: var(--text-bright) !important;
  font-family: var(--font-mono) !important;
  letter-spacing: 0.05em;
  transition: all 0.3s ease !important;
}

.neon-btn:hover {
  border-color: var(--neon-cyan) !important;
  box-shadow: var(--glow-cyan) !important;
  color: var(--neon-cyan) !important;
}

.legend-bar {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 18px;
  padding: 10px 16px;
  margin-bottom: 12px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-input);
  flex-wrap: wrap;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-base);
  letter-spacing: 0.04em;
}

.legend-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: inline-block;
}

.graph-canvas-wrapper {
  position: relative;
  z-index: 1;
  flex: 1;
  background: var(--bg-scene);
  border: 1px solid var(--accent-cyan-a15);
  border-radius: var(--radius-card);
  overflow: hidden;
}

/* 画布背景叠加网格，增强赛博空间感 */
.graph-canvas-wrapper::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(var(--accent-purple-a04) 1px, transparent 1px),
    linear-gradient(90deg, var(--accent-cyan-a03) 1px, transparent 1px);
  background-size: 40px 40px;
  pointer-events: none;
  z-index: 0;
}

.graph-canvas {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
}

.graph-loading,
.graph-empty {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--text-soft);
}

.loading-text {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--neon-cyan);
  letter-spacing: 0.1em;
}

.empty-tip {
  margin: 0;
  font-size: 14px;
  color: var(--text-soft);
}

/* §12.3-2 降级提示条：霓虹警示渐变 */
.degrade-bar {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  margin-bottom: 12px;
  background: linear-gradient(90deg, var(--accent-pink-a18), var(--accent-purple-a12));
  border: 1px solid var(--accent-pink-a35);
  border-radius: var(--radius-input);
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-bright);
  letter-spacing: 0.03em;
}

.degrade-icon {
  font-size: 15px;
  flex-shrink: 0;
}

.degrade-text {
  flex: 1;
  line-height: 1.5;
}

/* §12.3-3 列表视图：小屏降级 / 手动切换 */
.list-view-wrapper {
  position: relative;
  z-index: 1;
  flex: 1;
  overflow: auto;
  padding: 4px;
}

.list-groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.list-group {
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
  padding: 14px 18px;
  transition: all 0.3s ease;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
  margin-bottom: 10px;
  border-bottom: 1px dashed var(--accent-cyan-a20);
}

.group-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.group-name {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.group-count {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--neon-cyan);
  background: var(--accent-cyan-a10);
  border: 1px solid var(--accent-cyan-a30);
  padding: 2px 10px;
  border-radius: var(--radius-pill);
}

.group-pages {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.page-item {
  display: flex;
  align-items: center;
  padding: 7px 12px;
  border-radius: 8px;
  transition: all 0.25s ease;
}

.page-item:hover {
  background: var(--accent-purple-a12);
  transform: translateX(4px);
}

.page-name {
  flex: 1;
  font-size: 13px;
  font-family: var(--font-mono);
  color: var(--text-base);
}

.page-links {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--neon-cyan);
}

/* FR-16-1 右键上下文菜单：浮层 + 毛玻璃 */
.ctx-menu {
  position: absolute;
  z-index: 20;
  min-width: 180px;
  background: var(--bg-glass);
  backdrop-filter: blur(12px);
  border: 1px solid var(--accent-purple-a40);
  border-radius: var(--radius-card);
  box-shadow: var(--glow-cyan);
  padding: 6px 0;
  font-family: var(--font-mono);
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  font-size: 13px;
  color: var(--text-base);
  cursor: pointer;
  transition: all 0.2s ease;
}

.ctx-item:hover {
  background: var(--accent-purple-a15);
  color: var(--neon-cyan);
}

.ctx-item.ctx-close:hover {
  color: var(--neon-pink, var(--accent-pink-a70));
}

.ctx-icon {
  font-size: 14px;
  flex-shrink: 0;
}

/* FR-16-1 推荐侧边栏：右侧浮层，固定宽度，毛玻璃背景 */
.recommend-panel {
  position: absolute;
  top: 16px;
  right: 16px;
  bottom: 16px;
  width: 340px;
  z-index: 15;
  display: flex;
  flex-direction: column;
  background: var(--bg-glass);
  backdrop-filter: blur(16px);
  border: 1px solid var(--accent-cyan-a30);
  border-radius: var(--radius-card);
  box-shadow: var(--glow-cyan);
  overflow: hidden;
}

.recommend-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--accent-purple-a20);
  flex-shrink: 0;
}

.recommend-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.05em;
}

.recommend-icon {
  font-size: 15px;
  color: var(--neon-cyan);
}

.recommend-close {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--accent-purple-a30);
  background: transparent;
  color: var(--text-soft);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.recommend-close:hover {
  border-color: var(--neon-pink, var(--accent-pink-a70));
  color: var(--neon-pink, var(--accent-pink-a70));
  transform: rotate(90deg);
}

.recommend-source {
  padding: 10px 16px;
  font-size: 12px;
  color: var(--text-soft);
  border-bottom: 1px dashed var(--accent-cyan-a15);
  flex-shrink: 0;
  word-break: break-all;
}

.source-label {
  font-family: var(--font-mono);
  margin-right: 4px;
}

.source-path {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-cyan);
  background: var(--accent-cyan-a10);
  padding: 2px 6px;
  border-radius: 4px;
}

.recommend-loading,
.recommend-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-soft);
  text-align: center;
}

.recommend-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.recommend-card {
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-input);
  padding: 12px 14px;
  transition: all 0.25s ease;
}

.recommend-card:hover {
  border-color: var(--neon-cyan);
  box-shadow: var(--glow-cyan);
}

.rec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.rec-title {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--text-bright);
  word-break: break-all;
}

.rec-score {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-cyan);
  background: var(--accent-cyan-a10);
  border: 1px solid var(--accent-cyan-a30);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  flex-shrink: 0;
}

.rec-path {
  margin-bottom: 8px;
}

.rec-path code {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-soft);
  word-break: break-all;
}

.rec-reasons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.rec-reason {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-base);
  background: var(--accent-purple-a12);
  border: 1px solid var(--accent-purple-a20);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
}

.rec-link-btn {
  width: 100%;
  padding: 6px 12px !important;
  font-size: 12px !important;
}

.rec-link-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 窄屏适配：侧边栏占满宽度 */
@media (max-width: 768px) {
  .recommend-panel {
    left: 8px;
    right: 8px;
    top: 8px;
    bottom: 8px;
    width: auto;
  }
}
</style>
