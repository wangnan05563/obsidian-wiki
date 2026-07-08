<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { Network, type Options } from 'vis-network';
import { DataSet } from 'vis-data';
import RobotAvatar from '../components/RobotAvatar.vue';
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

// 目录颜色映射：不同目录的节点用不同颜色，便于区分
const DIR_COLORS: Record<string, string> = {
  entities: '#F5A8C0',
  concepts: '#C8E6E0',
  comparisons: '#E1D5F0',
  queries: '#FFF1B8',
};

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
    color: DIR_COLORS[dir] ?? '#FFD6E0',
    pages: pages.sort((a, b) => b.links - a.links),
  }));
}

// 将后端 nodes/edges 转为 vis-network 格式
function renderGraph(data: GraphData) {
  if (!containerRef.value) return;

  const huge = isHuge.value;
  const large = isLarge.value;

  // 节点：大图模式下简化样式（缩小尺寸、关闭阴影）
  const nodes = data.nodes.map((path) => {
    const parts = path.split('/');
    const dir = parts[0] ?? 'default';
    const label = parts[parts.length - 1]?.replace('.md', '') ?? path;
    return {
      id: path,
      // 超大图隐藏标签，仅悬停显示，减少 DOM 开销
      label: huge ? '' : label,
      title: label,
      color: { background: DIR_COLORS[dir] ?? '#FFD6E0', border: '#E886A6' },
      shape: 'dot',
      size: huge ? 8 : large ? 12 : 16,
      font: { size: huge ? 10 : 12, color: '#4A3B47' },
      shadow: huge ? false : { enabled: true, size: 6, color: 'rgba(245, 168, 192, 0.3)' },
    };
  });

  // 边：大图模式关闭平滑曲线，减少 Canvas 绘制计算
  const edges = data.edges.map((e, idx) => ({
    id: idx,
    from: e.from,
    to: e.to,
    arrows: 'to' as const,
    color: { color: '#F5A8C0', opacity: huge ? 0.3 : 0.5 },
    width: huge ? 1 : 1.5,
    smooth: !large && !huge,
  }));

  const nodesDS = new DataSet(nodes);
  const edgesDS = new DataSet(edges);

  // vis-network 配置：根据节点数自适应降级
  const options: Options = {
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
      stabilization: { iterations: huge ? 50 : large ? 80 : 100 },
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
      <div class="graph-head">
        <RobotAvatar :size="56" :floating="loading" />
        <div class="head-text">
          <h2 class="head-title">知识图谱</h2>
          <p class="head-tip">页面间的双向链接关系可视化</p>
        </div>
        <div class="graph-stats">
          <span class="stat-chip">📄 {{ nodeCount }} 节点</span>
          <span class="stat-chip">🔗 {{ edgeCount }} 链接</span>
        </div>
        <el-button size="small" @click="toggleView">
          {{ listView ? '图谱视图' : '列表视图' }}
        </el-button>
        <el-button size="small" :loading="loading" @click="loadGraph">刷新</el-button>
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

      <!-- 图例 -->
      <div v-if="!listView" class="legend-bar">
        <span class="legend-item">
          <span class="legend-dot" style="background: #F5A8C0"></span>实体
        </span>
        <span class="legend-item">
          <span class="legend-dot" style="background: #C8E6E0"></span>概念
        </span>
        <span class="legend-item">
          <span class="legend-dot" style="background: #E1D5F0"></span>对比
        </span>
        <span class="legend-item">
          <span class="legend-dot" style="background: #FFF1B8"></span>问答
        </span>
      </div>

      <!-- 图谱画布 -->
      <div v-if="!listView" class="graph-canvas-wrapper">
        <div v-if="loading" class="graph-loading">
          <RobotAvatar :size="100" :floating="true" />
          <p>正在构建图谱…</p>
        </div>
        <div v-else-if="nodeCount === 0" class="graph-empty">
          <RobotAvatar :size="120" :floating="true" />
          <p class="empty-tip">知识库还是空的，没有图谱数据</p>
        </div>
        <div ref="containerRef" class="graph-canvas" v-show="!loading && nodeCount > 0"></div>
      </div>

      <!-- §12.3-3 列表视图（小屏降级 / 手动切换） -->
      <div v-else class="list-view-wrapper">
        <div v-if="loading" class="graph-loading">
          <RobotAvatar :size="80" :floating="true" />
          <p>加载中…</p>
        </div>
        <div v-else-if="listData.length === 0" class="graph-empty">
          <RobotAvatar :size="120" :floating="true" />
          <p class="empty-tip">知识库还是空的，没有图谱数据</p>
        </div>
        <div v-else class="list-groups">
          <div v-for="group in listData" :key="group.dir" class="list-group">
            <div class="group-head">
              <span class="group-dot" :style="{ background: group.color }"></span>
              <span class="group-name">{{ group.dir }}</span>
              <span class="group-count">{{ group.pages.length }} 页</span>
            </div>
            <div class="group-pages">
              <div v-for="page in group.pages" :key="page.path" class="page-item">
                <span class="page-name">📄 {{ page.name }}</span>
                <span class="page-links">🔗 {{ page.links }}</span>
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
  padding: 24px 28px;
  height: calc(100vh - 220px);
  min-height: 480px;
  display: flex;
  flex-direction: column;
}

.graph-head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
}

.head-text {
  flex: 1;
}

.head-title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
}

.head-tip {
  margin: 0;
  color: var(--color-text-soft);
  font-size: 13px;
}

.graph-stats {
  display: flex;
  gap: 8px;
}

.stat-chip {
  padding: 4px 12px;
  background: var(--color-cyan);
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
}

.legend-bar {
  display: flex;
  gap: 16px;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: rgba(255, 255, 255, 0.4);
  border-radius: 12px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text);
}

.legend-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: inline-block;
}

.graph-canvas-wrapper {
  flex: 1;
  position: relative;
  background: rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-card);
  overflow: hidden;
}

.graph-canvas {
  width: 100%;
  height: 100%;
}

.graph-loading,
.graph-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--color-text-soft);
}

.empty-tip {
  margin: 0;
  font-size: 14px;
}

/* §12.3-2 降级提示条：性能优化模式 / 超大图模式 */
.degrade-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  margin-bottom: 10px;
  background: linear-gradient(90deg, rgba(255, 241, 184, 0.6), rgba(245, 168, 192, 0.4));
  border-radius: 12px;
  font-size: 12px;
  color: var(--color-text);
}

.degrade-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.degrade-text {
  flex: 1;
  line-height: 1.5;
}

/* §12.3-3 列表视图：小屏降级 / 手动切换 */
.list-view-wrapper {
  flex: 1;
  position: relative;
  overflow: auto;
  padding: 4px;
}

.list-groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.list-group {
  background: rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-card);
  padding: 12px 16px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px dashed rgba(232, 134, 166, 0.3);
}

.group-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.group-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
  flex: 1;
}

.group-count {
  font-size: 11px;
  color: var(--color-text-soft);
  background: var(--color-cyan);
  padding: 2px 8px;
  border-radius: 10px;
}

.group-pages {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.page-item {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 8px;
  transition: background 0.2s;
}

.page-item:hover {
  background: rgba(245, 168, 192, 0.15);
}

.page-name {
  flex: 1;
  font-size: 13px;
  color: var(--color-text);
}

.page-links {
  font-size: 11px;
  color: var(--color-text-soft);
}
</style>
