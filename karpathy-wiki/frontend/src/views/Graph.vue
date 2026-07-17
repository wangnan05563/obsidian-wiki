<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { Network, type Options } from 'vis-network';
import { DataSet } from 'vis-data';
import type { GraphData } from '../types';

const containerRef = ref<HTMLDivElement | null>(null);
const loading = ref(false);
const nodeCount = ref(0);
const edgeCount = ref(0);
let network: Network | null = null;

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

// Read theme color from CSS variable (theme-aware)
function getThemeVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#b026ff';
}
// Directory color mapping: read from CSS vars so nodes follow the active theme
function getDirColors(): Record<string, string> {
  return {
    entities: getThemeVar('--graph-entities'),
    concepts: getThemeVar('--graph-concepts'),
    comparisons: getThemeVar('--graph-comparisons'),
    queries: getThemeVar('--graph-queries'),
  };
}
function getDirBorders(): Record<string, string> {
  return {
    entities: getThemeVar('--graph-entities-border'),
    concepts: getThemeVar('--graph-concepts-border'),
    comparisons: getThemeVar('--graph-comparisons-border'),
    queries: getThemeVar('--graph-queries-border'),
  };
}

// 检测屏幕宽度，窄屏（<768px）自动切换列表视图
function checkScreenSize() {
  isNarrowScreen.value = window.innerWidth < 768;
}

// 加载图谱数据并渲染
async function loadGraph() {
  loading.value = true;
  try {
    const res = await fetch('/api/graph');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: GraphData = await res.json();
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
          <span class="head-tag">// NEURAL GRAPH</span>
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

      <!-- 降级提示 -->
      <div v-if="degraded && !listView" class="degrade-bar">
        <span class="degrade-icon">⚡</span>
        <span class="degrade-text">
          {{ isHuge ? '节点数超过 500，已启用超大图模式（简化样式 + 快速布局）' : '节点数超过 200，已启用性能优化模式' }}
        </span>
      </div>

      <!-- 小屏提示 -->
      <div v-if="isNarrowScreen && !listView" class="degrade-bar">
        <span class="degrade-icon">📱</span>
        <span class="degrade-text">小屏设备，建议切换列表视图以获得更好体验</span>
      </div>

      <!-- 图例：霓虹色点带发光 -->
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
              <div v-for="page in group.pages" :key="page.path" class="page-item">
                <span class="page-name">▸ {{ page.name }}</span>
                <span class="page-links">⟶ {{ page.links }}</span>
              </div>
            </div>
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
}

.graph-card {
  position: relative;
  padding: 24px 28px;
  height: calc(100vh - 220px);
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
</style>
