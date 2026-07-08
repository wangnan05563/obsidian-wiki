<script setup lang="ts">
import { onMounted, onBeforeUnmount, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { Loading, Check, Close } from '@element-plus/icons-vue';
import RobotAvatar from '../components/RobotAvatar.vue';
import { useCompileStore } from '../stores/compile';
import type { IngestPayload, TimelineItem } from '../types';

const emit = defineEmits<{
  (e: 'restart'): void;
}>();

const store = useCompileStore();
let abortController: AbortController | null = null;

// 步骤中文名映射，与后端 step 标识对齐
const STEP_LABEL: Record<string, string> = {
  archive: '存档原始资料',
  read_schema: '读取 SCHEMA',
  extract: '提取要点',
  generate_page: '生成页面',
  finalize: '收尾'
};

const robotMood = computed<string>(() => {
  if (store.errorMessage) return 'sad';
  if (store.isDone) return 'happy';
  return 'thinking';
});

// SSE 流式解析：按 \n\n 切分事件块，每块内再按行解析 event/data
async function startCompile(payload: IngestPayload) {
  const isFormData = payload instanceof FormData;
  abortController = new AbortController();
  try {
    const response = await fetch('/api/compile', {
      method: 'POST',
      headers: isFormData ? {} : { 'Content-Type': 'application/json' },
      body: isFormData ? payload : JSON.stringify(payload),
      signal: abortController.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 协议：事件以空行（\n\n）分隔
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const evt of events) {
        const lines = evt.split('\n');
        let eventType = '';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7);
          if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (eventType && data) {
          try {
            store.handleEvent(eventType, JSON.parse(data));
          } catch {
            // 后端偶发非 JSON 数据时跳过这一条，避免整条流崩溃
          }
        }
      }
    }
  } catch (err) {
    // 用户主动取消（abort）不算错误
    if ((err as Error).name === 'AbortError') return;
    store.handleEvent('error', { message: (err as Error).message });
    ElMessage.error('编译请求失败：' + (err as Error).message);
  } finally {
    abortController = null;
  }
}

onMounted(() => {
  // 进入进度页立即发起请求；payload 由 Ingest 页预先存入 store
  if (store.pendingPayload && !store.isDone) {
    void startCompile(store.pendingPayload);
  }
});

onBeforeUnmount(() => {
  // 离开页面时中断未完成的请求，避免内存泄漏
  abortController?.abort();
});

function handleRestart() {
  store.reset();
  emit('restart');
}

function stepLabelOf(item: TimelineItem): string {
  return STEP_LABEL[item.step] ?? item.step;
}

function dotTypeOf(item: TimelineItem): 'primary' | 'success' | 'danger' {
  if (item.status === 'done') return 'success';
  if (item.status === 'error') return 'danger';
  return 'primary';
}
</script>

<template>
  <div class="progress-page">
    <div class="glass-card progress-card">
      <div class="progress-head">
        <RobotAvatar :size="96" :floating="store.isCompiling" />
        <div class="head-text">
          <h2 class="head-title">
            <template v-if="store.isCompiling">机器人正在编译…</template>
            <template v-else-if="store.isDone">编译完成 🎉</template>
            <template v-else-if="store.errorMessage">出错了 :(</template>
            <template v-else>准备就绪</template>
          </h2>
          <p class="head-tip">
            <template v-if="robotMood === 'thinking'">小提示：编译过程是流式的，可实时查看每一步</template>
            <template v-else-if="robotMood === 'happy'">
              共生成 {{ store.generatedPages.length }} 个页面
            </template>
            <template v-else>{{ store.errorMessage }}</template>
          </p>
        </div>
      </div>

      <el-timeline v-if="store.timeline.length > 0" class="timeline">
        <el-timeline-item
          v-for="(item, idx) in store.timeline"
          :key="idx"
          :type="dotTypeOf(item)"
          :hollow="item.status === 'running'"
          size="large"
        >
          <div class="tl-row">
            <div class="tl-head">
              <span class="tl-step">{{ stepLabelOf(item) }}</span>
              <span class="tl-status" :class="item.status">
                <el-icon v-if="item.status === 'running'" class="spin-icon"><Loading /></el-icon>
                <el-icon v-else-if="item.status === 'done'"><Check /></el-icon>
                <el-icon v-else><Close /></el-icon>
                <span>{{ item.status }}</span>
              </span>
            </div>
            <div class="tl-message">{{ item.message }}</div>
            <div v-if="item.page" class="tl-page">
              📄 {{ item.page.title }}
              <code>{{ item.page.path }}</code>
            </div>
          </div>
        </el-timeline-item>
      </el-timeline>

      <div v-else class="empty-progress">
        <p>等待编译开始…</p>
      </div>

      <div v-if="store.isDone && store.result" class="done-section">
        <div class="result-card glass-card">
          <div class="result-title">📦 本次编译结果</div>
          <ul class="result-list">
            <li v-for="p in store.result.pages" :key="p">
              <code>{{ p }}</code>
            </li>
          </ul>
          <div class="result-meta">
            索引更新：<strong>{{ store.result.indexUpdated ? '是' : '否' }}</strong>
          </div>
        </div>
        <div class="restart-bar">
          <el-button type="primary" size="large" @click="handleRestart">
            再投一篇
          </el-button>
        </div>
      </div>

      <div v-else-if="store.errorMessage" class="restart-bar">
        <el-button type="primary" size="large" @click="handleRestart">
          重新投递
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.progress-page {
  display: flex;
  flex-direction: column;
}

.progress-card {
  padding: 28px 32px;
}

.progress-head {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 20px;
}

.head-title {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text);
}

.head-tip {
  margin: 0;
  color: var(--color-text-soft);
  font-size: 13px;
}

.timeline {
  padding-left: 4px;
  margin-top: 8px;
}

.tl-row {
  padding-bottom: 4px;
}

.tl-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.tl-step {
  font-weight: 600;
  color: var(--color-text);
}

.tl-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 12px;
  background: var(--color-cyan);
  color: var(--color-text);
}

.tl-status.done {
  background: var(--color-success);
  color: #fff;
}

.tl-status.error {
  background: var(--color-error);
  color: #fff;
}

.tl-status.running {
  background: var(--color-yellow);
  color: var(--color-text);
}

.tl-message {
  margin-top: 4px;
  color: var(--color-text-soft);
  font-size: 13px;
}

.tl-page {
  margin-top: 6px;
  font-size: 13px;
  color: var(--color-text);
}

.tl-page code {
  margin-left: 6px;
  padding: 2px 8px;
  background: var(--color-pink);
  border-radius: 8px;
  font-size: 12px;
}

.empty-progress {
  text-align: center;
  color: var(--color-text-soft);
  padding: 40px 0;
}

.done-section {
  margin-top: 24px;
}

.result-card {
  padding: 18px 22px;
  background: rgba(255, 241, 184, 0.45);
}

.result-title {
  font-weight: 700;
  margin-bottom: 10px;
  color: var(--color-text);
}

.result-list {
  list-style: none;
  padding: 0;
  margin: 0 0 10px;
}

.result-list li {
  padding: 4px 0;
  font-size: 13px;
}

.result-list code {
  padding: 3px 10px;
  background: var(--color-pink);
  border-radius: 8px;
  font-size: 12px;
}

.result-meta {
  font-size: 13px;
  color: var(--color-text-soft);
}

.restart-bar {
  margin-top: 20px;
  display: flex;
  justify-content: center;
}
</style>
