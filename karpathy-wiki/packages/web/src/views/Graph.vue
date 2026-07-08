<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
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

// 目录颜色映射：不同目录的节点用不同颜色，便于区分
const DIR_COLORS: Record<string, string> = {
  entities: '#F5A8C0',
  concepts: '#C8E6E0',
  comparisons: '#E1D5F0',
  queries: '#FFF1B8',
};

// 加载图谱数据并渲染
async function loadGraph() {
  loading.value = true;
  try {
    const res = await fetch('/api/graph');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: GraphData = await res.json();
    nodeCount.value = data.nodes.length;
    edgeCount.value = data.edges.length;
    renderGraph(data);
  } catch (err) {
    ElMessage.error('加载图谱失败：' + (err as Error).message);
  } finally {
    loading.value = false;
  }
}

// 将后端 nodes/edges 转为 vis-network 格式
function renderGraph(data: GraphData) {
  if (!containerRef.value) return;

  // 节点：从路径提取目录名决定颜色，提取文件名作为标签
  const nodes = data.nodes.map((path) => {
    const parts = path.split('/');
    const dir = parts[0] ?? 'default';
    const label = parts[parts.length - 1]?.replace('.md', '') ?? path;
    return {
      id: path,
      label,
      color: { background: DIR_COLORS[dir] ?? '#FFD6E0', border: '#E886A6' },
      shape: 'dot',
      size: 16,
      font: { size: 12, color: '#4A3B47' },
    };
  });

  // 边：from/to 已是路径，直接用
  const edges = data.edges.map((e, idx) => ({
    id: idx,
    from: e.from,
    to: e.to,
    arrows: 'to' as const,
    color: { color: '#F5A8C0', opacity: 0.5 },
    width: 1.5,
  }));

  const nodesDS = new DataSet(nodes);
  const edgesDS = new DataSet(edges);

  // vis-network 配置：马卡龙配色 + 物理引擎
  const options: Options = {
    nodes: {
      borderWidth: 2,
      shadow: { enabled: true, size: 6, color: 'rgba(245, 168, 192, 0.3)' },
    },
    edges: {
      smooth: { enabled: true, type: 'continuous', roundness: 0.5 },
    },
    physics: {
      enabled: true,
      stabilization: { iterations: 100 },
      barnesHut: {
        gravitationalConstant: -3000,
        springLength: 120,
        springConstant: 0.04,
      },
    },
    interaction: {
      hover: true,
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
  loadGraph();
});

onBeforeUnmount(() => {
  // 清理 vis-network 实例，避免内存泄漏
  if (network) {
    network.destroy();
    network = null;
  }
});

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
        <el-button size="small" :loading="loading" @click="loadGraph">刷新</el-button>
      </div>

      <!-- 图例 -->
      <div class="legend-bar">
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
      <div class="graph-canvas-wrapper">
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
</style>
